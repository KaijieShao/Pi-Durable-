/**
 * Recovery after a restart (Interfaces and Storage § Recovery After a Restart; Deployment § Processes "On any
 * Coordinator restart"), before polling or dispatch. The owner's unfreeze repeats steps 1–3 from the same parts
 * (stopLeftovers, reconcileDatabase, resolveIntent) while the group is still frozen (engine/unfreeze.ts):
 *
 *   1. Revoke all generations and close all run keys.
 *   2. The watchdog kills leftover processes and containers and verifies they're gone: the Coordinator first kills
 *      what it can itself (defense in depth: the Pi processes of the runs in progress, then every other one of this
 *      deployment, and every managed container, verified), then asks the watchdog, the separate unit, for a sweep of
 *      everything in the slice and every labelled container and waits for its answer (engine/watchdog.ts). Either
 *      one unverified → freeze. No answer → the watchdog is unavailable: recovery goes on, but nothing is dispatched
 *      until it answers (fails closed).
 *   3. Reconcile: runs in progress → failed "interrupted by restart" (never resubmitted), their conversations
 *      quarantined, their pending follow-ups expired "(interrupted)"; uncertain budget reservations kept as
 *      unknown; saved merge intents checked against GitHub (main already contains the head → merged, no second
 *      merge); review steps and archives that did not complete are redone (comparing with GitHub before any push,
 *      finding the PR before opening one). Anything unresolved freezes the group; a push GitHub refuses because the
 *      branch changed outside the Coordinator is resolved (definite: nothing pushed) and holds only that task.
 *      Effect evidence (Agent Execution § Uncertain Effects; engine/intents.ts): every file change or check still
 *      pending is reconciled from its target before any job touches the task's worktree; the jobs run only once the
 *      kills above and the watchdog's sweep are verified (termination confirmed). Unresolved → the group freezes and
 *      the job waits for the owner. An interrupted run's worktree is NOT reviewed, committed or pushed: its changes
 *      since the last checkpoint stay there, its users are told which files they are and what reconciliation found,
 *      and only a reply (a fresh run, seeded with them) or /cancel (the archive's final checkpoint) moves them on.
 *      A run still 'starting' that never reached Pi (no Pi process recorded, no run key opened for its generation)
 *      did not start from Pi's point of view: it goes back to the queue (same run row and request id, so the same
 *      FIFO place; pending steers stay pending), at most START_RETURNS_LIMIT times, then its task fails. A first
 *      run's local worktree is kept only if it is provably what the next start would use (setup completed,
 *      pristine at the recorded base, branch not on GitHub) and its task is not being cancelled; otherwise the local
 *      worktree and branch are discarded and the next dispatch recreates them from the latest main (a cancel waits
 *      for this, so nothing of such a run is pushed). Follow-up and conflict runs keep their worktree.
 *   (4. relay and 5. dispatch are opened by the caller.)
 */

import { UNVERIFIED_SWEEP } from "../../watchdog/protocol.ts";
import { agentQueuePosition } from "../admission.ts";
import { blocksTaskRuns, readBranchHold } from "../branch-hold.ts";
import { INTERRUPTED_KEPT_REASON, interruptedKept, requeuedAfterRestart, sha7 } from "../messages.ts";
import type { RunnerRef } from "../ports.ts";
import {
	branchName,
	type Ctx,
	describeError,
	enqueueTask,
	type FollowupRow,
	freezeGroup,
	INTERRUPTED_PREFIX,
	interruptedKey,
	loadTask,
	type RunRow,
	restartReturnsKey,
	runNumber,
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
import { archiveEnded, effectFailed, ghRead, lastPushed, terminalText } from "./effects.ts";
import { expireFollowup, expireFollowups } from "./finalize.ts";
import { reconciledOf, settleTaskEffects, tasksWithOpenIntents } from "./intents.ts";
import { closeAllRunKeys } from "./keys.ts";
import { reviewStep } from "./review.ts";
import { type SweepOutcome, watchdogSweep } from "./watchdog.ts";

export const INTERRUPTED_REASON = "interrupted by restart";

/** A run is returned to the queue by a restart before it started at most this many times; then its task fails. */
export const START_RETURNS_LIMIT = 3;

export type RecoveryJob =
	| { readonly kind: "review"; readonly runId: number; readonly taskId: number; readonly interrupted: boolean }
	| { readonly kind: "archive"; readonly taskId: number }
	/** A run interrupted by the restart: reconcile its effects, then tell its users what the worktree keeps. */
	| { readonly kind: "interrupted"; readonly taskId: number; readonly runId: number }
	/** Effect evidence of a task no other job covers (pending or unresolved intents). */
	| { readonly kind: "effects"; readonly taskId: number }
	/** The local worktree and branch of a first run that never started (worktreeCheckKey says what to do). */
	| { readonly kind: "worktree"; readonly taskId: number };

export type IntentRow = { id: number; task_id: number; approval_id: number; head_commit: string };

/** How long restart cleanup waits for killed Pi processes (or units) to be reported gone before it freezes. */
const RUNNER_GONE_WAIT_MS = 5_000;

function isRunner(ctx: Ctx, ref: RunnerRef, onError: boolean): boolean {
	try {
		return ctx.launcher.isRunner(ref);
	} catch {
		return onError;
	}
}

function killRunner(ctx: Ctx, ref: RunnerRef): void {
	try {
		ctx.launcher.killRunner(ref);
	} catch (error) {
		ctx.log.warn("recovery_runner_kill_failed", { run: ref.runId, error: describeError(error) });
	}
}

/** Every Pi process of this deployment the launcher can find, whatever its run; undefined if it cannot tell. */
function leftovers(ctx: Ctx): readonly RunnerRef[] | undefined {
	try {
		return ctx.launcher.leftovers();
	} catch (error) {
		ctx.log.warn("recovery_runner_list_failed", { error: describeError(error) });
		return undefined;
	}
}

/** Kill those of `refs` that may be alive, then wait (bounded) until each is reported gone. */
async function killAndVerify(ctx: Ctx, refs: readonly RunnerRef[]): Promise<{ killed: number; left: number }> {
	const alive = refs.filter((ref) => isRunner(ctx, ref, false));
	for (const ref of alive) killRunner(ctx, ref);
	const deadline = Date.now() + RUNNER_GONE_WAIT_MS;
	let left = alive;
	while (left.length > 0) {
		await sleep(100);
		left = left.filter((ref) => isRunner(ctx, ref, true));
		if (Date.now() >= deadline) break;
	}
	return { killed: alive.length, left: left.length };
}

/**
 * Kill the Pi processes of runs in progress, found by the launcher from the run's row (its pid and markers, or its
 * systemd unit), then every other Pi process of this deployment (Deployment § Processes: everything in the slice),
 * e.g. one whose stop was never confirmed before the group froze; true when none is left. Only while no run is live.
 */
async function killRunners(ctx: Ctx): Promise<{ killed: number; ok: boolean }> {
	const rows = ctx.store.all<{ id: number; generation: number; pid: number | null }>(
		"SELECT id, generation, pid FROM runs WHERE generation IS NOT NULL AND state IN ('starting', 'running', 'finalizing')",
	);
	const recorded = await killAndVerify(
		ctx,
		rows.map((row) => ({ runId: row.id, generation: row.generation, pid: row.pid })),
	);
	const others = leftovers(ctx);
	const swept = others === undefined ? { killed: 0, left: 1 } : await killAndVerify(ctx, others);
	return { killed: recorded.killed + swept.killed, ok: recorded.left === 0 && swept.left === 0 };
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
	// An ended task's archive job (unfinishedWork) reconciles the run's effects before its final checkpoint.
	if (TERMINAL_TASK_STATES.has(task.state)) return;
	if (task.worktree_path !== null) {
		keepInterrupted(ctx, task, run, now, jobs);
		return;
	}
	if (task.cancel_requested === 1) return;
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
 * A run interrupted with a worktree (Interfaces and Storage § Recovery: "Its task keeps its worktree, branch and pull
 * request"): nothing of it is tested, committed or pushed here, so edits since the last checkpoint are neither pushed
 * nor dropped. The task waits in review, where a reply starts a fresh run seeded with the branch's current changes
 * and /cancel archives it (its final checkpoint pushes them), but neither touches the worktree before the
 * "interrupted" job has reconciled the run's effects and told the users what the worktree keeps. No head is posted
 * meanwhile, so /approve is refused (approving the last checkpoint would leave these changes behind). Inside the tx.
 */
function keepInterrupted(ctx: Ctx, task: TaskRow, run: RunRow, now: number, jobs: RecoveryJob[]): void {
	ctx.store.setMeta(interruptedKey(task.id), String(run.id));
	ctx.store.run(
		`UPDATE tasks SET state = CASE WHEN state = 'running' THEN 'review' ELSE state END, reason = ?, posted_head = NULL,
		   review_since = NULL, review_reminded = 0, updated_at = ?
		 WHERE id = ?`,
		INTERRUPTED_KEPT_REASON,
		now,
		task.id,
	);
	addJob(jobs, { kind: "interrupted", taskId: task.id, runId: run.id });
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

/** Interrupted runs whose reconciliation and notice did not complete (another restart, a freeze). In the tx. */
function interruptedWork(ctx: Ctx, jobs: RecoveryJob[]): void {
	const marks = ctx.store.all<{ key: string; value: string }>(
		"SELECT key, value FROM meta WHERE substr(key, 1, ?) = ? ORDER BY key",
		INTERRUPTED_PREFIX.length,
		INTERRUPTED_PREFIX,
	);
	for (const { key, value } of marks) {
		addJob(jobs, { kind: "interrupted", taskId: Number(key.slice(INTERRUPTED_PREFIX.length)), runId: Number(value) });
	}
}

/** Review steps and archives that did not complete before the restart. Inside the transaction. */
function unfinishedWork(ctx: Ctx, jobs: RecoveryJob[]): void {
	interruptedWork(ctx, jobs);
	// Not for a task whose later run was interrupted: that review would commit and push the interrupted run's changes
	// (the next run's review supersedes it). Checked on the runs themselves, not only on the mark: the mark is cleared
	// once the users are told, but the interrupted run's changes stay in the worktree until a reply's run or /cancel,
	// so a later restart or recheck must not redo the earlier review either.
	const unreviewed = ctx.store.all<{ id: number; task_id: number }>(
		`SELECT r.id, r.task_id FROM runs r JOIN tasks t ON t.id = r.task_id
		 WHERE r.state = 'finished' AND r.review_done = 0 AND t.cancel_requested = 0
		   AND t.state NOT IN ('merged', 'failed', 'cancelled')
		   AND NOT EXISTS (SELECT 1 FROM meta m WHERE m.key = ? || t.id)
		   AND NOT EXISTS (SELECT 1 FROM runs later WHERE later.task_id = r.task_id AND later.id > r.id
		     AND later.state = 'failed' AND later.reason = ?)
		 ORDER BY r.id`,
		INTERRUPTED_PREFIX,
		INTERRUPTED_REASON,
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
	// Pending or unresolved effects of a task no job above covers (each job reconciles its task's effects first).
	for (const taskId of tasksWithOpenIntents(ctx.store)) {
		if (!jobs.some((job) => job.taskId === taskId)) jobs.push({ kind: "effects", taskId });
	}
}

/** Step 3 in the database: one transaction. */
export function reconcileDatabase(
	ctx: Ctx,
	verified: boolean,
	jobs: RecoveryJob[],
): { inProgress: number; unknown: number } {
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

export type StopOutcome = {
	/** Run keys closed (step 1). */
	readonly closed: number;
	/** Pi processes the Coordinator killed itself. */
	readonly killed: number;
	/** What the Coordinator's own kills could not verify (Pi processes, containers), if anything. */
	readonly own: string | undefined;
	/** The watchdog's answer to this Coordinator's sweep request. */
	readonly sweep: SweepOutcome;
};

/**
 * Steps 1 and 2: revoke every generation; kill leftovers and verify they are gone: the Coordinator's own kills (the Pi
 * processes of the runs in progress by their systemd unit or their recorded pid with this deployment's and run's
 * markers, then every other Pi process of this deployment, and every labelled container), then the watchdog's sweep,
 * which gates admission. Only while no run is live. Freezes nothing itself.
 */
export async function stopLeftovers(ctx: Ctx, reason: "coordinator_start" | "recheck"): Promise<StopOutcome> {
	const closed = tx(ctx, () => closeAllRunKeys(ctx.store, ctx.now()));
	const runners = await killRunners(ctx);
	const containers = await killContainers(ctx);
	const own = runners.ok ? containers : "leftover Pi processes could not be verified stopped";
	const sweep = await watchdogSweep(ctx, reason);
	return { closed, killed: runners.killed, own, sweep };
}

/** The freeze reason of a stop that was not verified, if any (an unanswered sweep holds dispatch instead). */
export function stopProblem(stop: StopOutcome): string | undefined {
	return stop.own ?? (stop.sweep === "unverified" ? UNVERIFIED_SWEEP : undefined);
}

/** Saved merge intents still pending (step 3 checks each against GitHub before anything retries a merge). */
export function pendingMergeIntents(ctx: Ctx): IntentRow[] {
	return ctx.store.all<IntentRow>("SELECT * FROM merge_intents WHERE state = 'pending' ORDER BY id");
}

/**
 * Steps 1–3 (`reason`: the start of this Coordinator, or the recheck of a database an earlier version unfroze).
 * Returns the review/archive jobs to run before dispatch reopens. Anything unresolved freezes the group.
 */
export async function reconcile(ctx: Ctx, reason: "coordinator_start" | "recheck"): Promise<RecoveryJob[]> {
	// 1 and 2.
	const stop = await stopLeftovers(ctx, reason);
	const problem = stopProblem(stop);
	if (problem !== undefined) freezeGroup(ctx, problem);
	// 3. Reconcile the database, then saved merge intents against GitHub (never merge twice).
	const jobs: RecoveryJob[] = [];
	const summary = reconcileDatabase(ctx, problem === undefined, jobs);
	const intents = pendingMergeIntents(ctx);
	for (const intent of intents) {
		try {
			await resolveIntent(ctx, intent, jobs);
		} catch (error) {
			effectFailed(ctx, error, `checking the saved merge of ${taskRef(intent.task_id)}`);
		}
	}
	ctx.log.info("recovery_reconciled", {
		keys_closed: stop.closed,
		killed: stop.killed,
		watchdog: stop.sweep,
		in_progress: summary.inProgress,
		unknown_reservations: summary.unknown,
		intents: intents.length,
		jobs: jobs.length,
	});
	return jobs;
}

/**
 * A saved merge intent against GitHub: main already contains its head → merged (no second merge, the task is archived
 * by a job); not → returned. A GitHub read that fails throws (UnknownEffect): the outcome stays unknown.
 */
export async function resolveIntent(ctx: Ctx, intent: IntentRow, jobs: RecoveryJob[]): Promise<void> {
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

/** What the task does next, for the notice: a follow-up run queued meanwhile, a cancel, or a reply. */
function nextStep(ctx: Ctx, task: TaskRow): "reply" | "queued" | "cancelling" {
	if (task.cancel_requested === 1) return "cancelling";
	const queued = ctx.store.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND state = 'queued'",
		task.id,
	)?.n;
	return (queued ?? 0) > 0 ? "queued" : "reply";
}

/**
 * The interrupted run's effects are reconciled (runRecoveryJob did it first): tell its users what its worktree keeps
 * since the last checkpoint and what reconciliation found, then let replies, /cancel and reminders work on it. The
 * mark is cleared in the same transaction as the notice, so another restart before that redoes it, never twice.
 */
async function reportInterrupted(ctx: Ctx, job: Extract<RecoveryJob, { kind: "interrupted" }>): Promise<void> {
	if (ctx.store.getMeta(interruptedKey(job.taskId)) === undefined) return;
	const task = loadTask(ctx, job.taskId);
	const path = task.worktree_path;
	const changes = path === null ? undefined : await ctx.git.uncommittedChanges(path).catch(() => undefined);
	const run = ctx.store.get<RunRow>("SELECT * FROM runs WHERE id = ?", job.runId);
	tx(ctx, () => {
		const now = ctx.now();
		ctx.store.run("DELETE FROM meta WHERE key = ?", interruptedKey(job.taskId));
		const current = loadTask(ctx, job.taskId);
		if (TERMINAL_TASK_STATES.has(current.state)) return;
		if (current.state === "review") {
			ctx.store.run(
				"UPDATE tasks SET review_since = ?, review_reminded = 0, updated_at = ? WHERE id = ?",
				now,
				now,
				current.id,
			);
		}
		const text = interruptedKept({
			taskId: current.id,
			runNo: run === undefined ? 1 : runNumber(ctx, run),
			branch: current.branch,
			changes,
			effects: reconciledOf(ctx.store, job.runId),
			pushedHead: lastPushed(ctx, current),
			prUrl: current.pr_url,
			next: nextStep(ctx, current),
		});
		enqueueTask(ctx, current, "task_interrupted", text);
	});
	ctx.log.info("recovery_interrupted_kept", { task: job.taskId, run: job.runId, changes: changes?.length });
}

/**
 * Run one recovery job; review jobs reserve an execution slot for their tests. Every job but a first run's worktree
 * check (that run never reached Pi) first reconciles the task's pending effects: an unresolved one freezes the group
 * and stops the job (UnknownEffect), which is redone after the owner's review.
 */
export async function runRecoveryJob(ctx: Ctx, job: RecoveryJob): Promise<void> {
	if (job.kind === "worktree") return reconcileFirstWorktree(ctx, job.taskId);
	await settleTaskEffects(ctx, job.taskId);
	// Deleted published branches and closed original PRs wait for a read-only restoration check. Do not reserve a
	// recovery test slot or republish them at every restart; held.ts owns the retry after the original PR reopens.
	if (job.kind === "review" && blocksTaskRuns(readBranchHold(ctx.store, job.taskId))) return;
	if (job.kind === "effects") return;
	if (job.kind === "interrupted") return reportInterrupted(ctx, job);
	if (job.kind === "archive") {
		// A final push refused because the branch changed outside the Coordinator holds the task (no freeze).
		await archiveEnded(ctx, job.taskId);
		return;
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
