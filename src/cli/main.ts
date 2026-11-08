#!/usr/bin/env node
import { errorSummary } from "../runtime/log.ts";
import { packageVersion } from "../runtime/version.ts";
import { parseArgs, USAGE } from "./args.ts";
import { runCoordinatorCli, type StartCoordinator } from "./run.ts";

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
		case "owner": {
			const { runOwnerCommand } = await import("./owner.ts");
			const { command: _command, envFile, ...invocation } = args;
			return runOwnerCommand(invocation, { envFile });
		}
		case "watchdog": {
			// Its own minimal configuration: no Coordinator configuration and no secret is ever loaded here.
			const { runWatchdogCli } = await import("./watchdog.ts");
			const result = await runWatchdogCli({ envFile: args.envFile });
			return typeof result === "number" ? result : undefined;
		}
		default: {
			// Loaded on demand, after the configuration parsed: --help and the owner CLI never load the runtime.
			const start: StartCoordinator = async (config, deps) =>
				(await import("../coordinator/coordinator.ts")).startCoordinator(config, deps);
			const result = await runCoordinatorCli({ envFile: args.envFile, start });
			return typeof result === "number" ? result : undefined;
		}
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		if (code !== undefined) process.exitCode = code;
	},
	(error: unknown) => {
		// The first line of the message, redacted; never a stack (it may carry URLs or values).
		process.stderr.write(`Fatal: ${errorSummary(error)}\n`);
		process.exitCode = 1;
	},
);
