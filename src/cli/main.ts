#!/usr/bin/env node
import { createAuthContext } from "../agent/models.ts";
import { loadConfig } from "../config/load.ts";
import { ConfigError } from "../config/schema.ts";
import { scrubSecrets } from "../config/scrub.ts";
import { createLogger } from "../runtime/log.ts";
import { packageVersion } from "../runtime/version.ts";
import { parseArgs, USAGE } from "./args.ts";
import { runLogin } from "./login.ts";
import { runDaemon } from "./run.ts";

async function main(argv: readonly string[]): Promise<number | undefined> {
	const args = parseArgs(argv);
	switch (args.command) {
		case "help":
			process.stdout.write(`${USAGE}\n`);
			return 0;
		case "version":
			process.stdout.write(`${packageVersion()}\n`);
			return 0;
		case "invalid":
			process.stderr.write(`${args.message}\n\n${USAGE}\n`);
			return 2;
		case "login":
			if (args.envFile !== undefined && !loadEnvFile(args.envFile)) return 2;
			return runLogin(args.provider);
		default:
			return run(args.envFile);
	}
}

async function run(envFile: string | undefined): Promise<number | undefined> {
	let config: Awaited<ReturnType<typeof loadConfig>>;
	try {
		config = await loadConfig(envFile === undefined ? {} : { envFile });
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		process.stderr.write(`Configuration error:\n${error.message}\n`);
		return 2;
	}
	const pluginEnv = { ...process.env };
	const secrets = scrubSecrets(process.env);
	const log = createLogger({ level: config.logLevel });
	await runDaemon(config, { log, authContext: createAuthContext(secrets), pluginEnv });
	return undefined;
}

function loadEnvFile(path: string): boolean {
	try {
		process.loadEnvFile(path);
		return true;
	} catch {
		process.stderr.write(`--env-file: cannot read ${path}\n`);
		return false;
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		if (code !== undefined) process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`Fatal: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`);
		process.exitCode = 1;
	},
);
