/**
 * The watchdog's own configuration: only what it needs, nothing else (Deployment § Secrets: the model key, the
 * Telegram token and the GitHub token are held only in the Coordinator's memory).
 *
 *   PI_DATA_DIR              the Coordinator's data directory (its SQLite file and lock), resolved exactly as the
 *                            Coordinator resolves it, so the deployment marker is the launcher's
 *   TELEGRAM_GROUP_CHAT_ID   the group to freeze when a stop cannot be verified
 *   DOCKER_BIN               the Docker CLI (labelled containers)
 *   PI_RUNNER_ISOLATION      systemd (required on Linux: the Pi slice) or process (elsewhere: marked processes)
 *   PI_RUNNER_SLICE          the Pi slice; SYSTEMCTL_BIN the systemctl to ask for its control group
 *   LOG_LEVEL
 *
 * Every other variable is ignored, whatever its value: a missing or invalid bot token, model key or GitHub token is
 * nobody's concern here. An env file is read for these names only: its other lines (secrets, if it is the
 * Coordinator's file) are dropped before parsing and never reach `process.env` or this object. The deployment gives
 * the watchdog an env file of its own anyway (deploy/systemd/pi-durable-watchdog.service).
 */
import { homedir } from "node:os";
import {
	COMMAND_NAME,
	ConfigError,
	type ConfigProblem,
	dataDirFrom,
	type Env,
	isolationFrom,
	isolationProblem,
	LOG_LEVELS,
	nonEmpty,
	readEnvFileOnly,
	SLICE_NAME,
} from "../config/shared.ts";
import { deploymentId } from "../runner/argv.ts";
import type { LogLevel } from "../runtime/log.ts";

export type WatchdogConfig = {
	readonly dataDir: string;
	/** The deployment marker of the Pi processes (sha256 of the resolved data directory, as the launcher does). */
	readonly deployment: string;
	readonly groupChatId: number;
	readonly dockerBin: string;
	readonly isolation: "systemd" | "process";
	readonly slice: string;
	readonly systemctlBin: string;
	readonly logLevel: LogLevel;
};

/** The only variables the watchdog reads. */
export const WATCHDOG_VARIABLES = [
	"PI_DATA_DIR",
	"TELEGRAM_GROUP_CHAT_ID",
	"DOCKER_BIN",
	"PI_RUNNER_ISOLATION",
	"PI_RUNNER_SLICE",
	"SYSTEMCTL_BIN",
	"LOG_LEVEL",
] as const;

type Defaults = { readonly cwd: string; readonly home: string; readonly platform?: NodeJS.Platform };

function command(env: Env, name: string, fallback: string, problems: ConfigProblem[]): string {
	const value = nonEmpty(env[name]) ?? fallback;
	if (!COMMAND_NAME.test(value))
		problems.push({ variable: name, message: "an absolute path or a command name, without spaces or quotes" });
	return value;
}

function chatId(env: Env, problems: ConfigProblem[]): number {
	const raw = nonEmpty(env.TELEGRAM_GROUP_CHAT_ID);
	if (raw !== undefined && /^-[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
	problems.push({ variable: "TELEGRAM_GROUP_CHAT_ID", message: "required: the group's negative chat id" });
	return 0;
}

function isolation(env: Env, platform: NodeJS.Platform, problems: ConfigProblem[]): WatchdogConfig["isolation"] {
	const value = isolationFrom(env.PI_RUNNER_ISOLATION, platform);
	const problem = isolationProblem(value, platform);
	if (problem !== undefined) problems.push(problem);
	return value as WatchdogConfig["isolation"];
}

function slice(env: Env, problems: ConfigProblem[]): string {
	const value = nonEmpty(env.PI_RUNNER_SLICE) ?? "pi-durable-runs.slice";
	if (!SLICE_NAME.test(value) || value.length > 128)
		problems.push({ variable: "PI_RUNNER_SLICE", message: "a slice name such as pi-durable-runs.slice" });
	return value;
}

function logLevel(env: Env, problems: ConfigProblem[]): LogLevel {
	const value = nonEmpty(env.LOG_LEVEL) ?? "info";
	if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
	problems.push({ variable: "LOG_LEVEL", message: "debug, info, warn or error" });
	return "info";
}

/** Parse the watchdog's variables (only those); throws ConfigError listing every problem, never a value. */
export function parseWatchdogConfig(
	env: Env,
	defaults: Defaults = { cwd: process.cwd(), home: homedir() },
): WatchdogConfig {
	const problems: ConfigProblem[] = [];
	const dataDir = dataDirFrom(env.PI_DATA_DIR, defaults);
	const config: WatchdogConfig = {
		dataDir,
		deployment: deploymentId(dataDir),
		groupChatId: chatId(env, problems),
		dockerBin: command(env, "DOCKER_BIN", "docker", problems),
		isolation: isolation(env, defaults.platform ?? process.platform, problems),
		slice: slice(env, problems),
		systemctlBin: command(env, "SYSTEMCTL_BIN", "systemctl", problems),
		logLevel: logLevel(env, problems),
	};
	if (problems.length > 0) throw new ConfigError(problems);
	return config;
}

/**
 * The watchdog's variables from `env` (they win) and the optional env file: only WATCHDOG_VARIABLES are taken from
 * the file; nothing is written to `env`.
 */
export function loadWatchdogConfig(
	options: {
		readonly envFile?: string;
		readonly env?: Env;
		/** TEST ONLY: platform policy under test; production always uses process.platform. Never read from env/CLI. */
		readonly platform?: NodeJS.Platform;
	} = {},
): WatchdogConfig {
	const env = options.env ?? process.env;
	const picked: Record<string, string | undefined> = {};
	const file = options.envFile === undefined ? {} : readEnvFileOnly(options.envFile, WATCHDOG_VARIABLES);
	if (file === undefined)
		throw new ConfigError([{ variable: "--env-file", message: `${options.envFile}: cannot be read` }]);
	for (const name of WATCHDOG_VARIABLES) picked[name] = env[name] ?? file[name];
	return parseWatchdogConfig(picked, { cwd: process.cwd(), home: homedir(), platform: options.platform });
}
