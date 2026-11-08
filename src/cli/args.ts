export type OwnerAction = "status" | "unfreeze" | "failed-events";

export const OWNER_ACTIONS: readonly OwnerAction[] = ["status", "unfreeze", "failed-events"];

export type CliArgs =
	| { readonly command: "run"; readonly envFile?: string }
	| { readonly command: "owner"; readonly action: OwnerAction; readonly envFile?: string }
	| { readonly command: "help" }
	| { readonly command: "version" }
	| { readonly command: "invalid"; readonly message: string };

/** Parse `run [--env-file p]`, `owner status|unfreeze|failed-events [--env-file p]`, `--help`, `--version`. */
export function parseArgs(argv: readonly string[]): CliArgs {
	const rest = [...argv];
	if (rest.length === 0 || rest.includes("--help") || rest.includes("-h")) return { command: "help" };
	if (rest.includes("--version") || rest.includes("-v")) return { command: "version" };
	const envFile = takeOption(rest, "--env-file");
	if (envFile === null) return { command: "invalid", message: "--env-file needs a path" };
	const unknown = rest.find((arg) => arg.startsWith("-"));
	if (unknown !== undefined) return { command: "invalid", message: `unknown option: ${unknown}` };
	return parseCommand(rest, envFile === undefined ? {} : { envFile });
}

function parseCommand(rest: readonly string[], withFile: { envFile?: string }): CliArgs {
	const [command, ...positional] = rest;
	if (command === "run" && positional.length === 0) return { command: "run", ...withFile };
	if (command === "owner") {
		const action = OWNER_ACTIONS.find((each) => each === positional[0]);
		if (action !== undefined && positional.length === 1) return { command: "owner", action, ...withFile };
		return { command: "invalid", message: `usage: owner ${OWNER_ACTIONS.join("|")} [--env-file <path>]` };
	}
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

export const USAGE = `pi-durable-telegram: a multi-user Telegram group Coordinator for Pi Durable coding agents

Usage:
  pi-durable-telegram run [--env-file <path>]                    run the Coordinator (long polling)
  pi-durable-telegram owner status [--env-file <path>]           group state, tasks and execution slots
  pi-durable-telegram owner unfreeze [--env-file <path>]         unfreeze the group after you resolved the cause
  pi-durable-telegram owner failed-events [--env-file <path>]    Telegram messages that could not be delivered
  pi-durable-telegram --help | --version

Configuration comes from the environment (and the optional env file; real variables win).
See .env.example, RUN-LOCAL.md and docs/configuration.md.`;
