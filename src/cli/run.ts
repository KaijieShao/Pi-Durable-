import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { StartupError } from "../agent/models.ts";
import { type Agent, type OpenAgentDeps, openAgent } from "../agent/open.ts";
import { PollingError } from "../channel/create.ts";
import type { Config } from "../config/schema.ts";
import { acquireDataDirLock, type DataDirLock, LockHeld } from "../runtime/lock.ts";
import { errorSummary, type Logger } from "../runtime/log.ts";
import { ensurePrivateDir } from "../runtime/private-dir.ts";
import { createShutdownController } from "../runtime/signals.ts";

export type DaemonDeps = Omit<OpenAgentDeps, "onFatal" | "log"> & {
	readonly log: Logger;
	readonly exit?: (code: number) => void;
};

/**
 * `run`: lock the data directory, open the agent, start the channel (which resumes unfinished work) and run until a
 * signal or a fatal error. Shutdown: stop polling, drain handlers, close the harness, release the lock.
 */
export async function runDaemon(config: Config, deps: DaemonDeps): Promise<void> {
	const { log } = deps;
	const exit = deps.exit ?? ((code: number) => process.exit(code));
	await ensurePrivateDir(config.dataDir);
	const lock = takeLock(config.dataDir, log);
	if (lock === undefined) return exit(3);
	let agent: Agent | undefined;
	const controller = createShutdownController({
		log,
		exit,
		shutdown: async () => {
			await agent?.channel.stop();
			await agent?.harness.close(BG);
			await agent?.plugins.close();
			lock.release();
		},
	});
	const onFatal = (reason: string, error?: unknown, exitCode?: number) => {
		log.error("fatal", { reason, error: error === undefined ? undefined : errorSummary(error) });
		void controller.trigger(exitCode ?? 1, reason);
	};
	controller.install();
	process.on("unhandledRejection", (error) => onFatal("unhandled rejection", error));
	process.on("uncaughtException", (error) => onFatal("uncaught exception", error));
	try {
		agent = await openAgent(config, { ...deps, onFatal, log });
		await agent.channel.start(agent.harness, BG, { plugins: agent.plugins.report });
		log.info("started", {
			model: `${config.provider}/${config.modelId}`,
			workdir: config.workdir,
			data: config.dataDir,
		});
	} catch (error) {
		const code = error instanceof StartupError || error instanceof PollingError ? error.exitCode : 1;
		log.error("startup_failed", { error: errorSummary(error) });
		await controller.trigger(code, "startup failed");
	}
}

function takeLock(dataDir: string, log: Logger): DataDirLock | undefined {
	try {
		return acquireDataDirLock(dataDir);
	} catch (error) {
		if (!(error instanceof LockHeld)) throw error;
		log.error("lock_held", { reason: error.message });
		return undefined;
	}
}
