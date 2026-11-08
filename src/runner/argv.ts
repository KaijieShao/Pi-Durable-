/**
 * Command-line arguments of the Pi process (src/runner/main.ts), shared by both launchers and the runner. None of
 * them is a secret: the run key never appears in argv (IPC transport: the environment; stdio transport: the first
 * stdin frame).
 *
 *   --transport=ipc|stdio          Node IPC (forked child, the local "process" mode) or newline-delimited JSON frames
 *                                  on stdin/stdout (systemd transient unit, see frames.ts). Default ipc.
 *   --conversation-access=private|group
 *                                  Mode of the conversation's SQLite files: 0600 (owner only, local mode) or 0660
 *                                  (owner and the shared group: the Pi user and the Coordinator user). Default private.
 *   --pi-durable-deployment=<id>   Marker: which deployment started this process (deploymentId of its data dir).
 *   --pi-durable-run=<runId>       Marker: which run this process serves; must match the start message.
 *
 * The markers let restart cleanup and the watchdog find Pi processes by their command line (`ps`) on a host without
 * the systemd slice, and tell this deployment's processes from any other's.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const TRANSPORT_FLAG = "--transport=";
export const ACCESS_FLAG = "--conversation-access=";
export const MARKER_DEPLOYMENT = "--pi-durable-deployment=";
export const MARKER_RUN = "--pi-durable-run=";

export type RunnerTransport = "ipc" | "stdio";
export type ConversationAccess = "private" | "group";

export type RunnerArgs = {
	readonly transport: RunnerTransport;
	readonly conversationAccess: ConversationAccess;
	readonly deployment: string | undefined;
	readonly runId: number | undefined;
};

const DEPLOYMENT = /^[0-9a-f]{16}$/;
const RUN_ID = /^(0|[1-9]\d{0,15})$/;

/** The deployment marker: the first 16 hex digits of sha256 of the resolved data directory (not a secret). */
export function deploymentId(dataDir: string): string {
	return createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 16);
}

/** The arguments after the runner's path. */
export function runnerArgv(args: RunnerArgs): string[] {
	const argv = [`${TRANSPORT_FLAG}${args.transport}`, `${ACCESS_FLAG}${args.conversationAccess}`];
	if (args.deployment !== undefined) argv.push(`${MARKER_DEPLOYMENT}${args.deployment}`);
	if (args.runId !== undefined) argv.push(`${MARKER_RUN}${args.runId}`);
	return argv;
}

type Parsed = { -readonly [K in keyof RunnerArgs]: RunnerArgs[K] };

/** Each flag: its prefix and how it sets its field; undefined from `set` means the value is invalid. */
const FLAGS: readonly (readonly [string, (value: string, into: Parsed) => true | undefined])[] = [
	[TRANSPORT_FLAG, (value, into) => (value === "ipc" || value === "stdio" ? set(into, "transport", value) : undefined)],
	[
		ACCESS_FLAG,
		(value, into) => (value === "private" || value === "group" ? set(into, "conversationAccess", value) : undefined),
	],
	[MARKER_DEPLOYMENT, (value, into) => (DEPLOYMENT.test(value) ? set(into, "deployment", value) : undefined)],
	[MARKER_RUN, (value, into) => (RUN_ID.test(value) ? set(into, "runId", Number(value)) : undefined)],
];

function set<K extends keyof Parsed>(into: Parsed, key: K, value: Parsed[K]): true {
	into[key] = value;
	return true;
}

/** The runner's arguments, or the problem: unknown, repeated or malformed arguments are refused. */
export function parseRunnerArgv(argv: readonly string[]): RunnerArgs | string {
	const parsed: Parsed = { transport: "ipc", conversationAccess: "private", deployment: undefined, runId: undefined };
	const seen = new Set<string>();
	for (const arg of argv) {
		const flag = FLAGS.find(([prefix]) => arg.startsWith(prefix));
		if (flag === undefined) return "unknown argument";
		if (seen.has(flag[0])) return `repeated argument ${flag[0].slice(0, -1)}`;
		seen.add(flag[0]);
		if (flag[1](arg.slice(flag[0].length), parsed) === undefined) return `invalid argument ${flag[0].slice(0, -1)}`;
	}
	return parsed;
}

/** True if a process command line carries this deployment's marker (and this run's, if given) as whole words. */
export function hasRunnerMarkers(command: string, deployment: string, runId?: number): boolean {
	const words = new Set(command.trim().split(/\s+/));
	if (!words.has(`${MARKER_DEPLOYMENT}${deployment}`)) return false;
	return runId === undefined || words.has(`${MARKER_RUN}${runId}`);
}

/** The run marker of a command line that carries this deployment's marker, if it has exactly one well-formed one. */
export function markedRunId(command: string, deployment: string): number | undefined {
	if (!hasRunnerMarkers(command, deployment)) return undefined;
	const runs = command
		.trim()
		.split(/\s+/)
		.filter((word) => word.startsWith(MARKER_RUN))
		.map((word) => word.slice(MARKER_RUN.length));
	const [only] = runs;
	return runs.length === 1 && only !== undefined && RUN_ID.test(only) ? Number(only) : undefined;
}
