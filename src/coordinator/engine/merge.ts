/**
 * Merge worker (Architecture § Review and merge; Interfaces and Storage § Coordinator to GitHub; Capacity § Fixed
 * limits "Merges: 1 at a time per repository"). Strictly one merge at a time (an in-memory flag plus at most one
 * pending merge intent). A merge intent is saved before any merge step, so recovery can ask GitHub whether main
 * already contains the head before trying again.
 *
 * For an approved task: GitHub's PR head must still equal the approved head (else the approval is rejected). Fetch
 * main. If main has not moved for this branch, the tests that passed at the end of the run cover this commit
 * (failed tests block the merge) and GitHub is asked to merge exactly that commit; the up-to-date rule makes GitHub
 * refuse if main moved meanwhile, and the Coordinator starts over. If main moved, main is merged into the task
 * branch in its worktree: a conflict admits a conflict-fix run; a clean result is tested, pushed and goes back to
 * review for a new approval. Merge tests hold a 'check' execution slot.
 */
import { admitRun } from "../admission.ts";
import { clip, sha7 } from "../messages.ts";
import { GitHubError, type MergeResult, type PullRequest } from "../ports.ts";
import {
	type Ctx,
	enqueueTask,
	groupHeld,
	loadTask,
	releaseSlot,
	reserveCheckSlot,
	sleep,
	type TaskRow,
	taskRef,
	tx,
	UnknownEffect,
} from "./context.ts";
import { archiveTask, effectFailed, ghRead, pushBranch } from "./effects.ts";
import { runTests, testsText } from "./review.ts";

const MAX_LOOPS = 3;

type ApprovalRow = { id: number; task_id: number; user_id: number; head_commit: string; state: string };
type IntentRow = { id: number; task_id: number; approval_id: number; head_commit: string; state: string };

/** The next task to merge: one with a pending intent first, then FIFO by its valid approval. */
export function nextMergeTask(ctx: Ctx): number | undefined {
	return ctx.store.get<{ id: number }>(
		`SELECT t.id FROM tasks t
		 LEFT JOIN merge_intents m ON m.task_id = t.id AND m.state = 'pending'
		 LEFT JOIN approvals a ON a.task_id = t.id AND a.state = 'valid'
		 WHERE t.chat_id = ? AND t.state = 'merging'
		 ORDER BY (m.id IS NULL), (a.id IS NULL), a.id, t.id LIMIT 1`,
		ctx.chatId,
	)?.id;
}

/**
 * Back to review: invalidate the approval, settle the intent, post `text`. Call outside a transaction.
 * `postedHead` (when given) replaces posted_head (undefined keeps it; null clears it so /approve waits).
 */
function returnToReview(
	ctx: Ctx,
	task: TaskRow,
	p: {
		approvalId: number | undefined;
		intentId: number | undefined;
		intentState: "returned" | "failed";
		reason: string;
		text: string;
		kind: string;
	},
): void {
	tx(ctx, () => {
		const now = ctx.now();
		if (p.approvalId !== undefined) {
			ctx.store.run(
				"UPDATE approvals SET state = 'invalidated', reason = ? WHERE id = ? AND state = 'valid'",
				p.reason,
				p.approvalId,
			);
		}
		if (p.intentId !== undefined) {
			ctx.store.run(
				"UPDATE merge_intents SET state = ?, reason = ?, settled_at = ? WHERE id = ? AND state = 'pending'",
				p.intentState,
				p.reason,
				now,
				p.intentId,
			);
		}
		ctx.store.run(
			"UPDATE tasks SET state = 'review', review_since = ?, review_reminded = 0, updated_at = ? WHERE id = ? AND state = 'merging'",
			now,
			now,
			task.id,
		);
		enqueueTask(ctx, loadTask(ctx, task.id), p.kind, p.text);
	});
	ctx.log.info("merge_returned", { task: task.id, kind: p.kind });
}

/** Run the merge procedure for one task; the caller guarantees no other merge is in flight. */
export async function mergeTask(ctx: Ctx, taskId: number): Promise<void> {
	const task = loadTask(ctx, taskId);
	if (task.state !== "merging") return;
	const approval = ctx.store.get<ApprovalRow>(
		"SELECT * FROM approvals WHERE task_id = ? AND state = 'valid' ORDER BY id DESC LIMIT 1",
		taskId,
	);
	const pendingIntent = ctx.store.get<IntentRow>(
		"SELECT * FROM merge_intents WHERE task_id = ? AND state = 'pending' ORDER BY id DESC LIMIT 1",
		taskId,
	);
	if (approval === undefined) {
		returnToReview(ctx, task, {
			approvalId: undefined,
			intentId: pendingIntent?.id,
			intentState: "failed",
			reason: "no valid approval",
			kind: "merge_rejected",
			text: `${taskRef(taskId)} is back in review: its approval is no longer valid. Approve again with /approve ${taskId}.`,
		});
		return;
	}
	if (task.pr_number === null || task.branch === null || task.worktree_path === null) {
		returnToReview(ctx, task, {
			approvalId: approval.id,
			intentId: pendingIntent?.id,
			intentState: "failed",
			reason: "nothing to merge",
			kind: "merge_rejected",
			text: `Approval rejected: ${taskRef(taskId)} has no pull request, so there is nothing to merge.`,
		});
		return;
	}
	// Merge tests (and the merge itself) hold an execution slot; wait for one without touching GitHub.
	const slotId = reserveCheckSlot(ctx, taskId);
	if (slotId === undefined) return;
	try {
		// The intent is saved before any merge step.
		const intentId = tx(ctx, () => {
			if (pendingIntent !== undefined && pendingIntent.approval_id === approval.id) return pendingIntent.id;
			if (pendingIntent !== undefined) {
				ctx.store.run(
					"UPDATE merge_intents SET state = 'returned', reason = 'superseded', settled_at = ? WHERE id = ?",
					ctx.now(),
					pendingIntent.id,
				);
			}
			return ctx.store.run(
				`INSERT INTO merge_intents(task_id, approval_id, head_commit, state, created_at)
				 VALUES (?, ?, ?, 'pending', ?)`,
				taskId,
				approval.id,
				approval.head_commit,
				ctx.now(),
			).lastInsertRowid;
		});
		await mergeLoop(ctx, task, approval, intentId);
	} catch (error) {
		effectFailed(ctx, error, `the merge of ${taskRef(taskId)}`);
	} finally {
		releaseSlot(ctx, slotId);
	}
}

type MergeJob = {
	readonly task: TaskRow;
	readonly approval: ApprovalRow;
	readonly intentId: number;
	readonly head: string;
	readonly prNumber: number;
	readonly base: string;
};

type PrVerdict = "ok" | "merged" | "stale" | "closed";

/** What GitHub's view of the PR means for this approval. */
function prVerdict(pr: PullRequest, head: string, localHead: string | null): PrVerdict {
	if (pr.merged) return pr.headSha === head ? "merged" : "stale";
	if (pr.state !== "open") return "closed";
	return pr.headSha === head && localHead === head ? "ok" : "stale";
}

function rejectApproval(ctx: Ctx, job: MergeJob, verdict: "stale" | "closed"): void {
	const task = taskRef(job.task.id);
	returnToReview(ctx, job.task, {
		approvalId: job.approval.id,
		intentId: job.intentId,
		intentState: "failed",
		reason: verdict === "stale" ? "branch changed after approval" : "pull request closed",
		kind: "merge_rejected",
		text:
			verdict === "stale"
				? `Approval rejected: the branch of ${task} changed after approval. Nothing was merged; approve the new head with /approve ${job.task.id} once the bot posts it.`
				: `Approval rejected: the pull request of ${task} was closed on GitHub. Nothing was merged.`,
	});
}

function testsBlocked(ctx: Ctx, job: MergeJob): void {
	returnToReview(ctx, job.task, {
		approvalId: job.approval.id,
		intentId: job.intentId,
		intentState: "returned",
		reason: "tests failed",
		kind: "merge_blocked",
		text: `${taskRef(job.task.id)} cannot merge: the tests did not pass at ${sha7(job.head)}. Fix them with a follow-up (reply to this message), then approve again.`,
	});
}

/** Handle a PR that is already merged, closed or stale; true when the merge attempt is over. */
async function settledByPr(ctx: Ctx, job: MergeJob, pr: PullRequest, verdict: PrVerdict): Promise<boolean> {
	if (verdict === "ok") return false;
	if (verdict === "merged")
		await completeMerge(ctx, job.task, job.approval, job.intentId, pr.mergeCommitSha ?? job.head);
	else rejectApproval(ctx, job, verdict);
	return true;
}

/** One pass of the merge procedure: "again" when GitHub refused and the Coordinator starts over. */
async function mergeAttempt(ctx: Ctx, job: MergeJob, loop: number): Promise<"again" | "done"> {
	// A freeze stops merges; the intent stays pending and the recheck resolves it against GitHub.
	if (groupHeld(ctx) || ctx.stopped) return "done";
	const pr = await ghRead(ctx, "pull request", () => ctx.github.getPullRequest(job.prNumber));
	const current = loadTask(ctx, job.task.id);
	if (await settledByPr(ctx, job, pr, prVerdict(pr, job.head, current.head_commit))) return "done";
	const mainSha = await ctx.git.fetchBase();
	if (!(await ctx.git.isAncestor(mainSha, job.head))) {
		await combineWithMain(ctx, current, job.approval, job.intentId);
		return "done";
	}
	// Main has not moved: the tests that passed at the end of the run cover this commit; failed tests block.
	if (current.tests_passed_head !== job.head) testsBlocked(ctx, job);
	if (current.tests_passed_head !== job.head || groupHeld(ctx) || ctx.stopped) return "done";
	const result = await mergeOnGitHub(ctx, job.task, job.prNumber, job.head, job.base);
	if (result.merged) {
		await completeMerge(ctx, job.task, job.approval, job.intentId, result.sha);
		return "done";
	}
	// GitHub refused (main moved between the check and the merge, or the head changed): start over.
	ctx.log.info("merge_refused", { task: job.task.id, status: result.status, loop });
	return "again";
}

async function mergeLoop(ctx: Ctx, task: TaskRow, approval: ApprovalRow, intentId: number): Promise<void> {
	const job: MergeJob = {
		task,
		approval,
		intentId,
		head: approval.head_commit,
		prNumber: task.pr_number as number,
		base: ctx.config.github.baseBranch,
	};
	for (let loop = 1; loop <= MAX_LOOPS; loop++) {
		if ((await mergeAttempt(ctx, job, loop)) === "done") return;
	}
	returnToReview(ctx, task, {
		approvalId: approval.id,
		intentId,
		intentState: "returned",
		reason: "main kept moving",
		kind: "merge_retry_exhausted",
		text: `${taskRef(task.id)} did not merge: GitHub refused ${MAX_LOOPS} times while main kept moving. Nothing was merged. Approve again with /approve ${task.id}.`,
	});
}

/** One merge call; a definite error on the first attempt is thrown (nothing merged), later ones are unknown. */
async function tryMerge(ctx: Ctx, task: TaskRow, prNumber: number, head: string, attempt: number) {
	try {
		return await ctx.github.mergePullRequest(prNumber, head, `Merge task ${task.id}`);
	} catch (error) {
		if (error instanceof GitHubError && !error.transient && attempt === 0) throw error;
		ctx.log.warn("merge_call_failed", { task: task.id, attempt });
		return undefined;
	}
}

/** Did an earlier, unanswered merge call take effect? Main contains the head, or the PR is merged. */
async function mergedState(ctx: Ctx, prNumber: number, head: string, base: string): Promise<MergeResult | undefined> {
	if (await ctx.github.branchContains(base, head)) {
		const pr = await ctx.github.getPullRequest(prNumber).catch(() => undefined);
		return { merged: true, sha: pr?.mergeCommitSha ?? head };
	}
	const pr = await ctx.github.getPullRequest(prNumber);
	return pr.merged ? { merged: true, sha: pr.mergeCommitSha ?? head } : undefined;
}

async function retryMerge(ctx: Ctx, task: TaskRow, prNumber: number, head: string, base: string, attempt: number) {
	await sleep(ctx.retryDelayMs * 2 ** (attempt - 1));
	let known: MergeResult | undefined;
	try {
		known = await mergedState(ctx, prNumber, head, base);
	} catch (error) {
		ctx.log.warn("merge_readback_failed", { task: task.id, attempt });
		if (error instanceof GitHubError && !error.transient) throw error;
		return undefined;
	}
	return known ?? tryMerge(ctx, task, prNumber, head, attempt);
}

/**
 * Ask GitHub to merge exactly `head`. On an unknown outcome, read GitHub (does main contain the head? is the PR
 * merged?) before trying again; still unknown after the retries → UnknownEffect (the group freezes).
 */
async function mergeOnGitHub(
	ctx: Ctx,
	task: TaskRow,
	prNumber: number,
	head: string,
	base: string,
): Promise<MergeResult> {
	for (let attempt = 0; attempt < MAX_LOOPS; attempt++) {
		const result =
			attempt === 0
				? await tryMerge(ctx, task, prNumber, head, attempt)
				: await retryMerge(ctx, task, prNumber, head, base, attempt);
		if (result !== undefined) return result;
	}
	throw new UnknownEffect(`the merge outcome of ${taskRef(task.id)} on GitHub is unknown`);
}

async function completeMerge(
	ctx: Ctx,
	task: TaskRow,
	approval: ApprovalRow,
	intentId: number,
	mergeSha: string,
): Promise<void> {
	tx(ctx, () => {
		const now = ctx.now();
		ctx.store.run(
			"UPDATE merge_intents SET state = 'merged', merge_commit = ?, settled_at = ? WHERE id = ?",
			mergeSha,
			now,
			intentId,
		);
		ctx.store.run("UPDATE approvals SET state = 'consumed' WHERE id = ?", approval.id);
		ctx.store.run("UPDATE tasks SET state = 'merged', reason = NULL, updated_at = ? WHERE id = ?", now, task.id);
		enqueueTask(ctx, task, "task_merged", `${taskRef(task.id)} merged into main (${sha7(mergeSha)}).`);
	});
	ctx.log.info("task_merged", { task: task.id, merge: mergeSha });
	try {
		await archiveTask(ctx, task.id, undefined);
	} catch (error) {
		// Only the local folder is left; the next recovery archives it again.
		ctx.log.warn("merged_archive_failed", { task: task.id });
		void error;
	}
}

/** Settle the approval and the intent once main was merged into the worktree (conflict or combined). */
function settleCombined(ctx: Ctx, approvalId: number, intentId: number, reason: string): void {
	ctx.store.run(
		"UPDATE approvals SET state = 'invalidated', reason = ? WHERE id = ? AND state = 'valid'",
		reason,
		approvalId,
	);
	ctx.store.run(
		"UPDATE merge_intents SET state = 'returned', reason = ?, settled_at = ? WHERE id = ?",
		reason,
		ctx.now(),
		intentId,
	);
}

/** Conflict: nothing merges; the files are listed and a conflict-fix run is admitted (or the task waits in review). */
function conflictFound(
	ctx: Ctx,
	task: TaskRow,
	approval: ApprovalRow,
	intentId: number,
	files: readonly string[],
): void {
	const listed = files.length === 0 ? "(unknown files)" : clip(files.join(", "), 600);
	tx(ctx, () => {
		const now = ctx.now();
		settleCombined(ctx, approval.id, intentId, "merge conflict");
		// The worktree now holds an unfinished merge: /approve waits for the next posted head.
		ctx.store.run("UPDATE tasks SET posted_head = NULL, updated_at = ? WHERE id = ?", now, task.id);
		const admitted = admitRun(ctx.store, ctx.limits, {
			taskId: task.id,
			kind: "conflict",
			requestedBy: task.creator_id,
			requestId: `conflict-${task.id}-${intentId}`,
			inputText: conflictInput(files),
		});
		if (!admitted.ok) {
			ctx.store.run(
				"UPDATE tasks SET state = 'review', reason = 'merge conflict', review_since = ?, review_reminded = 0 WHERE id = ?",
				now,
				task.id,
			);
		}
		const outcome = admitted.ok
			? `A run of ${taskRef(task.id)} was admitted to resolve it (queue position ${admitted.position}); you'll review again.`
			: `The conflict-fix run could not be queued (${admitted.reason}); reply to this message to start the conflict fix when the queue has room.`;
		enqueueTask(
			ctx,
			loadTask(ctx, task.id),
			"merge_conflict",
			`Merge conflict in: ${listed}. Nothing was merged. ${outcome}`,
		);
	});
	ctx.log.info("merge_conflict", { task: task.id, files: files.length });
}

/** Main moved: merge it into the task branch in the worktree (the check slot is held by the caller). */
async function combineWithMain(ctx: Ctx, task: TaskRow, approval: ApprovalRow, intentId: number): Promise<void> {
	const path = task.worktree_path as string;
	const result = await ctx.git.mergeBase(path);
	if (result.conflict) return conflictFound(ctx, task, approval, intentId, result.files);
	const head = result.commit;
	const tests = await runTests(ctx, task, path);
	await pushBranch(ctx, task.branch as string, path, head);
	const passedHead = tests.passed ? head : null;
	tx(ctx, () => {
		const now = ctx.now();
		settleCombined(ctx, approval.id, intentId, "main moved");
		ctx.store.run(
			`UPDATE tasks SET state = 'review', reason = NULL, head_commit = ?, posted_head = ?, tests_passed_head = ?,
			   review_since = ?, review_reminded = 0, updated_at = ? WHERE id = ?`,
			head,
			head,
			passedHead,
			now,
			now,
			task.id,
		);
		enqueueTask(
			ctx,
			loadTask(ctx, task.id),
			"merge_main_moved",
			`Main moved; ${taskRef(task.id)} was combined with the latest main and retested (${testsText(tests)}). Head: ${sha7(head)}. Nothing was merged yet: approve again with /approve ${task.id}.`,
		);
	});
	ctx.log.info("merge_main_moved", { task: task.id, tests: tests.outcome });
}

function conflictInput(files: readonly string[]): string {
	return [
		"Merging the latest main branch into this task's branch stopped with conflicts.",
		`Conflicting files: ${files.length === 0 ? "(see the conflict markers)" : files.join(", ")}.`,
		"Resolve every conflict so the project keeps both this task's behaviour and the changes from main: edit the",
		"files to remove all conflict markers (<<<<<<<, =======, >>>>>>>), run the tests with run_check, and finish with",
		"a short summary of how you resolved them.",
	].join("\n");
}
