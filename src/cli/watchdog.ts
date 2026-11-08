/**
 * `watchdog [--env-file p]`: the watchdog as its own process (Deployment § Processes: the watchdog systemd unit, a
 * separate unit that survives a Coordinator crash; deploy/systemd/pi-durable-watchdog.service). It reads only its own
 * variables (src/watchdog/config.ts), removes any secret variable from its environment, and runs the core of
 * src/watchdog/watchdog.ts with the production reapers:
 *
 *   systemd isolation   everything in the Pi slice's control group, then every marked Pi process of this deployment
 *   process isolation   every marked Pi process of this deployment (the local mode)
 *   containers          every container labelled pi-durable.managed=1, through DOCKER_BIN
 *
 * Exit codes: 0 stopped by SIGINT/SIGTERM, 2 configuration problem (printed by variable name, never a value).
 */
import { scrubSecrets } from "../config/scrub.ts";
import { ConfigError, requireRunnerIsolation } from "../config/shared.ts";
import { createLogger, errorSummary, type Logger } from "../runtime/log.ts";
import { createShutdownController } from "../runtime/signals.ts";
import { packageVersion } from "../runtime/version.ts";
import { loadWatchdogConfig, type WatchdogConfig } from "../watchdog/config.ts";
import {
	dockerContainerReaper,
	markerProcessReaper,
	type Reaper,
	type Reapers,
	sliceProcessReaper,
} from "../watchdog/reapers.ts";
import { startWatchdog, type Watchdog } from "../watchdog/watchdog.ts";

export type WatchdogCliOptions = {
	/** TEST ONLY: platform policy under test; never configurable from the environment or product CLI. */
	readonly platform?: NodeJS.Platform;
	readonly envFile?: string | undefined;
	/** Defaults to `process.env` (only the watchdog's variables are read; secret variables are removed from it). */
	readonly env?: NodeJS.ProcessEnv;
	readonly stderr?: (text: string) => void;
	readonly exit?: (code: number) => void;
	/** Install SIGINT/SIGTERM handlers (default true). */
	readonly processHandlers?: boolean;
	readonly createLog?: (config: WatchdogConfig) => Logger;
};

/** Production reapers, guarded even for prebuilt configs. `platform` is a code-only test injection. */
export function productionReapers(config: WatchdogConfig, platform: NodeJS.Platform = process.platform): Reapers {
	requireRunnerIsolation(config.isolation, platform);
	const marked = markerProcessReaper({ deployment: config.deployment });
	const processes: Reaper[] =
		config.isolation === "systemd"
			? [
					sliceProcessReaper({ slice: config.slice, deployment: config.deployment, systemctl: config.systemctlBin }),
					marked,
				]
			: [marked];
	return { processes, containers: [dockerContainerReaper({ bin: config.dockerBin })] };
}

/** The configuration, or the exit code after printing its problems (by variable name, never a value). */
function readConfig(options: WatchdogCliOptions, env: NodeJS.ProcessEnv): WatchdogConfig | number {
	const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text));
	try {
		return loadWatchdogConfig({
			...(options.envFile === undefined ? {} : { envFile: options.envFile }),
			env,
			platform: options.platform,
		});
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		stderr(`Configuration error:\n${error.problems.map((p) => `  ${p.variable}: ${p.message}`).join("\n")}\n`);
		return 2;
	}
}

function installHandlers(
	controller: { trigger: (code: number, reason: string) => Promise<void>; install(): void },
	log: Logger,
): void {
	controller.install();
	const fatal = (reason: string) => (error: unknown) => {
		log.error("fatal", { reason, error: errorSummary(error) });
		void controller.trigger(1, reason);
	};
	process.on("unhandledRejection", fatal("unhandled_rejection"));
	process.on("uncaughtException", fatal("uncaught_exception"));
}

export async function runWatchdogCli(options: WatchdogCliOptions = {}): Promise<number | Watchdog> {
	const env = options.env ?? process.env;
	const config = readConfig(options, env);
	if (typeof config === "number") return config;
	// The watchdog needs no secret; if its environment has any (a shared env), they go before anything else runs.
	const removed = Object.keys(scrubSecrets(env)).length;
	const log = options.createLog?.(config) ?? createLogger({ level: config.logLevel });
	log.info("watchdog_starting", {
		version: packageVersion(),
		data: config.dataDir,
		group: config.groupChatId,
		isolation: config.isolation,
		...(config.isolation === "systemd" ? { slice: config.slice } : {}),
	});
	if (removed > 0) log.warn("watchdog_secrets_removed", { count: removed });
	const watchdog = startWatchdog({
		dataDir: config.dataDir,
		chatId: config.groupChatId,
		reapers: productionReapers(config, options.platform),
		log,
	});
	const controller = createShutdownController({
		log,
		watchdogMs: 30_000,
		...(options.exit === undefined ? {} : { exit: options.exit }),
		shutdown: () => watchdog.stop(),
	});
	if (options.processHandlers !== false) installHandlers(controller, log);
	return watchdog;
}
