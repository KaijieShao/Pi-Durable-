/**
 * The real Pi process (src/runner/main.ts), forked through the real launcher, against a fake OpenAI Responses
 * upstream on 127.0.0.1 (no relay in between). A test tool executor serves read/write/edit from a temp directory.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { RunLauncher, RunnerExit, RunnerHandle, RunnerRef } from "../../src/coordinator/ports.ts";
import { createRunLauncher } from "../../src/coordinator/runner-launcher.ts";
import { deploymentId } from "../../src/runner/argv.ts";
import { confinePath } from "../../src/runner/policy.ts";
import type { FromRunner, RunnerInput, RunnerStart, ToolResult } from "../../src/runner/protocol.ts";
import { type LogFields, silentLogger } from "../../src/runtime/log.ts";
import { sleep, waitFor } from "../helpers/env.ts";
import { FakeModel, type FakeRequest, type FakeStep } from "../helpers/fake-model.ts";

const RUN_KEY = "test-run-key-0123456789";
type Finished = Extract<FromRunner, { type: "finished" }>;
type ToolMessage = Extract<FromRunner, { type: "tool" }>;

let root: string;
let launcher: RunLauncher;
const fake = new FakeModel();
const notes: { event: string; fields: LogFields | undefined }[] = [];

before(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-runner-"));
	await fake.start();
	launcher = createRunLauncher({
		dataDir: join(root, "data"),
		log: { ...silentLogger, info: (event, fields) => notes.push({ event, fields }) },
		testEnv: { PI_RUNNER_TEST_FAST_RETRY: "1" },
	});
});

after(async () => {
	await fake.stop();
	await rm(root, { recursive: true, force: true });
});

type Run = {
	/** requestId of the run's own input. */
	readonly requestId: string;
	/** Path of the run's conversation file. */
	readonly conversation: string;
	readonly handle: RunnerHandle;
	readonly messages: FromRunner[];
	readonly tools: ToolMessage[];
	readonly finished: Promise<Finished>;
	readonly exited: Promise<RunnerExit>;
	readonly worktree: string;
	waitFor(predicate: (message: FromRunner) => boolean, what: string): Promise<FromRunner>;
	/** The run start as restart cleanup sees it. */
	ref(): RunnerRef;
};

let counter = 0;

/**
 * Launch one run. `onTool` may hold a tool call (return a promise) or answer it; by default calls are executed
 * against `worktree` at once.
 */
async function launch(options: {
	input: string;
	codexGateway?: boolean;
	steers?: RunnerInput[];
	conversation?: string;
	fresh?: boolean;
	worktree?: string;
	onTool?: (message: ToolMessage, run: Run) => Promise<ToolResult | undefined> | ToolResult | undefined;
}): Promise<Run> {
	const id = ++counter;
	const worktree = options.worktree ?? join(root, `worktree-${id}`);
	await mkdir(worktree, { recursive: true });
	const conversation = options.conversation ?? join(root, "data", "conversations", `conv-${id}.sqlite`);
	const start: RunnerStart = {
		type: "start",
		runId: id,
		taskId: 100 + id,
		conversationPath: conversation,
		fresh: options.fresh ?? true,
		model: {
			modelId: "gpt-4.1-mini",
			thinkingLevel: "off",
			relayBaseUrl: fake.url,
			codexGateway: options.codexGateway ?? false,
		},
		input: { content: options.input, requestId: `u${id}` },
		steers: options.steers ?? [],
		instructions: "You are agent alpha. Keep answers short.",
		limits: { maxRetries: 2, toolResultBytes: 16 * 1024, deadlineMs: 60_000 },
		checkOps: ["test", "lint"],
	};
	const messages: FromRunner[] = [];
	const tools: ToolMessage[] = [];
	let resolveFinished!: (message: Finished) => void;
	const finished = new Promise<Finished>((resolve) => {
		resolveFinished = resolve;
	});
	let run: Run | undefined;
	const handle = launcher.launch(
		start,
		RUN_KEY,
		(message) => {
			messages.push(message);
			if (message.type === "finished") resolveFinished(message);
			if (message.type === "tool") {
				tools.push(message);
				void (async () => {
					const custom = run === undefined ? undefined : await options.onTool?.(message, run);
					const result = custom ?? (await executeTool(worktree, message));
					handle.send({ type: "tool_result", id: message.id, result });
				})();
			}
		},
		{ generation: 1 },
	);
	const created: Run = {
		requestId: start.input.requestId,
		conversation,
		handle,
		messages,
		tools,
		finished,
		exited: handle.exited,
		worktree,
		waitFor: (predicate, what) =>
			waitFor(() => messages.find(predicate), { what, timeoutMs: 20_000 }) as Promise<FromRunner>,
		ref: () => ({ runId: start.runId, generation: 1, pid: handle.pid ?? null }),
	};
	run = created;
	return created;
}

/** The test's tool executor: confined read/write/edit in the worktree; run_check always passes. */
async function executeTool(worktree: string, message: ToolMessage): Promise<ToolResult> {
	if (message.name === "run_check") return { ok: true, text: `${String(message.args.operation)}: passed` };
	const path = confinePath(message.args.path);
	if (!path.ok) return { ok: false, text: `denied: ${path.reason}` };
	const file = join(worktree, path.path);
	try {
		if (message.name === "read") return { ok: true, text: await readFile(file, "utf8") };
		if (message.name === "write") {
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, String(message.args.content));
			return { ok: true, text: `wrote ${path.path}` };
		}
		const current = await readFile(file, "utf8");
		await writeFile(file, current.replace(String(message.args.oldText), String(message.args.newText)));
		return { ok: true, text: `edited ${path.path}` };
	} catch (error) {
		return { ok: false, text: `error: ${(error as NodeJS.ErrnoException).code ?? "io"}` };
	}
}

function script(steps: (request: FakeRequest) => FakeStep | Promise<FakeStep>): void {
	fake.requests.length = 0;
	fake.script(steps);
}

async function settle(run: Run): Promise<{ finished: Finished; exit: RunnerExit }> {
	const finished = await withTimeout(run.finished, 30_000, "finished");
	const exit = await withTimeout(run.exited, 15_000, "exit");
	return { finished, exit };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
		}),
	]);
}

/** A one-shot latch the test opens to release a held fake model request. */
function latch(): { readonly opened: Promise<void>; open(): void } {
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open: () => open() };
}

const statusOf = (requestId: string, status: string) => (message: FromRunner) =>
	message.type === "steer_status" && message.requestId === requestId && message.status === status;

function statuses(run: Run, requestId: string): string[] {
	return run.messages.flatMap((message) =>
		message.type === "steer_status" && message.requestId === requestId ? [message.status] : [],
	);
}

describe("Pi runner process", { timeout: 120_000 }, () => {
	it("adapts the real Harness request for a Codex gateway without losing its tools", async () => {
		script(() => ({ text: "Gateway request accepted." }));
		const run = await launch({ input: "Read package.json", codexGateway: true });
		const { finished, exit } = await settle(run);
		assert.equal(finished.outcome, "answered");
		assert.equal(exit.code, 0);
		assert.equal(fake.requests.length, 1);
		const body = fake.requests[0]?.body;
		assert.match(body.instructions, /You are agent alpha/);
		assert.ok(!("max_output_tokens" in body));
		assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name).sort(), [
			"edit",
			"read",
			"run_check",
			"write",
		]);
	});

	it("runs a tool call through the IPC executor and finishes answered", async () => {
		script(({ index }) =>
			index === 0
				? { toolCalls: [{ name: "write", args: { path: "hello.txt", content: "hi there" } }] }
				: { text: "Wrote hello.txt." },
		);
		const run = await launch({ input: "create hello.txt" });
		const { finished, exit } = await settle(run);
		assert.equal(finished.outcome, "answered");
		assert.equal(finished.answer, "Wrote hello.txt.");
		assert.deepEqual(finished.delivered, []);
		assert.deepEqual(finished.unconsumed, []);
		assert.equal(exit.code, 0);
		assert.ok(run.messages.some((message) => message.type === "ready"));
		assert.equal(run.tools.length, 1);
		assert.equal(run.tools[0]?.name, "write");
		assert.deepEqual(run.tools[0]?.args, { path: "hello.txt", content: "hi there" });
		assert.equal(await readFile(join(run.worktree, "hello.txt"), "utf8"), "hi there");
		assert.equal(fake.requests.length, 2);
		assert.equal(fake.requests[0]?.auth, `Bearer ${RUN_KEY}`);
		const second = fake.requests[1]?.body;
		assert.match(JSON.stringify(second.input), /wrote hello\.txt/);
		// The system prompt carries the instructions and the environment note; the tool list is the fixed four.
		assert.match(JSON.stringify(second), /You are agent alpha/);
		const names = (second.tools as { name: string }[]).map((tool) => tool.name).sort();
		assert.deepEqual(names, ["edit", "read", "run_check", "write"]);
		// Provider retries off, compaction off: one request per attempt; metadata lines reached the logger.
		assert.ok(notes.some((note) => note.event === "runner_exit"));
	});

	it("steers a follow-up into the running work after the in-flight tool round", async () => {
		const steerText = "STEER-1: also add a README";
		script(({ index }) =>
			index === 0
				? { toolCalls: [{ name: "write", args: { path: "a.txt", content: "a" } }] }
				: { text: "Done with both." },
		);
		const run = await launch({
			input: "write a.txt",
			onTool: async (_message, self) => {
				self.handle.send({ type: "steer", requestId: "s1", content: steerText });
				await self.waitFor(
					(message) => message.type === "steer_status" && message.requestId === "s1",
					"steer submitted",
				);
				return undefined;
			},
		});
		const { finished } = await settle(run);
		assert.equal(finished.outcome, "answered");
		assert.deepEqual(statuses(run, "s1"), ["submitted", "delivered"]);
		assert.deepEqual(finished.delivered, ["s1"]);
		assert.deepEqual(finished.unconsumed, []);
		assert.equal(fake.requests.length, 2);
		const second = fake.requests[1]?.body;
		assert.match(JSON.stringify(second.input), /STEER-1: also add a README/);
		assert.match(JSON.stringify(second.input), /wrote a\.txt/);
	});

	it("turns a follow-up that arrives after the answer into one successor run, and waits for it", async () => {
		const steerText = "STEER-2: one more thing";
		script(({ index, userTexts }) => {
			if (index === 0) return { text: "First answer." };
			assert.ok(userTexts.includes(steerText), "the successor run's request carries the follow-up");
			return { text: "Second answer." };
		});
		const run = await launch({ input: "say something" });
		await run.waitFor((message) => message.type === "progress" && /idle/.test(message.text), "idle");
		run.handle.send({ type: "steer", requestId: "s2", content: steerText });
		const { finished } = await settle(run);
		assert.equal(finished.outcome, "answered");
		assert.equal(finished.answer, "Second answer.");
		assert.deepEqual(statuses(run, "s2"), ["successor", "delivered"]);
		assert.deepEqual(finished.delivered, ["s2"]);
		assert.equal(fake.requests.length, 2);
		assert.match(JSON.stringify(fake.requests[1]?.body.input), /First answer\./);
	});

	it("cap_reached withdraws a steer queued in Pi's inbox and refuses new ones: no successor run starts", async () => {
		const queuedText = "CAP-QUEUED: one more thing";
		const answer = latch();
		script(async ({ index }) => {
			if (index > 0) return { text: "A successor run must not start." };
			await answer.opened;
			return { text: "Only answer." };
		});
		const run = await launch({ input: "answer once" });
		await fake.waitForRequests(1);
		// The run's answer (its last allowed request) is in flight: the follow-up waits in Pi's inbox as a steer.
		run.handle.send({ type: "steer", requestId: "cap-queued", content: queuedText });
		await run.waitFor(statusOf("cap-queued", "submitted"), "steer submitted");
		run.handle.send({ type: "cap_reached" });
		await run.waitFor(statusOf("cap-queued", "withdrawn"), "queued steer withdrawn");
		run.handle.send({ type: "steer", requestId: "cap-late", content: "CAP-LATE: and this" });
		await run.waitFor(statusOf("cap-late", "withdrawn"), "late steer refused");
		answer.open();

		const { finished, exit } = await settle(run);
		assert.equal(finished.outcome, "answered", "a withdrawn steer is not a failure of the run");
		assert.equal(finished.answer, "Only answer.");
		assert.deepEqual(finished.answered, [run.requestId]);
		assert.deepEqual(finished.delivered, []);
		assert.deepEqual(finished.unconsumed, ["cap-queued"]);
		assert.deepEqual(statuses(run, "cap-queued"), ["submitted", "withdrawn"]);
		assert.deepEqual(statuses(run, "cap-late"), ["withdrawn"]);
		assert.equal(exit.code, 0);
		await sleep(200);
		assert.equal(fake.requests.length, 1, "Pi started no successor run with the withdrawn steer");

		// The conversation is quiet and reusable: the next run opens it, and the withdrawn steer is not in its history.
		script(() => ({ text: "Next run answered." }));
		const next = await launch({ input: "next run", conversation: run.conversation, fresh: false });
		const reused = await settle(next);
		assert.equal(reused.finished.outcome, "answered");
		assert.equal(fake.requests.length, 1);
		const history = JSON.stringify(fake.requests[0]?.body.input);
		assert.match(history, /answer once/);
		assert.match(history, /Only answer\./);
		assert.doesNotMatch(history, /CAP-QUEUED|CAP-LATE/);
	});

	it("reports a steer delivered only after the model answered a request carrying it, not when it is placed", async () => {
		const steerText = "SEEN-STEER: also add b.txt";
		const respond = latch();
		script(async ({ index, userTexts }) => {
			if (index === 0) return { toolCalls: [{ name: "write", args: { path: "a.txt", content: "a" } }] };
			if (index === 1) {
				assert.ok(userTexts.includes(steerText), "the steer is placed into the next request");
				await respond.opened;
				return { toolCalls: [{ name: "write", args: { path: "b.txt", content: "b" } }] };
			}
			return { status: 400, body: JSON.stringify({ error: { message: "upstream rejected the request" } }) };
		});
		const run = await launch({
			input: "write a.txt",
			onTool: async (message, self) => {
				if (message.args.path !== "a.txt") return undefined;
				self.handle.send({ type: "steer", requestId: "seen", content: steerText });
				await self.waitFor(statusOf("seen", "submitted"), "steer submitted");
				return undefined;
			},
		});
		// Placed and sent to the model, which has not answered yet: not delivered.
		await fake.waitForRequests(2);
		await sleep(500);
		assert.deepEqual(statuses(run, "seen"), ["submitted"]);
		respond.open();
		await run.waitFor(statusOf("seen", "delivered"), "delivered once the model answered");

		// The run then fails (the next request is refused): the steer the model worked on stays delivered.
		const { finished } = await settle(run);
		assert.equal(finished.outcome, "failed");
		assert.deepEqual(finished.delivered, ["seen"]);
		assert.deepEqual(finished.unconsumed, []);
		assert.deepEqual(finished.answered, []);
		assert.deepEqual(statuses(run, "seen"), ["submitted", "delivered"]);
		assert.equal(fake.requests.length, 3);
	});

	it("a steer placed but never answered by the model is reported unconsumed, not delivered", async () => {
		const steerText = "UNSEEN-STEER: this request is refused";
		script(({ index }) =>
			index === 0
				? { toolCalls: [{ name: "write", args: { path: "a.txt", content: "a" } }] }
				: { status: 400, body: JSON.stringify({ error: { message: "upstream rejected the request" } }) },
		);
		const run = await launch({
			input: "write a.txt",
			onTool: async (_message, self) => {
				self.handle.send({ type: "steer", requestId: "unseen", content: steerText });
				await self.waitFor(statusOf("unseen", "submitted"), "steer submitted");
				return undefined;
			},
		});
		const { finished } = await settle(run);
		assert.equal(finished.outcome, "failed");
		assert.equal(fake.requests.length, 2);
		assert.ok(JSON.stringify(fake.requests[1]?.body.input).includes(steerText), "Pi placed it into the request");
		assert.deepEqual(finished.delivered, []);
		assert.deepEqual(finished.unconsumed, ["unseen"]);
		assert.deepEqual(statuses(run, "unseen"), ["submitted"]);
	});

	it("a successor Pi starts after the answer and whose first request is refused: answered names the run's input", async () => {
		const answer = latch();
		script(async ({ index }) => {
			if (index > 0) return { status: 400, body: JSON.stringify({ error: { message: "request limit reached" } }) };
			await answer.opened;
			return { text: "First answer." };
		});
		const run = await launch({ input: "answer, then a successor" });
		await fake.waitForRequests(1);
		run.handle.send({ type: "steer", requestId: "refused", content: "REFUSED-SUCCESSOR: more" });
		await run.waitFor(statusOf("refused", "submitted"), "steer submitted");
		answer.open();
		const { finished } = await settle(run);
		// Pi answered the run's input, then the queued steer started a successor whose only request was refused.
		assert.equal(fake.requests.length, 2);
		assert.equal(finished.outcome, "failed");
		assert.equal(finished.answer, "First answer.");
		assert.deepEqual(finished.answered, [run.requestId]);
		assert.deepEqual(finished.delivered, []);
		assert.deepEqual(finished.unconsumed, ["refused"]);
		assert.deepEqual(statuses(run, "refused"), ["submitted"]);
	});

	it("submits follow-ups accepted before the process started as steers", async () => {
		script(({ index }) =>
			index === 0
				? { toolCalls: [{ name: "read", args: { path: "missing.txt" } }] }
				: { text: "Handled the early follow-up." },
		);
		const run = await launch({ input: "read missing.txt", steers: [{ requestId: "early", content: "EARLY-STEER" }] });
		const { finished } = await settle(run);
		assert.equal(finished.outcome, "answered");
		assert.deepEqual(finished.delivered, ["early"]);
		assert.equal(statuses(run, "early")[0], "submitted");
		assert.ok(statuses(run, "early").includes("delivered"));
		assert.match(JSON.stringify(fake.requests.at(-1)?.body.input), /EARLY-STEER/);
	});

	it("does not retry a 401 and finishes failed with the reason", async () => {
		script(() => ({
			status: 401,
			body: JSON.stringify({ error: { message: "run key not open", type: "invalid_request_error" } }),
		}));
		const run = await launch({ input: "hello" });
		const { finished, exit } = await settle(run);
		assert.equal(finished.outcome, "failed");
		assert.match(finished.reason ?? "", /model_error/);
		assert.match(finished.reason ?? "", /401/);
		assert.equal(exit.code, 0);
		await sleep(200);
		assert.equal(fake.requests.length, 1);
	});

	it("refuses a follow-up after a failed run instead of starting a successor", async () => {
		script(() => ({ status: 400, body: JSON.stringify({ error: { message: "upstream rejected the request" } }) }));
		const run = await launch({ input: "hello" });
		await run.waitFor((message) => message.type === "progress" && /idle/.test(message.text), "idle");
		run.handle.send({ type: "steer", requestId: "late", content: "too late" });
		const { finished } = await settle(run);
		assert.equal(finished.outcome, "failed");
		assert.deepEqual(statuses(run, "late"), ["rejected"]);
		assert.deepEqual(finished.delivered, []);
		assert.equal(fake.requests.length, 1);
	});

	it("rejects a follow-up that arrives after finished", async () => {
		script(() => ({ text: "quick" }));
		const run = await launch({ input: "hello" });
		await run.finished;
		run.handle.send({ type: "steer", requestId: "after", content: "after the end" });
		await run.exited;
		// Either refused by the exiting process or never delivered; never accepted.
		assert.ok(statuses(run, "after").every((status) => status === "rejected"));
		assert.equal(fake.requests.length, 1);
	});

	it("retries a 503 with Pi's durable retry only (maxRetries 2: three requests)", async () => {
		script(() => ({ status: 503 }));
		const run = await launch({ input: "hello" });
		const { finished } = await settle(run);
		assert.equal(finished.outcome, "failed");
		assert.match(finished.reason ?? "", /model_error/);
		await sleep(200);
		assert.equal(fake.requests.length, 3);
	});

	it("aborts mid-run: finished aborted, then the process exits", async () => {
		script(() => ({ hang: true }));
		const run = await launch({ input: "think forever" });
		await fake.waitForRequests(1);
		assert.ok(launcher.isRunner(run.ref()));
		run.handle.send({ type: "abort", reason: "cancelled by user" });
		const { finished, exit } = await settle(run);
		assert.equal(finished.outcome, "aborted");
		assert.equal(finished.reason, "cancelled by user");
		assert.equal(exit.code, 0);
		assert.equal(launcher.isRunner(run.ref()), false);
		// A follow-up after the stop is refused, never accepted.
		assert.equal(run.messages.filter((message) => message.type === "finished").length, 1);
	});

	it("aborts with a follow-up still queued: it is reported unconsumed", async () => {
		script(({ index }) =>
			index === 0 ? { toolCalls: [{ name: "write", args: { path: "slow.txt", content: "x" } }] } : { hang: true },
		);
		const run = await launch({
			input: "write slow.txt",
			onTool: async (_message, self) => {
				self.handle.send({ type: "steer", requestId: "s3", content: "never placed" });
				await self.waitFor((message) => message.type === "steer_status" && message.requestId === "s3", "steer");
				self.handle.send({ type: "abort", reason: "limit" });
				await sleep(100);
				return { ok: true, text: "late result" };
			},
		});
		const { finished } = await settle(run);
		assert.equal(finished.outcome, "aborted");
		assert.deepEqual(finished.unconsumed, ["s3"]);
		assert.deepEqual(finished.delivered, []);
	});

	it("blocks a policy-denied call before the executor; the model gets an error result", async () => {
		script(({ index }) =>
			index === 0
				? { toolCalls: [{ name: "write", args: { path: "../escape.txt", content: "x" } }] }
				: { text: "Understood." },
		);
		const run = await launch({ input: "escape" });
		const { finished } = await settle(run);
		assert.equal(finished.outcome, "answered");
		assert.equal(run.tools.length, 0);
		assert.equal(existsSync(join(dirname(run.worktree), "escape.txt")), false);
		const results = fake.requests[1]?.body.input.filter(
			(item: { type?: string }) => item.type === "function_call_output",
		);
		assert.equal(results.length, 1);
		assert.match(JSON.stringify(results[0].output), /blocked/i);
		assert.match(JSON.stringify(results[0].output), /\.\./);
	});

	it("caps a large tool result at the tool-result limit with a visible marker", async () => {
		script(({ index }) =>
			index === 0
				? { toolCalls: [{ name: "run_check", args: { operation: "test" } }] }
				: { text: "Tests looked long." },
		);
		const run = await launch({ input: "run the tests", onTool: () => ({ ok: false, text: "y".repeat(40_000) }) });
		const { finished } = await settle(run);
		assert.equal(finished.outcome, "answered");
		assert.deepEqual(run.tools[0]?.args, { operation: "test" });
		const output = fake.requests[1]?.body.input.find((item: { type?: string }) => item.type === "function_call_output")
			?.output as string;
		assert.ok(Buffer.byteLength(output) <= 16 * 1024, `tool output is ${Buffer.byteLength(output)} bytes`);
		assert.match(output, /\[truncated: \d+ bytes dropped\]$/);
	});

	it("refuses an unlisted run_check operation before the executor", async () => {
		script(({ index }) =>
			index === 0 ? { toolCalls: [{ name: "run_check", args: { operation: "deploy" } }] } : { text: "Ok." },
		);
		const run = await launch({ input: "deploy" });
		const { finished } = await settle(run);
		assert.equal(finished.outcome, "answered");
		assert.equal(run.tools.length, 0);
		assert.match(JSON.stringify(fake.requests[1]?.body.input), /deploy/);
	});

	it("reuses an existing conversation file: the next run sees the earlier history", async () => {
		const conversation = join(root, "data", "conversations", "reused.sqlite");
		script(() => ({ text: "Noted: PINEAPPLE-ACK." }));
		const first = await launch({ input: "Remember the word PINEAPPLE.", conversation });
		assert.equal((await settle(first)).finished.outcome, "answered");
		script(() => ({ text: "The word was PINEAPPLE." }));
		const second = await launch({ input: "Which word?", conversation, fresh: false });
		const { finished } = await settle(second);
		assert.equal(finished.outcome, "answered");
		assert.equal(fake.requests.length, 1);
		const history = JSON.stringify(fake.requests[0]?.body.input);
		assert.match(history, /Remember the word PINEAPPLE\./);
		assert.match(history, /Noted: PINEAPPLE-ACK\./);
		assert.match(history, /Which word\?/);
	});

	it("refuses a fresh start over an existing file and a reuse of a missing one", async () => {
		script(() => ({ text: "unused" }));
		const existing = join(root, "data", "conversations", "reused.sqlite");
		const clash = await launch({ input: "x", conversation: existing, fresh: true });
		const first = await settle(clash);
		assert.equal(first.finished.outcome, "failed");
		assert.match(first.finished.reason ?? "", /already exists/);
		const missing = await launch({ input: "x", conversation: join(root, "nope.sqlite"), fresh: false });
		const second = await settle(missing);
		assert.equal(second.finished.outcome, "failed");
		assert.match(second.finished.reason ?? "", /does not exist/);
		assert.equal(fake.requests.length, 0);
	});

	it("carries the deployment and run markers in argv (never the key); restart cleanup kills only a marked process", async () => {
		script(() => ({ hang: true }));
		const run = await launch({ input: "hang for the markers" });
		await fake.waitForRequests(1);
		const pid = run.handle.pid ?? 0;
		const command = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
		const deployment = deploymentId(join(root, "data"));
		assert.ok(command.includes(`--pi-durable-deployment=${deployment}`), command);
		assert.ok(command.includes(`--pi-durable-run=${run.ref().runId}`), command);
		assert.ok(command.includes("--transport=ipc"), command);
		assert.ok(!command.includes(RUN_KEY), "the run key is not in argv");
		// Another run's id, another deployment, or a process without markers (this test) is never taken for it.
		assert.equal(launcher.isRunner({ ...run.ref(), runId: run.ref().runId + 1000 }), false);
		const other = createRunLauncher({ dataDir: join(root, "other-data"), log: silentLogger });
		assert.equal(other.isRunner(run.ref()), false);
		// Restart cleanup's deployment-wide listing: this deployment's marked process, never another deployment's.
		assert.deepEqual(
			launcher.leftovers()?.filter((ref) => ref.pid === pid),
			[{ runId: run.ref().runId, generation: 0, pid }],
		);
		assert.equal(
			other.leftovers()?.some((ref) => ref.pid === pid),
			false,
		);
		assert.equal(
			launcher.leftovers()?.some((ref) => ref.pid === process.pid),
			false,
			"never this process",
		);
		other.killRunner(run.ref());
		assert.equal(launcher.isRunner({ runId: run.ref().runId, generation: 1, pid: process.pid }), false);
		launcher.killRunner({ runId: run.ref().runId, generation: 1, pid: process.pid });
		assert.equal(launcher.isRunner(run.ref()), true, "still running: nothing above killed it");
		launcher.killRunner(run.ref());
		const exit = await withTimeout(run.exited, 10_000, "exit");
		assert.equal(exit.signal, "SIGKILL");
		assert.equal(launcher.isRunner(run.ref()), false);
		assert.equal(
			launcher.leftovers()?.some((ref) => ref.pid === pid),
			false,
		);
		assert.equal(launcher.isolation, "process");
		assert.deepEqual(await launcher.available(), { ok: true });
	});

	it("kill() ends the whole process group", async () => {
		script(() => ({ hang: true }));
		const run = await launch({ input: "hang" });
		await fake.waitForRequests(1);
		run.handle.kill();
		const exit = await withTimeout(run.exited, 10_000, "exit");
		assert.equal(exit.signal, "SIGKILL");
		assert.equal(launcher.isRunner(run.ref()), false);
	});
});
