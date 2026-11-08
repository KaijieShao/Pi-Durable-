/**
 * Follow-ups end to end through the real Coordinator (commands, engine, relay, outbox, poller, git, GitHub client,
 * Pi runner process) against 127.0.0.1 fakes (Telegram, GitHub, model). Spec: Requirements § Follow-ups,
 * § Permissions; Architecture § Request Flow (follow-up during a run / during review); Agent Execution § Finalize
 * and Pending Inputs; Evaluation fault rows Permissions, Steer while busy, Duplicate update ID, Accepted follow-up
 * outcomes, Steer at normal completion, Follow-up during review, Follow-up after merge.
 *
 * No sleeps are used as synchronization: the fake model holds a request on a gate that the test opens once the
 * store (or Telegram) shows the state the scenario needs. Every test ends by checking that each accepted follow-up
 * got exactly one outcome (delivered / started another run / expired), counted in the outbox and in Telegram.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Update } from "grammy/types";
import { waitFor } from "../helpers/env.ts";
import { type FakeHandler, type FakeStep, type RecordedRequest, userTexts } from "../helpers/fake-model.ts";
import { agentPosition, GROUP, OWNER, type Stack, startStack, USER1, USER2 } from "./harness.ts";

const TASK_TEXT = "add a greet(name) helper in greet.js with a test";
const GREET_JS = 'exports.greet = (name) => "Hello, " + name + "!";\n';
const write = (path: string, content: string): FakeStep => ({
	toolCalls: [{ name: "write", args: { path, content } }],
});

// ---------------------------------------------------------------------------------------------------------------
// Gates and a scripted agent whose steps may wait

/** A one-shot latch: the model opens one to say "this request arrived", the test opens one to release a request. */
type Gate = { readonly opened: Promise<void>; open(): void };

function gate(): Gate {
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open: () => open() };
}

/** A step that signals `arrived`, then answers `step` once `release` opens. */
function held(arrived: Gate, release: Gate, step: FakeStep): () => Promise<FakeStep> {
	return async () => {
		arrived.open();
		await release.opened;
		return step;
	};
}

type Step = FakeStep | (() => FakeStep | Promise<FakeStep>);
type Plan = { readonly when: RegExp; readonly steps: readonly Step[] };

/**
 * The plan whose `when` matches the newest user message of the request (the run's input, or the latest follow-up
 * placed into the conversation); step k answers after k tool rounds since that message.
 */
function agent(plans: readonly Plan[]): FakeHandler {
	return async (request) => {
		const { input, round } = agentPosition(request);
		const plan = plans.find((candidate) => candidate.when.test(input));
		const step = plan?.steps[round] ?? plan?.steps.at(-1) ?? { text: "I have no plan for this input." };
		return typeof step === "function" ? step() : step;
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Store and fake inspection

type TaskRow = {
	id: number;
	state: string;
	reason: string | null;
	update_id: number;
	head_commit: string | null;
	followup_count: number;
	pr_number: number | null;
	worktree_path: string | null;
};
type RunRow = {
	id: number;
	task_id: number;
	kind: string;
	state: string;
	reason: string | null;
	requested_by: number;
	request_id: string;
	conversation_id: string;
	model_requests: number;
	started_at: number;
	answer: string | null;
};
type FollowupRow = {
	id: number;
	task_id: number;
	update_id: number;
	user_id: number;
	message_id: number;
	text: string;
	mode: string;
	run_id: number | null;
	state: string;
	reason: string | null;
};
type OutboxRow = { id: number; kind: string; text: string; reply_to: number | null; state: string };

const OUTCOME_TEXT: Readonly<Record<string, RegExp>> = {
	delivered: /^Follow-up delivered to Task \d+\./,
	started: /^Follow-up started another run of Task \d+ /,
	expired: /^Follow-up to Task \d+ expired: /,
};

function isOutcome(text: string): boolean {
	return Object.values(OUTCOME_TEXT).some((pattern) => pattern.test(text));
}

function outbox(stack: Stack): OutboxRow[] {
	return stack.coordinator.store.all<OutboxRow>("SELECT id, kind, text, reply_to, state FROM outbox ORDER BY id");
}

function task1(stack: Stack): TaskRow {
	const task = stack.tasks<TaskRow>()[0];
	assert.ok(task !== undefined, "Task 1 exists");
	return task;
}

function onlyRun(stack: Stack): RunRow {
	const runs = stack.runs<RunRow>();
	assert.equal(runs.length, 1, "exactly one run row");
	return runs[0] as RunRow;
}

function count(stack: Stack, sql: string, ...params: (number | string)[]): number {
	return stack.coordinator.store.get<{ n: number }>(sql, ...params)?.n ?? -1;
}

function followupState(stack: Stack, messageId: number): string | undefined {
	return stack.followups<FollowupRow>().find((followup) => followup.message_id === messageId)?.state;
}

async function followupReaches(stack: Stack, messageId: number, state: string): Promise<void> {
	await waitFor(() => followupState(stack, messageId) === state, {
		what: `follow-up ${messageId} ${state}`,
		timeoutMs: 30_000,
	});
}

/** The bot's reply to the user's message `messageId` (the first one; see repliesTo for all). */
function replyTo(stack: Stack, messageId: number, match: RegExp) {
	return stack.waitForBotMessage((message) => message.replyTo === messageId && match.test(message.text));
}

function repliesTo(stack: Stack, messageId: number): string[] {
	return stack.bot
		.sent()
		.filter((message) => message.chatId === GROUP && message.replyTo === messageId)
		.map((message) => message.text);
}

/** Model requests whose newest user message matches `input`. */
function requestsFor(stack: Stack, input: RegExp): RecordedRequest[] {
	return stack.model.requests.filter((request) => input.test(agentPosition(request).input));
}

/** How many user messages of one model request are exactly `text`. */
function userMessageCount(request: RecordedRequest | undefined, text: string): number {
	return userTexts(request?.body).filter((candidate) => candidate === text).length;
}

type PiSubmission = { requestId: string | null; status: string; answer: unknown };

/** Pi's own submissions of a conversation, read from its SQLite file (after the run closed it). */
function piSubmissions(stack: Stack, conversationId: string): PiSubmission[] {
	const conversation = stack.coordinator.store.get<{ path: string }>(
		"SELECT path FROM conversations WHERE id = ?",
		conversationId,
	);
	assert.ok(conversation !== undefined, "the conversation is recorded");
	const db = new DatabaseSync(conversation.path, { readOnly: true });
	try {
		const rows = db.prepare("SELECT record FROM submissions ORDER BY id").all() as { record: string }[];
		return rows.map((row) => {
			const record = JSON.parse(row.record) as { requestId?: string; status: string; answer?: unknown };
			// A settled "done" submission names the entry of the answer that settled it.
			if (record.status === "done") assert.notEqual(record.answer, undefined, "a done submission has its answer");
			return { requestId: record.requestId ?? null, status: record.status, answer: record.answer };
		});
	} finally {
		db.close();
	}
}

/**
 * Requirements § Follow-up outcomes: every accepted follow-up (a `followups` row) ends with exactly one outcome
 * the user sees, matching its final state: exactly one outcome row in the outbox replying to the follow-up, sent,
 * and exactly one such message in Telegram.
 */
async function assertOneOutcomeEach(stack: Stack, expected: Readonly<Record<number, string>>): Promise<void> {
	await stack.coordinator.idle();
	const followups = stack.followups<FollowupRow>();
	assert.deepEqual(
		Object.fromEntries(followups.map((followup) => [followup.message_id, followup.state])),
		Object.fromEntries(Object.entries(expected)),
		"accepted follow-ups and their final states",
	);
	const rows = outbox(stack);
	for (const followup of followups) {
		const pattern = OUTCOME_TEXT[followup.state];
		assert.ok(pattern !== undefined, `follow-up ${followup.id} is settled (${followup.state})`);
		const outcomes = rows.filter((row) => row.reply_to === followup.message_id && isOutcome(row.text));
		assert.equal(outcomes.length, 1, `exactly one outcome row for follow-up ${followup.id}`);
		assert.match(outcomes[0]?.text ?? "", pattern);
		assert.equal(outcomes[0]?.state, "sent");
		const seen = repliesTo(stack, followup.message_id).filter(isOutcome);
		assert.equal(seen.length, 1, `exactly one outcome message in Telegram for follow-up ${followup.id}`);
	}
}

/** A follow-up reply kept as an Update object, so the test can deliver the very same update again. */
let nextOwnMessageId = 70_000;
function replyUpdate(stack: Stack, userId: number, toMessageId: number, text: string): Update {
	return stack.bot.groupMessage({
		chatId: GROUP,
		fromId: userId,
		text,
		messageId: nextOwnMessageId++,
		replyTo: { messageId: toMessageId, text: "bot message" },
	});
}

function messageIdOf(update: Update): number {
	const id = update.message?.message_id;
	assert.ok(id !== undefined);
	return id;
}

/** Wait until the poller handled everything queued so far: a /status sent now is answered after it. */
async function drainUpdates(stack: Stack): Promise<void> {
	const probe = stack.sendCommand(USER2, "/status");
	await replyTo(stack, probe, /^Group: /);
}

// ---------------------------------------------------------------------------------------------------------------
// (a) Steer while busy

test("a reply while the task runs is steered into the same run: next request carries it, delivered, limits not reset", {
	timeout: 120_000,
}, async (t) => {
	const steerText = "STEER: also mention the README";
	const roundTwo = gate();
	const release = gate();
	const stack = await startStack({
		model: agent([
			{
				when: /^add a greet\(name\) helper/,
				steps: [
					write("greet.js", GREET_JS),
					// Held until the reply is with Pi, so it lands at this run's next tool-round boundary.
					held(roundTwo, release, write("notes.txt", "notes\n")),
				],
			},
			{ when: /^STEER: also mention the README/, steps: [{ text: "Done, README mentioned." }] },
		]),
	});
	t.after(() => {
		release.open();
		return stack.stop();
	});
	stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	const ack = await stack.waitForBotMessage(/^Task 1 accepted for agent alpha/);
	await roundTwo.opened;

	// The run is mid tool round: two model requests counted on the run row so far.
	const before = onlyRun(stack);
	assert.equal(before.state, "running");
	assert.equal(before.model_requests, 2);

	const steer = stack.reply(USER1, ack.id, steerText);
	await replyTo(
		stack,
		steer,
		/^Follow-up saved; it will be steered into the running Task 1 \(in progress, not queued\)\./,
	);
	await followupReaches(stack, steer, "submitted");
	assert.equal(stack.model.requests.length, 2, "the steer waits for the tool round; it does not start a request");
	release.open();

	const delivered = await replyTo(stack, steer, /^Follow-up delivered to Task 1\./);
	const review = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/, { since: delivered.id });
	assert.ok(review.text.includes("Done, README mentioned."), review.text);
	await stack.coordinator.idle();

	// The next model request carries the reply, after the held tool round, in the task's own history.
	assert.equal(stack.model.requests.length, 3);
	const steered = requestsFor(stack, /^STEER: also mention the README/);
	assert.equal(steered.length, 1);
	assert.equal(steered[0], stack.model.requests[2], "the very next request carries the steer");
	assert.equal(userMessageCount(steered[0], steerText), 1);
	const history = JSON.stringify(steered[0]?.body.input);
	assert.ok(history.includes(TASK_TEXT) && history.includes("notes.txt"), "placed after the held tool round");

	// Same run, same conversation, limits not reset: the request counter continued (2 → 3), one run key, every
	// budget reservation on this run, the deadline's start unchanged.
	const after = onlyRun(stack);
	assert.equal(after.id, before.id);
	assert.equal(after.state, "finished");
	assert.equal(after.model_requests, 3);
	assert.equal(after.started_at, before.started_at);
	assert.equal(after.conversation_id, before.conversation_id);
	assert.equal(count(stack, "SELECT COUNT(*) AS n FROM run_keys WHERE run_id = ?", after.id), 1);
	assert.equal(count(stack, "SELECT COUNT(*) AS n FROM budget WHERE run_id = ?", after.id), 3);
	assert.equal(count(stack, "SELECT COUNT(*) AS n FROM budget WHERE run_id <> ?", after.id), 0);
	assert.equal(count(stack, "SELECT COUNT(*) AS n FROM conversations"), 1);

	// Pi: the steer joined the running work (one Pi run: both submissions settled with the same answer).
	const submissions = piSubmissions(stack, after.conversation_id);
	const [followup] = stack.followups<FollowupRow>();
	assert.deepEqual(
		submissions.map((submission) => [submission.requestId, submission.status]),
		[
			[after.request_id, "done"],
			[String(followup?.update_id), "done"],
		],
	);
	assert.equal(submissions[0]?.answer, submissions[1]?.answer);

	// No new run, branch or pull request.
	assert.deepEqual(await stack.branches(), ["main", "task/1"]);
	assert.deepEqual(await stack.worktrees(), ["task-1"]);
	assert.equal(stack.github.pulls.size, 1);
	assert.deepEqual([followup?.mode, followup?.run_id], ["steer", after.id]);
	assert.equal(task1(stack).followup_count, 1);
	await assertOneOutcomeEach(stack, { [steer]: "delivered" });
});

// ---------------------------------------------------------------------------------------------------------------
// (b) Steer at normal completion

test("a steer arriving as the run answers becomes one successor run in the same run row; finalize waits for it", {
	timeout: 120_000,
}, async (t) => {
	const steerText = "LATE: please also export greet as default";
	const answering = gate();
	const releaseAnswer = gate();
	const successorAsked = gate();
	const releaseSuccessor = gate();
	const stack = await startStack({
		model: agent([
			{
				when: /^add a greet\(name\) helper/,
				steps: [write("greet.js", GREET_JS), held(answering, releaseAnswer, { text: "First answer: greet added." })],
			},
			{ when: /^LATE: /, steps: [held(successorAsked, releaseSuccessor, { text: "Second answer: default too." })] },
		]),
	});
	t.after(() => {
		releaseAnswer.open();
		releaseSuccessor.open();
		return stack.stop();
	});
	stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	const ack = await stack.waitForBotMessage(/^Task 1 accepted for agent alpha/);
	// The model is writing the run's final answer (request 2 of the run).
	await answering.opened;
	const steer = stack.reply(USER1, ack.id, steerText);
	await replyTo(stack, steer, /^Follow-up saved; it will be steered into the running Task 1/);
	await followupReaches(stack, steer, "submitted");
	releaseAnswer.open();

	// Pi answered, then took the unconsumed steer as the input of one successor run, in the same Pi process and
	// Coordinator run. While the successor works, finalize waits: the run is still running and nothing is posted.
	await successorAsked.opened;
	const during = onlyRun(stack);
	assert.equal(during.state, "running");
	assert.equal(during.model_requests, 3, "the successor's request is counted on the same run row");
	assert.equal(task1(stack).state, "running");
	assert.ok(!outbox(stack).some((row) => /ready for review/.test(row.text)), "no review queued before it drains");
	assert.equal(stack.github.pulls.size, 0);
	const successor = stack.model.requests[2];
	assert.equal(agentPosition(successor ?? { body: {} }).input, steerText);
	assert.ok(JSON.stringify(successor?.body.input).includes("First answer: greet added."), "it continues the run");
	releaseSuccessor.open();

	const review = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/, { since: ack.id });
	assert.ok(review.text.includes("Second answer: default too."), review.text);
	await stack.coordinator.idle();
	const run = onlyRun(stack);
	assert.equal(run.state, "finished");
	assert.equal(run.model_requests, 3);
	assert.equal(run.answer, "Second answer: default too.");
	assert.equal(count(stack, "SELECT COUNT(*) AS n FROM run_keys WHERE run_id = ?", run.id), 1);
	const [followup] = stack.followups<FollowupRow>();
	assert.deepEqual([followup?.mode, followup?.state, followup?.run_id], ["steer", "delivered", run.id]);

	// The successor's requestId is the follow-up's update id; it is a second Pi run (its own answer).
	const submissions = piSubmissions(stack, run.conversation_id);
	assert.deepEqual(
		submissions.map((submission) => [submission.requestId, submission.status]),
		[
			[String(task1(stack).update_id), "done"],
			[String(followup?.update_id), "done"],
		],
	);
	assert.notEqual(submissions[0]?.answer, submissions[1]?.answer, "two Pi runs: the run and its successor");

	// Finalize waited for the successor: the delivered outcome is queued before the review message.
	const rows = outbox(stack);
	const deliveredRow = rows.find((row) => row.reply_to === steer && /^Follow-up delivered/.test(row.text));
	const reviewRow = rows.find((row) => /^Task 1 is ready for review/.test(row.text));
	assert.ok(deliveredRow !== undefined && reviewRow !== undefined && deliveredRow.id < reviewRow.id);
	assert.equal(stack.github.pulls.size, 1);
	assert.deepEqual(await stack.branches(), ["main", "task/1"]);
	await assertOneOutcomeEach(stack, { [steer]: "delivered" });
});

// ---------------------------------------------------------------------------------------------------------------
// (c) Permissions, and (f) a reply after the merge

test("only the creator or the owner can follow up (also approve and cancel); after the merge a reply is rejected", {
	timeout: 180_000,
}, async (t) => {
	const ownerSteer = "OWNER STEER: keep greet.js tiny";
	const ownerFollowup = "OWNER FOLLOW-UP: add a farewell(name) helper";
	const strangerText = "STRANGER: delete everything";
	const roundTwo = gate();
	const release = gate();
	const stack = await startStack({
		model: agent([
			{
				when: /^add a greet\(name\) helper/,
				steps: [write("greet.js", GREET_JS), held(roundTwo, release, write("notes.txt", "notes\n"))],
			},
			{ when: /^OWNER STEER: /, steps: [{ text: "Kept greet.js tiny." }] },
			{
				when: /^OWNER FOLLOW-UP: /,
				steps: [write("farewell.js", 'exports.farewell = (n) => "Bye " + n;\n'), { text: "Added farewell." }],
			},
			{ when: /^STRANGER: /, steps: [{ text: "This must never be asked." }] },
		]),
	});
	t.after(() => {
		release.open();
		return stack.stop();
	});
	stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	const ack = await stack.waitForBotMessage(/^Task 1 accepted for agent alpha/);
	await roundTwo.opened;

	// While running: another member's reply is rejected; the owner's reply is steered in.
	const strangerSteer = stack.reply(USER2, ack.id, strangerText);
	await replyTo(
		stack,
		strangerSteer,
		/^Follow-up rejected: only the creator of Task 1 or the group owner can follow up on it\./,
	);
	assert.equal(stack.followups().length, 0);
	const steer = stack.reply(OWNER, ack.id, ownerSteer);
	await replyTo(stack, steer, /^Follow-up saved; it will be steered into the running Task 1/);
	await followupReaches(stack, steer, "submitted");
	release.open();
	await replyTo(stack, steer, /^Follow-up delivered to Task 1\./);
	const review1 = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);

	// In review: another member can neither follow up, approve nor cancel.
	const strangerReply = stack.reply(USER2, review1.id, strangerText);
	await replyTo(stack, strangerReply, /^Follow-up rejected: only the creator of Task 1 or the group owner/);
	const strangerApprove = stack.sendCommand(USER2, "/approve 1");
	await replyTo(
		stack,
		strangerApprove,
		/^\/approve rejected: only the creator of Task 1 or the group owner can approve/,
	);
	const strangerCancel = stack.sendCommand(USER2, "/cancel 1");
	await replyTo(stack, strangerCancel, /^\/cancel rejected: only the creator of Task 1 or the group owner can cancel/);
	await stack.coordinator.idle();
	assert.equal(task1(stack).state, "review");
	assert.equal(stack.runs().length, 1);
	assert.equal(count(stack, "SELECT COUNT(*) AS n FROM approvals"), 0);

	// The owner's reply during review starts another run of the task, counted against the owner.
	const followup = stack.reply(OWNER, review1.id, ownerFollowup);
	await replyTo(
		stack,
		followup,
		/^Follow-up started another run of Task 1 on the same branch and pull request\. Queue position 1\./,
	);
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 2\)/, { since: review1.id });
	const runs = stack.runs<RunRow>();
	assert.deepEqual(
		runs.map((run) => [run.kind, run.requested_by, run.state]),
		[
			["initial", USER1, "finished"],
			["followup", OWNER, "finished"],
		],
	);
	assert.equal(stack.github.pulls.size, 1);

	// The creator approves; after the merge, replies from anyone are rejected with a hint to send a new /task.
	const approve = stack.sendCommand(USER1, "/approve 1");
	await replyTo(stack, approve, /^Approved Task 1 at /);
	await stack.waitForBotMessage(/^Task 1 merged into main/);
	await stack.coordinator.idle();
	const lateCreator = stack.reply(USER1, review1.id, "one more change please");
	await replyTo(
		stack,
		lateCreator,
		/^Follow-up rejected: Task 1 is already merged; send a new \/task for further work\./,
	);
	const lateOwner = stack.reply(OWNER, review1.id, "and another one");
	await replyTo(stack, lateOwner, /^Follow-up rejected: Task 1 is already merged; send a new \/task/);
	const lateStranger = stack.reply(USER2, review1.id, strangerText);
	await replyTo(stack, lateStranger, /^Follow-up rejected: only the creator of Task 1 or the group owner/);
	await stack.coordinator.idle();

	assert.equal(task1(stack).state, "merged");
	assert.equal(stack.runs().length, 2, "no run after the merge");
	assert.equal(task1(stack).followup_count, 2, "rejected replies are not counted");
	assert.equal(requestsFor(stack, /^STRANGER: /).length, 0, "a rejected reply never reaches the model");
	assert.ok(!stack.model.requests.some((request) => JSON.stringify(request.body).includes(strangerText)));
	for (const rejected of [strangerSteer, strangerReply, lateCreator, lateOwner, lateStranger]) {
		assert.deepEqual(
			repliesTo(stack, rejected).map((text) => text.startsWith("Follow-up rejected: ")),
			[true],
			"exactly one reply, the rejection",
		);
	}
	await assertOneOutcomeEach(stack, { [steer]: "delivered", [followup]: "started" });
});

// ---------------------------------------------------------------------------------------------------------------
// (d) Duplicate update ID

test("the same Telegram update delivered twice makes one follow-up and one Pi submission (steer and review run)", {
	timeout: 180_000,
}, async (t) => {
	const steerText = "STEER: also log the name";
	const followupText = "FOLLOW-UP: add a farewell(name) helper";
	const roundTwo = gate();
	const release = gate();
	const stack = await startStack({
		model: agent([
			{
				when: /^add a greet\(name\) helper/,
				steps: [write("greet.js", GREET_JS), held(roundTwo, release, write("notes.txt", "notes\n"))],
			},
			{ when: /^STEER: /, steps: [{ text: "Logged the name." }] },
			{
				when: /^FOLLOW-UP: /,
				steps: [write("farewell.js", 'exports.farewell = (n) => "Bye " + n;\n'), { text: "Added farewell." }],
			},
		]),
	});
	t.after(() => {
		release.open();
		return stack.stop();
	});
	stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	const ack = await stack.waitForBotMessage(/^Task 1 accepted for agent alpha/);
	await roundTwo.opened;

	// A steer, saved and with Pi; then Telegram delivers the very same update again.
	const steerUpdate = replyUpdate(stack, USER1, ack.id, steerText);
	const steer = messageIdOf(steerUpdate);
	await replyTo(stack, steer, /^Follow-up saved; it will be steered into the running Task 1/);
	await followupReaches(stack, steer, "submitted");
	stack.bot.redeliver(steerUpdate);
	await drainUpdates(stack);
	assert.equal(stack.followups().length, 1);
	assert.equal(count(stack, "SELECT COUNT(*) AS n FROM commands WHERE update_id = ?", steerUpdate.update_id), 1);
	assert.equal(repliesTo(stack, steer).length, 1, "no second acknowledgement");
	release.open();
	await replyTo(stack, steer, /^Follow-up delivered to Task 1\./);
	const review1 = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);

	// A follow-up during review, delivered twice: right away, and again after its run finished (in review again,
	// where a second copy would otherwise start another run).
	const followupUpdate = replyUpdate(stack, USER1, review1.id, followupText);
	const followup = messageIdOf(followupUpdate);
	await replyTo(stack, followup, /^Follow-up started another run of Task 1 on the same branch and pull request/);
	stack.bot.redeliver(followupUpdate);
	await drainUpdates(stack);
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 2\)/, { since: review1.id });
	await stack.coordinator.idle();
	stack.bot.redeliver(followupUpdate);
	stack.bot.redeliver(steerUpdate);
	await drainUpdates(stack);
	await stack.coordinator.idle();

	assert.equal(task1(stack).state, "review");
	const runs = stack.runs<RunRow>();
	assert.equal(runs.length, 2, "one run for the follow-up, none for its copies");
	assert.equal(runs[1]?.request_id, String(followupUpdate.update_id));
	assert.equal(stack.followups().length, 2);
	assert.equal(task1(stack).followup_count, 2);
	assert.equal(count(stack, "SELECT COUNT(*) AS n FROM commands WHERE update_id = ?", followupUpdate.update_id), 1);
	assert.equal(repliesTo(stack, followup).length, 1, "one reply: started another run");
	assert.equal(repliesTo(stack, steer).length, 2, "two replies: saved, then delivered");
	assert.equal(stack.github.pulls.size, 1);

	// Pi saw each requestId once: one submission per follow-up in the (reused) conversation, and each text once.
	assert.equal(runs[1]?.conversation_id, runs[0]?.conversation_id);
	const submissions = piSubmissions(stack, runs[0]?.conversation_id ?? "");
	const ids = submissions.map((submission) => submission.requestId);
	assert.deepEqual(ids, [runs[0]?.request_id, String(steerUpdate.update_id), String(followupUpdate.update_id)]);
	const last = stack.model.requests.at(-1);
	assert.equal(userMessageCount(last, steerText), 1);
	assert.equal(userMessageCount(last, followupText), 1);
	await assertOneOutcomeEach(stack, { [steer]: "delivered", [followup]: "started" });
});

// ---------------------------------------------------------------------------------------------------------------
// (e) Follow-up count and length limits

test("follow-ups over 4000 characters, and the 6th follow-up of a task, are rejected with their reasons", {
	timeout: 120_000,
}, async (t) => {
	const exactly = `STEER 1 ${"a".repeat(4000 - 8)}`;
	const over = `STEER X ${"b".repeat(4001 - 8)}`;
	const roundTwo = gate();
	const release = gate();
	const stack = await startStack({
		model: agent([
			{
				when: /^add a greet\(name\) helper/,
				steps: [write("greet.js", GREET_JS), held(roundTwo, release, write("notes.txt", "notes\n"))],
			},
			{ when: /^STEER \d/, steps: [{ text: "Handled all five notes." }] },
		]),
	});
	t.after(() => {
		release.open();
		return stack.stop();
	});
	stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	const ack = await stack.waitForBotMessage(/^Task 1 accepted for agent alpha/);
	await roundTwo.opened;

	// 4001 characters: rejected with the length and the limit, not counted.
	const tooLong = stack.reply(USER1, ack.id, over);
	await replyTo(
		stack,
		tooLong,
		/^Follow-up rejected: the follow-up text is too long \(4001 characters; the limit is 4000\)\./,
	);
	assert.equal(task1(stack).followup_count, 0);
	assert.equal(stack.followups().length, 0);

	// 4000 characters is accepted; with four more the task has its 5 follow-ups; the 6th is rejected.
	const accepted = [stack.reply(USER1, ack.id, exactly)];
	for (const n of [2, 3, 4, 5]) accepted.push(stack.reply(USER1, ack.id, `STEER ${n}: note number ${n}`));
	for (const id of accepted) await replyTo(stack, id, /^Follow-up saved; it will be steered into the running Task 1/);
	const sixth = stack.reply(USER1, ack.id, "STEER 6: one too many");
	await replyTo(
		stack,
		sixth,
		/^Follow-up rejected: Task 1 already has 5 follow-ups, the limit; send a new \/task for further work\./,
	);
	for (const id of accepted) await followupReaches(stack, id, "submitted");
	release.open();
	const review = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);

	// The limit is per task, not per run: a reply during review is rejected too, and no run starts.
	const seventh = stack.reply(USER1, review.id, "STEER 7: during review");
	await replyTo(stack, seventh, /^Follow-up rejected: Task 1 already has 5 follow-ups, the limit/);
	await stack.coordinator.idle();
	assert.equal(stack.runs().length, 1);
	assert.equal(task1(stack).followup_count, 5);

	// The five reached the model in full at the next boundary; the rejected ones never did.
	const steered = stack.model.requests[2];
	assert.equal(stack.model.requests.length, 3);
	assert.equal(userMessageCount(steered, exactly), 1, "the 4000-character follow-up arrives whole");
	for (const n of [2, 3, 4, 5]) assert.equal(userMessageCount(steered, `STEER ${n}: note number ${n}`), 1);
	const everything = JSON.stringify(stack.model.requests.map((request) => request.body));
	assert.ok(!everything.includes("STEER X") && !everything.includes("STEER 6") && !everything.includes("STEER 7"));
	await assertOneOutcomeEach(stack, Object.fromEntries(accepted.map((id) => [id, "delivered"])));
});

// ---------------------------------------------------------------------------------------------------------------
// The shared request cap, and (f) a reply after a limit failure

test("the successor run shares the run's request cap; the limit fails the task and a later reply is rejected", {
	timeout: 120_000,
}, async (t) => {
	const steerText = "LATE: also add b.js and c.js";
	const answering = gate();
	const releaseAnswer = gate();
	const successorAsked = gate();
	const releaseSuccessor = gate();
	const stack = await startStack({
		// Test-only: a 4-request cap instead of 30, so reaching it takes 4 scripted model round trips, not 30. The relay
		// counts and refuses exactly the same way.
		limits: { modelRequestsPerRun: 4 },
		model: agent([
			{
				when: /^add a greet\(name\) helper/,
				steps: [write("a.js", "exports.a = 1;\n"), held(answering, releaseAnswer, { text: "First answer." })],
			},
			{
				when: /^LATE: /,
				steps: [
					held(successorAsked, releaseSuccessor, write("b.js", "exports.b = 2;\n")),
					write("c.js", "exports.c = 3;\n"),
					{ text: "This request must be refused by the relay before it reaches the model." },
				],
			},
		]),
	});
	t.after(() => {
		releaseAnswer.open();
		releaseSuccessor.open();
		return stack.stop();
	});
	stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	const ack = await stack.waitForBotMessage(/^Task 1 accepted for agent alpha/);
	await answering.opened;
	const steer = stack.reply(USER1, ack.id, steerText);
	await replyTo(stack, steer, /^Follow-up saved; it will be steered into the running Task 1/);
	await followupReaches(stack, steer, "submitted");
	releaseAnswer.open();

	// The successor's first request is request 3 of the same run row: the cap was not reset for it.
	await successorAsked.opened;
	await followupReaches(stack, steer, "delivered");
	assert.equal(onlyRun(stack).model_requests, 3);
	releaseSuccessor.open();

	const failed = await stack.waitForBotMessage(/^Task 1 failed: request limit reached \(4 per run\)\./);
	assert.match(failed.text, /Branch task\/1 kept\. Send a new \/task for further work\./);
	await stack.coordinator.idle();
	assert.equal(stack.model.requests.length, 4, "the 5th request was refused before it reached the model");
	const run = onlyRun(stack);
	assert.deepEqual([run.state, run.reason, run.model_requests], ["failed", "request limit reached (4 per run)", 4]);
	const task = task1(stack);
	assert.deepEqual([task.state, task.worktree_path], ["failed", null]);
	assert.deepEqual(await stack.worktrees(), []);
	assert.equal(await stack.branchSha("task/1"), task.head_commit, "the run's work is pushed to its branch");

	// A reply after the limit failure is rejected with a hint to send a new /task; nothing starts.
	const late = stack.reply(USER1, failed.id, "please try again");
	await replyTo(
		stack,
		late,
		/^Follow-up rejected: Task 1 failed \(request limit reached \(4 per run\)\); send a new \/task for further work\./,
	);
	await stack.coordinator.idle();
	assert.equal(stack.runs().length, 1);
	assert.equal(stack.model.requests.length, 4);
	await assertOneOutcomeEach(stack, { [steer]: "delivered" });
});

// ---------------------------------------------------------------------------------------------------------------
// (g) Accepted follow-up outcomes, and (f) a reply after a cancel

test("every accepted follow-up ends with exactly one outcome: delivered, started another run, expired at cancel", {
	timeout: 180_000,
}, async (t) => {
	const roundTwo = gate();
	const release = gate();
	const runTwoAsked = gate();
	const releaseRunTwo = gate();
	const stack = await startStack({
		model: agent([
			{
				when: /^add a greet\(name\) helper/,
				steps: [write("greet.js", GREET_JS), held(roundTwo, release, write("notes.txt", "notes\n"))],
			},
			{ when: /^A: /, steps: [{ text: "Run 1 done, with A." }] },
			// Run 2 stays on its first model request until the test is done with it (it is cancelled meanwhile).
			{ when: /^B: /, steps: [held(runTwoAsked, releaseRunTwo, { text: "Run 2 done." })] },
		]),
	});
	t.after(() => {
		release.open();
		releaseRunTwo.open();
		return stack.stop();
	});
	stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	const ack = await stack.waitForBotMessage(/^Task 1 accepted for agent alpha/);
	await roundTwo.opened;

	// A: steered into run 1 → delivered.
	const a = stack.reply(USER1, ack.id, "A: keep it short");
	await followupReaches(stack, a, "submitted");
	release.open();
	const review1 = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);

	// B: a reply during review → started another run (that message is its outcome).
	const b = stack.reply(USER1, review1.id, "B: add a farewell helper");
	await replyTo(stack, b, /^Follow-up started another run of Task 1/);
	await runTwoAsked.opened;

	// C: steered into run 2 while it waits on the model; the task is cancelled before C is placed → expired.
	const c = stack.reply(USER1, review1.id, "C: and a README");
	await replyTo(stack, c, /^Follow-up saved; it will be steered into the running Task 1/);
	await followupReaches(stack, c, "submitted");
	const cancel = stack.sendCommand(USER1, "/cancel 1");
	await replyTo(stack, cancel, /^Cancelling Task 1… /);
	await replyTo(stack, c, /^Follow-up to Task 1 expired: the task was cancelled\./);
	const cancelled = await stack.waitForBotMessage(/^Task 1 cancelled\. Pull request closed; branch task\/1 kept\./);
	await stack.coordinator.idle();
	releaseRunTwo.open();

	// D: a reply after the cancel → rejected with a hint to send a new /task; it is not an accepted follow-up.
	const d = stack.reply(USER1, cancelled.id, "D: one more thing");
	await replyTo(stack, d, /^Follow-up rejected: Task 1 was cancelled; send a new \/task for further work\./);
	await stack.coordinator.idle();

	assert.deepEqual(
		stack.runs<RunRow>().map((run) => [run.kind, run.state]),
		[
			["initial", "finished"],
			["followup", "cancelled"],
		],
		"no run after the cancel",
	);
	assert.equal(task1(stack).state, "cancelled");
	assert.equal(stack.github.pulls.get(1)?.state, "closed");
	assert.deepEqual(await stack.worktrees(), []);
	const expired = stack.followups<FollowupRow>().find((followup) => followup.message_id === c);
	assert.equal(expired?.reason, "expired (cancelled)");
	assert.equal(requestsFor(stack, /^C: /).length, 0, "the expired steer never reached the model");
	assert.deepEqual(repliesTo(stack, d), [
		"Follow-up rejected: Task 1 was cancelled; send a new /task for further work.",
	]);
	await assertOneOutcomeEach(stack, { [a]: "delivered", [b]: "started", [c]: "expired" });
});

test("a steer still unconsumed when the run's request cap is already used up expires; no successor starts", {
	timeout: 120_000,
}, async (t) => {
	const steerText = "LATE: one more thing";
	const answering = gate();
	const releaseAnswer = gate();
	const stack = await startStack({
		// Test-only: a 2-request cap instead of 30, so the run's answer uses the last allowed request after one tool
		// round instead of after 29. The relay counts and refuses exactly the same way.
		limits: { modelRequestsPerRun: 2 },
		model: agent([
			{
				when: /^add a greet\(name\) helper/,
				steps: [write("greet.js", GREET_JS), held(answering, releaseAnswer, { text: "First answer." })],
			},
			{ when: /^LATE: /, steps: [{ text: "The successor must never reach the model." }] },
		]),
	});
	t.after(() => {
		releaseAnswer.open();
		return stack.stop();
	});
	stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	const ack = await stack.waitForBotMessage(/^Task 1 accepted for agent alpha/);
	// The model is writing the answer with the run's 2nd and last allowed request.
	await answering.opened;
	const steer = stack.reply(USER1, ack.id, steerText);
	await replyTo(stack, steer, /^Follow-up saved; it will be steered into the running Task 1/);
	await followupReaches(stack, steer, "submitted");
	releaseAnswer.open();

	// Evaluation "Steer with cap used": the steer expires, and no new run starts.
	await replyTo(stack, steer, /^Follow-up to Task 1 expired: the run hit a limit\./);
	await stack.coordinator.idle();
	assert.equal(stack.model.requests.length, 2, "the cap held: nothing beyond the 2nd request reached the model");
	assert.equal(requestsFor(stack, /^LATE: /).length, 0, "the expired steer never reached the model");
	const run = onlyRun(stack);
	assert.equal(run.model_requests, 2);
	assert.equal(stack.followups<FollowupRow>()[0]?.reason, "expired (limit)");
	// The task reports its own final state. Spec reading (Agent Execution § Finalize): the run completed normally and
	// only the steer expires; the built system fails the task instead, because Pi starts the successor and the relay
	// refuses its first request as "request limit reached". Reported to the lead; not pinned here.
	const task = task1(stack);
	const final = task.state === "failed" ? /^Task 1 failed: request limit reached/ : /^Task 1 is ready for review/;
	assert.ok(["failed", "review"].includes(task.state), task.state);
	assert.ok(
		stack.bot.sent().some((message) => final.test(message.text)),
		"the task's final state is posted",
	);
	await assertOneOutcomeEach(stack, { [steer]: "expired" });
});

test("a steer still pending when the Coordinator restarts expires as interrupted; the run is never resumed", {
	timeout: 120_000,
}, async (t) => {
	const stack = await startStack({
		model: agent([
			// The second request hangs: the run is busy (and the steer queued in Pi) when the Coordinator restarts.
			{ when: /^add a greet\(name\) helper/, steps: [write("greet.js", GREET_JS), { hang: true }] },
			{ when: /^PENDING: /, steps: [{ text: "An interrupted run must not be resumed." }] },
		]),
	});
	t.after(() => stack.stop());
	stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	const ack = await stack.waitForBotMessage(/^Task 1 accepted for agent alpha/);
	await stack.model.waitForRequests(2, 30_000);
	const steer = stack.reply(USER1, ack.id, "PENDING: also add a README");
	await replyTo(stack, steer, /^Follow-up saved; it will be steered into the running Task 1/);
	await followupReaches(stack, steer, "submitted");
	await stack.restart();

	await replyTo(stack, steer, /^Follow-up to Task 1 expired: the run was interrupted by a restart\./);
	await stack.waitForBotMessage(/^Task 1 was interrupted by restart \(run 1\)/);
	await stack.coordinator.idle();
	const run = onlyRun(stack);
	assert.equal(run.state, "failed");
	assert.match(run.reason ?? "", /interrupted by restart/);
	assert.equal(stack.model.requests.length, 2, "nothing was resubmitted after the restart");
	assert.equal(requestsFor(stack, /^PENDING: /).length, 0);
	assert.equal(stack.followups<FollowupRow>()[0]?.reason, "expired (interrupted)");
	assert.equal(task1(stack).state, "review");
	await assertOneOutcomeEach(stack, { [steer]: "expired" });
});
