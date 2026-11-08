/** One owner command and its arguments (sent to the running Coordinator over its owner socket). */
export type OwnerInvocation =
	| { readonly action: "status" }
	/** `group`: the group chat id; the configured TELEGRAM_GROUP_CHAT_ID when omitted. */
	| { readonly action: "unfreeze"; readonly group?: number }
	| { readonly action: "resolve"; readonly intents: readonly number[] }
	| { readonly action: "failed-events" }
	| { readonly action: "conversations"; readonly task?: number }
	| { readonly action: "inspect"; readonly conversation: string }
	/** `group` as for unfreeze; `trial`: --trial <id>; `tasks`: --tasks <id,id,...> (the trial's tasks). */
	| {
			readonly action: "seal";
			readonly group?: number;
			readonly trial?: string;
			readonly tasks?: readonly number[];
	  };

export type OwnerAction = OwnerInvocation["action"];

export const OWNER_ACTIONS: readonly OwnerAction[] = [
	"status",
	"unfreeze",
	"resolve",
	"failed-events",
	"conversations",
	"inspect",
	"seal",
];

export type CliArgs =
	| { readonly command: "run"; readonly envFile?: string }
	| { readonly command: "watchdog"; readonly envFile?: string }
	| ({ readonly command: "owner"; readonly envFile?: string } & OwnerInvocation)
	| { readonly command: "help" }
	| { readonly command: "version" }
	| { readonly command: "invalid"; readonly message: string };

/**
 * Parse `run [--env-file p]`, `watchdog [--env-file p]`, `owner <command> [args] [--env-file p]` (OWNER_USAGE),
 * `--help`, `--version`.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
	const rest = [...argv];
	if (rest.length === 0 || rest.includes("--help") || rest.includes("-h")) return { command: "help" };
	if (rest.includes("--version") || rest.includes("-v")) return { command: "version" };
	const envFile = takeOption(rest, "--env-file");
	if (envFile === null) return { command: "invalid", message: "--env-file needs a path" };
	const seal = sealOptions(rest);
	if (typeof seal === "string") return { command: "invalid", message: seal };
	// A negative number is an argument (a group chat id), not an option.
	const unknown = rest.find((arg) => arg.startsWith("-") && !/^-\d+$/.test(arg));
	if (unknown !== undefined) return { command: "invalid", message: `unknown option: ${unknown}` };
	return withSealOptions(parseCommand(rest, envFile === undefined ? {} : { envFile }), seal);
}

/** The seal options belong to `owner seal` only. */
function withSealOptions(parsed: CliArgs, seal: { trial?: string; tasks?: number[] }): CliArgs {
	if (Object.keys(seal).length === 0) return parsed;
	if (parsed.command !== "owner" || parsed.action !== "seal")
		return { command: "invalid", message: "--trial and --tasks go with owner seal only" };
	return { ...parsed, ...seal };
}

const TRIAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `--trial <id>` and `--tasks <id,id,...>` (owner seal), taken out of `args`; a string is the problem. */
function sealOptions(args: string[]): { trial?: string; tasks?: number[] } | string {
	const trial = takeOption(args, "--trial");
	const tasks = takeOption(args, "--tasks");
	if (trial === null || (trial !== undefined && !TRIAL.test(trial)))
		return "--trial needs a trial id (letters, digits, '.', '_' or '-'; at most 64)";
	const ids = tasks?.split(",").map((part) => part.trim());
	if (tasks === null || (ids !== undefined && !ids.every((id) => POSITIVE.test(id))))
		return "--tasks needs task numbers separated by commas, e.g. --tasks 3,4";
	return {
		...(trial === undefined ? {} : { trial }),
		...(ids === undefined ? {} : { tasks: ids.map(Number) }),
	};
}

function parseCommand(rest: readonly string[], withFile: { envFile?: string }): CliArgs {
	const [command, ...positional] = rest;
	if (command === "run" && positional.length === 0) return { command: "run", ...withFile };
	if (command === "watchdog" && positional.length === 0) return { command: "watchdog", ...withFile };
	if (command === "owner") {
		const invocation = parseOwner(positional);
		if (invocation !== undefined) return { command: "owner", ...invocation, ...withFile };
		return { command: "invalid", message: `usage:\n${OWNER_USAGE}` };
	}
	return { command: "invalid", message: `unknown command: ${rest.join(" ")}` };
}

const POSITIVE = /^[1-9]\d{0,15}$/;
const CHAT_ID = /^-?[1-9]\d{0,15}$/;
const CONVERSATION = /^[A-Za-z0-9-]{1,64}$/;

type OwnerParser = (args: readonly string[]) => OwnerInvocation | undefined;

/** No argument → `none`; one that matches `pattern` → `make(it)`; anything else → undefined. */
function optionalArg(
	args: readonly string[],
	pattern: RegExp,
	none: OwnerInvocation,
	make: (arg: string) => OwnerInvocation,
): OwnerInvocation | undefined {
	if (args.length === 0) return none;
	const [first] = args;
	return args.length === 1 && first !== undefined && pattern.test(first) ? make(first) : undefined;
}

const OWNER_PARSERS: Readonly<Record<OwnerAction, OwnerParser>> = {
	status: (args) => (args.length === 0 ? { action: "status" } : undefined),
	unfreeze: (args) =>
		optionalArg(args, CHAT_ID, { action: "unfreeze" }, (group) => ({ action: "unfreeze", group: Number(group) })),
	resolve: (args) =>
		args.length > 0 && args.every((arg) => POSITIVE.test(arg))
			? { action: "resolve", intents: args.map(Number) }
			: undefined,
	"failed-events": (args) => (args.length === 0 ? { action: "failed-events" } : undefined),
	conversations: (args) =>
		optionalArg(args, POSITIVE, { action: "conversations" }, (task) => ({
			action: "conversations",
			task: Number(task),
		})),
	inspect: (args) => {
		const [id] = args;
		return args.length === 1 && id !== undefined && CONVERSATION.test(id)
			? { action: "inspect", conversation: id }
			: undefined;
	},
	seal: (args) => optionalArg(args, CHAT_ID, { action: "seal" }, (group) => ({ action: "seal", group: Number(group) })),
};

/** `owner <action> [args]`, or undefined when the arguments do not fit the action. */
function parseOwner(positional: readonly string[]): OwnerInvocation | undefined {
	const [action, ...args] = positional;
	if (action === undefined || !Object.hasOwn(OWNER_PARSERS, action)) return undefined;
	return OWNER_PARSERS[action as OwnerAction](args);
}

export const OWNER_USAGE = `  pi-durable-telegram owner status                     group state, slots, the watchdog, tasks, uncertain changes, disks
  pi-durable-telegram owner unfreeze [<group>]         repeat the recovery checks; unfreeze only if all pass
  pi-durable-telegram owner resolve <change>...        accept an unresolved file change as it is in the worktree
  pi-durable-telegram owner failed-events              Telegram messages that could not be delivered
  pi-durable-telegram owner conversations [<task>]     quarantined conversations
  pi-durable-telegram owner inspect <conversation>     a quarantined conversation's transcript, opened read-only
  pi-durable-telegram owner seal [<group>] [--trial <id>] [--tasks <id,...>]
                                                       trial harness: seal the group, grade a snapshot of main in
                                                       the isolated evaluator, then reopen dispatch
  (each with [--env-file <path>]; run as the Coordinator's user: it talks to <PI_DATA_DIR>/owner/owner.sock)`;

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
  pi-durable-telegram watchdog [--env-file <path>]               run the watchdog (start it before the Coordinator)
${OWNER_USAGE}
  pi-durable-telegram --help | --version

Configuration comes from the environment (and the optional env file; real variables win).
See .env.example, RUN-LOCAL.md and docs/configuration.md.`;
