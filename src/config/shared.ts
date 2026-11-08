/**
 * Configuration pieces shared by the Coordinator's parser (src/coordinator/config.ts) and the watchdog's own minimal
 * one (src/watchdog/config.ts), so both derive the same data directory (and with it the deployment marker of
 * src/runner/argv.ts) and the same Pi isolation from the same variables. No dependencies on purpose: the watchdog
 * loads nothing of the Coordinator's model or Telegram code.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";

export type ConfigProblem = { readonly variable: string; readonly message: string };

/** Every problem found, one per line; never carries a secret value. */
export class ConfigError extends Error {
	readonly problems: readonly ConfigProblem[];
	constructor(problems: readonly ConfigProblem[]) {
		super(problems.map((p) => `${p.variable}: ${p.message}`).join("\n"));
		this.name = "ConfigError";
		this.problems = problems;
	}
}

export type Env = Readonly<Record<string, string | undefined>>;

/** A slice name: dash-separated parts (systemd reads them as the slice hierarchy), never the root slice. */
export const SLICE_NAME = /^[A-Za-z0-9_]+(-[A-Za-z0-9_]+)*\.slice$/;
/** A command: an absolute path, or a name looked up on PATH. */
export const COMMAND_NAME = /^(\/[\w./@+-]+|[\w.+-]+)$/;
export const ISOLATIONS = ["systemd", "process"] as const;
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** The value of PI_DATA_DIR, absolute: default `~/.local/state/pi-durable-coordinator`, relative from `cwd`. */
export function dataDirFrom(
	value: string | undefined,
	defaults: { readonly cwd: string; readonly home: string },
): string {
	const path = nonEmpty(value) ?? join(defaults.home, ".local", "state", "pi-durable-coordinator");
	return isAbsolute(path) ? resolve(path) : resolve(defaults.cwd, path);
}

/** The value of PI_RUNNER_ISOLATION, or its default: systemd on Linux, process elsewhere. */
export function isolationFrom(value: string | undefined, platform: NodeJS.Platform): string {
	return nonEmpty(value) ?? (platform === "linux" ? "systemd" : "process");
}

/** The same fail-closed policy at parse time and at production factories, including prebuilt config objects. */
export function isolationProblem(value: string, platform: NodeJS.Platform): ConfigProblem | undefined {
	const message = !(ISOLATIONS as readonly string[]).includes(value)
		? "systemd or process"
		: platform === "linux" && value !== "systemd"
			? "Linux requires systemd isolation in the Pi slice; process isolation is refused. Use PI_RUNNER_ISOLATION=systemd and complete the Linux host setup (docs/isolation.md)"
			: undefined;
	return message === undefined ? undefined : { variable: "PI_RUNNER_ISOLATION", message };
}

export function requireRunnerIsolation(value: string, platform: NodeJS.Platform = process.platform): void {
	const problem = isolationProblem(value, platform);
	if (problem !== undefined) throw new ConfigError([problem]);
}

/**
 * Only the variables `names` of an env file (KEY=value lines; `export KEY=value` too), or undefined when it cannot be
 * read. Lines of other variables are dropped before parsing, so their values never end up in the result.
 */
export function readEnvFileOnly(path: string, names: readonly string[]): Record<string, string> | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const wanted = new Set(names);
	const kept = text.split(/\r?\n/).filter((line) => {
		const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
		return name !== undefined && wanted.has(name);
	});
	const parsed = parseEnv(kept.join("\n")) as Record<string, string>;
	return Object.fromEntries(Object.entries(parsed).filter(([name]) => wanted.has(name)));
}
