/**
 * Post-run review step (Architecture § Review and merge, first bullet): after a run is finalized and its process
 * and container are verified gone, run the approved tests on the worktree (read-only check container), commit a
 * checkpoint, push the branch (compared with GitHub first), open the task's pull request once or update it, and
 * post the link, the test result, the head commit and the test files the task changed. The task is then in review
 * and its agent is free. Idempotent: recovery redoes it for runs whose review did not complete.
 *
 * If GitHub refuses the push because the task branch changed outside the Coordinator, or the branch moved right after
 * the push, the outcome is definite: the checkpoint stays committed in the worktree, the task waits in review held
 * (branch-hold.ts), the message says which branch, both heads and what to do, and the group carries on. The run's
 * review stays not done; it is redone once the branch is restored (engine/held.ts, and recovery after a restart).
 */

import type { BranchHold } from "../branch-hold.ts";
import { clip, listFiles, reviewHeld, sha7 } from "../messages.ts";
import type { CheckOutcome, PullRequest } from "../ports.ts";
import {
	BranchMoved,
	type Ctx,
	clipText,
	describeError,
	enqueueTask,
	loadRun,
	loadTask,
	runNumber,
	type TaskRow,
	TERMINAL_TASK_STATES,
	taskRef,
	tx,
	UnknownEffect,
} from "./context.ts";
import { clearHold, ensurePullRequest, lastPushed, pushOrMoved, saveHold } from "./effects.ts";
import { effectsOpen } from "./intents.ts";

const ANSWER_IN_MESSAGE = 1500;
const TEST_FILE =
	/(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]*$|_test\.[A-Za-z0-9]+$/;

export const INTERRUPTED_NOTE = "interrupted by restart; reply to start another run (fresh conversation)";

export type TestResult = { readonly outcome: CheckOutcome; readonly passed: boolean };

/** The approved tests ("test" op) in a fresh check container with the worktree read-only. */
export async function runTests(ctx: Ctx, task: TaskRow, worktree: string): Promise<TestResult> {
	if (!ctx.sandbox.checkOps().includes("test")) return { outcome: "unknown_operation", passed: false };
	try {
		const result = await ctx.sandbox.runCheck({
			taskId: task.id,
			generation: task.generation,
			worktree,
			op: "test",
			writable: false,
			timeoutMs: ctx.limits.checkDeadlineMs,
		});
		return { outcome: result.outcome, passed: result.outcome === "passed" };
	} catch (error) {
		ctx.log.warn("tests_failed_to_run", { task: task.id, error: describeError(error) });
		return { outcome: "error", passed: false };
	}
}

export function testsText(tests: TestResult): string {
	return tests.passed ? "passed" : `failed (${tests.outcome})`;
}

export function isTestFile(path: string): boolean {
	return TEST_FILE.test(path);
}

export function pullRequestTitle(task: { id: number; text: string }): string {
	const firstLine = task.text.split("\n").find((line) => line.trim() !== "") ?? task.text;
	return `${taskRef(task.id)}: ${clip(firstLine, 60)}`;
}

function pullRequestBody(task: TaskRow, p: { runNo: number; tests: TestResult; head: string; answer: string }): string {
	return [
		`${taskRef(task.id)} for agent ${task.agent_id}, requested in Telegram by user ${task.creator_id}.`,
		"",
		clipText(task.text, 3000),
		"",
		`Latest run: run ${p.runNo}. Tests: ${testsText(p.tests)}. Head: ${p.head}.`,
		"",
		"The agent's answer (its claim, not a test result):",
		"",
		clipText(p.answer.trim() === "" ? "(none)" : p.answer, 3000),
	].join("\n");
}

type ReviewFacts = {
	readonly taskId: number;
	readonly runNo: number;
	readonly branch: string;
	readonly head: string;
	readonly tests: TestResult;
	readonly pr: PullRequest | undefined;
	readonly testFiles: readonly string[];
	readonly answer: string;
	readonly interrupted: boolean;
};

function reviewLead(f: ReviewFacts): string {
	const task = taskRef(f.taskId);
	if (f.interrupted)
		return `${task} was interrupted by restart (run ${f.runNo}); its work so far is saved on branch ${f.branch}.`;
	if (f.pr === undefined) return `${task} finished with no changes (run ${f.runNo}).`;
	return `${task} is ready for review (run ${f.runNo}).`;
}

function reviewNext(f: ReviewFacts, queued: boolean): string {
	if (queued) return "\nA follow-up run is queued; review again when it finishes.";
	const approve = f.pr === undefined ? "" : `, or send /approve ${f.taskId}`;
	if (f.interrupted) return `\nReply to this message to start another run (fresh conversation)${approve}.`;
	return `\nReply to this message for a follow-up${approve}.`;
}

/**
 * "Task 12 is ready for review (run 3). Tests: passed. Pull request: <url>. Head: <sha7>. Test files changed: <list|
 * none>." + the agent's answer (its claim) + how to continue.
 */
export function reviewText(f: ReviewFacts, queued: boolean): string {
	const files = f.testFiles.length === 0 ? "none" : listFiles(f.testFiles);
	const where =
		f.pr === undefined
			? ` Branch ${f.branch} is at main (${sha7(f.head)}); there is no pull request, so there is nothing to approve.`
			: ` Pull request: ${f.pr.url}. Head: ${sha7(f.head)}. Test files changed: ${files}.`;
	const answer = f.answer.trim();
	const said =
		answer === "" ? "" : `\nAgent's answer (its claim, not a test result): ${clipText(answer, ANSWER_IN_MESSAGE)}`;
	return `${reviewLead(f)} Tests: ${testsText(f.tests)}.${where}${said}${reviewNext(f, queued)}`;
}

function hasQueuedRun(ctx: Ctx, taskId: number): boolean {
	const n = ctx.store.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND state = 'queued'",
		taskId,
	)?.n;
	return (n ?? 0) > 0;
}

/**
 * Earlier runs of the task whose review is still not done (held: their push was refused) are superseded: this run's
 * checkpoint builds on theirs in the same worktree, so their review is never redone. Inside the transaction.
 */
function supersedeEarlierReviews(ctx: Ctx, taskId: number, runId: number): void {
	ctx.store.run(
		`UPDATE runs SET review_done = 1
		 WHERE task_id = ? AND id < ? AND review_done = 0 AND state IN ('finished', 'failed')`,
		taskId,
		runId,
	);
}

/** Record the review result and post it, in one transaction. */
function recordReview(ctx: Ctx, runId: number, f: ReviewFacts): void {
	const postedHead = f.pr === undefined ? null : f.head;
	const passedHead = f.tests.passed ? f.head : null;
	const note = f.interrupted ? INTERRUPTED_NOTE : null;
	const prNumber = f.pr?.number ?? null;
	const prUrl = f.pr?.url ?? null;
	tx(ctx, () => {
		const now = ctx.now();
		const current = loadTask(ctx, f.taskId);
		ctx.store.run("UPDATE runs SET checkpoint_commit = ?, review_done = 1 WHERE id = ?", f.head, runId);
		supersedeEarlierReviews(ctx, f.taskId, runId);
		// The checkpoint is on GitHub: a hold of the task (an earlier run's refused push) is over.
		clearHold(ctx, f.taskId);
		if (TERMINAL_TASK_STATES.has(current.state)) return;
		// A follow-up admitted during the review step keeps the task queued (approval waits for that run).
		const queued = hasQueuedRun(ctx, f.taskId);
		ctx.store.run(
			`UPDATE tasks SET state = ?, reason = ?, head_commit = ?, posted_head = ?, tests_passed_head = ?,
			   pr_number = COALESCE(?, pr_number), pr_url = COALESCE(?, pr_url),
			   review_since = ?, review_reminded = 0, updated_at = ?
			 WHERE id = ?`,
			queued ? "queued" : "review",
			note,
			f.head,
			postedHead,
			passedHead,
			prNumber,
			prUrl,
			now,
			now,
			f.taskId,
		);
		enqueueTask(ctx, current, "task_review", reviewText(f, queued));
	});
}

type Published = {
	readonly pr: PullRequest | undefined;
	/** The branch changed outside the Coordinator: the push was refused, or GitHub moved right after it. */
	readonly moved: BranchMoved | undefined;
	/** GitHub confirmed the push of the checkpoint. */
	readonly pushed: boolean;
};

/**
 * After the pull request step, GitHub's branch must still be at the pushed head (Interfaces § Coordinator to GitHub:
 * read GitHub's state). If it moved meanwhile, the review is held instead of posting a head GitHub no longer has. An
 * unreadable branch is left to the merge step, which reads GitHub's pull request again before any merge.
 */
async function movedSincePush(ctx: Ctx, branch: string, head: string): Promise<BranchMoved | undefined> {
	const now = await ctx.git.remoteBranchSha(branch).catch(() => head);
	if (now === undefined || now === head) return undefined;
	ctx.log.warn("push_branch_moved_after", { branch });
	return new BranchMoved(branch, now, head);
}

/** Push the checkpoint, then open or update the pull request (a branch with no commits beyond its base gets none). */
async function publish(
	ctx: Ctx,
	task: TaskRow,
	p: { branch: string; path: string; head: string; base: string; runNo: number; tests: TestResult; answer: string },
): Promise<Published> {
	const refused = await pushOrMoved(ctx, { branch: p.branch, path: p.path, head: p.head, expected: task.head_commit });
	if (refused !== undefined) return { pr: undefined, moved: refused, pushed: false };
	const pr =
		p.head !== p.base
			? await ensurePullRequest(ctx, task, {
					title: pullRequestTitle(task),
					body: pullRequestBody(task, { runNo: p.runNo, tests: p.tests, head: p.head, answer: p.answer }),
				})
			: undefined;
	return { pr, moved: await movedSincePush(ctx, p.branch, p.head), pushed: true };
}

type HeldReview = {
	readonly task: TaskRow;
	readonly runNo: number;
	readonly head: string;
	readonly tests: TestResult;
	readonly interrupted: boolean;
	readonly published: Published & { readonly moved: BranchMoved };
};

/** The task waits in review (or queued, if a follow-up run was admitted meanwhile). Inside the transaction. */
function setHeldTask(ctx: Ctx, current: TaskRow, runId: number, h: HeldReview, now: number): void {
	const { pr, pushed: pushedNow } = h.published;
	supersedeEarlierReviews(ctx, current.id, runId);
	// A checkpoint GitHub confirmed before the branch moved is the run's checkpoint and the task's head.
	if (pushedNow) ctx.store.run("UPDATE runs SET checkpoint_commit = ? WHERE id = ?", h.head, runId);
	ctx.store.run(
		`UPDATE tasks SET state = ?, reason = ?, head_commit = ?, pr_number = COALESCE(?, pr_number),
		   pr_url = COALESCE(?, pr_url), review_since = ?, review_reminded = 0, updated_at = ?
		 WHERE id = ?`,
		hasQueuedRun(ctx, current.id) ? "queued" : "review",
		h.interrupted ? INTERRUPTED_NOTE : null,
		pushedNow ? h.head : current.head_commit,
		pr?.number ?? null,
		pr?.url ?? null,
		now,
		now,
		current.id,
	);
}

/**
 * The checkpoint could not be put on GitHub because the branch changed outside the Coordinator: the task waits with
 * its worktree, held until the branch is restored (its review_done stays 0), and the message says why and what to do.
 */
function holdReview(ctx: Ctx, runId: number, h: HeldReview): void {
	const { moved, pushed: pushedNow } = h.published;
	const pushed = pushedNow ? h.head : lastPushed(ctx, h.task);
	const facts = { taskId: h.task.id, branch: moved.branch, github: moved.github, local: h.head, pushed };
	tx(ctx, () => {
		const now = ctx.now();
		const current = loadTask(ctx, h.task.id);
		if (TERMINAL_TASK_STATES.has(current.state)) return;
		setHeldTask(ctx, current, runId, h, now);
		const { taskId, ...rest } = facts;
		const hold: BranchHold = { kind: "review", runId, interrupted: h.interrupted, ...rest, since: now };
		if (!saveHold(ctx, taskId, hold)) return;
		const text = reviewHeld({ ...facts, runNo: h.runNo, tests: testsText(h.tests), interrupted: h.interrupted });
		enqueueTask(ctx, current, "task_held", text);
	});
	ctx.log.warn("review_held", { task: h.task.id, run: runId, pushed: pushedNow, tests: h.tests.outcome });
}

/**
 * The review step for `runId`; the caller holds an execution slot. Throws on an unknown effect (the caller
 * freezes the group; review_done stays 0 so the step is redone after resolution). A branch changed outside the
 * Coordinator holds the task instead (holdReview).
 */
export async function reviewStep(ctx: Ctx, runId: number, options: { interrupted: boolean }): Promise<void> {
	const run = loadRun(ctx, runId);
	if (run.review_done === 1) return;
	// Fails closed: the checkpoint commits the whole worktree, so only once every file change is reconciled.
	if (effectsOpen(ctx.store, run.task_id))
		throw new UnknownEffect(`the file changes of ${taskRef(run.task_id)} are not reconciled`);
	const task = loadTask(ctx, run.task_id);
	const { worktree_path: path, branch, base_commit: base } = task;
	if (path === null || branch === null || base === null) {
		tx(ctx, () => ctx.store.run("UPDATE runs SET review_done = 1 WHERE id = ?", runId));
		return;
	}
	const runNo = runNumber(ctx, run);
	const tests = await runTests(ctx, task, path);
	const head = (await ctx.git.checkpoint(path, `${taskRef(task.id)}: run ${runNo} checkpoint`)).commit;
	const answer = run.answer ?? "";
	const published = await publish(ctx, task, { branch, path, head, base, runNo, tests, answer });
	const { interrupted } = options;
	if (published.moved !== undefined) {
		holdReview(ctx, runId, {
			task,
			runNo,
			head,
			tests,
			interrupted,
			published: { ...published, moved: published.moved },
		});
		return;
	}
	const pr = published.pr;
	const testFiles = head !== base ? (await ctx.git.changedFiles(base, head)).filter(isTestFile) : [];
	recordReview(ctx, runId, { taskId: task.id, runNo, branch, head, tests, pr, testFiles, answer, interrupted });
	ctx.log.info("review_posted", {
		task: task.id,
		run: runId,
		tests: tests.outcome,
		pr: pr?.number,
		test_files: testFiles.length,
		interrupted,
	});
}
