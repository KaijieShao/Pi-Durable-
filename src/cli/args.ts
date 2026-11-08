export type CliArgs =
	| { readonly command: "run"; readonly envFile?: string }
	| { readonly command: "login"; readonly provider: string; readonly envFile?: string }
	| { readonly command: "help" }
	| { readonly command: "version" }
	| { readonly command: "invalid"; readonly message: string };

/** Parse `run [--env-file p]`, `login <provider> [--env-file p]`, `--help`, `--version`. */
export function parseArgs(argv: readonly string[]): CliArgs {
	const rest = [...argv];
	if (rest.length === 0 || rest.includes("--help") || rest.includes("-h")) return { command: "help" };
	if (rest.includes("--version") || rest.includes("-v")) return { command: "version" };
	const envFile = takeOption(rest, "--env-file");
	if (envFile === null) return { command: "invalid", message: "--env-file needs a path" };
	return parseCommand(rest, envFile === undefined ? {} : { envFile });
}

function parseCommand(rest: readonly string[], withFile: { envFile?: string }): CliArgs {
	const [command, ...positional] = rest;
	if (command === "run" && positional.length === 0) return { command: "run", ...withFile };
	if (command === "login" && positional.length === 1)
		return { command: "login", provider: positional[0] ?? "", ...withFile };
	if (command === "login") return { command: "invalid", message: "usage: login <provider>, e.g. login anthropic" };
	return { command: "invalid", message: `unknown command: ${rest.join(" ")}` };
}

/** Remove `--name value` or `--name=value` from `args`; null when the value is missing. */
function takeOption(args: string[], name: string): string | undefined | null {
	const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
	if (index < 0) return undefined;
	const arg = args[index] ?? "";
	if (arg.includes("=")) {
		args.splice(index, 1);
		return arg.slice(name.length + 1) || null;
	}
	const value = args[index + 1];
	args.splice(index, 2);
	return value === undefined || value.startsWith("--") ? null : value;
}

export const USAGE = `pi-durable-telegram: a durable personal coding agent in Telegram

Usage:
  pi-durable-telegram run [--env-file <path>]               run the bot (long polling)
  pi-durable-telegram login <provider> [--env-file <path>]  sign in, e.g. login anthropic
  pi-durable-telegram --help | --version

Configuration comes from the environment (and the optional env file); see README.`;
