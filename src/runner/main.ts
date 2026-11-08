/**
 * Entry point of the Pi process: one process per run, started by the Coordinator with a minimal environment. Two
 * transports (src/runner/argv.ts `--transport=`):
 *
 *   ipc    (default; "process" isolation, src/coordinator/runner-launcher.ts): a forked child with a Node IPC channel
 *          (src/runner/protocol.ts). The run key arrives only as OPENAI_API_KEY; it is captured and removed from the
 *          environment at once. Stdout carries only `@pi-runner {json}` metadata lines.
 *   stdio  ("systemd" isolation, src/coordinator/runner-systemd.ts): newline-delimited JSON frames on stdin/stdout
 *          (src/runner/frames.ts). The run key is the FIRST stdin frame, never argv or environment (an
 *          OPENAI_API_KEY in the environment is removed and ignored). Stdout carries only frames: anything else
 *          written to it is redirected to stderr.
 *
 * Stderr only on a crash (the error's name, never its text). The process exits on its own: after `finished`, when
 * the channel to the Coordinator closes (IPC disconnect, stdin end), and, independently of the Coordinator's
 * watchdog, `deadlineMs` + 30 s after the start message.
 *
 * Environment: HOME (an empty private directory), PATH, NODE_NO_WARNINGS, OPENAI_API_KEY (ipc only), and for tests
 * only PI_RUNNER_TEST_FAST_RETRY=1 (Pi retry backoff 20 ms instead of 2 s).
 */
import { parseRunnerArgv, type RunnerArgs } from "./argv.ts";
import { encodeFrame, keyFromFrame, readFrames } from "./frames.ts";
import type { RunController, RunnerIo } from "./harness.ts";
import type { FromRunner, RunnerStart, ToRunner } from "./protocol.ts";

/** Grace past the run deadline before the process exits by itself. */
const SELF_EXIT_GRACE_MS = 30_000;
/** Bound for the best-effort abort before a forced exit (disconnect, deadline, crash). */
const FORCED_EXIT_ABORT_MS = 5_000;

type NoteFields = Readonly<Record<string, string | number | boolean>>;

/** How the process talks to the Coordinator. */
type Transport = {
	/** The run key, once received. */
	key(): string | undefined;
	send(message: FromRunner): Promise<void>;
	note(event: string, fields?: NoteFields): void;
	/** Deliver incoming messages; `onClose` when the Coordinator is gone; `onFatal` on a protocol violation. */
	listen(onMessage: (message: unknown) => void, onClose: () => void, onFatal: (event: string) => void): void;
};

const envKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;
const fastRetry = process.env.PI_RUNNER_TEST_FAST_RETRY === "1";
const parsedArgs = parseRunnerArgv(process.argv.slice(2));
if (typeof parsedArgs === "string") {
	process.stderr.write(`pi-runner: ${parsedArgs}\n`);
	process.exit(1);
}
const args: RunnerArgs = parsedArgs;

let controller: RunController | undefined;
let started = false;
let exiting = false;
/** Exit code of a forced stop (disconnect 1, deadline 2); it wins over the run's own code. */
let forcedCode: number | undefined;
/** Messages that arrived before the run controller existed (Node delivers them once a listener is attached). */
const early: ToRunner[] = [];

const transport: Transport = args.transport === "stdio" ? stdioTransport() : ipcTransport(envKey);
const io: RunnerIo = { send: (message) => transport.send(message), note: (event, fields) => note(event, fields) };

transport.listen(onMessage, onClose, (event) => {
	note(event);
	exit(1);
});

process.on("uncaughtException", (error) => crash(error));
process.on("unhandledRejection", (error) => crash(error));

function ipcTransport(apiKey: string | undefined): Transport {
	return {
		key: () => apiKey,
		send: (message) =>
			new Promise<void>((resolve) => {
				if (!process.connected || process.send === undefined) {
					resolve();
					return;
				}
				try {
					process.send(message, undefined, undefined, () => resolve());
				} catch {
					resolve();
				}
			}),
		note(event, fields) {
			try {
				process.stdout.write(`@pi-runner ${JSON.stringify({ event, ...fields })}\n`);
			} catch {
				// stdout closed: metadata is optional.
			}
		},
		listen(onIncoming, onGone) {
			process.on("message", onIncoming);
			process.on("disconnect", onGone);
		},
	};
}

function stdioTransport(): Transport {
	const stdout = process.stdout;
	const writeFrame = stdout.write.bind(stdout);
	// Stdout carries only frames: anything else (a dependency's console.log) goes to stderr instead.
	stdout.write = process.stderr.write.bind(process.stderr) as typeof stdout.write;
	let apiKey: string | undefined;
	let closed = false;
	const frame = (value: object): Promise<void> =>
		new Promise<void>((resolve) => {
			if (closed) {
				resolve();
				return;
			}
			try {
				writeFrame(encodeFrame(value), () => resolve());
			} catch {
				resolve();
			}
		});
	return {
		key: () => apiKey,
		send: (message) => frame(message),
		note(event, fields) {
			void frame({ ...fields, type: "note", event });
		},
		listen(onIncoming, onGone, onFatal) {
			stdout.on("error", () => {
				closed = true;
				onGone();
			});
			let keyed = false;
			readFrames(process.stdin, {
				frame(value) {
					if (keyed) {
						onIncoming(value);
						return;
					}
					// The first frame is the run key and nothing else.
					keyed = true;
					apiKey = keyFromFrame(value);
					if (apiKey === undefined) onFatal("runner_missing_key");
				},
				invalid: (kind) => note("runner_bad_frame", { kind }),
				end: () => onGone(),
			});
		},
	};
}

function onMessage(message: unknown): void {
	if (typeof message !== "object" || message === null || typeof (message as { type?: unknown }).type !== "string") {
		note("runner_bad_message");
		return;
	}
	const typed = message as ToRunner;
	if (typed.type === "start") {
		if (started) {
			note("runner_duplicate_start");
			return;
		}
		started = true;
		void begin(typed);
		return;
	}
	if (controller === undefined) early.push(typed);
	else dispatch(controller, typed);
}

function onClose(): void {
	// The Coordinator is gone: nobody serves tool calls or receives reports. Stop and exit; recovery takes over.
	if (exiting) return;
	note("runner_disconnected");
	void forcedExit("coordinator disconnected", 1);
}

async function begin(raw: unknown): Promise<void> {
	const start = parseStart(raw);
	if (typeof start === "string") {
		note("runner_invalid_start");
		await io.send({ type: "finished", outcome: "failed", reason: start, delivered: [], unconsumed: [], answered: [] });
		exit(1);
		return;
	}
	const deadline = setTimeout(() => {
		note("runner_deadline_exit");
		void forcedExit("run deadline passed", 2);
	}, start.limits.deadlineMs + SELF_EXIT_GRACE_MS);
	deadline.unref();
	const { RunController } = await import("./harness.ts");
	const run = new RunController(start, io, {
		apiKey: transport.key(),
		fastRetry,
		sharedStore: args.conversationAccess === "group",
	});
	controller = run;
	for (const message of early.splice(0)) dispatch(run, message);
	const code = await run.run();
	exit(code);
}

function dispatch(run: RunController, message: ToRunner): void {
	switch (message.type) {
		case "steer":
			run.steer(message.requestId, message.content);
			return;
		case "tool_result":
			run.toolResult(message.id, message.result);
			return;
		case "abort":
			void run.abort(typeof message.reason === "string" ? message.reason : "aborted");
			return;
		case "cap_reached":
			run.capReached();
			return;
		default:
			note("runner_unknown_message");
	}
}

async function forcedExit(reason: string, code: number): Promise<void> {
	if (exiting || forcedCode !== undefined) return;
	forcedCode = code;
	// Also the code if the event loop drains first (the timers here are unreferenced).
	process.exitCode = code;
	const run = controller;
	if (run !== undefined) {
		const stopped = Promise.race([run.abort(reason).then(() => run.done), sleep(FORCED_EXIT_ABORT_MS)]);
		await stopped.catch(() => undefined);
	}
	exit(code);
}

function crash(error: unknown): void {
	const name = error instanceof Error ? error.name : typeof error;
	process.exitCode = 1;
	try {
		process.stderr.write(`pi-runner crash: ${name}\n`);
	} catch {
		// Nothing left to report to.
	}
	note("runner_crash", { error: name });
	void io.send({ type: "error", message: `runner crashed (${name})` }).finally(() => exit(1));
	setTimeout(() => exit(1), 1000).unref();
}

function exit(code: number): void {
	if (exiting) return;
	exiting = true;
	const final = forcedCode ?? code;
	process.exitCode = final;
	// The last message was flushed (send resolves on its callback); exit now so no timer or handle keeps us alive.
	setImmediate(() => process.exit(final));
}

/** One metadata line (ipc) or note frame (stdio) with primitive fields only. */
function note(event: string, fields?: NoteFields): void {
	transport.note(event, fields);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

// biome-ignore lint/suspicious/noExplicitAny: untrusted JSON being shape-checked
type Loose = any;

const isString = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown, min: number): boolean =>
	typeof value === "number" && Number.isInteger(value) && value >= min;
const isObject = (value: unknown): boolean => typeof value === "object" && value !== null;
const isInput = (value: Loose): boolean => isObject(value) && isString(value.content) && isString(value.requestId);

/** Shape rules of the start message, in order; the first that fails names the problem. */
const START_RULES: readonly (readonly [(start: Loose) => boolean, string])[] = [
	[(start) => isCount(start.runId, 0) && isCount(start.taskId, 0), "invalid run or task id"],
	[(start) => args.runId === undefined || start.runId === args.runId, "run id does not match the process marker"],
	[
		(start) => isString(start.conversationPath) && start.conversationPath.startsWith("/"),
		"conversationPath must be absolute",
	],
	[(start) => typeof start.fresh === "boolean", "fresh must be a boolean"],
	[(start) => isObject(start.model), "model missing"],
	[
		(start) =>
			isString(start.model.modelId) && isString(start.model.thinkingLevel) && isString(start.model.relayBaseUrl),
		"invalid model",
	],
	[(start) => typeof start.model.codexGateway === "boolean", "invalid model.codexGateway"],
	[(start) => isInput(start.input) && start.input.content !== "", "invalid input"],
	[(start) => Array.isArray(start.steers) && start.steers.every(isInput), "invalid steers"],
	[(start) => isString(start.instructions), "invalid instructions"],
	[(start) => isObject(start.limits), "limits missing"],
	[
		(start) =>
			isCount(start.limits.maxRetries, 0) &&
			isCount(start.limits.toolResultBytes, 256) &&
			isCount(start.limits.deadlineMs, 1),
		"invalid limits",
	],
	[(start) => Array.isArray(start.checkOps) && start.checkOps.every(isString), "invalid checkOps"],
];

/** Shape check of the start message; returns the reason when it is unusable. */
function parseStart(raw: unknown): RunnerStart | string {
	if (!isObject(raw)) return "invalid start message";
	const broken = START_RULES.find(([holds]) => !holds(raw));
	return broken === undefined ? (raw as RunnerStart) : `start message: ${broken[1]}`;
}
