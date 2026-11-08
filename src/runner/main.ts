/**
 * Entry point of the Pi process: one process per run, forked by the Coordinator (src/coordinator/runner-launcher.ts)
 * with a minimal environment and a Node IPC channel (src/runner/protocol.ts). The run key arrives only as
 * OPENAI_API_KEY; it is captured and removed from the environment at once. Nothing is written to stdout except
 * `@pi-runner {json}` metadata lines; stderr only on a crash (the error's name, never its text).
 *
 * The process exits on its own: after `finished`, when the IPC channel to the Coordinator closes, and, independently of
 * the Coordinator's watchdog, `deadlineMs` + 30 s after the start message.
 *
 * Environment: OPENAI_API_KEY (the run key), HOME (an empty private directory), PATH, NODE_NO_WARNINGS, and for tests
 * only PI_RUNNER_TEST_FAST_RETRY=1 (Pi retry backoff 20 ms instead of 2 s).
 */
import type { RunController, RunnerIo } from "./harness.ts";
import type { FromRunner, RunnerStart, ToRunner } from "./protocol.ts";

/** Grace past the run deadline before the process exits by itself. */
const SELF_EXIT_GRACE_MS = 30_000;
/** Bound for the best-effort abort before a forced exit (disconnect, deadline, crash). */
const FORCED_EXIT_ABORT_MS = 5_000;

const apiKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;
const fastRetry = process.env.PI_RUNNER_TEST_FAST_RETRY === "1";

let controller: RunController | undefined;
let started = false;
let exiting = false;
/** Exit code of a forced stop (disconnect 1, deadline 2); it wins over the run's own code. */
let forcedCode: number | undefined;
/** Messages that arrived before the run controller existed (Node delivers them once a listener is attached). */
const early: ToRunner[] = [];

const io: RunnerIo = {
	send: (message: FromRunner) =>
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
	note: (event, fields) => note(event, fields),
};

process.on("message", (message: unknown) => {
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
});

process.on("disconnect", () => {
	// The Coordinator is gone: nobody serves tool calls or receives reports. Stop and exit; recovery takes over.
	if (exiting) return;
	note("runner_disconnected");
	void forcedExit("coordinator disconnected", 1);
});

process.on("uncaughtException", (error) => crash(error));
process.on("unhandledRejection", (error) => crash(error));

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
	const run = new RunController(start, io, { apiKey, fastRetry });
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

/** One metadata line: `@pi-runner {"event":...}` with primitive fields only. */
function note(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void {
	try {
		process.stdout.write(`@pi-runner ${JSON.stringify({ event, ...fields })}\n`);
	} catch {
		// stdout closed: metadata is optional.
	}
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
