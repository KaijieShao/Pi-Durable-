/**
 * Durability of the group Coordinator, end to end on the real stack of test/e2e/harness.ts (the real Coordinator:
 * commands, engine, relay, outbox, poller, git, GitHub client and Pi runner processes; 127.0.0.1 fakes of Telegram,
 * GitHub and the model). Each test maps to the spec:
 *
 * - Restart after acceptance (evaluation.md § Fault Track; interfaces-and-storage.md § Telegram "An accepted command,
 *   its task or follow-up change and its acknowledgement event are saved in one database transaction"; § Outbox
 *   "Delivery is at-least-once"): an acknowledgement Telegram never confirmed goes out again after a restart and the
 *   command is applied once; a failure inside the transaction of a /task or of a follow-up leaves no command, no task,
 *   run or follow-up and no message, and the redelivered update is then applied once.
 * - Coordinator kill mid-run (evaluation.md; interfaces-and-storage.md § Recovery After a Restart; requirements.md
 *   § Durability, § No duplicate submissions, § Safe recovery): the run fails "interrupted by restart" and never
 *   resumes, its worktree (with its work, uncommitted and unpushed), branch and conversation (quarantined) are kept,
 *   its steer expires "(interrupted)" with a
 *   message, queued work (and a steer accepted for it) survives and runs once after recovery, a stranger's reply is
 *   rejected and the creator's starts a fresh conversation seeded with task, follow-up and diff. Once with a graceful
 *   stop (in process) and once with a real SIGKILL of a Coordinator process (stale lock, leftover Pi process; with
 *   E2E_DOCKER=1 also the leftover agent container).
 * - Delivery backlog (evaluation.md; § Outbox to Telegram): under Telegram 429s, required messages go out before
 *   progress, none is dropped, progress keeps only the latest per task, retry_after is honoured; a 5xx and a lost
 *   connection are retried with backoff.
 * - Frozen group (evaluation.md; architecture.md § Frozen group): an unconfirmed merge freezes the group while one
 *   task runs and one is queued; the running task is cancelled "group frozen", nothing dispatches or merges, the task
 *   in review keeps its pull request, /task, follow-ups and /approve get the frozen notice, /status and /cancel work,
 *   a restart keeps it frozen; the owner CLI's unfreeze over the owner socket repeats the recovery checks while the
 *   group stays frozen: refused (the group stays frozen, the CLI names the check) while GitHub cannot confirm the saved
 *   merge, then passing (the merge is found already on main: no second merge) and dispatch reopens.
 * - Telegram offset (§ Telegram "The offset is saved only after the batch is saved"; evaluation.md "Duplicate update
 *   ID"): a batch that fails part-way is fetched again, its saved updates are duplicates (dropped by update id) before
 *   and after a restart, and a forced redelivery is dropped too.
 *
 * Limits are DEMO_LIMITS everywhere (no test needs a smaller one). Synchronization is on store state, bot messages
 * and fake-model requests only; the one timing assertion (retry_after) measures gaps, it never sleeps.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { INTERRUPTED_KEPT_REASON } from "../../src/coordinator/messages.ts";
import type { Store } from "../../src/coordinator/store.ts";
import { OFFSET_KEY } from "../../src/coordinator/telegram/poller.ts";
import { type ApiCall, type FakeBotApi, groupUpdate, type ServerMessage } from "../fixtures/fake-bot-api.ts";
import { waitFor } from "../helpers/env.ts";
import { originGit } from "../helpers/fake-github.ts";
import { type FakeStep, type RecordedRequest, userTexts } from "../helpers/fake-model.ts";
import {
	agentPosition,
	dockerUnavailable,
	GROUP,
	OWNER,
	type Stack,
	scriptedAgent,
	startStack,
	USER1,
	USER2,
} from "./harness.ts";

type TaskRow = {
	id: number;
	state: string;
	reason: string | null;
	text: string;
	branch: string | null;
	worktree_path: string | null;
	head_commit: string | null;
	posted_head: string | null;
	pr_number: number | null;
};
type RunRow = {
	id: number;
	task_id: number;
	kind: string;
	state: string;
	reason: string | null;
	conversation_id: string | null;
	pid: number | null;
	started_at: number | null;
	ended_at: number | null;
};
type FollowupRow = { id: number; task_id: number; mode: string; state: string; reason: string | null; run_id: number };
type ConversationRow = { id: string; task_id: number; parent_id: string | null; quarantined: number; reusable: number };
type OutboxRow = {
	id: number;
	task_id: number | null;
	priority: number;
	kind: string;
	text: string;
	reply_to: number | null;
	state: string;
	attempts: number;
	telegram_message_id: number | null;
};
type CommandRow = { update_id: number; kind: string; outcome: string; task_id: number | null };

const sha7 = (sha: string): string => sha.slice(0, 7);

function outbox(stack: Stack): OutboxRow[] {
	return stack.coordinator.store.all<OutboxRow>("SELECT * FROM outbox ORDER BY id");
}

function commands(stack: Stack): CommandRow[] {
	return stack.coordinator.store.all<CommandRow>(
		"SELECT update_id, kind, outcome, task_id FROM commands ORDER BY update_id",
	);
}

function conversations(stack: Stack): ConversationRow[] {
	return stack.coordinator.store.all<ConversationRow>("SELECT * FROM conversations ORDER BY created_at, rowid");
}

/** Bot messages in the group that reply to `messageId`. */
function repliesTo(stack: Stack, messageId: number): ServerMessage[] {
	return stack.bot.sent().filter((message) => message.chatId === GROUP && message.replyTo === messageId);
}

/** Acknowledgements ("Task N accepted ...") sent in reply to the command message `messageId`. */
function acksTo(stack: Stack, messageId: number): ServerMessage[] {
	return repliesTo(stack, messageId).filter((message) => / accepted for agent /.test(message.text));
}

/** Wait until the outbox recorded bot message `messageId` as a task message (a reply to it is then a follow-up). */
async function mapped(stack: Stack, messageId: number): Promise<number> {
	await waitFor(
		() =>
			stack.coordinator.store.get<{ task_id: number }>(
				"SELECT task_id FROM task_messages WHERE chat_id = ? AND message_id = ?",
				GROUP,
				messageId,
			),
		{ what: `bot message ${messageId} mapped to its task` },
	);
	return messageId;
}

/** Model requests of one run: those whose newest user message (the run's input) matches. */
function requestsFor(stack: Stack, input: RegExp): RecordedRequest[] {
	return stack.model.requests.filter((request) => input.test(agentPosition(request).input));
}

async function fileAtBranch(stack: Stack, branch: string, path: string): Promise<string | undefined> {
	const result = await originGit(stack.origin.bare, ["show", `refs/heads/${branch}:${path}`], { okCodes: [0, 128] });
	return result.code === 0 ? result.stdout : undefined;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * A failure injected INSIDE SQLite, on the Coordinator's own connection: a TEMP trigger aborts an INSERT into
 * `table` while `shouldFail(NEW.<column>)` says so. The statement fails exactly like a full disk or an I/O error, the
 * Store's transaction rolls back and the error reaches the caller. TEMP objects belong to that connection only: a
 * restart (new connection) drops the fault.
 */
function injectInsertFailure(
	store: Store,
	table: "outbox" | "commands",
	column: string,
	shouldFail: (value: SQLInputValue) => boolean,
) {
	let fired = 0;
	const waiters: { readonly count: number; readonly resolve: () => void }[] = [];
	const name = `e2e_fail_${table}`;
	store.db.function(name, (value) => {
		if (!shouldFail(value)) return 0;
		fired++;
		for (const waiter of waiters.filter((each) => each.count <= fired)) waiter.resolve();
		return 1;
	});
	store.db.exec(
		`CREATE TEMP TRIGGER ${name} BEFORE INSERT ON main.${table} WHEN ${name}(NEW.${column}) = 1
		 BEGIN SELECT RAISE(ABORT, 'e2e injected failure'); END`,
	);
	return {
		/**
		 * Resolves after the `count`-th failing statement. Its continuation runs only once the failing call stack has
		 * unwound, so the (synchronous) rollback is done by then, and before anything else (a retry) can run.
		 */
		failed(count: number): Promise<void> {
			if (fired >= count) return Promise.resolve();
			return new Promise((resolve) => waiters.push({ count, resolve }));
		},
		get fired(): number {
			return fired;
		},
	};
}

type InsertFailure = ReturnType<typeof injectInsertFailure>;

/** performance.now() of every sendMessage call as the fake receives it (and decides on an injected failure). */
function recordSendTimes(bot: FakeBotApi): number[] {
	const times: number[] = [];
	const push = bot.calls.push.bind(bot.calls);
	bot.calls.push = (...calls: ApiCall[]): number => {
		for (const call of calls) if (call.method === "sendMessage") times.push(performance.now());
		return push(...calls);
	};
	return times;
}

/** A path pattern for FakeGitHub's fault matcher that can be switched off (the fake has no "clear faults"). */
class Switch extends RegExp {
	on = true;
	override test(input: string): boolean {
		return this.on && super.test(input);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Restart after acceptance

test("restart after acceptance: the command is applied once and its unconfirmed acknowledgement is sent again", {
	timeout: 120_000,
}, async (t) => {
	const text = "ACCEPT-ONCE: add accept.txt";
	const stack = await startStack({ model: scriptedAgent([{ when: /^ACCEPT-ONCE/, steps: [{ hang: true }] }]) });
	t.after(() => stack.stop());
	// Telegram takes every message in, but its confirmation does not come back before the Coordinator stops.
	stack.bot.delays.set("sendMessage", 600_000);
	const command = stack.sendCommand(USER1, `/task alpha ${text}`);
	const ack = /^Task 1 accepted for agent alpha\. Queue position 1\./;
	const delivered = await stack.waitForBotMessage(ack);
	// Stop at a known point: the run is in progress (its model call hangs), the acknowledgement is unconfirmed.
	await stack.model.waitForRequests(1, 30_000);
	await waitFor(() => stack.runs<RunRow>()[0]?.state === "running", { what: "run 1 running", timeoutMs: 30_000 });
	const unconfirmed = outbox(stack).filter((row) => row.kind === "task_accepted");
	assert.equal(unconfirmed.length, 1);
	assert.equal(unconfirmed[0]?.state, "pending", "Telegram never confirmed the acknowledgement");
	assert.equal(unconfirmed[0]?.telegram_message_id, null);
	const beforeRestart = stack.lastBotMessageId();
	stack.bot.delays.delete("sendMessage");

	await stack.restart();
	const resent = await stack.waitForBotMessage(ack, { since: beforeRestart });
	assert.equal(resent.replyTo, command);
	// "The reply is sent after restart, possibly twice": Telegram got it once before the stop, once after.
	assert.deepEqual(
		stack.bot
			.sent()
			.filter((message) => ack.test(message.text))
			.map((message) => message.id),
		[delivered.id, resent.id],
	);
	// "The command is applied once": one command row, one task, one run (the restart admitted nothing again).
	assert.deepEqual(
		commands(stack).map((row) => [row.kind, row.outcome, row.task_id]),
		[["task", "accepted", 1]],
	);
	assert.deepEqual(
		stack.tasks<TaskRow>().map((task) => [task.id, task.text]),
		[[1, text]],
	);
	assert.deepEqual(
		stack.runs<RunRow>().map((run) => [run.task_id, run.kind]),
		[[1, "initial"]],
	);
	// The same outbox row (stable id) is now confirmed, by the copy sent after the restart; a reply to it is a
	// follow-up to Task 1.
	const confirmed = outbox(stack).find((row) => row.id === unconfirmed[0]?.id);
	assert.deepEqual([confirmed?.state, confirmed?.telegram_message_id], ["sent", resent.id]);
	const mapping = stack.coordinator.store.get<{ task_id: number }>(
		"SELECT task_id FROM task_messages WHERE chat_id = ? AND message_id = ?",
		GROUP,
		resent.id,
	);
	assert.equal(mapping?.task_id, 1);
	await stack.coordinator.idle();
});

/** The follow-up variant: a reply during review whose transaction fails saves no follow-up, no run, no count. */
async function followupRolledBack(stack: Stack, review: ServerMessage, fault: InsertFailure): Promise<void> {
	const updateId = stack.bot.nextUpdateId;
	const reply = stack.reply(USER1, await mapped(stack, review.id), "ROLLBACK-FOLLOWUP: still nothing");
	await fault.failed(2);
	assert.equal(
		commands(stack).some((row) => row.update_id === updateId),
		false,
		"no command row",
	);
	assert.deepEqual(stack.followups(), [], "no follow-up");
	assert.equal(stack.runs().length, 1, "no run admitted");
	const task = stack.coordinator.store.get<{ state: string; followup_count: number }>(
		"SELECT state, followup_count FROM tasks WHERE id = 1",
	);
	assert.deepEqual([task?.state, task?.followup_count], ["review", 0], "the task did not change");
	assert.equal(
		outbox(stack).some((row) => row.kind === "followup_accepted"),
		false,
		"no acknowledgement",
	);
	// Applied once when the update comes again.
	const ack = await stack.waitForBotMessage((message) => message.replyTo === reply);
	assert.match(ack.text, /^Follow-up started another run of Task 1 on the same branch\. Queue position 1\./);
	await stack.waitForBotMessage(/^Task 1 finished with no changes \(run 2\)/, { since: ack.id });
	await stack.coordinator.idle();
	assert.deepEqual(
		stack.followups<FollowupRow>().map((followup) => [followup.mode, followup.state]),
		[["run", "started"]],
	);
	assert.equal(stack.runs().length, 2);
	assert.equal(repliesTo(stack, reply).length, 1);
}

test("a failure inside the command transaction saves nothing (no command, task, run, follow-up or message); the update is then applied once", {
	timeout: 120_000,
}, async (t) => {
	const stack = await startStack({
		model: scriptedAgent([{ when: /^ROLLBACK-/, steps: [{ text: "Nothing to do." }] }]),
	});
	t.after(() => stack.stop());
	const store = stack.coordinator.store;
	// The acknowledgement is the transaction's last insert: the command row and the task, run or follow-up are already
	// written when it fails. Each kind of acknowledgement fails once.
	const failedOnce = new Set<SQLInputValue>();
	const once = (kind: SQLInputValue): boolean => !failedOnce.has(kind) && failedOnce.add(kind).size > 0;
	const fault = injectInsertFailure(
		store,
		"outbox",
		"kind",
		(kind) => /^(task|followup)_accepted$/.test(String(kind)) && once(kind),
	);
	const updateId = stack.bot.nextUpdateId;
	const command = stack.sendCommand(USER1, "/task alpha ROLLBACK-TASK: touch nothing");
	await fault.failed(1);
	// Checked right after the rollback: the poller retries the batch only after its backoff (1 s).
	assert.deepEqual(commands(stack), [], "no command row");
	assert.deepEqual(stack.tasks(), [], "no task");
	assert.deepEqual(stack.runs(), [], "no run");
	assert.deepEqual(outbox(stack), [], "no acknowledgement");
	assert.equal(store.getMeta(OFFSET_KEY), undefined, "the offset did not move past the unsaved update");

	// The same update is fetched again and applied exactly once.
	const ack = await stack.waitForBotMessage((message) => message.replyTo === command);
	assert.match(ack.text, /^Task 1 accepted for agent alpha\. Queue position 1\./);
	assert.equal(fault.fired, 1);
	assert.deepEqual(
		commands(stack).map((row) => [row.update_id, row.kind, row.outcome]),
		[[updateId, "task", "accepted"]],
	);
	await waitFor(() => store.getMeta(OFFSET_KEY) === String(updateId + 1), { what: "offset saved" });
	const review = await stack.waitForBotMessage(/^Task 1 finished with no changes \(run 1\)/, { since: ack.id });
	await stack.coordinator.idle();
	assert.equal(stack.tasks().length, 1);
	assert.equal(stack.runs().length, 1);
	assert.equal(acksTo(stack, command).length, 1);

	await followupRolledBack(stack, review, fault);
});

// ---------------------------------------------------------------------------------------------------------------
// Coordinator kill mid-run

const MIDRUN_ONE = "MIDRUN-ONE: write midrun.txt";
const MIDRUN_TWO = "MIDRUN-TWO: write two.txt";
const MIDRUN_CONTENT = "midrun content 7f3a\n";
const STEER_TEXT = "STEER-LOST: also add a footer";
const QUEUED_STEER = "STEER-QUEUED: also mention it in two.txt";
const FRESH_TEXT = "RESUMED-FRESH: add a second line";

/** Task 1 writes a file, then its model call hangs (the restart comes then); Task 2 and the fresh run finish. */
function midRunAgent(oneSteps: readonly FakeStep[]) {
	return scriptedAgent([
		{ when: /^MIDRUN-ONE/, steps: oneSteps },
		{
			when: /^MIDRUN-TWO/,
			steps: [
				{ toolCalls: [{ name: "write", args: { path: "two.txt", content: "two\n" } }] },
				{ text: "Wrote two.txt." },
			],
		},
		// A steer saved for Task 2 while it was queued: it may be placed before or after Task 2's first tool round, so
		// this plan writes the same file (the result does not depend on where it lands).
		{
			when: /^STEER-QUEUED/,
			steps: [
				{ toolCalls: [{ name: "write", args: { path: "two.txt", content: "two\n" } }] },
				{ text: "Steered into Task 2." },
			],
		},
		// The fresh conversation's input is the seeded text (it starts with the continuation note, not the task).
		{ when: /RESUMED-FRESH/, steps: [{ text: "Continued in a fresh conversation." }] },
	]);
}

const MIDRUN_STEPS: readonly FakeStep[] = [
	{ toolCalls: [{ name: "write", args: { path: "midrun.txt", content: MIDRUN_CONTENT } }] },
	{ hang: true },
];

/**
 * After recovery: run 1 interrupted, never resumed, its task in review with its work kept in the worktree: neither
 * committed nor pushed (edits since the last checkpoint wait for a reply's fresh run or /cancel), and not lost.
 */
async function assertInterrupted(stack: Stack, interrupted: ServerMessage, requestsBefore: number): Promise<void> {
	assert.match(interrupted.text, /It is not resumed, and nothing was committed or pushed\./);
	assert.match(interrupted.text, /Kept in its worktree, changed since the last checkpoint: midrun\.txt \(new\)\./);
	assert.match(interrupted.text, /Reply to this message to start a fresh run that continues from these changes/);
	assert.ok(!interrupted.text.includes(MIDRUN_CONTENT.trim()), "file names only, never content");
	const run1 = stack.runs<RunRow>().find((run) => run.task_id === 1);
	assert.deepEqual([run1?.state, run1?.reason], ["failed", "interrupted by restart"]);
	const task1 = stack.tasks<TaskRow>()[0];
	assert.equal(task1?.state, "review");
	assert.equal(task1?.reason, INTERRUPTED_KEPT_REASON);
	// The worktree and the branch are kept; the work done before the restart is in the worktree, not on GitHub.
	assert.ok(task1?.worktree_path !== null && task1?.worktree_path !== undefined);
	assert.ok(existsSync(task1.worktree_path), "the worktree is kept");
	assert.ok((await stack.worktrees()).includes("task-1"));
	assert.equal(readFileSync(join(task1.worktree_path, "midrun.txt"), "utf8"), MIDRUN_CONTENT);
	assert.equal(await stack.branchSha("task/1"), undefined, "nothing of the interrupted run is pushed");
	assert.equal(task1.posted_head, null, "no head to approve");
	// Its conversation is quarantined (never written again, never reused).
	const [conversation] = conversations(stack);
	assert.equal(conversation?.id, run1?.conversation_id);
	assert.deepEqual([conversation?.quarantined, conversation?.reusable], [1, 0]);
	// Not resumed: the model never got another request for that run.
	assert.equal(requestsFor(stack, /^MIDRUN-ONE/).length, 2);
	assert.equal(
		stack.model.requests.slice(requestsBefore).filter((r) => /^MIDRUN-ONE/.test(agentPosition(r).input)).length,
		0,
	);
}

/** A steer accepted for a queued run survives the restart: it reaches Task 2's run when it starts after recovery. */
async function assertQueuedSteerDelivered(stack: Stack, steer: number, since: number): Promise<void> {
	const delivered = await stack.waitForBotMessage((message) => message.replyTo === steer && message.id > since);
	assert.equal(delivered.text, "Follow-up delivered to Task 2.");
	const followup = stack.followups<FollowupRow>().find((row) => row.task_id === 2);
	assert.deepEqual([followup?.mode, followup?.state], ["steer", "delivered"]);
	const steered = requestsFor(stack, /^STEER-QUEUED/);
	assert.ok(steered.length > 0, "the steer reached the model");
	assert.ok(JSON.stringify(steered[0]?.body.input).includes(MIDRUN_TWO), "in Task 2's own conversation");
}

/**
 * Only an authorized follow-up starts another run: a reply from someone else is rejected. The creator's reply starts
 * another run of Task 1 on a fresh conversation seeded with the task, the follow-up and the branch's diff.
 */
async function assertFreshConversation(stack: Stack, interrupted: ServerMessage): Promise<void> {
	const stranger = stack.reply(USER2, await mapped(stack, interrupted.id), "NOT-MINE: let me take over");
	const refused = await stack.waitForBotMessage((message) => message.replyTo === stranger, { since: interrupted.id });
	assert.equal(refused.text, "Follow-up rejected: only the creator of Task 1 or the group owner can follow up on it.");
	const reply = stack.reply(USER1, interrupted.id, FRESH_TEXT);
	const started = await stack.waitForBotMessage((message) => message.replyTo === reply, { since: interrupted.id });
	// Nothing was pushed yet, so there is no pull request: this run's review step opens it.
	assert.match(started.text, /^Follow-up started another run of Task 1 on the same branch\./);
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 2\)/, { since: started.id });
	assert.equal(await fileAtBranch(stack, "task/1", "midrun.txt"), MIDRUN_CONTENT, "pushed by run 2's review step");
	const runs = stack.runs<RunRow>().filter((run) => run.task_id === 1);
	assert.equal(runs.length, 2);
	const [old, fresh] = conversations(stack).filter((conversation) => conversation.task_id === 1);
	assert.ok(old !== undefined && fresh !== undefined);
	assert.deepEqual([runs[0]?.conversation_id, runs[1]?.conversation_id], [old.id, fresh.id]);
	assert.equal(fresh.parent_id, old.id, "the fresh conversation records the quarantined one as its parent");
	assert.equal(fresh.quarantined, 0);
	// Seeded with the original task text, this follow-up and the branch's current changes, and nothing else: no
	// replayed history, and the expired steer is not copied forward.
	const first = requestsFor(stack, /RESUMED-FRESH/)[0];
	assert.ok(first !== undefined);
	const users = userTexts(first.body);
	assert.equal(users.length, 1, "a fresh conversation: one user message");
	const seeded = users[0] ?? "";
	assert.ok(seeded.includes(`Original task:\n${MIDRUN_ONE}`), seeded);
	assert.ok(seeded.includes(`Follow-up:\n${FRESH_TEXT}`), seeded);
	assert.ok(seeded.includes("midrun.txt") && seeded.includes(`+${MIDRUN_CONTENT.trim()}`), seeded);
	const everything = JSON.stringify(requestsFor(stack, /RESUMED-FRESH/).map((request) => request.body.input));
	assert.ok(!everything.includes("STEER-LOST"), "the expired steer is not copied forward");
	// biome-ignore lint/suspicious/noExplicitAny: raw Responses input items
	const replayed = (first.body.input as any[]).filter((item) => item?.type === "function_call_output");
	assert.equal(replayed.length, 0, "no tool results of the interrupted run are replayed");
}

test("Coordinator stop mid-run: interrupted, not resumed, its steer expired; queued work and its steer survive and run once; a reply starts a fresh seeded conversation", {
	timeout: 180_000,
}, async (t) => {
	const stack = await startStack({ model: midRunAgent(MIDRUN_STEPS) });
	t.after(() => stack.stop());
	const taskOne = stack.sendCommand(USER1, `/task alpha ${MIDRUN_ONE}`);
	const ack1 = await stack.waitForBotMessage((message) => message.replyTo === taskOne);
	// Task 1 wrote midrun.txt and now waits on its second model call, which hangs.
	await stack.model.waitForRequests(2, 30_000);
	const taskTwo = stack.sendCommand(USER2, `/task alpha ${MIDRUN_TWO}`);
	const ack2 = await stack.waitForBotMessage((message) => message.replyTo === taskTwo);
	assert.match(ack2.text, /^Task 2 accepted for agent alpha\. Queue position 1\. Waiting for agent alpha to finish/);
	const steer = stack.reply(USER1, await mapped(stack, ack1.id), STEER_TEXT);
	const saved = await stack.waitForBotMessage((message) => message.replyTo === steer);
	assert.match(saved.text, /^Follow-up saved; it will be steered into the running Task 1/);
	await waitFor(() => stack.followups<FollowupRow>()[0]?.state === "submitted", {
		what: "steer submitted to Pi",
		timeoutMs: 30_000,
	});
	const queuedSteer = stack.reply(USER2, await mapped(stack, ack2.id), QUEUED_STEER);
	const queuedSaved = await stack.waitForBotMessage((message) => message.replyTo === queuedSteer);
	assert.equal(
		queuedSaved.text,
		"Follow-up saved; it will be steered into Task 2 when its run starts. Queue position 1.",
	);
	const queuedRun = stack.runs<RunRow>().find((run) => run.task_id === 2);
	assert.equal(queuedRun?.state, "queued");
	const requestsBefore = stack.model.requests.length;
	const since = stack.lastBotMessageId();

	await stack.restart();
	const interrupted = await stack.waitForBotMessage(/^Task 1 was interrupted by restart \(run 1\)/, { since });
	// The pending steer expired "(interrupted)" and its author is told, in reply to the follow-up.
	const expired = await stack.waitForBotMessage((message) => message.replyTo === steer && message.id > since);
	assert.equal(expired.text, "Follow-up to Task 1 expired: the run was interrupted by a restart.");
	const followup = stack.followups<FollowupRow>().find((row) => row.task_id === 1);
	assert.deepEqual([followup?.state, followup?.reason], ["expired", "expired (interrupted)"]);
	// The queued task stayed queued (same run row) and runs once, normally, after recovery.
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/, { since });
	await stack.coordinator.idle();
	await assertInterrupted(stack, interrupted, requestsBefore);
	await assertQueuedSteerDelivered(stack, queuedSteer, since);
	const runsOfTwo = stack.runs<RunRow>().filter((run) => run.task_id === 2);
	assert.deepEqual(
		runsOfTwo.map((run) => [run.id, run.state]),
		[[queuedRun?.id, "finished"]],
		"no double admission",
	);
	const run1 = stack.runs<RunRow>()[0];
	assert.ok(
		(runsOfTwo[0]?.started_at ?? 0) >= (run1?.ended_at ?? Number.POSITIVE_INFINITY),
		"dispatched after recovery",
	);
	assert.ok(requestsFor(stack, /^MIDRUN-TWO/).length > 0);
	assert.equal(stack.tasks().length, 2);
	assert.equal(commands(stack).length, 4, "every update saved once");

	await assertFreshConversation(stack, interrupted);
	assert.equal(stack.runs().length, 3, "the stranger's reply admitted nothing");
	assert.equal(stack.github.pulls.size, 2, "one pull request per task");
});

/**
 * The Coordinator in its own process (same config and test deps as the harness), so the test can SIGKILL it. With
 * `docker`, no sandbox is injected: the Coordinator builds its production Docker sandbox from the config.
 */
function spawnCoordinator(stack: Stack, docker: boolean): { child: ChildProcess; ready: Promise<void> } {
	const root = new URL("../../", import.meta.url);
	const modules = [
		"src/coordinator/coordinator.ts",
		"src/coordinator/runner-launcher.ts",
		"src/coordinator/sandbox/local.ts",
		"test/e2e/harness.ts",
		"src/runtime/log.ts",
	].map((path) => new URL(path, root).href);
	const program = `
		import { readFileSync } from "node:fs";
		const { modules, config, remoteUrl, docker } = JSON.parse(readFileSync(0, "utf8"));
		const [coordinator, launcher, local, harness, log] = await Promise.all(modules.map((m) => import(m)));
		const checks = { test: harness.nodeTestCheck };
		await coordinator.startCoordinator(config, {
			remoteUrl,
			...(docker ? {} : { sandbox: local.createLocalSandbox({ taskDir: config.paths.taskDir, checks }) }),
			launcher: launcher.createRunLauncher({
				dataDir: config.paths.dataDir,
				log: log.silentLogger,
				testEnv: { PI_RUNNER_TEST_FAST_RETRY: "1" },
			}),
			log: log.silentLogger,
			pollTimeoutSeconds: 1,
			retryDelayMs: 50,
		});
		process.stdout.write("ready\\n");
	`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
		cwd: stack.dir,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: stack.dir, NODE_NO_WARNINGS: "1" },
		stdio: ["pipe", "pipe", process.env.E2E_LOG === "1" ? "inherit" : "ignore"],
	});
	child.stdin?.end(JSON.stringify({ modules, config: stack.config, remoteUrl: stack.origin.bare, docker }));
	const ready = new Promise<void>((resolve, reject) => {
		child.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.toString("utf8").includes("ready")) resolve();
		});
		child.once("exit", (code) => reject(new Error(`the Coordinator process exited early (${code})`)));
	});
	return { child, ready };
}

/** Rows of the Coordinator's database, read through a separate read-only connection (no Coordinator in process). */
function readRows<T>(stack: Stack, sql: string): T[] {
	const db = new DatabaseSync(join(stack.config.paths.dataDir, "coordinator.sqlite"), { readOnly: true });
	try {
		return db.prepare(sql).all() as T[];
	} finally {
		db.close();
	}
}

async function killProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGKILL");
	await exited;
}

/** True if a container with exactly this name is running on the Docker daemon. */
function containerRunning(name: string): boolean {
	const result = spawnSync("docker", ["ps", "-q", "--filter", `name=^/${name}$`], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(result.status, 0, "docker ps failed");
	return result.stdout.trim() !== "";
}

/**
 * kill -9 of the Coordinator process during a run: no shutdown at all (no abort to Pi, no container stop, no outbox
 * grace, the lock file left behind). Telegram holds its confirmations, so the acknowledgement is unconfirmed too.
 */
async function killMidRun(t: TestContext, options: { docker: boolean }): Promise<void> {
	const stack = await startStack({
		model: midRunAgent(MIDRUN_STEPS),
		...(options.docker ? { sandbox: "docker" } : {}),
	});
	t.after(() => stack.stop());
	// Hand the data directory to a Coordinator in its own process.
	await stack.coordinator.stop();
	const { child, ready } = spawnCoordinator(stack, options.docker);
	t.after(() => killProcess(child));
	await ready;
	stack.bot.delays.set("sendMessage", 600_000);
	const command = stack.sendCommand(USER1, `/task alpha ${MIDRUN_ONE}`);
	const ack = await stack.waitForBotMessage((message) => message.replyTo === command);
	await stack.model.waitForRequests(2, 60_000);
	const running = await waitFor(
		() =>
			readRows<RunRow & { container: string | null }>(stack, "SELECT * FROM runs").find(
				(run) => run.state === "running",
			),
		{ what: "run 1 running", timeoutMs: 30_000 },
	);
	assert.ok(running.pid !== null);
	assert.ok(processAlive(running.pid), "the run's Pi process is alive before the kill");
	const lockPath = join(stack.config.paths.dataDir, "owner.lock");
	assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, child.pid);
	const requestsBefore = stack.model.requests.length;

	// The watchdog (in this process) is held for the moment of the kill, so the leftover can be observed first: once it
	// runs again it sweeps what the dead Coordinator left (test/e2e/watchdog.test.ts covers that part).
	await stack.watchdog.stop();
	await killProcess(child);
	// The agent container does not die with the Coordinator (Docker): the watchdog / recovery has to kill it.
	if (options.docker) assert.ok(running.container !== null && containerRunning(running.container), "container left");
	stack.watchdog.start();
	stack.bot.delays.delete("sendMessage");
	await stack.restart();
	assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid, "the stale lock was taken over");
	const interrupted = await stack.waitForBotMessage(/^Task 1 was interrupted by restart \(run 1\)/, { since: ack.id });
	await stack.coordinator.idle();
	if (options.docker) assert.equal(containerRunning(running.container ?? ""), false, "the leftover container is gone");
	// No leftover Pi process of the killed Coordinator survives.
	await waitFor(() => !processAlive(running.pid as number), { what: "the old Pi process gone", timeoutMs: 15_000 });
	await assertInterrupted(stack, interrupted, requestsBefore);
	// The acknowledgement Telegram never confirmed is sent again; the command was applied once.
	assert.equal(acksTo(stack, command).length, 2);
	assert.equal(outbox(stack).find((row) => row.kind === "task_accepted")?.state, "sent");
	assert.equal(stack.tasks().length, 1);
	assert.equal(stack.runs().length, 1, "nothing admitted again");
	assert.equal(commands(stack).length, 1);
}

test(
	"Coordinator process SIGKILLed mid-run: stale lock taken over, no Pi process survives, run interrupted, unconfirmed ack resent",
	{
		timeout: 180_000,
	},
	(t) => killMidRun(t, { docker: false }),
);

test(
	"the same kill -9 with the production Docker sandbox: the leftover agent container is killed and verified gone",
	{
		timeout: 300_000,
		skip: dockerUnavailable(),
	},
	(t) => killMidRun(t, { docker: true }),
);

// ---------------------------------------------------------------------------------------------------------------
// Delivery backlog

function backlogPlan(when: RegExp, file: string) {
	return {
		when,
		steps: [
			{ toolCalls: [{ name: "write", args: { path: file, content: "exports.ok = true;\n" } }] },
			{ toolCalls: [{ name: "run_check", args: { operation: "test" } }] },
			{ text: `Wrote ${file}; the tests pass.` },
		],
	};
}

test("delivery backlog under Telegram 429s: required messages before progress, latest progress per task, none dropped, retry_after honoured", {
	timeout: 180_000,
}, async (t) => {
	const stack = await startStack({
		model: scriptedAgent([backlogPlan(/^BACKLOG-ALPHA/, "alpha.js"), backlogPlan(/^BACKLOG-BETA/, "beta.js")]),
	});
	t.after(() => stack.stop());
	const sendTimes = recordSendTimes(stack.bot);
	// Telegram rate-limits every send ("retry after 2 s") until the backlog is built.
	stack.bot.failNext("sendMessage", { status: 429, retryAfter: 2 }, 100_000);
	stack.sendCommand(USER1, "/task alpha BACKLOG-ALPHA: add alpha.js");
	stack.sendCommand(USER2, "/task beta BACKLOG-BETA: add beta.js");
	stack.sendCommand(OWNER, "/status");
	// Telegram does not hold the engine back: both runs end and both review messages are queued.
	await waitFor(() => outbox(stack).filter((row) => row.kind === "task_review").length === 2, {
		what: "both review messages queued",
		timeoutMs: 120_000,
	});
	await stack.coordinator.engine.idle();
	await waitFor(() => sendTimes.length >= 2, { what: "two rate-limited send attempts", timeoutMs: 30_000 });
	const backlog = outbox(stack);
	assert.ok(
		backlog.every((row) => row.state === "pending"),
		"nothing went out, nothing failed",
	);
	assert.deepEqual(stack.bot.sent(), []);
	const required = backlog.filter((row) => row.priority === 0);
	const progress = backlog.filter((row) => row.priority === 1);
	assert.deepEqual(
		required.map((row) => row.kind),
		["task_accepted", "task_accepted", "status_answered", "task_review", "task_review"],
	);
	// Progress: only the latest update per task is kept (each run posted several).
	assert.deepEqual(
		progress.map((row) => row.task_id).sort((x, y) => (x ?? 0) - (y ?? 0)),
		[1, 2],
	);

	const rateLimited = sendTimes.length;
	stack.bot.clearFailures();
	// The rate limit ends, then a 5xx and a connection lost before Telegram took the message: retried with backoff.
	stack.bot.failNext("sendMessage", { status: 502 });
	stack.bot.failNext("sendMessage", { drop: "before" });
	await waitFor(() => outbox(stack).every((row) => row.state === "sent"), { what: "backlog sent", timeoutMs: 60_000 });
	// Required messages first (FIFO), then progress (FIFO); every message exactly once.
	const sent = stack.bot.sent().filter((message) => message.chatId === GROUP);
	assert.deepEqual(
		sent.map((message) => message.text),
		[...required, ...progress].map((row) => row.text),
	);
	assert.deepEqual(
		outbox(stack).map((row) => row.id),
		backlog.map((row) => row.id),
	);
	assert.equal(stack.coordinator.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM failed_events")?.n, 0);
	// retry_after honoured: every attempt that followed a 429, the first successful one included, came >= 2 s later.
	const gaps = sendTimes.slice(1, rateLimited + 1).map((time, index) => time - (sendTimes[index] ?? 0));
	assert.ok(gaps.length >= 2, `gaps: ${gaps.join(", ")}`);
	assert.ok(
		gaps.every((gap) => gap >= 1990),
		`gaps after a 429 (ms): ${gaps.map(Math.round).join(", ")}`,
	);
	// The 502 and the lost connection were retried after the outbox's own backoff (1 s, then 2 s); a 429 counts as no
	// attempt, so the head row (the first acknowledgement) needed exactly 3.
	const retries = sendTimes
		.slice(rateLimited + 1, rateLimited + 3)
		.map((time, index) => time - (sendTimes[rateLimited + index] ?? 0));
	assert.equal(retries.length, 2);
	assert.ok(
		(retries[0] ?? 0) >= 990 && (retries[1] ?? 0) >= 1990,
		`retry gaps (ms): ${retries.map(Math.round).join(", ")}`,
	);
	assert.equal(outbox(stack)[0]?.attempts, 3);
});

// ---------------------------------------------------------------------------------------------------------------
// Frozen group

function frozenPlan(when: RegExp, file: string, last: FakeStep) {
	return {
		when,
		steps: [{ toolCalls: [{ name: "write", args: { path: file, content: `exports.file = "${file}";\n` } }] }, last],
	};
}

const FROZEN_NOTICE =
	/The group is frozen \(the merge outcome of Task 1 on GitHub is unknown\)\. New tasks, follow-ups and approvals are rejected until the owner resolves it/;

/** While frozen: /task, a follow-up and /approve are rejected with the frozen notice; /status still answers. */
async function assertFrozenCommands(stack: Stack, review2: ServerMessage): Promise<void> {
	await mapped(stack, review2.id);
	const since = stack.lastBotMessageId();
	const task = stack.sendCommand(USER2, "/task beta FROZEN-FIVE: should be rejected");
	const followup = stack.reply(USER2, review2.id, "FROZEN-FOLLOWUP: one more change");
	const approve = stack.sendCommand(USER2, "/approve 2");
	const status = stack.sendCommand(OWNER, "/status");
	const answer = async (id: number) =>
		(await stack.waitForBotMessage((message) => message.replyTo === id, { since })).text;
	const [taskAnswer, followupAnswer, approveAnswer, report] = [
		await answer(task),
		await answer(followup),
		await answer(approve),
		await answer(status),
	];
	assert.match(taskAnswer, /^Task request rejected: /);
	assert.match(taskAnswer, FROZEN_NOTICE);
	assert.match(followupAnswer, /^Follow-up rejected: /);
	assert.match(followupAnswer, FROZEN_NOTICE);
	assert.match(approveAnswer, /^\/approve rejected: /);
	assert.match(approveAnswer, FROZEN_NOTICE);
	assert.match(report, /^Group: frozen \(the merge outcome of Task 1 on GitHub is unknown\)\./);
	assert.match(report, /Task 1 · alpha · merging/);
	assert.match(report, /Task 2 · beta · in review · https:\/\/github\.com\/acme\/demo\/pull\/2/);
	assert.match(report, /Task 4 · alpha · queued · queue position 1/);
	assert.match(report, /Task 3 · alpha · cancelled/);
	assert.equal(stack.tasks().length, 4, "no task created");
	assert.equal(stack.followups().length, 0, "no follow-up saved");
	const approvals = stack.coordinator.store.all<{ task_id: number }>("SELECT task_id FROM approvals");
	assert.deepEqual(
		approvals.map((row) => row.task_id),
		[1],
		"no approval saved",
	);
}

/** Tasks 1 and 2 in review with PRs; Task 3 running (its model call hangs); Task 4 queued behind it. */
async function frozenSetup(stack: Stack): Promise<{ review2: ServerMessage }> {
	stack.sendCommand(USER1, "/task alpha FROZEN-ONE: add one.js");
	// One after the other, so Task 1 gets pull request #1 and Task 2 #2 (the faults below and the checks name them).
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	stack.sendCommand(USER2, "/task beta FROZEN-TWO: add two.js");
	const review2 = await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/);
	stack.sendCommand(USER1, "/task alpha FROZEN-THREE: add three.js");
	await waitFor(() => requestsFor(stack, /^FROZEN-THREE/).length === 2, { what: "Task 3 hangs", timeoutMs: 30_000 });
	const four = stack.sendCommand(USER2, "/task alpha FROZEN-FOUR: add four.js");
	const ack4 = await stack.waitForBotMessage((message) => message.replyTo === four);
	assert.match(ack4.text, /^Task 4 accepted for agent alpha\. Queue position 1\. Waiting for agent alpha/);
	return { review2 };
}

test("frozen group: an unconfirmed merge freezes it; running task cancelled, no dispatch or merge, frozen notices, /status and /cancel work; owner unfreeze and recheck reopen dispatch", {
	timeout: 240_000,
}, async (t) => {
	const stack = await startStack({
		model: scriptedAgent([
			frozenPlan(/^FROZEN-ONE/, "one.js", { text: "Added one.js." }),
			frozenPlan(/^FROZEN-TWO/, "two.js", { text: "Added two.js." }),
			frozenPlan(/^FROZEN-THREE/, "three.js", { hang: true }),
			frozenPlan(/^FROZEN-FOUR/, "four.js", { text: "Added four.js." }),
		]),
	});
	t.after(() => stack.stop());
	const { review2 } = await frozenSetup(stack);
	const mainBefore = await stack.mainSha();
	const head1 = stack.tasks<TaskRow>()[0]?.head_commit ?? "";

	// GitHub merges Task 1 but the response is lost, and GitHub cannot be read back: the outcome is unknown.
	const compareDown = new Switch("/compare/");
	stack.github.failNext("GET", compareDown, 500, 100_000);
	stack.github.dropResponseAfterEffect("PUT", /\/pulls\/1\/merge$/);
	const approve = stack.sendCommand(USER1, "/approve 1");
	await stack.waitForBotMessage((message) => message.replyTo === approve);
	const frozen = await stack.waitForBotMessage(
		/^Group frozen: the merge outcome of Task 1 on GitHub is unknown\. Only the owner CLI can unfreeze it\./,
		{ timeoutMs: 90_000 },
	);
	// The running task is cancelled "group frozen" (stopped, final checkpoint pushed, worktree archived).
	const cancelled = await stack.waitForBotMessage(/^Task 3 cancelled: group frozen\./, { since: frozen.id });
	assert.match(cancelled.text, /Branch task\/3 kept\./);
	await stack.coordinator.idle();
	const tasks = stack.tasks<TaskRow>();
	assert.deepEqual(
		tasks.map((task) => [task.id, task.state]),
		[
			[1, "merging"],
			[2, "review"],
			[3, "cancelled"],
			[4, "queued"],
		],
	);
	assert.equal(tasks[2]?.reason, "group frozen");
	assert.equal(stack.runs<RunRow>().find((run) => run.task_id === 3)?.reason, "group frozen");
	assert.equal(tasks[2]?.worktree_path, null);
	assert.equal(await fileAtBranch(stack, "task/3", "three.js"), 'exports.file = "three.js";\n');
	// GitHub did merge (the Coordinator just cannot tell); nothing more happens until the owner resolves it.
	assert.deepEqual(await stack.parents(await stack.mainSha()), [mainBefore, head1]);
	const intents = () =>
		stack.coordinator.store.all<{ state: string; settled_at: number | null }>("SELECT * FROM merge_intents");
	assert.deepEqual(
		intents().map((intent) => intent.state),
		["pending"],
	);
	// Tasks in review keep their pull requests; queued stays queued (alpha is free again, yet nothing dispatches).
	assert.equal(stack.github.pulls.get(2)?.state, "open");
	assert.equal(tasks[1]?.pr_number, 2);
	assert.equal(stack.runs<RunRow>().find((run) => run.task_id === 4)?.state, "queued");
	await assertFrozenCommands(stack, review2);
	await stack.coordinator.idle();
	assert.equal(stack.runs<RunRow>().find((run) => run.task_id === 4)?.state, "queued", "no dispatch while frozen");
	assert.equal(stack.github.count("PUT", /\/merge$/), 1, "no merge while frozen");
	// An authorized /cancel still works while frozen: Task 2's pull request is closed and its worktree archived.
	const cancel = stack.sendCommand(USER2, "/cancel 2");
	const cancelling = await stack.waitForBotMessage((message) => message.replyTo === cancel, { since: frozen.id });
	assert.match(cancelling.text, /^Cancelling Task 2… You will get a message once its pull request is closed/);
	await stack.waitForBotMessage(/^Task 2 cancelled\. Pull request closed; branch task\/2 kept\./, {
		since: cancelling.id,
	});
	await stack.coordinator.idle();
	assert.equal(stack.github.pulls.get(2)?.state, "closed");
	assert.equal(stack.tasks<TaskRow>()[1]?.state, "cancelled");
	assert.equal(stack.runs<RunRow>().find((run) => run.task_id === 4)?.state, "queued", "still no dispatch");
	// A restart does not unfreeze the group; its recovery cannot resolve the merge either (GitHub is still unreadable).
	const beforeRestart = stack.lastBotMessageId();
	await stack.restart();
	await stack.coordinator.idle();
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "frozen");
	assert.deepEqual(
		intents().map((intent) => intent.state),
		["pending"],
	);
	assert.equal(stack.runs<RunRow>().find((run) => run.task_id === 4)?.state, "queued", "no dispatch after restart");
	assert.equal(stack.github.count("PUT", /\/merge$/), 1, "no merge after restart");
	assert.equal(
		stack.lastBotMessages(20).filter((message) => message.id > beforeRestart && /^Group frozen/.test(message.text))
			.length,
		0,
		"the frozen notice is posted once",
	);

	// The owner's unfreeze (the owner CLI, over the Coordinator's owner socket) while GitHub is still unreadable: the
	// Coordinator repeats the recovery checks, the saved merge cannot be confirmed, the group stays frozen.
	const early = await stack.owner("unfreeze");
	assert.equal(early.code, 1, early.stdout);
	assert.match(
		early.stderr,
		/^Group -1001234567890 stays frozen \(frozen: the merge outcome of Task 1 on GitHub is unknown\): the recovery check "merges" failed\. Nothing was unfrozen\./,
	);
	assert.match(
		early.stderr,
		/\n {2}ok {5}watchdog: .*\n {2}FAILED merges: the saved merge of Task 1 is still unknown: GitHub could not be read \(merge check\)\n/,
	);
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "frozen");
	assert.deepEqual(
		intents().map((intent) => intent.state),
		["pending"],
	);
	await stack.coordinator.idle();
	assert.equal(stack.runs<RunRow>().find((run) => run.task_id === 4)?.state, "queued", "no dispatch after a refusal");
	assert.equal(stack.github.count("PUT", /\/merge$/), 1, "no merge after a refusal");
	// GitHub can be read again: the owner unfreezes, and every recovery check passes.
	compareDown.on = false;
	const unfrozen = await stack.owner("unfreeze", String(GROUP));
	assert.equal(unfrozen.code, 0, unfrozen.stderr);
	assert.match(
		unfrozen.stdout,
		/^Group -1001234567890 unfrozen \(it was frozen: the merge outcome of Task 1 on GitHub is unknown\)\. Every recovery check passed:/,
	);
	// The recheck finds main already containing Task 1's head: merged without a second merge; then dispatch reopens.
	const merged = await stack.waitForBotMessage(/^Task 1 merged into main \(([0-9a-f]{7})\)\./, { since: frozen.id });
	await stack.waitForBotMessage(/^Task 4 is ready for review \(run 1\)/, { since: frozen.id });
	await stack.coordinator.idle();
	assert.equal(stack.github.count("PUT", /\/merge$/), 1, "nothing merged twice");
	const main = await stack.mainSha();
	assert.ok(merged.text.includes(sha7(main)), merged.text);
	assert.deepEqual(await stack.parents(main), [mainBefore, head1]);
	const [intent] = intents();
	assert.equal(intent?.state, "merged");
	const run4 = stack.runs<RunRow>().find((run) => run.task_id === 4);
	assert.equal(run4?.state, "finished");
	assert.ok((run4?.started_at ?? 0) >= (intent?.settled_at ?? Number.POSITIVE_INFINITY), "dispatch after the recheck");
	assert.deepEqual(stack.coordinator.store.groupState(GROUP), { state: "normal", reason: null, recheck: false });
	assert.deepEqual(
		stack.tasks<TaskRow>().map((task) => [task.id, task.state]),
		[
			[1, "merged"],
			[2, "cancelled"],
			[3, "cancelled"],
			[4, "review"],
		],
	);
	assert.deepEqual(await stack.worktrees(), ["task-4"]);
	assert.deepEqual(await stack.branches(), ["main", "task/1", "task/2", "task/3", "task/4"], "every branch kept");
});

// ---------------------------------------------------------------------------------------------------------------
// Telegram offset

test("the Telegram offset is saved only after the whole batch; redelivered updates are dropped by update id, also after a restart", {
	timeout: 180_000,
}, async (t) => {
	const stack = await startStack({
		model: scriptedAgent([
			{ when: /^OFFSET-ONE/, steps: [{ text: "Nothing to change." }] },
			{ when: /^OFFSET-TWO/, steps: [{ text: "Nothing to change either." }] },
		]),
	});
	t.after(() => stack.stop());
	const offset = () => stack.coordinator.store.getMeta(OFFSET_KEY);
	// One saved batch first: the offset follows it.
	const help = stack.bot.nextUpdateId;
	const helpMessage = stack.sendCommand(USER1, "/help");
	await stack.waitForBotMessage((message) => message.replyTo === helpMessage);
	await waitFor(() => offset() === String(help + 1), { what: "offset after the first batch" });

	// One batch of three updates; the third one's transaction fails (inside SQLite) every time on this connection.
	const [a, b, c] = [help + 1, help + 2, help + 3];
	const fault = injectInsertFailure(stack.coordinator.store, "commands", "update_id", (id) => id === c);
	const taskOne = stack.sendCommand(USER1, "/task alpha OFFSET-ONE: change nothing");
	const status = stack.sendCommand(USER2, "/status");
	const taskTwo = stack.sendCommand(USER2, "/task beta OFFSET-TWO: change nothing");
	await fault.failed(1);
	assert.deepEqual(
		commands(stack).map((row) => row.update_id),
		[help, a, b],
		"the first two updates are saved",
	);
	assert.equal(offset(), String(help + 1), "the offset stays before the batch");
	// The poller fetches the same batch again: the saved updates are duplicates, the third fails again.
	await waitFor(() => fault.fired >= 2, { what: "the batch fetched again" });
	await stack.waitForBotMessage(/^Task 1 finished with no changes \(run 1\)/);
	await stack.coordinator.engine.idle();
	assert.equal(offset(), String(help + 1));
	assert.equal(stack.tasks().length, 1, "no second task from the redelivered /task");
	assert.equal(acksTo(stack, taskOne).length, 1);
	assert.equal(repliesTo(stack, status).length, 1);

	// Restart while the batch is unsaved: the new Coordinator polls from the saved offset and gets the batch again.
	const since = stack.lastBotMessageId();
	const callsBefore = stack.bot.calls.length;
	await stack.restart();
	const accepted = await stack.waitForBotMessage((message) => message.replyTo === taskTwo, { since });
	assert.match(accepted.text, /^Task 2 accepted for agent beta\. Queue position 1\./);
	const polls = stack.bot.calls.slice(callsBefore).filter((call) => call.method === "getUpdates");
	assert.equal(polls[0]?.body.offset, help + 1, "the first poll after the restart starts at the saved offset");
	await waitFor(() => offset() === String(c + 1), { what: "offset after the batch" });
	assert.deepEqual(
		commands(stack).map((row) => row.update_id),
		[help, a, b, c],
	);
	assert.deepEqual(
		stack.tasks<TaskRow>().map((task) => task.text),
		["OFFSET-ONE: change nothing", "OFFSET-TWO: change nothing"],
	);
	assert.equal(acksTo(stack, taskOne).length, 1, "no second acknowledgement for a redelivered update");
	assert.equal(repliesTo(stack, status).length, 1);

	// Telegram serves an update again although it is behind the offset: dropped as a duplicate.
	stack.bot.redeliver(
		groupUpdate({
			botUsername: stack.bot.username,
			botId: stack.bot.botId,
			chatId: GROUP,
			fromId: USER1,
			text: "/task@pi_e2e_bot alpha OFFSET-ONE: change nothing",
			messageId: taskOne,
			updateId: a,
		}),
	);
	const marker = stack.sendCommand(OWNER, "/help");
	await stack.waitForBotMessage((message) => message.replyTo === marker);
	await stack.waitForBotMessage(/^Task 2 finished with no changes \(run 1\)/);
	await stack.coordinator.idle();
	assert.equal(stack.tasks().length, 2);
	assert.equal(stack.runs().length, 2);
	assert.equal(acksTo(stack, taskOne).length, 1);
	assert.equal(acksTo(stack, taskTwo).length, 1);
	assert.equal(commands(stack).length, 5);
});
