/**
 * Review and merge, end to end through the real Coordinator against 127.0.0.1 fakes (Architecture § Review and
 * merge; Interfaces and Storage § Telegram /approve and § Coordinator to GitHub; Evaluation § Fault Track rows
 * Permissions, Stale approval, Merge conflict, Main branch moved, Main branch moved during merge, Restart mid-merge,
 * Lost pull request response, Cancel in review):
 *
 *   - /approve binds to the head the bot last posted; a commit pushed to the task branch on GitHub afterwards (before
 *     or during the merge) gets the approval rejected and nothing merges; the rejection says why (both heads, changed
 *     outside the Coordinator) and what works: restoring the branch, then /approve merges, or /cancel closes it;
 *   - only the creator or the owner can approve, cancel or follow up; a newly admitted run blocks /approve;
 *   - merges run one at a time (never two pending merge intents); the second task meets a moved main, is combined,
 *     retested and needs a new approval;
 *   - main moving between the Coordinator's check and GitHub's merge: GitHub refuses, the Coordinator starts over,
 *     and what merges is exactly what was tested;
 *   - two tasks editing the same lines: the second merge lists the conflicting file, nothing merges, a conflict-fix
 *     run is admitted automatically and the task is reviewed and approved again;
 *   - a lost pull-request-creation response: exactly one pull request, found by head and base (in-process retry, and
 *     after a restart once the owner unfroze the group);
 *   - a restart after GitHub merged but before the Coordinator saved it: recovery sees main contains the head, no
 *     second merge;
 *   - /cancel of a task in review closes its pull request and archives its worktree (folder gone, branch kept).
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ServerMessage } from "../fixtures/fake-bot-api.ts";
import { waitFor } from "../helpers/env.ts";
import { commitOnOrigin, type FakeCall, type FakeGitHub, originGit } from "../helpers/fake-github.ts";
import type { RecordedRequest } from "../helpers/fake-model.ts";
import {
	type AgentPlan,
	agentPosition,
	GROUP,
	OWNER,
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
	branch: string | null;
	worktree_path: string | null;
	head_commit: string | null;
	posted_head: string | null;
	tests_passed_head: string | null;
	pr_number: number | null;
	pr_url: string | null;
	archived: number;
	cancel_requested: number;
};
type RunRow = { id: number; task_id: number; kind: string; state: string; request_id: string; review_done: number };
type ApprovalRow = { id: number; task_id: number; user_id: number; head_commit: string; state: string; reason: string };
type IntentRow = {
	id: number;
	task_id: number;
	approval_id: number;
	head_commit: string;
	state: string;
	reason: string | null;
	merge_commit: string | null;
};

const A_TASK = "add a.js exporting a()";
const B_TASK = "add b.js exporting b()";
const A_JS = "exports.a = () => 1;\n";
const B_JS = "exports.b = () => 2;\n";

const sha7 = (sha: string | null | undefined): string => (sha ?? "").slice(0, 7);

/** The agent writes one file, then answers. */
function writer(when: RegExp, path: string, content: string, answer: string): AgentPlan {
	return { when, steps: [{ toolCalls: [{ name: "write", args: { path, content } }] }, { text: answer }] };
}

const AGENTS: readonly AgentPlan[] = [
	writer(/^add a\.js exporting a\(\)/, "a.js", A_JS, "Added a.js."),
	writer(/^add b\.js exporting b\(\)/, "b.js", B_JS, "Added b.js."),
];

/** A promise the test releases (holds a fake model step or a fake GitHub call). */
function gate(): { readonly promise: Promise<void>; release(): void } {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release: () => release() };
}

async function stackFor(t: TestContext, options: StackOptions, cleanup: () => void = () => {}): Promise<Stack> {
	const stack = await startStack(options);
	t.after(() => {
		cleanup();
		return stack.stop();
	});
	return stack;
}

function taskRow(stack: Stack, id: number): TaskRow {
	const row = stack.tasks<TaskRow>().find((task) => task.id === id);
	assert.ok(row !== undefined, `Task ${id} exists`);
	return row;
}

function approvals(stack: Stack): ApprovalRow[] {
	return stack.coordinator.store.all<ApprovalRow>("SELECT * FROM approvals ORDER BY id");
}

function intents(stack: Stack): IntentRow[] {
	return stack.coordinator.store.all<IntentRow>("SELECT * FROM merge_intents ORDER BY id");
}

function pendingIntents(stack: Stack): IntentRow[] {
	return intents(stack).filter((intent) => intent.state === "pending");
}

/** GitHub merge calls in order, e.g. ["/pulls/1/merge"]. */
function mergeCalls(github: FakeGitHub): string[] {
	return github.calls
		.filter((call) => call.method === "PUT" && /\/pulls\/\d+\/merge$/.test(call.path))
		.map((call) => call.path.replace(`/repos/${REPO}`, ""));
}

function requestsFor(stack: Stack, input: RegExp): RecordedRequest[] {
	return stack.model.requests.filter((request) => input.test(agentPosition(request).input));
}

/** Send a command and wait for the bot's reply to it (acknowledgement or rejection). */
async function command(stack: Stack, userId: number, text: string): Promise<ServerMessage> {
	const since = stack.lastBotMessageId();
	const sent = stack.sendCommand(userId, text);
	return stack.waitForBotMessage((message) => message.replyTo === sent, { since });
}

/** Reply to a bot message and wait for the bot's reply to that reply. */
async function replyTo(stack: Stack, userId: number, messageId: number, text: string): Promise<ServerMessage> {
	const since = stack.lastBotMessageId();
	const sent = stack.reply(userId, messageId, text);
	return stack.waitForBotMessage((message) => message.replyTo === sent, { since });
}

/** The review message of run `run` of task `id`, and the task's posted head. */
async function reviewOf(
	stack: Stack,
	id: number,
	run = 1,
	since = 0,
): Promise<{ message: ServerMessage; head: string }> {
	const message = await stack.waitForBotMessage(new RegExp(`^Task ${id} is ready for review \\(run ${run}\\)`), {
		since,
	});
	const row = taskRow(stack, id);
	assert.equal(row.state, "review");
	assert.ok(row.posted_head !== null && row.posted_head === row.head_commit);
	assert.ok(message.text.includes(`Head: ${sha7(row.posted_head)}.`), message.text);
	return { message, head: row.posted_head };
}

/**
 * Exact check that merges run one at a time: a TEMP trigger on the Coordinator's own SQLite connection records the
 * number of pending merge intents after every insert or update of merge_intents. Returns the maximum seen.
 */
function probePendingIntents(stack: Stack): () => number {
	stack.coordinator.store.db.exec(`
		CREATE TEMP TABLE e2e_pending_intents(n INTEGER NOT NULL);
		CREATE TEMP TRIGGER e2e_intent_inserted AFTER INSERT ON merge_intents BEGIN
			INSERT INTO e2e_pending_intents(n) SELECT COUNT(*) FROM merge_intents WHERE state = 'pending';
		END;
		CREATE TEMP TRIGGER e2e_intent_updated AFTER UPDATE ON merge_intents BEGIN
			INSERT INTO e2e_pending_intents(n) SELECT COUNT(*) FROM merge_intents WHERE state = 'pending';
		END;`);
	return () =>
		stack.coordinator.store.get<{ n: number | null }>("SELECT MAX(n) AS n FROM temp.e2e_pending_intents")?.n ?? 0;
}

/**
 * Observe every request FakeGitHub receives, synchronously and before its fault checks (FakeGitHub records each
 * request in `calls` first), so a hook can arm `failNext` for the very request it sees.
 */
function onGitHubCall(github: FakeGitHub, hook: (call: FakeCall) => void): void {
	const calls = github.calls;
	const push = calls.push.bind(calls);
	calls.push = (...items: FakeCall[]): number => {
		for (const item of items) hook(item);
		return push(...items);
	};
}

/**
 * The rejection posted when GitHub's pull request head (`onGitHub`) is not the approved head: which task, nothing
 * merged, why, and what works (restore the branch, then /approve or /cancel; a follow-up or /cancel before that keeps
 * its work in the worktree, and the group carries on: test/e2e/branch-moved.test.ts).
 */
function staleApprovalText(id: number, onGitHub: string, approvedHead: string): string {
	return [
		`Approval of Task ${id} rejected; nothing was merged.`,
		`Why: branch task/${id} on GitHub is at ${sha7(onGitHub)}, but the approval was for ${sha7(approvedHead)}, the ` +
			"head the bot posted. The branch changed outside the Coordinator.",
		`What to do: restore task/${id} on GitHub to ${sha7(approvedHead)}, for example from a clone after git fetch ` +
			"origin:",
		`git push --force origin ${approvedHead}:refs/heads/task/${id}`,
		"(this drops the commits pushed since; save them on another branch first if you need them). Then send " +
			`/approve ${id} again to approve that head, or /cancel ${id} to drop the task.`,
		"The Coordinator never overwrites commits on GitHub: a follow-up run or a /cancel before the branch is " +
			"restored keeps its work in the task's worktree until then. The other tasks and the group carry on.",
	].join("\n");
}

/** What the rejection asks for: a force push of `branch` on GitHub back to `sha` (only if it is still at `from`). */
async function restoreBranch(stack: Stack, branch: string, sha: string, from: string): Promise<void> {
	await originGit(stack.origin.bare, ["update-ref", `refs/heads/${branch}`, sha, from]);
	assert.equal(await stack.branchSha(branch), sha);
}

async function mergeCommitsOnMain(stack: Stack): Promise<number> {
	return Number((await originGit(stack.origin.bare, ["rev-list", "--count", "--merges", "refs/heads/main"])).stdout);
}

// ---------------------------------------------------------------------------------------------------------------
// (a) Stale approval

test("stale approval: a commit pushed to the task branch after the bot posted its head → rejected with why and what to do, nothing merges; restored branch + /approve merges", {
	timeout: 120_000,
}, async (t) => {
	const stack = await stackFor(t, { model: scriptedAgent(AGENTS) });
	const mainBefore = await stack.mainSha();
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	const { head: posted } = await reviewOf(stack, 1);

	// Someone pushes to task/1 on GitHub after the bot posted the head.
	const foreign = await commitOnOrigin(
		stack.origin.bare,
		"task/1",
		{ "evil.js": "exports.evil = true;\n" },
		{
			message: "pushed outside the Coordinator",
		},
	);
	assert.notEqual(foreign, posted);

	// /approve approves the head the bot last posted (the Coordinator re-checks GitHub before merging).
	const ack = await command(stack, USER1, "/approve 1");
	assert.ok(ack.text.startsWith(`Approved Task 1 at ${sha7(posted)};`), ack.text);
	assert.equal(approvals(stack)[0]?.head_commit, posted);

	// The merge step sees GitHub's pull request head differ from the approved head: approval rejected, and the
	// message says which task, that nothing merged, why, and what the system supports doing next.
	const rejected = await stack.waitForBotMessage(/^Approval of Task 1 rejected; nothing was merged\./, {
		since: ack.id,
	});
	assert.equal(rejected.text, staleApprovalText(1, foreign, posted));
	await stack.coordinator.idle();
	assert.equal(await stack.mainSha(), mainBefore, "main is unchanged");
	assert.equal(await stack.fileAtMain("evil.js"), undefined);
	assert.deepEqual(mergeCalls(stack.github), [], "GitHub was never asked to merge");
	assert.equal(stack.github.pulls.get(1)?.merged, false);
	assert.equal(taskRow(stack, 1).state, "review");
	assert.deepEqual(
		approvals(stack).map((a) => [a.state, a.reason]),
		[["invalidated", "branch changed after approval"]],
	);
	assert.deepEqual(
		intents(stack).map((i) => i.state),
		["failed"],
	);

	// As the message says: restore task/1 on GitHub to the approved head (a force push), then /approve again merges.
	await restoreBranch(stack, "task/1", posted, foreign);
	const again = await command(stack, USER1, "/approve 1");
	assert.ok(again.text.startsWith(`Approved Task 1 at ${sha7(posted)};`), again.text);
	await stack.waitForBotMessage(/^Task 1 merged into main/, { since: again.id });
	await stack.coordinator.idle();
	const main = await stack.mainSha();
	assert.deepEqual(await stack.parents(main), [mainBefore, posted], "exactly the approved head merged");
	assert.equal(await stack.fileAtMain("a.js"), A_JS);
	assert.equal(await stack.fileAtMain("evil.js"), undefined, "the commit pushed outside never merges");
	assert.deepEqual(mergeCalls(stack.github), ["/pulls/1/merge"]);
	assert.deepEqual(
		approvals(stack).map((a) => [a.head_commit, a.state]),
		[
			[posted, "invalidated"],
			[posted, "consumed"],
		],
	);
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal");
});

test("stale approval during the merge: a commit lands on the task branch between the check and GitHub's merge → refused, rejected, nothing merges; restored branch + /cancel closes it", {
	timeout: 120_000,
}, async (t) => {
	const stack = await stackFor(t, { model: scriptedAgent(AGENTS) });
	const mainBefore = await stack.mainSha();
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	const { head: posted } = await reviewOf(stack, 1);

	// After the Coordinator checked the pull request head, a commit is pushed to task/1 (GitHub's merge then sees a
	// head other than the sha it was asked to merge).
	let pushed: string | undefined;
	stack.github.beforeMerge = async () => {
		pushed ??= await commitOnOrigin(stack.origin.bare, "task/1", { "late.js": "exports.late = true;\n" });
	};
	const ack = await command(stack, USER1, "/approve 1");
	assert.ok(ack.text.startsWith(`Approved Task 1 at ${sha7(posted)};`), ack.text);
	const rejected = await stack.waitForBotMessage(/^Approval of Task 1 rejected; nothing was merged\./, {
		since: ack.id,
	});
	await stack.coordinator.idle();
	assert.ok(pushed !== undefined);
	assert.equal(rejected.text, staleApprovalText(1, pushed, posted));
	assert.deepEqual(mergeCalls(stack.github), ["/pulls/1/merge"], "GitHub refused the one merge call (409)");
	assert.equal(await stack.mainSha(), mainBefore, "main is unchanged");
	assert.equal(stack.github.pulls.get(1)?.merged, false);
	assert.equal(taskRow(stack, 1).state, "review");
	assert.equal(approvals(stack)[0]?.state, "invalidated");

	// As the message says: restore the branch, then /cancel closes the task cleanly (its push compares equal with
	// GitHub, so nothing is refused and the group does not freeze).
	await restoreBranch(stack, "task/1", posted, pushed);
	const cancel = await command(stack, USER1, "/cancel 1");
	assert.match(cancel.text, /^Cancelling Task 1…/);
	const final = await stack.waitForBotMessage(/^Task 1 cancelled\./, { since: cancel.id });
	await stack.coordinator.idle();
	assert.equal(final.text, "Task 1 cancelled. Pull request closed; branch task/1 kept.");
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal");
	assert.deepEqual([taskRow(stack, 1).state, taskRow(stack, 1).worktree_path], ["cancelled", null]);
	assert.equal(stack.github.pulls.get(1)?.state, "closed");
	assert.equal(await stack.branchSha("task/1"), posted, "the approved head is kept on the branch");
	assert.equal(await stack.mainSha(), mainBefore, "nothing merged");
});

// ---------------------------------------------------------------------------------------------------------------
// (b) Permissions, and a newly admitted run

test("only the creator or the owner can approve, cancel or follow up; a newly admitted run blocks /approve", {
	timeout: 120_000,
}, async (t) => {
	const hold = gate();
	const followupText = "also add b.js exporting b()";
	const stack = await stackFor(
		t,
		{
			model: scriptedAgent([
				AGENTS[0] as AgentPlan,
				{
					when: /^also add b\.js/,
					// Held until /approve was tried while this run is admitted and running.
					steps: [
						hold.promise.then(() => ({ toolCalls: [{ name: "write", args: { path: "b.js", content: B_JS } }] })),
						{ text: "Added b.js too." },
					],
				},
			]),
		},
		hold.release,
	);
	const mainBefore = await stack.mainSha();
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	const review1 = await reviewOf(stack, 1);

	// USER2 is neither the creator (USER1) nor the owner.
	const approve = await command(stack, USER2, "/approve 1");
	assert.equal(approve.text, "/approve rejected: only the creator of Task 1 or the group owner can approve it.");
	const cancel = await command(stack, USER2, "/cancel 1");
	assert.equal(cancel.text, "/cancel rejected: only the creator of Task 1 or the group owner can cancel it.");
	const followup = await replyTo(stack, USER2, review1.message.id, "please also add c.js");
	assert.equal(followup.text, "Follow-up rejected: only the creator of Task 1 or the group owner can follow up on it.");
	await stack.coordinator.idle();
	assert.deepEqual(approvals(stack), []);
	const after = taskRow(stack, 1);
	assert.deepEqual([after.state, after.cancel_requested], ["review", 0]);
	assert.equal(stack.runs().length, 1, "no run was admitted");

	// The creator's follow-up admits another run; /approve is rejected while it is admitted.
	const started = await replyTo(stack, USER1, review1.message.id, followupText);
	assert.match(started.text, /^Follow-up started another run of Task 1 on the same branch and pull request/);
	await waitFor(() => requestsFor(stack, /^also add b\.js/).length > 0, { what: "run 2 talks to the model" });
	const blocked = await command(stack, USER1, "/approve 1");
	assert.equal(
		blocked.text,
		`/approve rejected: a new run of Task 1 was admitted, so ${sha7(review1.head)}, the head the bot last posted, ` +
			"is no longer what would merge; wait for the bot to post that run's result, then approve its new head with " +
			"/approve 1.",
	);
	assert.deepEqual(approvals(stack), []);
	hold.release();

	// The owner approves the head the bot posted after run 2; it merges.
	const review2 = await reviewOf(stack, 1, 2, review1.message.id);
	assert.notEqual(review2.head, review1.head);
	const ownerAck = await command(stack, OWNER, "/approve 1");
	assert.ok(ownerAck.text.startsWith(`Approved Task 1 at ${sha7(review2.head)};`), ownerAck.text);
	await stack.waitForBotMessage(/^Task 1 merged into main/, { since: ownerAck.id });
	await stack.coordinator.idle();
	const main = await stack.mainSha();
	assert.deepEqual(await stack.parents(main), [mainBefore, review2.head]);
	assert.deepEqual(
		approvals(stack).map((a) => [a.user_id, a.head_commit, a.state]),
		[[OWNER, review2.head, "consumed"]],
	);
});

// ---------------------------------------------------------------------------------------------------------------
// (c) Merges one at a time

test("two approved tasks merge one at a time: never two merge intents pending; the second is combined, retested, approved again", {
	timeout: 180_000,
}, async (t) => {
	const hold = gate();
	const stack = await stackFor(t, { model: scriptedAgent(AGENTS) }, hold.release);
	const maxPending = probePendingIntents(stack);
	const mainBefore = await stack.mainSha();
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	// Task 2 is sent once Task 1's review is posted, so each gets the pull request number the test names (run at the
	// same time, the review that finishes first gets #1). Both still start from the same main: nothing has merged yet.
	const review1 = await reviewOf(stack, 1);
	stack.sendCommand(USER2, `/task beta ${B_TASK}`);
	const review2 = await reviewOf(stack, 2);

	// Every merge call reaching GitHub: which pull request, and the pending merge intents at that moment. The first
	// one is held so Task 2 gets approved while Task 1's merge is in flight.
	const atMerge: { path: string | undefined; pending: number[] }[] = [];
	stack.github.beforeMerge = async () => {
		const path = stack.github.calls.at(-1)?.path.replace(`/repos/${REPO}`, "");
		atMerge.push({ path, pending: pendingIntents(stack).map((intent) => intent.task_id) });
		if (atMerge.length === 1) await hold.promise;
	};
	const ack1 = await command(stack, USER1, "/approve 1");
	assert.match(
		ack1.text,
		/^Approved Task 1 at [0-9a-f]{7}; merging when the merge queue reaches it\. Merge queue position 1\./,
	);
	await waitFor(() => atMerge.length === 1, { what: "Task 1's merge call at GitHub" });
	const ack2 = await command(stack, USER2, "/approve 2");
	assert.ok(ack2.text.startsWith(`Approved Task 2 at ${sha7(review2.head)};`), ack2.text);
	assert.match(ack2.text, /Merge queue position 2\./);

	// Task 1's merge is with GitHub; Task 2 is approved and waiting, without a merge intent of its own.
	assert.deepEqual(
		pendingIntents(stack).map((intent) => intent.task_id),
		[1],
	);
	assert.deepEqual([taskRow(stack, 1).state, taskRow(stack, 2).state], ["merging", "merging"]);
	assert.deepEqual(
		approvals(stack).map((a) => [a.task_id, a.state]),
		[
			[1, "valid"],
			[2, "valid"],
		],
	);
	// A task whose merge is in flight is neither cancellable nor open to follow-ups (Architecture § task lifecycle).
	const cancel = await command(stack, USER1, "/cancel 1");
	assert.equal(cancel.text, "/cancel rejected: merge in progress for Task 1; it cannot be cancelled now.");
	const followup = await replyTo(stack, USER1, review1.message.id, "one more change please");
	assert.match(followup.text, /^Follow-up rejected: merge in progress for Task 1/);
	assert.equal(stack.runs().length, 2, "no run was admitted");
	assert.equal(taskRow(stack, 1).cancel_requested, 0);
	hold.release();

	const merged1 = await stack.waitForBotMessage(/^Task 1 merged into main/, { since: ack2.id });
	const moved = await stack.waitForBotMessage(
		/^Main moved; Task 2 was combined with the latest main and retested \(passed\)\./,
		{ since: ack2.id },
	);
	assert.ok(
		moved.text.endsWith(
			`Nothing was merged: the approval of ${sha7(review2.head)} does not cover this combined result, so approve ` +
				"it with /approve 2.",
		),
		moved.text,
	);
	await stack.coordinator.idle();
	const main1 = await stack.mainSha();
	assert.ok(merged1.text.includes(sha7(main1)), merged1.text);
	assert.deepEqual(await stack.parents(main1), [mainBefore, review1.head]);
	const combined = taskRow(stack, 2);
	assert.equal(combined.state, "review", "Task 2 needs a new approval");
	assert.ok(combined.head_commit !== null);
	assert.ok(moved.text.includes(`Head: ${sha7(combined.head_commit)}.`), moved.text);
	assert.deepEqual(await stack.parents(combined.head_commit), [review2.head, main1], "main merged into task/2");
	assert.equal(combined.tests_passed_head, combined.head_commit, "the combined result was tested");
	assert.equal(combined.posted_head, combined.head_commit);
	assert.equal(await stack.branchSha("task/2"), combined.head_commit, "the combined result is pushed");
	assert.equal(await stack.fileAtMain("b.js"), undefined, "nothing of Task 2 merged yet");
	assert.deepEqual(mergeCalls(stack.github), ["/pulls/1/merge"], "Task 2 never reached GitHub's merge");
	assert.deepEqual(
		approvals(stack).map((a) => [a.task_id, a.state]),
		[
			[1, "consumed"],
			[2, "invalidated"],
		],
	);

	// A new approval of the combined head merges it on top of Task 1.
	const again = await command(stack, USER2, "/approve 2");
	assert.ok(again.text.startsWith(`Approved Task 2 at ${sha7(combined.head_commit)};`), again.text);
	await stack.waitForBotMessage(/^Task 2 merged into main/, { since: again.id });
	await stack.coordinator.idle();
	const main2 = await stack.mainSha();
	assert.deepEqual(await stack.parents(main2), [main1, combined.head_commit]);
	assert.equal(await stack.fileAtMain("a.js"), A_JS);
	assert.equal(await stack.fileAtMain("b.js"), B_JS);

	// GitHub merge calls in order, each made with exactly one pending merge intent: that task's own.
	assert.deepEqual(mergeCalls(stack.github), ["/pulls/1/merge", "/pulls/2/merge"]);
	assert.deepEqual(atMerge, [
		{ path: "/pulls/1/merge", pending: [1] },
		{ path: "/pulls/2/merge", pending: [2] },
	]);
	assert.equal(maxPending(), 1, "never two merge intents pending at once");
	assert.deepEqual(
		intents(stack).map((i) => [i.task_id, i.state]),
		[
			[1, "merged"],
			[2, "returned"],
			[2, "merged"],
		],
	);
	assert.deepEqual(
		stack.tasks<TaskRow>().map((task) => task.state),
		["merged", "merged"],
	);
});

// ---------------------------------------------------------------------------------------------------------------
// (d) Main moved during the merge

test("main moves between the Coordinator's check and GitHub's merge: GitHub refuses, the Coordinator starts over, what merges was tested", {
	timeout: 120_000,
}, async (t) => {
	const stack = await stackFor(t, { model: scriptedAgent(AGENTS) });
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	const { head } = await reviewOf(stack, 1);

	// Inside GitHub's merge handler, before its checks: another change lands on main (once).
	let movedMain: string | undefined;
	stack.github.beforeMerge = async () => {
		movedMain ??= await commitOnOrigin(stack.origin.bare, "main", { "CHANGELOG.md": "# Changelog\n\n- other work\n" });
	};
	const ack = await command(stack, USER1, "/approve 1");
	assert.ok(ack.text.startsWith(`Approved Task 1 at ${sha7(head)};`), ack.text);
	const moved = await stack.waitForBotMessage(
		/^Main moved; Task 1 was combined with the latest main and retested \(passed\)\./,
		{ since: ack.id },
	);
	await stack.coordinator.idle();
	assert.ok(movedMain !== undefined);
	assert.deepEqual(mergeCalls(stack.github), ["/pulls/1/merge"], "one merge call, refused (405: not up to date)");
	assert.equal(await stack.mainSha(), movedMain, "nothing merged: main is only the other change");
	assert.equal(stack.github.pulls.get(1)?.merged, false);
	const task = taskRow(stack, 1);
	const combined = task.head_commit;
	assert.ok(combined !== null);
	assert.equal(task.state, "review", "approval required again");
	assert.ok(moved.text.includes(`Head: ${sha7(combined)}.`), moved.text);
	assert.deepEqual(await stack.parents(combined), [head, movedMain], "started over: main merged into task/1");
	assert.equal(task.tests_passed_head, combined, "the combined result was tested");
	assert.equal(await stack.branchSha("task/1"), combined);
	assert.deepEqual(
		intents(stack).map((i) => [i.state, i.reason]),
		[["returned", "main moved"]],
	);

	// The second approval merges exactly the tested combined commit.
	const again = await command(stack, USER1, "/approve 1");
	assert.ok(again.text.startsWith(`Approved Task 1 at ${sha7(combined)};`), again.text);
	await stack.waitForBotMessage(/^Task 1 merged into main/, { since: again.id });
	await stack.coordinator.idle();
	const main = await stack.mainSha();
	assert.deepEqual(await stack.parents(main), [movedMain, combined]);
	const pull = stack.github.pulls.get(1);
	assert.ok(pull?.merged === true);
	assert.equal(pull.mergeCommitSha, main);
	assert.equal(await stack.github.headSha(pull), combined, "GitHub merged the tested head");
	assert.equal(approvals(stack).at(-1)?.head_commit, combined);
	assert.equal(await stack.fileAtMain("a.js"), A_JS);
	assert.equal(await stack.fileAtMain("CHANGELOG.md"), "# Changelog\n\n- other work\n");
	assert.deepEqual(mergeCalls(stack.github), ["/pulls/1/merge", "/pulls/1/merge"]);
});

// ---------------------------------------------------------------------------------------------------------------
// (e) Merge conflict

const README_LINE = "A tiny project the e2e agents work on.";
const RESOLVED_README = "# demo\n\nA tiny project, reworded by alpha and by beta.\n";
const CONFLICT_INPUT = /^Merging the latest main branch into this task's branch stopped with conflicts/;

function rewordReadme(who: string): AgentPlan {
	return {
		when: new RegExp(`^reword the README tagline \\(${who}\\)`),
		steps: [
			{
				toolCalls: [
					{
						name: "edit",
						args: { path: "README.md", oldText: README_LINE, newText: `A tiny project, reworded by ${who}.` },
					},
				],
			},
			{ text: `README reworded by ${who}.` },
		],
	};
}

test("two tasks edit the same lines: the second merge lists the conflict, nothing merges, a fix run is admitted, then review and approval again", {
	timeout: 180_000,
}, async (t) => {
	const hold = gate();
	const stack = await stackFor(
		t,
		{
			model: scriptedAgent([
				rewordReadme("alpha"),
				rewordReadme("beta"),
				{
					when: CONFLICT_INPUT,
					steps: [
						// Held until the test looked at the worktree and tried /approve during the fix run.
						hold.promise.then(() => ({ toolCalls: [{ name: "read", args: { path: "README.md" } }] })),
						{ toolCalls: [{ name: "write", args: { path: "README.md", content: RESOLVED_README } }] },
						{ toolCalls: [{ name: "run_check", args: { operation: "test" } }] },
						{ text: "Resolved the README conflict: kept both rewordings." },
					],
				},
			]),
		},
		hold.release,
	);
	stack.sendCommand(USER1, "/task alpha reword the README tagline (alpha)");
	// Task 2 is sent once Task 1's review is posted, so each gets the pull request number the test names (run at the
	// same time, the review that finishes first gets #1). Both still start from the same main: nothing has merged yet.
	await reviewOf(stack, 1);
	stack.sendCommand(USER2, "/task beta reword the README tagline (beta)");
	const review2 = await reviewOf(stack, 2);
	const ack1 = await command(stack, USER1, "/approve 1");
	await stack.waitForBotMessage(/^Task 1 merged into main/, { since: ack1.id });
	await stack.coordinator.idle();
	const main1 = await stack.mainSha();

	// Merging Task 2 merges main into task/2 first: git reports the conflict, nothing merges.
	const ack2 = await command(stack, USER2, "/approve 2");
	const conflict = await stack.waitForBotMessage(/^Merge conflict in: /, { since: ack2.id });
	assert.equal(
		conflict.text,
		"Merge conflict in: README.md. Nothing was merged: Task 2 could not be combined with the latest main, so the " +
			`approval of ${sha7(review2.head)} no longer applies. A run of Task 2 was admitted to resolve it (queue ` +
			"position 1); when the bot posts its result, review it and approve the new head with /approve 2.",
	);
	assert.equal(await stack.mainSha(), main1, "nothing merged");
	assert.equal(await stack.fileAtMain("README.md"), "# demo\n\nA tiny project, reworded by alpha.\n");
	assert.deepEqual(mergeCalls(stack.github), ["/pulls/1/merge"]);
	assert.equal(stack.github.pulls.get(2)?.merged, false);
	assert.deepEqual(
		intents(stack).map((i) => [i.task_id, i.state, i.reason]),
		[
			[1, "merged", null],
			[2, "returned", "merge conflict"],
		],
	);
	assert.equal(approvals(stack).at(-1)?.state, "invalidated");

	// The fix run was admitted automatically for Task 2's agent; the merge is left in progress in the worktree.
	await waitFor(() => requestsFor(stack, CONFLICT_INPUT).length > 0, {
		what: "the conflict-fix run talks to the model",
	});
	const fixRun = stack.runs<RunRow>().at(-1);
	assert.equal(fixRun?.task_id, 2);
	assert.equal(fixRun?.kind, "conflict");
	assert.match(fixRun?.request_id ?? "", /^conflict-2-\d+$/);
	const onDisk = readFileSync(join(stack.config.paths.taskDir, "worktrees", "task-2", "README.md"), "utf8");
	assert.match(onDisk, /^<<<<<<< /m);
	assert.match(onDisk, /^>>>>>>> /m);
	assert.equal(taskRow(stack, 2).posted_head, null, "no head to approve during the fix");
	const early = await command(stack, USER2, "/approve 2");
	assert.equal(
		early.text,
		"/approve rejected: a conflict-fix run of Task 2 is queued or running, so there is no head to approve yet; " +
			"wait for the bot to post its result, then approve the new head with /approve 2.",
	);
	hold.release();

	// After the fix run: retested, pushed, back in review on the same pull request.
	const review3 = await reviewOf(stack, 2, 2, conflict.id);
	assert.match(review3.message.text, /Tests: passed\./);
	assert.ok(review3.message.text.includes(`Pull request: https://github.com/${REPO}/pull/2.`), review3.message.text);
	const afterRead = requestsFor(stack, CONFLICT_INPUT).find((request) => agentPosition(request).round === 1);
	const seen = JSON.stringify(afterRead?.body.input ?? "");
	assert.ok(seen.includes("<<<<<<<") && seen.includes("reworded by beta"), "the agent saw the conflict markers");
	assert.deepEqual(await stack.parents(review3.head), [review2.head, main1], "the fix concludes the merge of main");
	assert.equal(taskRow(stack, 2).tests_passed_head, review3.head);
	assert.equal(await stack.branchSha("task/2"), review3.head);
	assert.equal(stack.github.pulls.size, 2, "still one pull request per task");

	// Approved again: it merges.
	const ack3 = await command(stack, USER2, "/approve 2");
	assert.ok(ack3.text.startsWith(`Approved Task 2 at ${sha7(review3.head)};`), ack3.text);
	await stack.waitForBotMessage(/^Task 2 merged into main/, { since: ack3.id });
	await stack.coordinator.idle();
	const main2 = await stack.mainSha();
	assert.deepEqual(await stack.parents(main2), [main1, review3.head]);
	assert.equal(await stack.fileAtMain("README.md"), RESOLVED_README);
	assert.deepEqual(mergeCalls(stack.github), ["/pulls/1/merge", "/pulls/2/merge"]);
});

// ---------------------------------------------------------------------------------------------------------------
// (f) Lost pull request response

function isPullList(call: FakeCall): boolean {
	return call.method === "GET" && /\/pulls\?/.test(call.path);
}

function isPullCreate(call: FakeCall): boolean {
	return call.method === "POST" && /\/pulls$/.test(call.path);
}

test("lost pull request response: GitHub opens the PR but the answer is lost → found by head and base, exactly one PR", {
	timeout: 120_000,
}, async (t) => {
	const stack = await stackFor(t, { model: scriptedAgent(AGENTS) });
	stack.github.dropResponseAfterEffect("POST", /\/pulls$/);
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	const { message } = await reviewOf(stack, 1);
	assert.ok(message.text.includes(`Pull request: https://github.com/${REPO}/pull/1.`), message.text);
	await stack.coordinator.idle();
	assert.equal(stack.github.pulls.size, 1, "exactly one pull request");
	assert.equal(stack.github.count("POST", /\/pulls$/), 1, "it was opened once, never again");
	assert.equal(taskRow(stack, 1).pr_number, 1);
	// After the lost answer, the pull request was looked up by repository, base and head branch.
	const created = stack.github.calls.findIndex(isPullCreate);
	const lookup = stack.github.calls.slice(created + 1).find(isPullList);
	assert.ok(lookup !== undefined, "a lookup followed the lost response");
	const query = new URL(lookup.path, "http://github.invalid").searchParams;
	assert.deepEqual([query.get("head"), query.get("base")], [`${REPO.split("/")[0]}:task/1`, "main"]);
	assert.ok(lookup.path.startsWith(`/repos/${REPO}/pulls?`));
});

test("lost pull request response and GitHub unreadable: the group freezes; after a restart and the owner's unfreeze, recovery finds the one PR", {
	timeout: 120_000,
}, async (t) => {
	const stack = await stackFor(t, { model: scriptedAgent(AGENTS) });
	// The pull request is opened but its answer is lost, and every read-back lookup fails until the restart, so the
	// Coordinator cannot learn the outcome before it goes down.
	let created = false;
	let unreadable = true;
	onGitHubCall(stack.github, (call) => {
		if (isPullCreate(call)) created = true;
		else if (created && unreadable && isPullList(call)) stack.github.failNext("GET", /\/pulls\?/, 404);
	});
	stack.github.dropResponseAfterEffect("POST", /\/pulls$/);
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	const frozen = await stack.waitForBotMessage(/^Group frozen: /);
	assert.equal(
		frozen.text,
		"Group frozen: the outcome of opening the pull request on GitHub is unknown. Only the owner CLI can unfreeze it.",
	);
	await stack.coordinator.idle();
	assert.equal(stack.github.pulls.size, 1, "GitHub did open the pull request");
	assert.equal(taskRow(stack, 1).pr_number, null, "the Coordinator does not know it");
	assert.equal(stack.runs<RunRow>()[0]?.review_done, 0);

	// Restart: the frozen group holds the redo of the review step until the owner unfreezes it.
	unreadable = false;
	await stack.restart();
	await stack.coordinator.idle();
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "frozen");
	assert.equal(stack.runs<RunRow>()[0]?.review_done, 0);
	// The owner CLI, over the Coordinator's owner socket: the recovery checks pass, the group unfreezes.
	const unfrozen = await stack.owner("unfreeze");
	assert.equal(unfrozen.code, 0, unfrozen.stderr);

	// The recheck redoes the review step: it looks the pull request up by head and base and opens no second one.
	const { message } = await reviewOf(stack, 1, 1, frozen.id);
	assert.ok(message.text.includes(`Pull request: https://github.com/${REPO}/pull/1.`), message.text);
	await stack.coordinator.idle();
	assert.equal(stack.github.pulls.size, 1, "exactly one pull request");
	assert.equal(stack.github.count("POST", /\/pulls$/), 1, "opened once");
	const task = taskRow(stack, 1);
	assert.deepEqual([task.pr_number, task.pr_url], [1, `https://github.com/${REPO}/pull/1`]);
	assert.equal(stack.runs<RunRow>()[0]?.review_done, 1);
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal");
});

// ---------------------------------------------------------------------------------------------------------------
// (g) Restart mid-merge

test("restart after GitHub merged but before the Coordinator saved it: recovery sees main contains the head, no second merge", {
	timeout: 120_000,
}, async (t) => {
	const hold = gate();
	const stack = await stackFor(t, { model: scriptedAgent(AGENTS) }, hold.release);
	const mainBefore = await stack.mainSha();
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	const { head } = await reviewOf(stack, 1);

	// GitHub holds the merge call until the Coordinator is down, then merges and the answer is lost.
	let arrived = false;
	stack.github.beforeMerge = async () => {
		if (arrived) return;
		arrived = true;
		await hold.promise;
	};
	stack.github.dropResponseAfterEffect("PUT", /\/pulls\/1\/merge$/);
	const ack = await command(stack, USER1, "/approve 1");
	await waitFor(() => arrived, { what: "the merge call at GitHub" });
	assert.deepEqual(
		pendingIntents(stack).map((intent) => [intent.task_id, intent.head_commit]),
		[[1, head]],
		"the merge intent was saved before the merge call",
	);

	// The Coordinator goes down while waiting for GitHub's answer (its database is closed: it can record nothing).
	await stack.coordinator.stop();
	hold.release();
	await waitFor(() => stack.github.pulls.get(1)?.merged === true, { what: "GitHub merged" });
	const merged = await stack.mainSha();
	assert.deepEqual(await stack.parents(merged), [mainBefore, head]);

	// Restart: the saved intent is checked against GitHub; main already contains the head → merged, not merged again.
	await stack.restart();
	const done = await stack.waitForBotMessage(/^Task 1 merged into main \(/, { since: ack.id });
	assert.ok(done.text.includes(sha7(merged)), done.text);
	await stack.coordinator.idle();
	assert.deepEqual(mergeCalls(stack.github), ["/pulls/1/merge"], "GitHub was asked to merge once");
	assert.equal(await stack.mainSha(), merged);
	assert.equal(await mergeCommitsOnMain(stack), 1, "one merge commit on main");
	assert.equal(stack.lastBotMessages(50).filter((message) => /^Task 1 merged into main/.test(message.text)).length, 1);
	const task = taskRow(stack, 1);
	assert.deepEqual([task.state, task.worktree_path, task.archived], ["merged", null, 1]);
	assert.deepEqual(
		intents(stack).map((i) => [i.state, i.merge_commit]),
		[["merged", merged]],
	);
	assert.deepEqual(
		approvals(stack).map((a) => a.state),
		["consumed"],
	);
	assert.deepEqual(await stack.worktrees(), []);
	assert.deepEqual(await stack.branches(), ["main", "task/1"], "the task branch is kept");
});

test("lost merge response without a restart: the Coordinator reads GitHub before retrying and does not merge twice", {
	timeout: 120_000,
}, async (t) => {
	const stack = await stackFor(t, { model: scriptedAgent(AGENTS) });
	const mainBefore = await stack.mainSha();
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	const { head } = await reviewOf(stack, 1);
	stack.github.dropResponseAfterEffect("PUT", /\/pulls\/1\/merge$/);
	const ack = await command(stack, USER1, "/approve 1");
	const done = await stack.waitForBotMessage(/^Task 1 merged into main \(/, { since: ack.id });
	await stack.coordinator.idle();
	const merged = await stack.mainSha();
	assert.ok(done.text.includes(sha7(merged)), done.text);
	assert.deepEqual(await stack.parents(merged), [mainBefore, head]);
	assert.deepEqual(mergeCalls(stack.github), ["/pulls/1/merge"], "no second merge call");
	assert.equal(await mergeCommitsOnMain(stack), 1);
	// The read-back after the lost answer: does main contain the head?
	const put = stack.github.calls.findIndex((call) => call.method === "PUT");
	const compare = stack.github.calls
		.slice(put + 1)
		.find((call) => call.method === "GET" && call.path.includes("/compare/"));
	assert.ok(compare?.path.includes(`/compare/${head}...main`), compare?.path);
	assert.equal(taskRow(stack, 1).state, "merged");
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal");
});

// ---------------------------------------------------------------------------------------------------------------
// (h) Cancel in review

test("/cancel of a task in review closes its pull request and archives its worktree (folder gone, branch kept)", {
	timeout: 120_000,
}, async (t) => {
	const stack = await stackFor(t, { model: scriptedAgent(AGENTS) });
	const mainBefore = await stack.mainSha();
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	const review = await reviewOf(stack, 1);
	const worktree = join(stack.config.paths.taskDir, "worktrees", "task-1");
	assert.ok(existsSync(worktree));
	assert.equal(stack.github.pulls.get(1)?.state, "open");

	const ack = await command(stack, USER1, "/cancel 1");
	assert.equal(
		ack.text,
		"Cancelling Task 1… You will get a message once its pull request is closed and its worktree archived.",
	);
	const done = await stack.waitForBotMessage(/^Task 1 cancelled\./, { since: ack.id });
	assert.equal(done.text, "Task 1 cancelled. Pull request closed; branch task/1 kept.");
	await stack.coordinator.idle();
	const pull = stack.github.pulls.get(1);
	assert.deepEqual([pull?.state, pull?.merged], ["closed", false]);
	assert.equal(existsSync(worktree), false, "the worktree folder is deleted");
	assert.deepEqual(await stack.worktrees(), []);
	assert.deepEqual(await stack.branches(), ["main", "task/1"], "the branch is kept");
	assert.equal(await stack.branchSha("task/1"), review.head);
	const task = taskRow(stack, 1);
	assert.deepEqual([task.state, task.worktree_path, task.archived], ["cancelled", null, 1]);
	assert.equal(await stack.mainSha(), mainBefore);
	assert.deepEqual(mergeCalls(stack.github), []);

	// The task is over: a reply and /approve are rejected.
	const late = await replyTo(stack, USER1, review.message.id, "one more change please");
	assert.equal(late.text, "Follow-up rejected: Task 1 was cancelled; send a new /task for further work.");
	const approve = await command(stack, USER1, "/approve 1");
	assert.equal(approve.text, "/approve rejected: Task 1 is already cancelled.");
	assert.equal(stack.runs().length, 1);
});
