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
 *      A run still 'starting' that never reached Pi (no Pi process recorded, no run key opened for its generation)
 *      did not start from Pi's point of view: it goes back to the queue (same run row and request id, so the same
 *      FIFO place; pending steers stay pending), at most START_RETURNS_LIMIT times, then its task fails. A first
 *      run's local worktree is kept only if it is provably what the next start would use (setup completed,
 *      pristine at the recorded base, branch not on GitHub) and its task is not being cancelled; otherwise the local
 *      worktree and branch are discarded and the next dispatch recreates them from the latest main (a cancel waits
 *      for this, so nothing of such a run is pushed). Follow-up and conflict runs keep their worktree.
 *   (4. relay and 5. dispatch are opened by the caller.)
 */
import { agentQueuePosition } from "../admission.ts";
import { requeuedAfterRestart, sha7 } from "../messages.ts";
import {
	branchName,
	type Ctx,
	describeError,
	enqueueTask,
	type FollowupRow,
	freezeGroup,
	loadTask,
	type RunRow,
	restartReturnsKey,
	setupStateKey,
	sleep,
	type TaskRow,
	TERMINAL_TASK_STATES,
	taskRef,
	tx,
	WORKTREE_CHECK_PREFIX,
	worktreeCheckKey,
	worktreePath,
} from "./context.ts";
import { archiveTask, effectFailed, ghRead, terminalText } from "./effects.ts";
import { expireFollowup, expireFollowups } from "./finalize.ts";
import { closeAllRunKeys } from "./keys.ts";
import { reviewStep } from "./review.ts";

export const INTERRUPTED_REASON = "interrupted by restart";

/** A run is returned to the queue by a restart before it started at most this many times; then its task fails. */
export const START_RETURNS_LIMIT = 3;

export type RecoveryJob =
	| { readonly kind: "review"; readonly runId: number; readonly taskId: number; readonly interrupted: boolean }
	| { readonly kind: "archive"; readonly taskId: number }
	/** The local worktree and branch of a first run that never started (worktreeCheckKey says what to do). */
	| { readonly kind: "worktree"; readonly taskId: number };

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

/**
 * Step 3 evidence that nothing of this run reached Pi: it is still 'starting', no Pi process was recorded and no run
 * key was opened for its generation (keys of an earlier start of the same run were closed when that start was put
 * back in the queue, knowing nothing had been submitted). Pi's requestId covers live retries only, so a run that
 * might have been submitted is never submitted again.
 */
function neverReachedPi(ctx: Ctx, run: RunRow): boolean {
	if (run.state !== "starting" || run.pid !== null) return false;
	const keys = ctx.store.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM run_keys WHERE run_id = ? AND (? IS NULL OR generation = ?)",
		run.id,
		run.generation,
		run.generation,
	)?.n;
	return (keys ?? 0) === 0;
}

/** Add a job unless the same kind of job for the task is there already. */
function addJob(jobs: RecoveryJob[], job: RecoveryJob): void {
	if (!jobs.some((other) => other.kind === job.kind && other.taskId === job.taskId)) jobs.push(job);
}

/** The worktree job of a first run, saved so that another restart before it is done finds it again. */
function worktreeJob(ctx: Ctx, taskId: number, intent: "check" | "discard", jobs: RecoveryJob[]): void {
	ctx.store.setMeta(worktreeCheckKey(taskId), intent);
	addJob(jobs, { kind: "worktree", taskId });
}

/**
 * A run that never started was put back in the queue START_RETURNS_LIMIT times already: the restarts keep coming
 * while it starts, so its task fails instead of looping. A first run pushed nothing: its local worktree and branch
 * are discarded and nothing goes to GitHub; a later run's task is archived like any failed task (work pushed, pull
 * request closed, branch kept). Inside the transaction.
 */
function failUnstarted(ctx: Ctx, run: RunRow, now: number, restarts: number, jobs: RecoveryJob[]): void {
	const reason = `the Coordinator restarted ${restarts} times before its run could start, so it is not queued again`;
	ctx.store.run("UPDATE runs SET state = 'failed', reason = ?, ended_at = ? WHERE id = ?", reason, now, run.id);
	ctx.store.run(
		"UPDATE runs SET state = 'cancelled', reason = 'task failed', ended_at = ? WHERE task_id = ? AND state = 'queued'",
		now,
		run.task_id,
	);
	expireFollowups(ctx, { taskId: run.task_id }, "interrupted");
	ctx.store.run(
		"UPDATE approvals SET state = 'invalidated', reason = 'task failed' WHERE task_id = ? AND state = 'valid'",
		run.task_id,
	);
	ctx.store.run("UPDATE tasks SET state = 'failed', reason = ?, updated_at = ? WHERE id = ?", reason, now, run.task_id);
	ctx.log.warn("recovery_start_failed", { run: run.id, task: run.task_id, restarts });
	if (run.kind !== "initial") {
		addJob(jobs, { kind: "archive", taskId: run.task_id });
		return;
	}
	ctx.store.run(
		"UPDATE tasks SET branch = NULL, worktree_path = NULL, base_commit = NULL, head_commit = NULL WHERE id = ?",
		run.task_id,
	);
	const task = loadTask(ctx, run.task_id);
	const result = { prClosed: false, branchKept: false, head: null };
	enqueueTask(ctx, task, "task_final", terminalText(task, "failed", reason, result));
	worktreeJob(ctx, task.id, "discard", jobs);
}

/**
 * A run that never reached Pi goes back to the queue: the same run row and request id (so the same FIFO place), its
 * slot released with the others, its task queued again, its pending steers left pending (they are submitted when it
 * really starts). The count of returns is saved; past the limit the task fails. Inside the transaction.
 */
function returnToQueue(ctx: Ctx, run: RunRow, now: number, jobs: RecoveryJob[]): void {
	const returns = Number(ctx.store.getMeta(restartReturnsKey(run.id)) ?? "0");
	if (returns >= START_RETURNS_LIMIT) {
		failUnstarted(ctx, run, now, returns + 1, jobs);
		return;
	}
	ctx.store.setMeta(restartReturnsKey(run.id), String(returns + 1));
	ctx.store.run("UPDATE runs SET state = 'queued' WHERE id = ? AND state = 'starting'", run.id);
	ctx.store.run(
		"UPDATE tasks SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'running'",
		now,
		run.task_id,
	);
	if (run.kind === "initial") worktreeJob(ctx, run.task_id, "check", jobs);
	const task = loadTask(ctx, run.task_id);
	enqueueTask(ctx, task, "task_requeued", requeuedAfterRestart(task.id, agentQueuePosition(ctx.store, run.id)));
	ctx.log.info("recovery_run_requeued", { run: run.id, task: task.id, returns: returns + 1, kind: run.kind });
}

/** A run in progress at restart: back to the queue if it never reached Pi, else interrupted. Inside the tx. */
function reconcileRun(ctx: Ctx, run: RunRow, now: number, jobs: RecoveryJob[]): void {
	const task = loadTask(ctx, run.task_id);
	const live = !TERMINAL_TASK_STATES.has(task.state) && task.cancel_requested === 0;
	if (live && neverReachedPi(ctx, run)) returnToQueue(ctx, run, now, jobs);
	else interruptRun(ctx, run, now, jobs);
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
	for (const task of unarchived) addJob(jobs, { kind: "archive", taskId: task.id });
	const checks = ctx.store.all<{ key: string }>(
		"SELECT key FROM meta WHERE substr(key, 1, ?) = ? ORDER BY key",
		WORKTREE_CHECK_PREFIX.length,
		WORKTREE_CHECK_PREFIX,
	);
	for (const { key } of checks)
		addJob(jobs, { kind: "worktree", taskId: Number(key.slice(WORKTREE_CHECK_PREFIX.length)) });
}

/** Step 3 in the database: one transaction. */
function reconcileDatabase(ctx: Ctx, verified: boolean, jobs: RecoveryJob[]): { inProgress: number; unknown: number } {
	return tx(ctx, () => {
		const now = ctx.now();
		// Slots are freed only once the leftovers are verified gone; otherwise they stay held until the recheck.
		if (verified) ctx.store.run("DELETE FROM slots");
		const unknown = ctx.store.run(
			"UPDATE budget SET state = 'unknown', settled_at = ? WHERE state = 'reserved'",
			now,
		).changes;
		const inProgress = ctx.store.all<RunRow>(
			"SELECT * FROM runs WHERE state IN ('starting', 'running', 'finalizing') ORDER BY id",
		);
		for (const run of inProgress) reconcileRun(ctx, run, now, jobs);
		unfinishedWork(ctx, jobs);
		return { inProgress: inProgress.length, unknown };
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
		in_progress: summary.inProgress,
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

/**
 * A first run's worktree is kept only if it is exactly what its next start would use: recorded, its setup completed,
 * pristine on its branch at the recorded base, and the branch not on GitHub (it was never pushed; if GitHub has it
 * anyway, or cannot say, the next start applies the rule for an existing branch).
 */
async function keepableWorktree(ctx: Ctx, task: TaskRow): Promise<boolean> {
	const { worktree_path: path, branch, base_commit: base } = task;
	if (path === null || branch === null || base === null) return false;
	if (ctx.store.getMeta(setupStateKey(task.id)) !== "done") return false;
	if (!(await ctx.git.isPristineWorktree(path, branch, base).catch(() => false))) return false;
	return (await ctx.git.remoteBranchSha(branch).catch(() => "unknown")) === undefined;
}

/**
 * The local worktree and branch of a first run that never started: kept if pristine ("check") and the task is not
 * being cancelled, else forgotten in the database first and then deleted from disk, so the next dispatch recreates
 * them from the latest main (a cancel then finds no worktree and pushes nothing). Idempotent; the saved intent is
 * cleared last, so a restart in between redoes it.
 */
async function reconcileFirstWorktree(ctx: Ctx, taskId: number): Promise<void> {
	const intent = ctx.store.getMeta(worktreeCheckKey(taskId));
	if (intent === undefined) return;
	const task = loadTask(ctx, taskId);
	const clear = (): void => {
		tx(ctx, () => ctx.store.run("DELETE FROM meta WHERE key = ?", worktreeCheckKey(taskId)));
	};
	// Ended meanwhile with its branch still recorded: its archive owns the worktree and branch. With none recorded
	// (this job forgot them before a failure or restart, or they were never recorded), the leftovers are removed here.
	if (TERMINAL_TASK_STATES.has(task.state) && task.branch !== null) return clear();
	if (intent === "check" && task.cancel_requested === 0 && (await keepableWorktree(ctx, task))) {
		ctx.log.info("recovery_worktree_kept", { task: taskId });
		return clear();
	}
	const path = task.worktree_path ?? worktreePath(ctx, taskId);
	const branch = task.branch ?? branchName(ctx, taskId);
	const createdAt = task.base_commit ?? undefined;
	tx(ctx, () => {
		ctx.store.run(
			"UPDATE tasks SET branch = NULL, worktree_path = NULL, base_commit = NULL, head_commit = NULL WHERE id = ?",
			taskId,
		);
		ctx.store.run("DELETE FROM meta WHERE key = ?", setupStateKey(taskId));
	});
	await ctx.git.removeWorktree(path);
	await ctx.git.deleteBranch(branch, createdAt);
	clear();
	ctx.log.info("recovery_worktree_discarded", { task: taskId });
}

/** Run one recovery job; review jobs reserve an execution slot for their tests. */
export async function runRecoveryJob(ctx: Ctx, job: RecoveryJob): Promise<void> {
	if (job.kind === "worktree") return reconcileFirstWorktree(ctx, job.taskId);
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
