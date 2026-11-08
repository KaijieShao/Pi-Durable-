/**
 * TEST ONLY: real CLI parser/implementation in a separate process, with the Mac process-policy injected in code.
 * Portable process-reaper/lease/crash tests use this entry; it does not verify real Linux slice isolation.
 * Production main.ts never sets this option, and no environment or product CLI flag can set it.
 */
import { parseArgs } from "../../src/cli/args.ts";
import { runWatchdogCli } from "../../src/cli/watchdog.ts";
import { errorSummary } from "../../src/runtime/log.ts";

const args = parseArgs(process.argv.slice(2));
if (args.command !== "watchdog") throw new Error("test fixture expects watchdog arguments");
try {
	const result = await runWatchdogCli({ envFile: args.envFile, platform: "darwin" });
	if (typeof result === "number") process.exitCode = result;
} catch (error) {
	process.stderr.write(`Fatal: ${errorSummary(error)}\n`);
	process.exitCode = 1;
}
