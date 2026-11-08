/**
 * A task branch moved on GitHub outside the Coordinator, end to end through the real Coordinator against 127.0.0.1
 * fakes (Interfaces and Storage § Telegram /approve "is rejected if the branch has changed", § Coordinator to GitHub
 * "Before retrying any GitHub change ... reads GitHub's current state ... If the outcome is still unknown, the group
 * freezes"; Requirements § Safe recovery; Architecture § Review and merge ("The folder is deleted only after GitHub
 * confirms the push"), § Fails closed; Evaluation § Fault Track "Stale approval").
 *
 * A commit pushed to a task branch on GitHub (commitOnOrigin) is a DEFINITE outcome for the Coordinator's next push of
 * that branch: GitHub refuses it, nothing was pushed. At each point (before /approve, between /approve and GitHub's
 * merge, before a follow-up run's checkpoint push, before /cancel's final push):
 *   - only that task waits (back in review, or cancelled with its worktree kept); the group is not frozen and the
 *     other tasks keep running and merging;
 *   - nothing is force-pushed (origin's reflog: every push to the branch is a fast-forward) and the foreign commit
 *     stays until someone restores the branch; the task's own work stays committed in its worktree;
 *   - once the branch is restored, /approve merges (after the bot posts the kept checkpoint) or /cancel archives.
 * A push whose outcome really is unknown (its answer lost, or the network down, and GitHub unreadable after the
 * bounded retries) still freezes the group; after the owner unfreezes it, the recheck finishes the review step.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { type Git, GitError } from "../../src/coordinator/git.ts";
import type { ServerMessage } from "../fixtures/fake-bot-api.ts";
import { waitFor } from "../helpers/env.ts";
import { commitOnOrigin, originGit } from "../helpers/fake-github.ts";
import type { RecordedRequest } from "../helpers/fake-model.ts";
import {
	type AgentPlan,
	agentPosition,
	GROUP,
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
	worktree_path: string | null;
	head_commit: string | null;
	posted_head: string | null;
	pr_number: number | null;
	archived: number;
};
type RunRow = { id: number; task_id: number; kind: string; state: string; review_done: number };

const A_TASK = "add a.js exporting a()";
const B_TASK = "add b.js exporting b()";
const A_JS = "exports.a = () => 1;\n";
const B_JS = "exports.b = () => 2;\n";
const C_JS = "exports.c = () => 3;\n";
const EVIL_JS = "exports.evil = true;\n";
const ZERO = "0".repeat(40);

const sha7 = (sha: string | null | undefined): string => (sha ?? "").slice(0, 7);

function gate(): { readonly promise: Promise<void>; release(): void } {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release: () => release() };
}

/** The agent writes one file, then answers. */
function writer(when: RegExp, path: string, content: string, answer: string): AgentPlan {
	return { when, steps: [{ toolCalls: [{ name: "write", args: { path, content } }] }, { text: answer }] };
}

/** Task 2's agent: held before it writes b.js until `hold` is released (it is "running" meanwhile). */
function heldWriterB(hold: { promise: Promise<void> }): AgentPlan {
	return {
		when: /^add b\.js exporting b\(\)/,
		steps: [
			hold.promise.then(() => ({ toolCalls: [{ name: "write", args: { path: "b.js", content: B_JS } }] })),
			{ text: "Added b.js." },
		],
	};
}

const AGENT_A = writer(/^add a\.js exporting a\(\)/, "a.js", A_JS, "Added a.js.");

async function stackFor(t: TestContext, options: StackOptions, cleanup: () => void = () => {}): Promise<Stack> {
	const stack = await startStack(options);
	t.after(() => {
		cleanup();
		return stack.stop();
	});
	// Origin keeps a reflog of every ref update: the proof that nothing was force-pushed.
	await originGit(stack.origin.bare, ["config", "core.logAllRefUpdates", "always"]);
	return stack;
}

function taskRow(stack: Stack, id: number): TaskRow {
	const row = stack.tasks<TaskRow>().find((task) => task.id === id);
	assert.ok(row !== undefined, `Task ${id} exists`);
	return row;
}

function requestsFor(stack: Stack, input: RegExp): RecordedRequest[] {
	return stack.model.requests.filter((request) => input.test(agentPosition(request).input));
}

async function command(stack: Stack, userId: number, text: string): Promise<ServerMessage> {
	const since = stack.lastBotMessageId();
	const sent = stack.sendCommand(userId, text);
	return stack.waitForBotMessage((message) => message.replyTo === sent, { since });
}

async function replyTo(stack: Stack, userId: number, messageId: number, text: string): Promise<ServerMessage> {
	const since = stack.lastBotMessageId();
	const sent = stack.reply(userId, messageId, text);
	return stack.waitForBotMessage((message) => message.replyTo === sent, { since });
}

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

/** Someone pushes a commit to the task branch on GitHub (on top of what is there). */
function pushOutside(stack: Stack, branch: string, file = "evil.js"): Promise<string> {
	return commitOnOrigin(stack.origin.bare, branch, { [file]: EVIL_JS }, { message: "pushed outside the Coordinator" });
}

/** What the messages ask for: force the branch on GitHub back to `sha` (only if it is still at `from`). */
async function restoreBranch(stack: Stack, branch: string, sha: string, from: string): Promise<void> {
	await originGit(stack.origin.bare, ["update-ref", `refs/heads/${branch}`, sha, from]);
	assert.equal(await stack.branchSha(branch), sha);
}

/**
 * Every push to `branch` on origin was a fast-forward (the Coordinator is the only pusher; the test's own updates
 * are update-ref calls, not pushes). Returns how many pushes there were.
 */
async function assertOnlyFastForwardPushes(stack: Stack, branch: string): Promise<number> {
	const log = readFileSync(join(stack.origin.bare, "logs", "refs", "heads", ...branch.split("/")), "utf8");
	const pushes = log
		.split("\n")
		.filter((line) => line.split("\t")[1] === "push")
		.map((line) => line.split(" ").slice(0, 2) as [string, string]);
	assert.ok(pushes.length > 0, `the Coordinator pushed ${branch}`);
	for (const [from, to] of pushes) {
		assert.ok(
			from === ZERO || (await stack.isAncestor(from, to)),
			`push ${sha7(from)} → ${sha7(to)} is a fast-forward`,
		);
	}
	return pushes.length;
}

/** The group is not frozen and Task `running` is still running (not cancelled "group frozen"). */
function assertGroupCarriesOn(stack: Stack, running?: number): void {
	assert.deepEqual(stack.coordinator.store.groupState(GROUP), { state: "normal", reason: null, recheck: false });
	assert.equal(
		stack.lastBotMessages(50).filter((message) => /^Group frozen/.test(message.text)).length,
		0,
		"no freeze notice",
	);
	if (running === undefined) return;
	assert.equal(taskRow(stack, running).state, "running");
	assert.equal(stack.runs<RunRow>().find((run) => run.task_id === running)?.state, "running");
}

type Hold = {
	kind: string;
	runId: number | null;
	branch: string;
	local: string;
	pushed: string | null;
	github: string;
};

function holdOf(stack: Stack, id: number): Hold | undefined {
	const raw = stack.coordinator.store.getMeta(`branch_hold:${id}`);
	return raw === undefined ? undefined : (JSON.parse(raw) as Hold);
}

/** A file at a commit of the Coordinator's own repository (where the worktrees' commits live). */
async function fileAtLocal(stack: Stack, sha: string, path: string): Promise<string | undefined> {
	const repo = join(stack.config.paths.taskDir, "repo.git");
	const result = await originGit(repo, ["show", `${sha}:${path}`], { okCodes: [0, 128] });
	return result.code === 0 ? result.stdout : undefined;
}

async function fileAt(stack: Stack, rev: string, path: string): Promise<string | undefined> {
	const result = await originGit(stack.origin.bare, ["show", `${rev}:${path}`], { okCodes: [0, 128] });
	return result.code === 0 ? result.stdout : undefined;
}

/** The approval rejection of the merge step (engine/merge.ts; messages.ts approvalBranchChanged). */
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

function restoreLines(id: number, pushed: string): string[] {
	return [
		`What to do: restore task/${id} on GitHub to ${sha7(pushed)}, for example from a clone after git fetch origin:`,
		`git push --force origin ${pushed}:refs/heads/task/${id}`,
		"(this drops the commits pushed since; save them on another branch first if you need them).",
	];
}

function whyMoved(id: number, onGitHub: string, pushed: string): string {
	return (
		`Why: branch task/${id} on GitHub is at ${sha7(onGitHub)}, but the Coordinator last pushed ${sha7(pushed)} ` +
		"there: the branch changed outside the Coordinator. The Coordinator never overwrites commits on GitHub."
	);
}

// ---------------------------------------------------------------------------------------------------------------
// At /approve: the merge step reads GitHub's pull request first

test("branch moved before /approve: the approval is rejected, only that task is back in review; the group carries on (another task runs and merges); restored → /approve merges, never force-pushed", {
	timeout: 180_000,
}, async (t) => {
	const hold = gate();
	const stack = await stackFor(t, { model: scriptedAgent([AGENT_A, heldWriterB(hold)]) }, hold.release);
	const mainBefore = await stack.mainSha();
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	const { head: posted } = await reviewOf(stack, 1);
	stack.sendCommand(USER2, `/task beta ${B_TASK}`);
	await waitFor(() => requestsFor(stack, /^add b\.js/).length > 0, { what: "Task 2 is running" });

	const foreign = await pushOutside(stack, "task/1");
	const ack = await command(stack, USER1, "/approve 1");
	assert.ok(ack.text.startsWith(`Approved Task 1 at ${sha7(posted)};`), ack.text);
	const rejected = await stack.waitForBotMessage(/^Approval of Task 1 rejected; nothing was merged\./, {
		since: ack.id,
	});
	assert.equal(rejected.text, staleApprovalText(1, foreign, posted));
	assert.equal(taskRow(stack, 1).state, "review");
	assertGroupCarriesOn(stack, 2);
	assert.equal(await stack.branchSha("task/1"), foreign, "the foreign commit is not overwritten");
	assert.equal(await stack.mainSha(), mainBefore);

	// The other task keeps going and merges while Task 1 waits.
	hold.release();
	await reviewOf(stack, 2, 1, rejected.id);
	const approve2 = await command(stack, USER2, "/approve 2");
	await stack.waitForBotMessage(/^Task 2 merged into main/, { since: approve2.id });
	assert.equal(await stack.branchSha("task/1"), foreign, "still not overwritten");

	// Restored as the message says: /approve again; main moved (Task 2), so the combined result is approved again.
	await restoreBranch(stack, "task/1", posted, foreign);
	const again = await command(stack, USER1, "/approve 1");
	assert.ok(again.text.startsWith(`Approved Task 1 at ${sha7(posted)};`), again.text);
	await stack.waitForBotMessage(/^Main moved; Task 1 was combined with the latest main and retested \(passed\)/, {
		since: again.id,
	});
	await stack.coordinator.idle();
	const combined = taskRow(stack, 1).posted_head ?? "";
	const third = await command(stack, USER1, "/approve 1");
	await stack.waitForBotMessage(/^Task 1 merged into main/, { since: third.id });
	await stack.coordinator.idle();
	assert.deepEqual((await stack.parents(await stack.mainSha()))[1], combined, "the approved combined head merged");
	assert.equal(await stack.fileAtMain("a.js"), A_JS);
	assert.equal(await stack.fileAtMain("b.js"), B_JS);
	assert.equal(await stack.fileAtMain("evil.js"), undefined, "the commit pushed outside never merges");
	assertGroupCarriesOn(stack);
	await assertOnlyFastForwardPushes(stack, "task/1");
});

test("branch moved between /approve and GitHub's merge: GitHub refuses, the approval is rejected; another task keeps running; restored → /approve merges exactly the approved head", {
	timeout: 180_000,
}, async (t) => {
	const hold = gate();
	const stack = await stackFor(t, { model: scriptedAgent([AGENT_A, heldWriterB(hold)]) }, hold.release);
	const mainBefore = await stack.mainSha();
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	const { head: posted } = await reviewOf(stack, 1);
	stack.sendCommand(USER2, `/task beta ${B_TASK}`);
	await waitFor(() => requestsFor(stack, /^add b\.js/).length > 0, { what: "Task 2 is running" });

	let foreign: string | undefined;
	stack.github.beforeMerge = async () => {
		foreign ??= await pushOutside(stack, "task/1", "late.js");
	};
	const ack = await command(stack, USER1, "/approve 1");
	const rejected = await stack.waitForBotMessage(/^Approval of Task 1 rejected; nothing was merged\./, {
		since: ack.id,
	});
	stack.github.beforeMerge = undefined;
	assert.ok(foreign !== undefined);
	assert.equal(rejected.text, staleApprovalText(1, foreign, posted));
	assert.equal(stack.github.count("PUT", /\/pulls\/1\/merge$/), 1, "GitHub refused the one merge call");
	assert.equal(await stack.mainSha(), mainBefore, "nothing merged");
	assert.equal(taskRow(stack, 1).state, "review");
	assertGroupCarriesOn(stack, 2);
	assert.equal(await stack.branchSha("task/1"), foreign);

	await restoreBranch(stack, "task/1", posted, foreign);
	const again = await command(stack, USER1, "/approve 1");
	await stack.waitForBotMessage(/^Task 1 merged into main/, { since: again.id });
	assert.deepEqual(await stack.parents(await stack.mainSha()), [mainBefore, posted], "exactly the approved head");
	assert.equal(await stack.fileAtMain("late.js"), undefined);
	hold.release();
	await reviewOf(stack, 2, 1, again.id);
	assertGroupCarriesOn(stack);
	await assertOnlyFastForwardPushes(stack, "task/1");
});

// ---------------------------------------------------------------------------------------------------------------
// At a follow-up run's checkpoint push

test("branch moved before a follow-up run's checkpoint push: refused, so the checkpoint stays in the worktree and only that task is held in review (no freeze; another task keeps running); restored → pushed, posted, approved and merged", {
	timeout: 180_000,
}, async (t) => {
	const hold = gate();
	const stack = await stackFor(
		t,
		{
			model: scriptedAgent([
				AGENT_A,
				heldWriterB(hold),
				writer(/^also add c\.js exporting c\(\)/, "c.js", C_JS, "Added c.js."),
			]),
		},
		hold.release,
	);
	const mainBefore = await stack.mainSha();
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	const review1 = await reviewOf(stack, 1);
	const posted = review1.head;
	stack.sendCommand(USER2, `/task beta ${B_TASK}`);
	await waitFor(() => requestsFor(stack, /^add b\.js/).length > 0, { what: "Task 2 is running" });

	const foreign = await pushOutside(stack, "task/1");
	const started = await replyTo(stack, USER1, review1.message.id, "also add c.js exporting c()");
	assert.match(started.text, /^Follow-up started another run of Task 1 on the same branch and pull request\./);
	const held = await stack.waitForBotMessage(
		/^Task 1 finished run 2, but GitHub refused the push of its checkpoint\./,
		{
			since: started.id,
		},
	);
	// The hold is saved in the same transaction as the message (no idle(): Task 2 is held on purpose).
	const kept = holdOf(stack, 1);
	assert.ok(kept !== undefined);
	assert.deepEqual([kept.kind, kept.pushed, kept.github], ["review", posted, foreign]);
	assert.equal(
		held.text,
		[
			"Task 1 finished run 2, but GitHub refused the push of its checkpoint. Nothing was merged.",
			whyMoved(1, foreign, posted),
			`Kept: the run's work is committed in the task's worktree as ${sha7(kept.local)} (tests: passed); it is not on ` +
				"GitHub yet.",
			...restoreLines(1, posted),
			`Once that is done, the Coordinator pushes ${sha7(kept.local)} and posts it for review; approve it then with ` +
				"/approve 1. Or send /cancel 1 to drop the task.",
			"Until then /approve 1 is rejected. The other tasks and the group carry on.",
		].join("\n"),
	);
	// Only that task waits: the group is not frozen, Task 2 still runs, nothing is pushed over the foreign commit,
	// and run 2's work is committed in Task 1's worktree.
	assertGroupCarriesOn(stack, 2);
	const task = taskRow(stack, 1);
	assert.deepEqual([task.state, task.head_commit, task.posted_head], ["review", posted, posted]);
	assert.equal(await stack.branchSha("task/1"), foreign);
	assert.ok(task.worktree_path !== null && existsSync(join(task.worktree_path, "c.js")));
	assert.equal(await fileAtLocal(stack, kept.local, "c.js"), C_JS);
	assert.equal(await fileAtLocal(stack, kept.local, "a.js"), A_JS);
	const blocked = await command(stack, USER1, "/approve 1");
	assert.equal(
		blocked.text,
		`/approve rejected: the latest checkpoint of Task 1, ${sha7(kept.local)}, is not on GitHub yet: branch task/1 ` +
			`changed on GitHub outside the Coordinator (it was at ${sha7(foreign)} when the Coordinator last looked); once ` +
			`it is restored to ${sha7(posted)}, the bot pushes ${sha7(kept.local)} and posts it for review; approve it then.`,
	);

	// Task 2 finishes meanwhile.
	hold.release();
	await reviewOf(stack, 2, 1, held.id);

	// Restored: the Coordinator pushes the kept checkpoint (a fast-forward) and posts it; approving it merges.
	await restoreBranch(stack, "task/1", posted, foreign);
	const review2 = await reviewOf(stack, 1, 2, blocked.id);
	assert.equal(review2.head, kept.local);
	assert.equal(await stack.branchSha("task/1"), kept.local);
	assert.equal(holdOf(stack, 1), undefined);
	const approve = await command(stack, USER1, "/approve 1");
	assert.ok(approve.text.startsWith(`Approved Task 1 at ${sha7(kept.local)};`), approve.text);
	await stack.waitForBotMessage(/^Task 1 merged into main/, { since: approve.id });
	assert.deepEqual(await stack.parents(await stack.mainSha()), [mainBefore, kept.local]);
	assert.equal(await stack.fileAtMain("c.js"), C_JS);
	assert.equal(await stack.fileAtMain("evil.js"), undefined, "the commit pushed outside never merges");
	assert.equal(stack.github.pulls.size, 2, "one pull request per task");
	assertGroupCarriesOn(stack);
	await assertOnlyFastForwardPushes(stack, "task/1");
});

// ---------------------------------------------------------------------------------------------------------------
// At /cancel's final push

test("branch moved before /cancel's final push: cancelled, pull request closed, worktree and its final checkpoint kept (no freeze; new work still runs); restored → pushed and archived", {
	timeout: 180_000,
}, async (t) => {
	const hold = gate();
	const stack = await stackFor(
		t,
		{
			model: scriptedAgent([
				AGENT_A,
				writer(/^add b\.js exporting b\(\)/, "b.js", B_JS, "Added b.js."),
				{
					when: /^keep going on wip/,
					steps: [
						{ toolCalls: [{ name: "write", args: { path: "wip.js", content: C_JS } }] },
						hold.promise.then(() => ({ text: "Done." })),
					],
				},
			]),
		},
		hold.release,
	);
	stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
	const review1 = await reviewOf(stack, 1);
	const posted = review1.head;
	const started = await replyTo(stack, USER1, review1.message.id, "keep going on wip");
	assert.match(started.text, /^Follow-up started another run of Task 1/);
	// Run 2 wrote wip.js and waits for its model's next answer.
	await waitFor(() => requestsFor(stack, /^keep going on wip/).length >= 2, { what: "run 2 wrote wip.js" });

	const foreign = await pushOutside(stack, "task/1");
	const cancel = await command(stack, USER1, "/cancel 1");
	assert.match(cancel.text, /^Cancelling Task 1…/);
	const heldMessage = await stack.waitForBotMessage(/^Task 1 cancelled\. Its worktree is kept/, { since: cancel.id });
	await stack.coordinator.idle();
	const kept = holdOf(stack, 1);
	assert.ok(kept !== undefined);
	assert.deepEqual([kept.kind, kept.pushed, kept.github], ["archive", posted, foreign]);
	assert.equal(
		heldMessage.text,
		[
			"Task 1 cancelled. Its worktree is kept: GitHub refused its final push.",
			whyMoved(1, foreign, posted),
			`Kept: the task's work is committed in its worktree as ${sha7(kept.local)}; it is not on GitHub yet. Nothing ` +
				"was merged. Its pull request is closed.",
			...restoreLines(1, posted),
			`Once that is done, the Coordinator pushes ${sha7(kept.local)} and archives the worktree; the branch is kept.`,
		].join("\n"),
	);
	assertGroupCarriesOn(stack);
	const task = taskRow(stack, 1);
	assert.deepEqual([task.state, task.archived], ["cancelled", 0]);
	assert.deepEqual(await stack.worktrees(), ["task-1"], "the worktree is kept");
	assert.equal(await fileAtLocal(stack, kept.local, "wip.js"), C_JS, "the final checkpoint holds run 2's work");
	assert.equal(stack.github.pulls.get(1)?.state, "closed");
	assert.equal(await stack.branchSha("task/1"), foreign);

	// New work is dispatched and reviewed while Task 1 waits.
	stack.sendCommand(USER2, `/task beta ${B_TASK}`);
	const review2 = await reviewOf(stack, 2, 1, heldMessage.id);

	// Restored: the final checkpoint is pushed (a fast-forward), then the worktree is archived; the branch keeps it.
	await restoreBranch(stack, "task/1", posted, foreign);
	const final = await stack.waitForBotMessage(/^Task 1 cancelled\. Pull request closed/, { since: review2.message.id });
	assert.equal(final.text, "Task 1 cancelled. Pull request closed; branch task/1 kept.");
	await stack.coordinator.idle();
	assert.deepEqual(await stack.worktrees(), ["task-2"]);
	assert.equal(await stack.branchSha("task/1"), kept.local);
	assert.equal(await fileAt(stack, "refs/heads/task/1", "wip.js"), C_JS);
	assert.equal(holdOf(stack, 1), undefined);
	assert.deepEqual([taskRow(stack, 1).worktree_path, taskRow(stack, 1).archived], [null, 1]);
	assertGroupCarriesOn(stack);
	await assertOnlyFastForwardPushes(stack, "task/1");
});

// ---------------------------------------------------------------------------------------------------------------
// The genuinely uncertain case still freezes

for (const [what, lands] of [
	["its answer is lost", true],
	["the network fails", false],
] as const) {
	test(`a push whose outcome is unknown (${what}, and GitHub cannot be read back after the retries) still freezes the group; after the owner unfreezes it, the recheck finishes the review`, {
		timeout: 180_000,
	}, async (t) => {
		const net = { down: false, failPush: true };
		const wrapGit = (git: Git): Git => ({
			...git,
			async remoteBranchSha(branch) {
				if (net.down) throw new GitError("timeout", "ls-remote timed out");
				return git.remoteBranchSha(branch);
			},
			async push(path, branch) {
				if (!net.failPush) return git.push(path, branch);
				net.down = true;
				if (lands) await git.push(path, branch);
				throw new GitError("timeout", "git push timed out");
			},
		});
		const stack = await stackFor(t, { model: scriptedAgent([AGENT_A]), wrap: { git: wrapGit } });
		stack.sendCommand(USER1, `/task alpha ${A_TASK}`);
		const frozen = await stack.waitForBotMessage(/^Group frozen:/, { timeoutMs: 90_000 });
		assert.equal(
			frozen.text,
			"Group frozen: the push of task/1 could not be confirmed. Only the owner CLI can unfreeze it.",
		);
		await stack.coordinator.idle();
		assert.equal(stack.coordinator.store.groupState(GROUP).state, "frozen");
		assert.equal(holdOf(stack, 1), undefined, "an unknown outcome is not a held branch");
		const run = stack.runs<RunRow>()[0];
		assert.deepEqual([run?.state, run?.review_done], ["finished", 0]);
		const head = await originGit(join(stack.config.paths.taskDir, "repo.git"), ["rev-parse", "refs/heads/task/1"]);
		assert.equal(await stack.branchSha("task/1"), lands ? head.stdout.trim() : undefined);
		assert.equal(
			stack.lastBotMessages(20).filter((message) => /is ready for review/.test(message.text)).length,
			0,
			"nothing is posted on a guess",
		);

		// GitHub is reachable again; the owner unfreezes; the recheck compares with GitHub, then finishes the review.
		net.down = false;
		net.failPush = false;
		const unfrozen = await stack.owner("unfreeze");
		assert.equal(unfrozen.code, 0, unfrozen.stderr);
		const review = await reviewOf(stack, 1, 1, frozen.id);
		assert.equal(review.head, head.stdout.trim());
		assert.equal(await stack.branchSha("task/1"), review.head);
		assert.equal(stack.github.pulls.size, 1);
		assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal");
		await assertOnlyFastForwardPushes(stack, "task/1");
	});
}
