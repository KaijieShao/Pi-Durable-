/**
 * Limits end to end, through the real Coordinator (commands, engine, relay, outbox, poller, git, GitHub client, Pi
 * runner process) against 127.0.0.1 fakes (Telegram, GitHub, model). Spec: capacity.md § Concurrency and Resource
 * Limits and § Fixed limits; agent-execution.md § Limits; requirements.md § Tasks; evaluation.md fault rows
 * "30-request cap", "Over-48K input", "10-minute deadline", "Cancellation" and the stress row "Queue saturation".
 *
 * Model faults: an upstream 401 or 400 is not retried (exactly one request) and fails the task; a 503 is retried by
 * Pi's durable retry at most twice. Demo queue: 2 runs deployment-wide and 1 per agent, waiting caps 2 per agent /
 * 4 per group / 4 per user with "queue full" reasons, queue positions in acknowledgements, 4 open tasks per group.
 * Run limits: the 30-request cap (retries included), the 48K-token input check before anything is sent, the run
 * deadline. /status during 2 runs, /cancel of a running task (key closed, process gone, final checkpoint pushed,
 * worktree archived, pull request closed) and of a queued one.
 *
 * Observation without touching the harness: a recording tap is put between Pi and the relay through the engine's
 * public `setRelayUrl`, so a test sees every request Pi makes (including those the relay refuses before the fake
 * model) and can replay a run's key against the real relay after revocation. The key stays in memory, never printed.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	createServer,
	request as httpRequest,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { type TestContext, test } from "node:test";
import { estimateInputTokens, hashRunKey } from "../../src/coordinator/relay.ts";
import type { ServerMessage } from "../fixtures/fake-bot-api.ts";
import { waitFor } from "../helpers/env.ts";
import { originGit } from "../helpers/fake-github.ts";
import type { FakeStep, RecordedRequest } from "../helpers/fake-model.ts";
import {
	agentPosition,
	dockerUnavailable,
	OWNER,
	PROJECT_FILES,
	REPO,
	type Stack,
	type StackOptions,
	scriptedAgent,
	startStack,
	USER1,
	USER2,
} from "./harness.ts";

type TaskRow = {
	id: number;
	state: string;
	reason: string | null;
	agent_id: string;
	branch: string | null;
	worktree_path: string | null;
	archived: number;
	base_commit: string | null;
	head_commit: string | null;
	pr_number: number | null;
};
type RunRow = {
	id: number;
	task_id: number;
	kind: string;
	state: string;
	reason: string | null;
	model_requests: number;
	pid: number | null;
	container: string | null;
	generation: number | null;
	started_at: number | null;
};

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/** A promise the test opens when it wants a held model answer to go out. */
type Gate = { readonly promise: Promise<void>; open(): void };

function gate(): Gate {
	let open: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/** Model requests of one run: those whose newest user message (the run's input) matches. */
function requestsFor(stack: Stack, input: RegExp): RecordedRequest[] {
	return stack.model.requests.filter((request) => input.test(agentPosition(request).input));
}

/** The bot's first message replying to `messageId` (an acknowledgement or a rejection of that command). */
function replyTo(stack: Stack, messageId: number, timeoutMs?: number): Promise<ServerMessage> {
	return stack.waitForBotMessage((message) => message.replyTo === messageId, { timeoutMs });
}

function task(stack: Stack, id: number): TaskRow {
	const row = stack.tasks<TaskRow>().find((candidate) => candidate.id === id);
	assert.ok(row !== undefined, `task ${id} exists`);
	return row;
}

function runsOf(stack: Stack, taskId: number): RunRow[] {
	return stack.runs<RunRow>().filter((run) => run.task_id === taskId);
}

function lastRun(stack: Stack, taskId: number): RunRow {
	const run = runsOf(stack, taskId).at(-1);
	assert.ok(run !== undefined, `task ${taskId} has a run`);
	return run;
}

/** True once no process has this pid (the runner is reaped by the Coordinator when it exits). */
function processGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/**
 * A deterministic dispatch barrier: after pending microtasks have run, `engine.kick()` runs one engine pass
 * synchronously (dispatch reserves a slot and marks the run 'starting' inside that call). A run still 'queued'
 * afterwards is held by a limit, not by timing.
 */
async function dispatchPass(stack: Stack): Promise<void> {
	for (let pass = 0; pass < 2; pass++) {
		await new Promise((resolve) => setImmediate(resolve));
		stack.coordinator.engine.kick();
	}
}

/** File content on an origin branch, or undefined. */
async function fileAt(stack: Stack, branch: string, path: string): Promise<string | undefined> {
	const result = await originGit(stack.origin.bare, ["show", `refs/heads/${branch}:${path}`], { okCodes: [0, 128] });
	return result.code === 0 ? result.stdout : undefined;
}

/** Expect the engine's verified-stop invariant: no slot held, group not frozen (see finalizeRun). */
function assertStoppedCleanly(stack: Stack): void {
	const slots = stack.coordinator.store.all<{ id: number }>("SELECT id FROM slots");
	assert.deepEqual(slots, [], "every execution slot was released (only after the stop was verified)");
	const group = stack.coordinator.store.groupState(stack.config.telegram.groupChatId);
	assert.equal(group.state, "normal", "the stop was confirmed: the group did not freeze");
}

// ---------------------------------------------------------------------------------------------------------------
// A recording tap between Pi and the relay

/** A complete HTTP answer (a relay error answer recorded by the tap, replayed verbatim). */
type Answer = { readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: Buffer };

type Tapped = {
	readonly keyHash: string;
	readonly input: string;
	readonly estimate: number;
	status: number;
	answer?: Answer;
};

type RelayTap = {
	readonly url: string;
	/** Every request Pi sent, in arrival order, with the relay's status (and its answer, for non-2xx ones). */
	readonly seen: Tapped[];
	/**
	 * When set and it returns an answer for a request (by the run's newest input), the tap answers Pi with it and does
	 * not forward the request: the relay never sees it, so nothing is counted, revoked or aborted.
	 */
	intercept: ((input: string) => Answer | undefined) | undefined;
	/** Requests of one run (matched by its key's hash in run_keys). */
	forRun(runId: number): Tapped[];
	/** The run key Pi used for `runId` (memory only; never logged). */
	keyOf(runId: number): string | undefined;
	close(): Promise<void>;
};

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
	const { host: _host, ...rest } = headers;
	return rest;
}

/**
 * Starts a 127.0.0.1 proxy in front of the stack's relay and points the engine at it (runs dispatched afterwards
 * talk to the relay through it). It forwards every request unchanged and streams the answer back.
 */
async function tapRelay(stack: Stack): Promise<RelayTap> {
	const relay = new URL(stack.coordinator.relayUrl);
	const seen: Tapped[] = [];
	const keys = new Map<string, string>();
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const key = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
			const keyHash = hashRunKey(key);
			keys.set(keyHash, key);
			const parsed = parseBody(body);
			const entry: Tapped = {
				keyHash,
				input: agentPosition({ body: parsed }).input,
				estimate: estimateOf(parsed),
				status: 0,
			};
			seen.push(entry);
			const canned = tap.intercept?.(entry.input);
			if (canned !== undefined) {
				entry.status = canned.status;
				res.writeHead(canned.status, canned.headers);
				res.end(canned.body);
				return;
			}
			const upstream = httpRequest(
				{
					host: "127.0.0.1",
					port: relay.port,
					path: req.url,
					method: req.method,
					headers: forwardHeaders(req.headers),
				},
				(answer) => relayAnswered(entry, answer, res),
			);
			upstream.on("error", () => res.destroy());
			res.on("close", () => upstream.destroy());
			upstream.end(body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	stack.coordinator.engine.setRelayUrl(url);
	const hashesOf = (runId: number): Set<string> =>
		new Set(
			stack.coordinator.store
				.all<{ key_hash: string }>("SELECT key_hash FROM run_keys WHERE run_id = ?", runId)
				.map((row) => row.key_hash),
		);
	const tap: RelayTap = {
		url,
		seen,
		intercept: undefined,
		forRun: (runId) => {
			const hashes = hashesOf(runId);
			return seen.filter((entry) => hashes.has(entry.keyHash));
		},
		keyOf: (runId) => {
			const hash = [...hashesOf(runId)].at(-1);
			return hash === undefined ? undefined : keys.get(hash);
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
	return tap;
}

/** Stream the relay's answer to Pi; keep a copy of error answers (they are small JSON bodies). */
function relayAnswered(entry: Tapped, answer: IncomingMessage, res: ServerResponse): void {
	const status = answer.statusCode ?? 502;
	entry.status = status;
	res.writeHead(status, answer.headers);
	if (status >= 200 && status <= 299) {
		answer.pipe(res);
		return;
	}
	const chunks: Buffer[] = [];
	answer.on("data", (chunk: Buffer) => chunks.push(chunk));
	answer.on("end", () => {
		const body = Buffer.concat(chunks);
		entry.answer = { status, headers: answer.headers, body };
		res.end(body);
	});
}

function parseBody(body: Buffer): unknown {
	try {
		return JSON.parse(body.toString("utf8"));
	} catch {
		return undefined;
	}
}

function estimateOf(body: unknown): number {
	return body === undefined ? -1 : estimateInputTokens(body);
}

/** A stack plus a relay tap, both stopped after the test (gates are opened first so no handler stays parked). */
async function tappedStack(t: TestContext, options: StackOptions, gates: readonly Gate[] = []) {
	const stack = await startStack(options);
	const tap = await tapRelay(stack);
	t.after(async () => {
		for (const held of gates) held.open();
		await stack.stop();
		await tap.close();
	});
	return { stack, tap };
}

/**
 * Pi's own retry policy on the relay's exact answer. Through the relay, a 400/401 also revokes the run at once (key
 * closed, Pi aborted within milliseconds), which alone would hide a retry Pi meant to make 20 ms later. Here the tap
 * answers a new run's requests with `answer` (recorded from the relay) without forwarding them: nothing revokes or
 * aborts the run, so the run ends only when Pi itself gives up. Returns the failure message and Pi's requests.
 */
async function piAttemptsWith(
	stack: Stack,
	tap: RelayTap,
	answer: Answer,
	p: { agent: string; taskId: number; job: string },
) {
	tap.intercept = (input) => (input.startsWith(p.job) ? answer : undefined);
	stack.sendCommand(USER2, `/task ${p.agent} ${p.job} the relay's answer, replayed`);
	const failed = await stack.waitForBotMessage(new RegExp(`^Task ${p.taskId} failed`));
	await stack.coordinator.idle();
	tap.intercept = undefined;
	const run = lastRun(stack, p.taskId);
	return { failed, run, attempts: tap.forRun(run.id).map((entry) => entry.status) };
}

// ---------------------------------------------------------------------------------------------------------------
// (a)–(c) Model faults: 400/401 are not retried and fail the task; a 503 is retried by Pi at most twice.

test("an upstream 401 is not retried: one request, the task fails naming the rejected credentials, its PR is closed", {
	timeout: 120_000,
}, async (t) => {
	const { stack, tap } = await tappedStack(t, {
		model: scriptedAgent([
			{
				when: /^job-a1/,
				steps: [{ toolCalls: [{ name: "write", args: { path: "a1.txt", content: "a1\n" } }] }, { text: "a1 done" }],
			},
			{ when: /^job-a2/, steps: [{ status: 401 }] },
		]),
	});
	// Run 1 succeeds, so the task has a pull request when the follow-up run meets the 401.
	stack.sendCommand(USER1, "/task alpha job-a1 write a1.txt");
	const review = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	const head1 = task(stack, 1).head_commit;
	assert.equal(stack.github.pulls.get(1)?.state, "open");
	stack.reply(USER1, review.id, "job-a2 change a1.txt");
	await stack.waitForBotMessage(/^Follow-up started another run of Task 1/, { since: review.id });

	const failed = await stack.waitForBotMessage(/^Task 1 failed/, { since: review.id });
	assert.equal(
		failed.text,
		"Task 1 failed: the model rejected the credentials (status 401). Pull request closed; branch task/1 kept. " +
			"Send a new /task for further work.",
	);
	await stack.coordinator.idle();
	const run2 = lastRun(stack, 1);
	assert.equal(run2.kind, "followup");
	assert.equal(run2.state, "failed");
	assert.equal(run2.reason, "the model rejected the credentials (status 401)");
	// Exactly one request for that run: at the fake model, at the relay's count, and from Pi itself (the tap).
	assert.equal(requestsFor(stack, /^job-a2/).length, 1, "the fake model saw the 401 request once");
	assert.equal(run2.model_requests, 1);
	assert.deepEqual(
		tap.forRun(run2.id).map((entry) => entry.status),
		[401],
		"Pi sent one request for the run and did not retry it",
	);
	const failedTask = task(stack, 1);
	assert.equal(failedTask.state, "failed");
	assert.equal(failedTask.reason, "the model rejected the credentials (status 401)");
	assert.equal(stack.github.pulls.get(1)?.state, "closed");
	assert.equal(stack.github.pulls.get(1)?.merged, false);
	assert.deepEqual(await stack.worktrees(), [], "worktree archived (folder deleted)");
	assert.equal(failedTask.worktree_path, null);
	assert.equal(failedTask.archived, 1);
	assert.deepEqual(await stack.branches(), ["main", "task/1"], "branch kept");
	assert.equal(await stack.branchSha("task/1"), head1, "nothing new to checkpoint: the branch stays at run 1's head");
	assertStoppedCleanly(stack);

	// Pi does not retry the relay's 401 by itself either (with nothing revoking the run; a 503 is retried: see below).
	const recorded = tap.forRun(run2.id)[0]?.answer;
	assert.ok(recorded !== undefined && recorded.status === 401);
	const replay = await piAttemptsWith(stack, tap, recorded, { agent: "beta", taskId: 2, job: "job-a3" });
	assert.deepEqual(replay.attempts, [401], "one attempt: Pi's durable retry treats it as final");
	assert.match(replay.failed.text, /^Task 2 failed: the run failed \(model_error: .*status 401/);
	assert.equal(replay.run.model_requests, 0, "the replayed run never reached the relay");
	assert.equal(requestsFor(stack, /^job-a3/).length, 0);
});

test("an upstream 400 is not retried: one request, the task fails naming the rejected request, branch kept", {
	timeout: 120_000,
}, async (t) => {
	const { stack, tap } = await tappedStack(t, { model: scriptedAgent([{ when: /^job-b/, steps: [{ status: 400 }] }]) });
	const mainSha = await stack.mainSha();
	const command = stack.sendCommand(USER1, "/task alpha job-b do something");
	await replyTo(stack, command);
	const failed = await stack.waitForBotMessage(/^Task 1 failed/);
	assert.equal(
		failed.text,
		"Task 1 failed: the model rejected the request (status 400). Branch task/1 kept. Send a new /task for further work.",
	);
	assert.equal(failed.replyTo, command, "the creator is told, replying to the /task");
	await stack.coordinator.idle();
	const run = lastRun(stack, 1);
	assert.deepEqual(
		[run.state, run.reason, run.model_requests],
		["failed", "the model rejected the request (status 400)", 1],
	);
	assert.equal(stack.model.requests.length, 1, "the fake model saw the 400 request once");
	assert.deepEqual(
		tap.forRun(run.id).map((entry) => entry.status),
		[400],
	);
	const failedTask = task(stack, 1);
	assert.deepEqual([failedTask.state, failedTask.worktree_path, failedTask.archived], ["failed", null, 1]);
	assert.equal(stack.github.pulls.size, 0, "no pull request was ever opened");
	assert.deepEqual(await stack.worktrees(), []);
	assert.equal(await stack.branchSha("task/1"), mainSha, "the branch is kept (pushed at its base: no work)");
	assertStoppedCleanly(stack);

	// Pi does not retry the relay's 400 by itself either.
	const recorded = tap.forRun(run.id)[0]?.answer;
	assert.ok(recorded !== undefined && recorded.status === 400);
	const replay = await piAttemptsWith(stack, tap, recorded, { agent: "beta", taskId: 2, job: "job-b2" });
	assert.deepEqual(replay.attempts, [400], "one attempt: Pi's durable retry treats it as final");
	assert.match(replay.failed.text, /^Task 2 failed: the run failed \(model_error: .*status 400/);
	assert.equal(stack.model.requests.length, 1, "still only the first run's request reached the model");

	// A follow-up to the failed task is rejected with a hint to send a new /task (evaluation.md "Follow-up after merge").
	const late = stack.reply(USER1, failed.id, "please try again");
	const rejected = await replyTo(stack, late);
	assert.match(rejected.text, /^Follow-up rejected: Task 1 failed \(.*status 400.*\); send a new \/task/);
	await stack.coordinator.idle();
	assert.equal(runsOf(stack, 1).length, 1, "no new run after the failure");
});

/** job-c1: its first call gets two 503s, then it writes c1.txt and answers. job-c2: every attempt gets a 503. */
function flaky503() {
	const attempts = new Map<string, number>();
	return (request: { readonly body: unknown }): FakeStep => {
		const { input, round } = agentPosition(request);
		if (input.startsWith("job-c2")) return { status: 503 };
		const call = `${input}#${round}`;
		const attempt = (attempts.get(call) ?? 0) + 1;
		attempts.set(call, attempt);
		if (round === 0 && attempt <= 2) return { status: 503 };
		return round === 0
			? { toolCalls: [{ name: "write", args: { path: "c1.txt", content: "c1\n" } }] }
			: { text: "c1 done" };
	};
}

test("a 503 is retried by Pi at most twice: two 503s then success; a third 503 fails the task after 3 requests", {
	timeout: 120_000,
}, async (t) => {
	const { stack, tap } = await tappedStack(t, { model: flaky503() });

	// Two 503s, then the same call succeeds on Pi's second retry and the run completes normally.
	stack.sendCommand(USER1, "/task alpha job-c1 write c1.txt");
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	const c1 = requestsFor(stack, /^job-c1/);
	assert.equal(c1.length, 4, "3 attempts of the first call (1 + 2 retries), then the answer");
	assert.equal(
		JSON.stringify(c1[0]?.body.input),
		JSON.stringify(c1[2]?.body.input),
		"the retries resend the same call",
	);
	assert.equal(lastRun(stack, 1).model_requests, 4, "every retry is a counted request");
	assert.deepEqual(
		tap.forRun(lastRun(stack, 1).id).map((entry) => entry.status),
		[503, 503, 200, 200],
	);

	// Always 503: the call is tried 3 times (at most 2 retries), then the run fails and so does the task.
	stack.sendCommand(USER2, "/task beta job-c2 write c2.txt");
	const failed = await stack.waitForBotMessage(/^Task 2 failed/);
	await stack.coordinator.idle();
	assert.equal(requestsFor(stack, /^job-c2/).length, 3, "1 attempt + 2 retries, never more");
	const run2 = lastRun(stack, 2);
	assert.equal(run2.model_requests, 3);
	assert.deepEqual(
		tap.forRun(run2.id).map((entry) => entry.status),
		[503, 503, 503],
	);
	assert.equal(task(stack, 2).state, "failed");
	assert.match(failed.text, /^Task 2 failed: the run failed \(model_error: .*status 503.*\)\. Branch task\/2 kept\./);
	assert.deepEqual(await stack.worktrees(), ["task-1"], "task 2's worktree archived; task 1 is in review");
	assertStoppedCleanly(stack);

	// Control for the replay method of the 400/401 tests: the relay's 503 answer replayed the same way is retried.
	const recorded = tap.forRun(run2.id)[0]?.answer;
	assert.ok(recorded !== undefined && recorded.status === 503);
	const replay = await piAttemptsWith(stack, tap, recorded, { agent: "beta", taskId: 3, job: "job-c3" });
	assert.deepEqual(replay.attempts, [503, 503, 503]);
});

// ---------------------------------------------------------------------------------------------------------------
// (d) The demo queue, with the real DEMO_LIMITS: 2 runs deployment-wide and 1 per agent; waiting caps; positions;
// 4 open tasks per group.

/**
 * A model for inputs "job-N …": round 0 waits for job N's gate (opened by the test), then writes job-N.txt;
 * round 1 answers. After `releaseAll()` every gate, also of jobs not seen yet, is open.
 */
function gatedJobs() {
	const gates = new Map<string, Gate>();
	let allOpen = false;
	const gateOf = (job: string): Gate => {
		let held = gates.get(job);
		if (held === undefined) {
			held = gate();
			gates.set(job, held);
			if (allOpen) held.open();
		}
		return held;
	};
	const model = async (request: { readonly body: unknown }): Promise<FakeStep> => {
		const { input, round } = agentPosition(request);
		const job = /^(job-\d+)/.exec(input)?.[1];
		if (job === undefined) return { text: "no plan for this input" };
		if (round > 0) return { text: `${job} done` };
		await gateOf(job).promise;
		return { toolCalls: [{ name: "write", args: { path: `${job}.txt`, content: `${job}\n` } }] };
	};
	return {
		model,
		release: (job: string): void => gateOf(job).open(),
		releaseAll: (): void => {
			allOpen = true;
			for (const held of gates.values()) held.open();
		},
	};
}

type Peaks = { slots: number; perAgent: number; activeRuns: number; openTasks: number };

/**
 * Samples the store every few milliseconds and keeps the peaks: execution slots in use (runs and checks), run slots
 * of one agent, runs between dispatch and release, and open tasks (non-terminal tasks holding a worktree).
 */
function watchPeaks(stack: Stack): { peaks: Peaks; stop(): Peaks } {
	const peaks: Peaks = { slots: 0, perAgent: 0, activeRuns: 0, openTasks: 0 };
	const n = (sql: string): number => stack.coordinator.store.get<{ n: number }>(sql)?.n ?? 0;
	const sample = (): void => {
		peaks.slots = Math.max(peaks.slots, n("SELECT COUNT(*) AS n FROM slots"));
		peaks.perAgent = Math.max(
			peaks.perAgent,
			n("SELECT COALESCE(MAX(c), 0) AS n FROM (SELECT COUNT(*) AS c FROM slots WHERE kind = 'run' GROUP BY agent_id)"),
		);
		peaks.activeRuns = Math.max(
			peaks.activeRuns,
			n("SELECT COUNT(*) AS n FROM runs WHERE state IN ('starting', 'running', 'finalizing')"),
		);
		peaks.openTasks = Math.max(
			peaks.openTasks,
			n(`SELECT COUNT(*) AS n FROM tasks WHERE worktree_path IS NOT NULL AND archived = 0
			   AND state NOT IN ('merged', 'failed', 'cancelled')`),
		);
	};
	const timer = setInterval(() => {
		try {
			sample();
		} catch {
			// The Coordinator is stopping.
		}
	}, 5);
	return {
		peaks,
		stop: () => {
			clearInterval(timer);
			return { ...peaks };
		},
	};
}

/** Send a command and return the bot's acknowledgement or rejection text. */
async function command(stack: Stack, userId: number, text: string): Promise<string> {
	return (await replyTo(stack, stack.sendCommand(userId, text))).text;
}

/** The /status lines of one task ("Task 3 · gamma · queued · …"). */
async function statusLines(stack: Stack, userId: number): Promise<Map<number, string>> {
	const text = await command(stack, userId, "/status");
	const lines = new Map<number, string>();
	for (const line of text.split("\n")) {
		const id = /^Task (\d+) · /.exec(line)?.[1];
		if (id !== undefined && !lines.has(Number(id))) lines.set(Number(id), line);
	}
	lines.set(0, text.split("\n")[0] ?? "");
	return lines;
}

const waitForModel = (stack: Stack, job: string): Promise<unknown> =>
	waitFor(() => requestsFor(stack, new RegExp(`^${job}\\b`)).length > 0, {
		what: `model request of ${job}`,
		timeoutMs: 30_000,
	});

/** Queue/admission tests keep checking the complete state prefix; status-view tests check the new summary/PR suffix. */
function assertStatusPrefix(lines: ReadonlyMap<number, string>, id: number, expected: string): void {
	const line = lines.get(id) ?? "";
	assert.ok(line.startsWith(`${expected} · `), line);
}

test("demo queue limits: 2 runs at once and 1 per agent, waiting caps with 'queue full', positions, 4 open tasks", {
	timeout: 240_000,
}, async (t) => {
	const jobs = gatedJobs();
	const { stack } = await tappedStack(t, { model: jobs.model, env: { PI_AGENTS: "alpha,beta,gamma" } }, [
		{ promise: Promise.resolve(), open: jobs.releaseAll },
	]);
	const watch = watchPeaks(stack);
	t.after(() => watch.stop());

	// Two agents run at once; the model holds both runs.
	assert.equal(
		await command(stack, USER1, "/task alpha job-1 first alpha task"),
		"Task 1 accepted for agent alpha. Queue position 1.",
	);
	await waitForModel(stack, "job-1");
	assert.equal(
		await command(stack, USER2, "/task beta job-2 first beta task"),
		"Task 2 accepted for agent beta. Queue position 1.",
	);
	await waitForModel(stack, "job-2");

	// /status answers while 2 tasks run.
	const busy = await statusLines(stack, USER2);
	assert.match(busy.get(0) ?? "", /^Coordinator: live .*slots 2\/2/);
	assertStatusPrefix(busy, 1, "Task 1 · alpha · running");
	assertStatusPrefix(busy, 2, "Task 2 · beta · running");

	// A third agent's task waits for a deployment-wide slot although gamma is idle.
	assert.equal(
		await command(stack, USER1, "/task gamma job-3 gamma task"),
		"Task 3 accepted for agent gamma. Queue position 1. Waiting for an execution slot (2/2 in use).",
	);
	await dispatchPass(stack);
	assert.equal(lastRun(stack, 3).state, "queued", "gamma is free, but both execution slots are taken");

	// Per-agent waiting cap 2: the third waiting task for alpha is refused with the reason.
	assert.equal(
		await command(stack, USER1, "/task alpha job-4 second alpha task"),
		"Task 4 accepted for agent alpha. Queue position 1. Waiting for agent alpha to finish its current run.",
	);
	assert.equal(
		await command(stack, USER2, "/task alpha job-5 third alpha task"),
		"Task 5 accepted for agent alpha. Queue position 2. Waiting for agent alpha to finish its current run.",
	);
	assert.equal(
		await command(stack, OWNER, "/task alpha job-x1 one too many for alpha"),
		"Task request rejected: queue full: agent alpha already has 2 waiting tasks.",
	);
	// Per-group waiting cap 4 (the owner has nothing waiting, so it is the group's cap that refuses).
	assert.equal(
		await command(stack, USER2, "/task beta job-6 second beta task"),
		"Task 6 accepted for agent beta. Queue position 1. Waiting for agent beta to finish its current run.",
	);
	assert.equal(
		await command(stack, OWNER, "/task gamma job-x2 one too many for the group"),
		"Task request rejected: queue full: the group already has 4 waiting tasks.",
	);
	assert.equal(stack.tasks().length, 6, "rejected submissions create no task");

	const queued = await statusLines(stack, USER1);
	assertStatusPrefix(
		queued,
		3,
		"Task 3 · gamma · queued · queue position 1 · waiting for an execution slot (2/2 in use)",
	);
	assertStatusPrefix(
		queued,
		4,
		"Task 4 · alpha · queued · queue position 1 · waiting for agent alpha to finish its current run",
	);
	assertStatusPrefix(
		queued,
		5,
		"Task 5 · alpha · queued · queue position 2 · waiting for agent alpha to finish its current run",
	);
	assertStatusPrefix(
		queued,
		6,
		"Task 6 · beta · queued · queue position 1 · waiting for agent beta to finish its current run",
	);

	// /cancel of a queued task removes it from the queue: its place is free again.
	assert.equal(await command(stack, USER2, "/cancel 5"), "Task 5 cancelled.");
	assert.deepEqual(
		[task(stack, 5).state, lastRun(stack, 5).state, task(stack, 5).branch],
		["cancelled", "cancelled", null],
	);
	assert.equal(lastRun(stack, 5).started_at, null, "it never started");
	assert.equal(
		await command(stack, OWNER, "/task alpha job-7 alpha task after the cancel"),
		"Task 7 accepted for agent alpha. Queue position 2. Waiting for agent alpha to finish its current run.",
	);

	// Task 1 finishes: its slot goes to the oldest queued run whose agent is free (gamma's), not to alpha's next task.
	jobs.release("job-1");
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	await waitForModel(stack, "job-3");
	await dispatchPass(stack);
	assert.equal(lastRun(stack, 4).state, "queued", "alpha is free now, but both execution slots are taken");

	// Everything finishes; tasks 1–4 are in review, so the 4-open-task cap holds the remaining first runs.
	jobs.releaseAll();
	await stack.waitForBotMessage(/^Task 4 is ready for review \(run 1\)/);
	await waitFor(() => stack.coordinator.store.all("SELECT id FROM slots").length === 0, { what: "slots released" });
	await dispatchPass(stack);
	assert.deepEqual(
		[1, 2, 3, 4].map((id) => task(stack, id).state),
		["review", "review", "review", "review"],
	);
	assert.deepEqual(
		[lastRun(stack, 6).state, lastRun(stack, 7).state],
		["queued", "queued"],
		"4 open tasks: first runs wait",
	);
	// Tasks 6 and 7 were acknowledged as waiting for their agents; now only the reviews hold them, and each is told.
	for (const id of [6, 7]) {
		await stack.waitForBotMessage(
			new RegExp(
				`^Task ${id} is waiting for open reviews to finish \\(4 open tasks\\); it starts once a task in review`,
			),
		);
	}
	const reviews = await statusLines(stack, USER1);
	assert.match(reviews.get(0) ?? "", /^Coordinator: live .*slots 0\/2/);
	assert.match(
		reviews.get(6) ?? "",
		/^Task 6 · beta · queued · queue position 1 · waiting for open reviews to finish \(4 open tasks\) ·/,
	);
	assert.match(
		reviews.get(7) ?? "",
		/^Task 7 · alpha · queued · queue position 1 · waiting for open reviews to finish \(4 open tasks\) ·/,
	);
	// A 5th first run submitted now is told at once that it waits for reviews.
	assert.equal(
		await command(stack, USER1, "/task gamma job-8 gamma task while 4 are open"),
		"Task 8 accepted for agent gamma. Queue position 1. Waiting for open reviews to finish (4 open tasks).",
	);

	// A follow-up run of a task in review reuses its worktree: it is not another open task, so it runs.
	const review1 = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	stack.reply(USER1, review1.id, "job-9 follow-up on task 1");
	await stack.waitForBotMessage(
		/^Follow-up started another run of Task 1 on the same branch and pull request\. Queue position 2\./,
	);
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 2\)/);
	await dispatchPass(stack);
	assert.deepEqual(
		[lastRun(stack, 6).state, lastRun(stack, 7).state, lastRun(stack, 8).state],
		["queued", "queued", "queued"],
	);

	// Cancelling a task in review frees an open place: the oldest waiting first run (task 6) starts.
	const cancelling = await command(stack, USER2, "/cancel 2");
	assert.match(
		cancelling,
		/^Cancelling Task 2… You will get a message once its pull request is closed and its worktree archived\./,
	);
	await stack.waitForBotMessage(/^Task 2 cancelled\. Pull request closed; branch task\/2 kept\./);
	await stack.waitForBotMessage(/^Task 6 is ready for review \(run 1\)/);
	await waitFor(() => stack.coordinator.store.all("SELECT id FROM slots").length === 0, { what: "slots released" });
	await dispatchPass(stack);
	assert.deepEqual([lastRun(stack, 7).state, lastRun(stack, 8).state], ["queued", "queued"], "4 open tasks again");
	// Each waiting task was told once; task 8 already in its acknowledgement, so the engine did not repeat it.
	const told = (id: number): number =>
		stack
			.lastBotMessages(1000)
			.filter((message) => new RegExp(`^Task ${id} is waiting for open reviews`).test(message.text)).length;
	assert.deepEqual([told(6), told(7), told(8)], [1, 1, 0]);

	const peaks = watch.stop();
	assert.ok(peaks.slots <= 2, `at most 2 executions deployment-wide (peak ${peaks.slots})`);
	assert.equal(peaks.perAgent, 1, "at most 1 run per agent");
	assert.ok(peaks.activeRuns <= 2, `at most 2 runs between dispatch and release (peak ${peaks.activeRuns})`);
	assert.equal(peaks.activeRuns, 2, "two runs did overlap");
	assert.ok(peaks.openTasks <= 4, `at most 4 open tasks (peak ${peaks.openTasks})`);
});

test("per-user waiting cap 4: a user's 5th waiting task is refused 'queue full' while others can still queue", {
	timeout: 120_000,
}, async (t) => {
	const jobs = gatedJobs();
	const { stack } = await tappedStack(
		t,
		{
			model: jobs.model,
			env: { PI_AGENTS: "alpha,beta,gamma" },
			// The per-user cap (4, the real value) is checked after the per-group cap, and one Coordinator serves one group:
			// with the demo's equal caps the group cap always refuses first. Only to make the user's cap the binding one
			// is the group cap raised above it here; every other limit is DEMO_LIMITS.
			limits: { waitingPerGroup: 5 },
		},
		[{ promise: Promise.resolve(), open: jobs.releaseAll }],
	);
	await command(stack, OWNER, "/task alpha job-1 hold alpha");
	await waitForModel(stack, "job-1");
	await command(stack, OWNER, "/task beta job-2 hold beta");
	await waitForModel(stack, "job-2");
	const acks = [];
	for (const [agent, job] of [
		["alpha", 3],
		["alpha", 4],
		["beta", 5],
		["beta", 6],
	] as const) {
		acks.push(await command(stack, USER1, `/task ${agent} job-${job} waiting task`));
	}
	assert.deepEqual(
		acks.map((ack) => /^Task \d+ accepted for agent \w+\. Queue position (\d)\./.exec(ack)?.[1]),
		["1", "2", "1", "2"],
	);
	assert.equal(
		await command(stack, USER1, "/task gamma job-x one too many for this user"),
		"Task request rejected: queue full: you already have 4 waiting tasks.",
	);
	assert.equal(
		await command(stack, USER2, "/task gamma job-7 another user's task"),
		"Task 7 accepted for agent gamma. Queue position 1. Waiting for an execution slot (2/2 in use).",
	);
});

// ---------------------------------------------------------------------------------------------------------------
// (e) The 30-request cap (real value), retries included; (f) the 48K-token input check (real value).

const readReadme: FakeStep = { toolCalls: [{ name: "read", args: { path: "README.md" } }] };

test("30-request cap, retries included: request 31 is refused at the relay and the task fails with that limit", {
	timeout: 180_000,
}, async (t) => {
	let retried = false;
	const { stack, tap } = await tappedStack(t, {
		env: { PI_AGENTS: "alpha,beta" },
		// A model that never stops calling tools. job-e1's first call gets one 503 (Pi retries it: a counted request).
		model: (request) => {
			const { input } = agentPosition(request);
			if (input.startsWith("job-e1") && !retried) {
				retried = true;
				return { status: 503 };
			}
			return readReadme;
		},
	});
	stack.sendCommand(USER1, "/task alpha job-e1 keep reading");
	stack.sendCommand(USER2, "/task beta job-e2 keep reading");
	const failed1 = await stack.waitForBotMessage(/^Task 1 failed/);
	const failed2 = await stack.waitForBotMessage(/^Task 2 failed/);
	await stack.coordinator.idle();

	// With a retry: 30 forwarded requests (1 retried 503 + 29 tool rounds); Pi's 31st is refused before the model.
	assert.equal(
		failed1.text,
		"Task 1 failed: request limit reached (30 per run). Branch task/1 kept. Send a new /task for further work.",
	);
	const run1 = lastRun(stack, 1);
	assert.deepEqual(
		[run1.state, run1.reason, run1.model_requests],
		["failed", "request limit reached (30 per run)", 30],
	);
	assert.equal(requestsFor(stack, /^job-e1/).length, 30, "the fake model never saw a 31st request");
	const tapped1 = tap.forRun(run1.id);
	assert.equal(tapped1.length, 31, "Pi did send a 31st request");
	assert.deepEqual([tapped1[0]?.status, tapped1.at(-1)?.status], [503, 400]);
	assert.equal(task(stack, 1).state, "failed");

	// Without retries Pi's own turn limit (30 tool rounds) ends the run first: the model still gets at most 30.
	const run2 = lastRun(stack, 2);
	assert.equal(requestsFor(stack, /^job-e2/).length, 30);
	assert.equal(run2.model_requests, 30);
	assert.equal(tap.forRun(run2.id).length, 30, "no 31st request was even attempted");
	assert.equal(run2.state, "failed");
	assert.match(failed2.text, /^Task 2 failed: the run failed \(turn_limit/);
	assert.deepEqual(await stack.worktrees(), []);
	assertStoppedCleanly(stack);
});

const BIG_FILE = Array.from(
	{ length: 3000 },
	(_, i) => `line ${i + 1}: ${"lorem ipsum dolor sit amet ".repeat(2)}`,
).join("\n");

test("over-48K input: a request whose assembled input exceeds 48K tokens is refused before it reaches the model", {
	timeout: 180_000,
}, async (t) => {
	const { stack, tap } = await tappedStack(t, {
		files: { ...PROJECT_FILES, "big.txt": `${BIG_FILE}\n` },
		// Every round reads the big file again; each result is capped at 16 KiB, so the history grows ~4K tokens a round.
		model: () => ({ toolCalls: [{ name: "read", args: { path: "big.txt" } }] }),
	});
	stack.sendCommand(USER1, "/task alpha job-f read big.txt until the context is full");
	const failed = await stack.waitForBotMessage(/^Task 1 failed/);
	await stack.coordinator.idle();
	assert.equal(
		failed.text,
		"Task 1 failed: input exceeds 48K tokens. Branch task/1 kept. Send a new /task for further work.",
	);
	const run = lastRun(stack, 1);
	assert.deepEqual([run.state, run.reason], ["failed", "input exceeds 48K tokens"]);

	const tapped = tap.forRun(run.id);
	const refused = tapped.at(-1);
	assert.ok(refused !== undefined && refused.status === 400);
	assert.ok(refused.estimate > 48_000, `the refused input was over 48K tokens (${refused.estimate})`);
	const forwarded = stack.model.requests;
	assert.equal(forwarded.length, tapped.length - 1, "everything but the refused request reached the model");
	assert.ok(forwarded.length < 30, "the context limit, not the request cap, ended the run");
	for (const request of forwarded) assert.ok(estimateInputTokens(request.body) <= 48_000);
	assert.ok(estimateInputTokens(forwarded.at(-1)?.body) > 40_000, "the input really grew up to the limit");
	assert.equal(run.model_requests, forwarded.length, "the refused request is not counted");
	assert.deepEqual(await stack.worktrees(), []);
	assertStoppedCleanly(stack);
});

// ---------------------------------------------------------------------------------------------------------------
// (g) The run deadline; (h) /status during 2 runs, /cancel of a running and of a queued task.

/** Gone from the Docker daemon (agent containers are named and recorded in runs.container). */
function dockerContainerGone(name: string): boolean {
	const result = spawnSync("docker", ["ps", "-a", "-q", "--filter", `name=^/${name}$`], {
		encoding: "utf8",
		timeout: 30_000,
	});
	return result.status === 0 && result.stdout.trim() === "";
}

/** The run's Pi process and agent container are gone (the local sandbox's containers are the engine's own records). */
async function assertWorkloadGone(stack: Stack, run: RunRow, sandbox: "local" | "docker"): Promise<void> {
	assert.ok(run.pid !== null, "the run had a Pi process");
	await waitFor(() => processGone(run.pid as number), { what: "Pi process gone", timeoutMs: 20_000 });
	assert.ok(run.container !== null, "the run had an agent container");
	if (sandbox === "docker") assert.ok(dockerContainerGone(run.container), `container ${run.container} is gone`);
	const slot = stack.coordinator.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM slots WHERE run_id = ?", run.id);
	// finalizeRun releases a run's slot only after sandbox.live({task, generation}) was verified empty.
	assert.equal(slot?.n, 0, "the slot was released after the stop was verified");
	assert.equal(stack.coordinator.store.groupState(stack.config.telegram.groupChatId).state, "normal");
}

async function lastCommitMessage(stack: Stack, branch: string): Promise<string> {
	return (await originGit(stack.origin.bare, ["log", "-1", "--format=%s", `refs/heads/${branch}`])).stdout.trim();
}

async function runDeadline(t: TestContext, sandbox: "local" | "docker"): Promise<void> {
	// Test-only: a short run deadline instead of 10 minutes (same timer path); Docker needs more for run 1's start.
	const runDeadlineMs = sandbox === "docker" ? 15_000 : 4000;
	const { stack } = await tappedStack(t, {
		sandbox,
		limits: { runDeadlineMs },
		model: scriptedAgent([
			{
				when: /^job-g1/,
				steps: [{ toolCalls: [{ name: "write", args: { path: "g1.txt", content: "g1\n" } }] }, { text: "g1 done" }],
			},
			// Run 2 writes a file, then the model never answers: only the deadline ends the run.
			{
				when: /^job-g2/,
				steps: [{ toolCalls: [{ name: "write", args: { path: "g2.txt", content: "g2\n" } }] }, { hang: true }],
			},
		]),
	});
	stack.sendCommand(USER1, "/task alpha job-g1 write g1.txt");
	const review = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/, { timeoutMs: 120_000 });
	const head1 = task(stack, 1).head_commit as string;
	stack.reply(USER1, review.id, "job-g2 write g2.txt as well");
	const failed = await stack.waitForBotMessage(/^Task 1 failed/, {
		since: review.id,
		timeoutMs: runDeadlineMs + 60_000,
	});
	assert.equal(
		failed.text,
		`Task 1 failed: ${runDeadlineMs} ms run deadline. Pull request closed; branch task/1 kept. Send a new /task for further work.`,
	);
	await stack.coordinator.idle();
	const run2 = lastRun(stack, 1);
	assert.deepEqual([run2.state, run2.reason], ["failed", `${runDeadlineMs} ms run deadline`]);
	const ended = stack.coordinator.store.get<{ started_at: number; ended_at: number }>(
		"SELECT started_at, ended_at FROM runs WHERE id = ?",
		run2.id,
	);
	assert.ok(ended !== undefined && ended.ended_at - ended.started_at >= runDeadlineMs, "it ran until the deadline");
	await assertWorkloadGone(stack, run2, sandbox);
	assert.equal(task(stack, 1).state, "failed");
	assert.equal(stack.github.pulls.get(1)?.state, "closed");
	assert.deepEqual(await stack.worktrees(), [], "worktree archived");
	assert.equal(await fileAt(stack, "task/1", "g2.txt"), "g2\n", "run 2's work is in the final checkpoint on GitHub");
	assert.equal(await lastCommitMessage(stack, "task/1"), "Task 1: final checkpoint");
	assert.ok(await stack.isAncestor(head1, (await stack.branchSha("task/1")) as string), "no force push");
}

test(
	"run deadline: the run is stopped, the task fails with the deadline, the PR is closed, the worktree archived",
	{
		timeout: 180_000,
	},
	(t) => runDeadline(t, "local"),
);

test("run deadline on the production Docker sandbox", { timeout: 300_000, skip: dockerUnavailable() }, (t) =>
	runDeadline(t, "docker"),
);

async function cancelRunning(t: TestContext, sandbox: "local" | "docker"): Promise<void> {
	const hold = gate();
	const { stack, tap } = await tappedStack(
		t,
		{
			sandbox,
			env: { PI_AGENTS: "alpha,beta,gamma" },
			model: scriptedAgent([
				{
					when: /^job-h1/,
					steps: [{ toolCalls: [{ name: "write", args: { path: "h1.txt", content: "h1\n" } }] }, { text: "h1 done" }],
				},
				{
					when: /^job-h2/,
					steps: [{ toolCalls: [{ name: "write", args: { path: "h2.txt", content: "h2\n" } }] }, { hang: true }],
				},
				{ when: /^job-h3/, steps: [hold.promise.then((): FakeStep => ({ text: "h3 done" }))] },
				{ when: /^job-h4/, steps: [{ text: "h4 done" }] },
			]),
		},
		[hold],
	);
	stack.sendCommand(USER1, "/task alpha job-h1 write h1.txt");
	const review = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/, { timeoutMs: 120_000 });
	const head1 = task(stack, 1).head_commit as string;
	stack.sendCommand(USER2, "/task beta job-h3 hold beta");
	await waitForModel(stack, "job-h3");
	stack.reply(USER1, review.id, "job-h2 write h2.txt too");
	// Run 2 has written h2.txt and waits on the model.
	await waitFor(() => requestsFor(stack, /^job-h2/).length === 2, { what: "run 2 after its write", timeoutMs: 60_000 });
	assert.equal(
		await command(stack, USER1, "/task gamma job-h4 queued gamma task"),
		"Task 3 accepted for agent gamma. Queue position 1. Waiting for an execution slot (2/2 in use).",
	);

	// /status works while 2 tasks run.
	const status = await statusLines(stack, USER2);
	assert.match(status.get(0) ?? "", /^Coordinator: live .*slots 2\/2/);
	assertStatusPrefix(status, 1, `Task 1 · alpha · running · https://github.com/${REPO}/pull/1`);
	assertStatusPrefix(status, 2, "Task 2 · beta · running");
	assertStatusPrefix(
		status,
		3,
		"Task 3 · gamma · queued · queue position 1 · waiting for an execution slot (2/2 in use)",
	);

	// /cancel of a queued task removes it from the queue at once; nothing of it ever ran.
	assert.equal(await command(stack, USER1, "/cancel 3"), "Task 3 cancelled.");
	assert.deepEqual([task(stack, 3).state, lastRun(stack, 3).state], ["cancelled", "cancelled"]);

	// /cancel of the running task: revoke, stop, final checkpoint + push, close the PR, archive.
	const run2 = lastRun(stack, 1);
	const key = tap.keyOf(run2.id);
	assert.ok(key !== undefined);
	assert.ok(
		tap.forRun(run2.id).every((entry) => entry.status === 200),
		"the run key worked while the run was running",
	);
	assert.equal(
		await command(stack, OWNER, "/cancel 1"),
		"Cancelling Task 1… You will get a message once its run is stopped and its work is saved to its branch.",
	);
	const cancelled = await stack.waitForBotMessage(/^Task 1 cancelled/, { since: review.id, timeoutMs: 60_000 });
	assert.equal(cancelled.text, "Task 1 cancelled. Pull request closed; branch task/1 kept.");
	await waitFor(() => stack.coordinator.engine.activeRuns().length === 1, { what: "only task 2 still running" });
	const finalRun2 = lastRun(stack, 1);
	assert.deepEqual([finalRun2.id, finalRun2.state, task(stack, 1).state], [run2.id, "cancelled", "cancelled"]);

	// The run key is closed: the relay refuses it from now on (and nothing reaches the model).
	const before = stack.model.requests.length;
	const replay = await fetch(`${stack.coordinator.relayUrl}/responses`, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({ model: "gpt-4.1-mini", input: [{ role: "user", content: "after cancel" }] }),
	});
	assert.equal(replay.status, 401);
	assert.equal(((await replay.json()) as { error: { message: string } }).error.message, "run key not open");
	assert.equal(stack.model.requests.length, before);
	const openKeys = stack.coordinator.store.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM run_keys WHERE run_id = ? AND state = 'open'",
		run2.id,
	);
	assert.equal(openKeys?.n, 0);

	await assertWorkloadGone(stack, finalRun2, sandbox);
	assert.equal(await fileAt(stack, "task/1", "h2.txt"), "h2\n", "the remaining work is committed and pushed");
	assert.equal(await lastCommitMessage(stack, "task/1"), "Task 1: final checkpoint");
	assert.ok(await stack.isAncestor(head1, (await stack.branchSha("task/1")) as string));
	assert.deepEqual(await stack.worktrees(), ["task-2"], "task 1's worktree archived");
	assert.deepEqual([task(stack, 1).worktree_path, task(stack, 1).archived], [null, 1]);
	assert.equal(stack.github.pulls.get(1)?.state, "closed");
	assert.equal(stack.github.pulls.get(1)?.merged, false);
	// Kept; task 2 (still running) pushes at its review step, task 3 never got a branch.
	assert.deepEqual(await stack.branches(), ["main", "task/1"]);

	// The freed slot does not start the cancelled queued task; a later reply to task 1 is rejected.
	await dispatchPass(stack);
	assert.equal(requestsFor(stack, /^job-h4/).length, 0);
	assert.equal(runsOf(stack, 3).length, 1);
	const late = stack.reply(USER1, review.id, "one more thing");
	assert.match((await replyTo(stack, late)).text, /^Follow-up rejected: Task 1 was cancelled; send a new \/task/);

	// Task 2 is untouched and still finishes normally.
	hold.open();
	await stack.waitForBotMessage(/^Task 2 finished with no changes \(run 1\)/, {
		since: cancelled.id,
		timeoutMs: 60_000,
	});
	assert.equal(task(stack, 2).state, "review");
}

test(
	"/status while 2 tasks run; /cancel of a queued task and of a running one (key closed, work saved, PR closed)",
	{
		timeout: 180_000,
	},
	(t) => cancelRunning(t, "local"),
);

test(
	"/cancel of a running task on the production Docker sandbox",
	{ timeout: 300_000, skip: dockerUnavailable() },
	(t) => cancelRunning(t, "docker"),
);
