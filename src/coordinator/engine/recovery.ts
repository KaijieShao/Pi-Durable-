/**
 * Recovery after a restart (Interfaces and Storage § Recovery After a Restart; Deployment § Processes "On any
 * Coordinator restart"), before polling or dispatch, and again after the owner unfreezes a group (recheck):
 *
 *   1. Revoke all generations and close all run keys.
 *   2. Kill leftover Pi processes and every managed container; verify they are gone, else freeze.
 *   3. Reconcile: runs in progress → failed "interrupted by restart" (never resubmitted), their conversations
 *      quarantined, their pending follow-ups expired "(interrupted)"; uncertain budget reservations kept as
 *      unknown; saved merge intents checked against GitHub (main already contains the head → merged, no second
 *      merge); review steps and archives that did not complete are redone (comparing with GitHub before any push,
 *      finding the PR before opening one). Anything unresolved freezes the group.
 *   (4. relay and 5. dispatch are opened by the caller.)
 */
import { sha7 } from "../messages.ts";
import {
	type Ctx,
	describeError,
	enqueueTask,
	type FollowupRow,
	freezeGroup,
	loadTask,
	type RunRow,
	sleep,
	TERMINAL_TASK_STATES,
	taskRef,
	tx,
} from "./context.ts";
import { archiveTask, effectFailed, ghRead, terminalText } from "./effects.ts";
import { expireFollowup } from "./finalize.ts";
import { closeAllRunKeys } from "./keys.ts";
import { reviewStep } from "./review.ts";

export const INTERRUPTED_REASON = "interrupted by restart";

export type RecoveryJob =
	| { readonly kind: "review"; readonly runId: number; readonly taskId: number; readonly interrupted: boolean }
	| { readonly kind: "archive"; readonly taskId: number };

type IntentRow = { id: number; task_id: number; approval_id: number; head_commit: string };

function killPid(pid: number): void {
	for (const target of [-pid, pid]) {
		try {
			process.kill(target, "SIGKILL");
		} catch {
			// Not ours or already gone.
		}
	}
}

function isRunner(ctx: Ctx, pid: number, onError: boolean): boolean {
	try {
		return ctx.launcher.isRunner(pid);
	} catch {
		return onError;
	}
}

/** Kill the Pi processes recorded for runs in progress; true when none is left. */
async function killRunners(ctx: Ctx): Promise<{ killed: number; ok: boolean }> {
	const leftovers = ctx.store.all<{ pid: number }>(
		"SELECT pid FROM runs WHERE pid IS NOT NULL AND state IN ('starting', 'running', 'finalizing')",
	);
	const alive = leftovers.filter((row) => isRunner(ctx, row.pid, false));
	for (const row of alive) killPid(row.pid);
	if (alive.length > 0) await sleep(200);
	return { killed: alive.length, ok: !alive.some((row) => isRunner(ctx, row.pid, true)) };
}

/** Kill every managed container and verify none is left. Returns the problem, if any. */
async function killContainers(ctx: Ctx): Promise<string | undefined> {
	try {
		await ctx.sandbox.killAll();
		if ((await ctx.sandbox.live()).length === 0) return undefined;
		await sleep(200);
		await ctx.sandbox.killAll();
		return (await ctx.sandbox.live()).length === 0 ? undefined : "leftover containers could not be verified gone";
	} catch (error) {
		ctx.log.error("recovery_containers_failed", { error: describeError(error) });
		return "leftover containers could not be checked";
	}
}

/** A run in progress at restart: failed "interrupted by restart", never resubmitted. Inside the transaction. */
function interruptRun(ctx: Ctx, run: RunRow, now: number, jobs: RecoveryJob[]): void {
	ctx.store.run(
		"UPDATE runs SET state = 'failed', reason = ?, ended_at = ? WHERE id = ?",
		INTERRUPTED_REASON,
		now,
		run.id,
	);
	if (run.conversation_id !== null) {
		// Quarantined: never written again (opened read-only for inspection only).
		ctx.store.run("UPDATE conversations SET quarantined = 1, reusable = 0 WHERE id = ?", run.conversation_id);
	}
	const followups = ctx.store.all<FollowupRow>(
		"SELECT * FROM followups WHERE run_id = ? AND state IN ('pending', 'submitted') ORDER BY id",
		run.id,
	);
	for (const followup of followups) expireFollowup(ctx, followup, "interrupted");
	const task = loadTask(ctx, run.task_id);
	if (TERMINAL_TASK_STATES.has(task.state) || task.cancel_requested === 1) return;
	if (task.worktree_path !== null) {
		// Its work goes to GitHub (checkpoint, push, PR) and the task waits in review.
		jobs.push({ kind: "review", runId: run.id, taskId: task.id, interrupted: true });
		return;
	}
	// Nothing ran yet and there is no worktree to review: the task fails (never resubmitted).
	ctx.store.run(
		"UPDATE runs SET state = 'cancelled', reason = 'task failed', ended_at = ? WHERE task_id = ? AND state = 'queued'",
		now,
		task.id,
	);
	ctx.store.run(
		"UPDATE tasks SET state = 'failed', reason = ?, updated_at = ? WHERE id = ?",
		`${INTERRUPTED_REASON} before it started`,
		now,
		task.id,
	);
	jobs.push({ kind: "archive", taskId: task.id });
}

/** Review steps and archives that did not complete before the restart. Inside the transaction. */
function unfinishedWork(ctx: Ctx, jobs: RecoveryJob[]): void {
	const unreviewed = ctx.store.all<{ id: number; task_id: number }>(
		`SELECT r.id, r.task_id FROM runs r JOIN tasks t ON t.id = r.task_id
		 WHERE r.state = 'finished' AND r.review_done = 0 AND t.cancel_requested = 0
		   AND t.state NOT IN ('merged', 'failed', 'cancelled')
		 ORDER BY r.id`,
	);
	for (const run of unreviewed) jobs.push({ kind: "review", runId: run.id, taskId: run.task_id, interrupted: false });
	const unarchived = ctx.store.all<{ id: number }>(
		"SELECT id FROM tasks WHERE state IN ('merged', 'failed', 'cancelled') AND worktree_path IS NOT NULL ORDER BY id",
	);
	for (const task of unarchived) jobs.push({ kind: "archive", taskId: task.id });
}

/** Step 3 in the database: one transaction. */
function reconcileDatabase(ctx: Ctx, verified: boolean, jobs: RecoveryJob[]): { interrupted: number; unknown: number } {
	return tx(ctx, () => {
		const now = ctx.now();
		// Slots are freed only once the leftovers are verified gone; otherwise they stay held until the recheck.
		if (verified) ctx.store.run("DELETE FROM slots");
		const unknown = ctx.store.run(
			"UPDATE budget SET state = 'unknown', settled_at = ? WHERE state = 'reserved'",
			now,
		).changes;
		const interrupted = ctx.store.all<RunRow>(
			"SELECT * FROM runs WHERE state IN ('starting', 'running', 'finalizing') ORDER BY id",
		);
		for (const run of interrupted) interruptRun(ctx, run, now, jobs);
		unfinishedWork(ctx, jobs);
		return { interrupted: interrupted.length, unknown };
	});
}

/** Steps 1–3. Returns the review/archive jobs to run before dispatch reopens. */
export async function reconcile(ctx: Ctx): Promise<RecoveryJob[]> {
	// 1. Revoke every generation.
	const closed = tx(ctx, () => closeAllRunKeys(ctx.store, ctx.now()));
	// 2. Kill leftovers and verify they are gone.
	// STUB(spec: deployment.md § Processes "On any Coordinator restart, the watchdog..."): no separate watchdog unit or
	// Pi systemd slice; the Coordinator itself kills the runner pids it recorded and every labelled container.
	const runners = await killRunners(ctx);
	const containers = await killContainers(ctx);
	const stopProblem = runners.ok ? containers : "leftover Pi processes could not be verified stopped";
	if (stopProblem !== undefined) freezeGroup(ctx, stopProblem);
	// 3. Reconcile the database, then saved merge intents against GitHub (never merge twice).
	const jobs: RecoveryJob[] = [];
	const summary = reconcileDatabase(ctx, stopProblem === undefined, jobs);
	const intents = ctx.store.all<IntentRow>("SELECT * FROM merge_intents WHERE state = 'pending' ORDER BY id");
	for (const intent of intents) {
		try {
			await resolveIntent(ctx, intent, jobs);
		} catch (error) {
			effectFailed(ctx, error, `checking the saved merge of ${taskRef(intent.task_id)}`);
		}
	}
	ctx.log.info("recovery_reconciled", {
		keys_closed: closed,
		killed: runners.killed,
		interrupted: summary.interrupted,
		unknown_reservations: summary.unknown,
		intents: intents.length,
		jobs: jobs.length,
	});
	return jobs;
}

async function resolveIntent(ctx: Ctx, intent: IntentRow, jobs: RecoveryJob[]): Promise<void> {
	const base = ctx.config.github.baseBranch;
	const contains = await ghRead(ctx, "merge check", () => ctx.github.branchContains(base, intent.head_commit));
	if (!contains) {
		tx(ctx, () =>
			ctx.store.run(
				"UPDATE merge_intents SET state = 'returned', reason = 'not merged at restart', settled_at = ? WHERE id = ?",
				ctx.now(),
				intent.id,
			),
		);
		return;
	}
	const task = loadTask(ctx, intent.task_id);
	let mergeSha = intent.head_commit;
	if (task.pr_number !== null) {
		const number = task.pr_number;
		const pr = await ghRead(ctx, "pull request", () => ctx.github.getPullRequest(number)).catch(() => undefined);
		mergeSha = pr?.mergeCommitSha ?? mergeSha;
	}
	tx(ctx, () => {
		const now = ctx.now();
		ctx.store.run(
			"UPDATE merge_intents SET state = 'merged', merge_commit = ?, settled_at = ? WHERE id = ?",
			mergeSha,
			now,
			intent.id,
		);
		ctx.store.run("UPDATE approvals SET state = 'consumed' WHERE id = ?", intent.approval_id);
		if (task.state !== "merged") {
			ctx.store.run("UPDATE tasks SET state = 'merged', reason = NULL, updated_at = ? WHERE id = ?", now, task.id);
			enqueueTask(ctx, task, "task_merged", `${taskRef(task.id)} merged into main (${sha7(mergeSha)}).`);
		}
	});
	if (!jobs.some((job) => job.kind === "archive" && job.taskId === task.id))
		jobs.push({ kind: "archive", taskId: task.id });
	ctx.log.info("recovery_merge_found", { task: task.id });
}

/** Run one recovery job; review jobs reserve an execution slot for their tests. */
export async function runRecoveryJob(ctx: Ctx, job: RecoveryJob): Promise<void> {
	if (job.kind === "archive") {
		const task = loadTask(ctx, job.taskId);
		if (task.state === "merged") return archiveTask(ctx, job.taskId, undefined);
		const kind = task.state === "cancelled" ? "cancelled" : "failed";
		return archiveTask(ctx, job.taskId, (result) => terminalText(loadTask(ctx, job.taskId), kind, task.reason, result));
	}
	const task = loadTask(ctx, job.taskId);
	const slotId = tx(
		ctx,
		() =>
			ctx.store.run(
				"INSERT INTO slots(kind, task_id, run_id, agent_id, acquired_at) VALUES ('run', ?, ?, ?, ?)",
				task.id,
				job.runId,
				task.agent_id,
				ctx.now(),
			).lastInsertRowid,
	);
	try {
		await reviewStep(ctx, job.runId, { interrupted: job.interrupted });
	} finally {
		tx(ctx, () => ctx.store.run("DELETE FROM slots WHERE id = ?", slotId));
	}
}
