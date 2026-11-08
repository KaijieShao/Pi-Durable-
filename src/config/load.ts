import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { piAgentDir, piDefaultsEnv, withPiDefaults } from "./pi-home.ts";
import { type Config, ConfigError, parseConfig } from "./schema.ts";

/**
 * Load an optional env file into `process.env` (real environment wins), fill unset `PI_PROVIDER`, `PI_MODEL` and
 * `PI_THINKING` from pi's settings, parse it, and check the paths that must exist. Throws `ConfigError` with every
 * problem.
 */
export async function loadConfig(options: { envFile?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Config> {
	const env = options.env ?? process.env;
	if (options.envFile !== undefined) loadEnvFile(options.envFile, env);
	const config = parseConfig(withPiDefaults(env, piDefaultsEnv(piAgentDir(env))));
	await checkWorkdir(config.workdir);
	return config;
}

function loadEnvFile(path: string, env: NodeJS.ProcessEnv): void {
	try {
		if (env === process.env) process.loadEnvFile(path);
		else {
			const parsed = parseEnvText(readFileSync(path, "utf8"));
			for (const [key, value] of Object.entries(parsed)) env[key] ??= value;
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const reason = code === "ENOENT" ? "file not found" : "cannot be read";
		throw new ConfigError([{ variable: "--env-file", message: `${path}: ${reason}` }]);
	}
}

/** Minimal KEY=VALUE parser for env files read into a non-process env (tests). */
export function parseEnvText(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
		if (match === null) continue;
		const raw = match[2] ?? "";
		out[match[1] ?? ""] = raw.replace(/^(['"])(.*)\1$/, "$2");
	}
	return out;
}

async function checkWorkdir(workdir: string): Promise<void> {
	const info = await stat(workdir).catch(() => undefined);
	if (info?.isDirectory() !== true) {
		throw new ConfigError([{ variable: "PI_WORKDIR", message: `${workdir} is not an existing directory` }]);
	}
}
