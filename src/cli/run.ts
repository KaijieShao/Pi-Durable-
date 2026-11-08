import { scrubSecrets } from "../config/scrub.ts";
import { ConfigError, type CoordinatorConfig, describeConfig, loadCoordinatorConfig } from "../coordinator/config.ts";
import { TelegramError } from "../coordinator/ports.ts";
import { LockHeld } from "../runtime/lock.ts";
import { createLogger, errorSummary, type Logger } from "../runtime/log.ts";
import { createShutdownController, type Shutdown } from "../runtime/signals.ts";
import { packageVersion } from "../runtime/version.ts";

/** Exit codes: 2 and 3 need a person (deploy units must not restart-loop on them). */
export const EXIT = { ok: 0, fatal: 1, config: 2, locked: 3 } as const;

/** What the CLI needs from a started Coordinator (src/coordinator/coordinator.ts returns more). */
export type CoordinatorHandle = { stop(): Promise<void> };

export type StartCoordinator = (config: CoordinatorConfig, deps: { log: Logger }) => Promise<CoordinatorHandle>;

export type RunOptions = {
	readonly envFile?: string | undefined;
	readonly start: StartCoordinator;
	/** Defaults to `process.env`; the env file is always loaded into `process.env` (see loadCoordinatorConfig). */
	readonly env?: NodeJS.ProcessEnv;
	readonly createLog?: (config: CoordinatorConfig) => Logger;
	readonly stderr?: (text: string) => void;
	readonly exit?: (code: number) => void;
	/** Install SIGINT/SIGTERM and unhandled-error handlers on `process` (default true; tests turn it off). */
	readonly processHandlers?: boolean;
	/** Exit with code 1 if stop() hangs longer than this (default 30 s: runs get stopGraceMs 15 s to stop). */
	readonly watchdogMs?: number;
};

export type RunningCoordinator = { readonly handle: CoordinatorHandle; readonly shutdown: Shutdown };

/**
 * `run`: parse the configuration (a ConfigError prints every problem, never a value, and returns 2), remove secret
 * variables from the environment (they now live only in the config object), create the metadata-only logger, start
 * the Coordinator and route SIGINT/SIGTERM and unhandled errors into one `stop()`. Returns an exit code when the
 * Coordinator did not start (after the shutdown path ran), otherwise the running handle.
 */
export async function runCoordinatorCli(options: RunOptions): Promise<number | RunningCoordinator> {
	const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text));
	const env = options.env ?? process.env;
	const config = readConfig(options.envFile, env, stderr);
	if (config === undefined) return EXIT.config;
	// Child processes (git, docker, Pi) get explicit environments; this is defense in depth.
	scrubSecrets(env);
	const log = options.createLog?.(config) ?? createLogger({ level: config.logLevel });
	log.info("coordinator_starting", { version: packageVersion(), ...describeConfig(config) });
	let starting: Promise<CoordinatorHandle> | undefined;
	const controller = createShutdownController({
		log,
		watchdogMs: options.watchdogMs ?? 30_000,
		...(options.exit === undefined ? {} : { exit: options.exit }),
		shutdown: async () => {
			const handle = await starting?.catch(() => undefined);
			await handle?.stop();
		},
	});
	if (options.processHandlers !== false) installProcessHandlers(controller, log);
	starting = options.start(config, { log });
	try {
		const handle = await starting;
		log.info("coordinator_running", { group: config.telegram.groupChatId, agents: config.agents.length });
		return { handle, shutdown: controller.trigger };
	} catch (error) {
		const code = startupExitCode(error);
		if (error instanceof ConfigError) stderr(formatConfigError(error));
		log.error("startup_failed", { error: errorSummary(error), code });
		await controller.trigger(code, "startup failed");
		return code;
	}
}

/** The parsed configuration, or undefined after printing its problems. */
export function readConfig(
	envFile: string | undefined,
	env: NodeJS.ProcessEnv | undefined,
	stderr: (text: string) => void,
): CoordinatorConfig | undefined {
	try {
		return loadCoordinatorConfig({
			...(envFile === undefined ? {} : { envFile }),
			...(env === undefined ? {} : { env }),
		});
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		stderr(formatConfigError(error));
		return undefined;
	}
}

function installProcessHandlers(controller: { trigger: Shutdown; install(): void }, log: Logger): void {
	controller.install();
	const fatal = (reason: string) => (error: unknown) => {
		log.error("fatal", { reason, error: errorSummary(error) });
		void controller.trigger(EXIT.fatal, reason);
	};
	process.on("unhandledRejection", fatal("unhandled_rejection"));
	process.on("uncaughtException", fatal("uncaught_exception"));
}

/** 2: configuration or a rejected bot token; 3: the data directory is locked by another live Coordinator. */
export function startupExitCode(error: unknown): number {
	if (error instanceof ConfigError) return EXIT.config;
	if (error instanceof TelegramError && error.kind === "unauthorized") return EXIT.config;
	if (error instanceof LockHeld) return EXIT.locked;
	return EXIT.fatal;
}

/** One line per problem: variable names and fixed messages only, never a value. */
export function formatConfigError(error: ConfigError): string {
	return `Configuration error:\n${error.problems.map((p) => `  ${p.variable}: ${p.message}`).join("\n")}\n`;
}
