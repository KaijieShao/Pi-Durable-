/**
 * Tasks held because their branch changed on GitHub outside the Coordinator (branch-hold.ts): look at each held
 * task's branch again every branchRecheckMs, and once GitHub's branch is back where the Coordinator can push without
 * force (it is gone, at the kept commit, or an ancestor of it), redo what waited:
 *   "review":  the run's review step (tests, push, pull request, review message), holding a check slot like a
 *              merge's tests; the task can then be approved at its new head;
 *   "archive": the archive (final push, pull request closed, folder deleted, branch kept).
 * The look itself is a read and holds no execution slot (git's network timeout is 120 s: a slow GitHub must not keep
 * other tasks from running); a restored review then waits for a free check slot, before new runs are dispatched.
 * Nothing is ever force-pushed. Reading the branch is a GitHub read, not a change: a failed read is tried again at the
 * next look, never a freeze. A change whose outcome stays unknown freezes the group as everywhere else.
 */
import { BRANCH_HOLD_PREFIX, type BranchHold, parseBranchHold } from "../branch-hold.ts";
import { INTERRUPTED_KEPT_REASON } from "../messages.ts";
import {
	type Ctx,
	describeError,
	groupHeld,
	releaseSlot,
	reserveCheckSlot,
	type TaskRow,
	TERMINAL_TASK_STATES,
	taskRef,
	tx,
} from "./context.ts";
import { archiveEnded, clearHold, effectFailed } from "./effects.ts";
import { effectsOpen } from "./intents.ts";
import { reviewStep } from "./review.ts";

type Held = { readonly taskId: number; readonly hold: BranchHold };

/** Holds of this group's tasks, oldest task first (unparsable rows are skipped). */
function heldTasks(ctx: Ctx): Held[] {
	const rows = ctx.store.all<{ key: string; value: string }>(
		`SELECT m.key, m.value FROM meta m JOIN tasks t ON t.id = CAST(substr(m.key, ?) AS INTEGER)
		 WHERE substr(m.key, 1, ?) = ? AND t.chat_id = ? ORDER BY t.id`,
		BRANCH_HOLD_PREFIX.length + 1,
		BRANCH_HOLD_PREFIX.length,
		BRANCH_HOLD_PREFIX,
		ctx.chatId,
	);
	const held: Held[] = [];
	for (const row of rows) {
		const hold = parseBranchHold(row.value);
		if (hold !== undefined) held.push({ taskId: Number(row.key.slice(BRANCH_HOLD_PREFIX.length)), hold });
	}
	return held;
}

function hasRunInProgress(ctx: Ctx, taskId: number): boolean {
	const n = ctx.store.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND state IN ('queued', 'starting', 'running', 'finalizing')",
		taskId,
	)?.n;
	return (n ?? 0) > 0;
}

function reviewDone(ctx: Ctx, runId: number | null): boolean {
	if (runId === null) return true;
	return ctx.store.get<{ review_done: number }>("SELECT review_done FROM runs WHERE id = ?", runId)?.review_done !== 0;
}

/** A hold nothing waits for any more (its task was archived, or its review is done): dropped. */
function stale(ctx: Ctx, task: TaskRow, hold: BranchHold): boolean {
	if (task.worktree_path === null) return true;
	if (hold.kind === "archive") return !TERMINAL_TASK_STATES.has(task.state) || task.state === "merged";
	return TERMINAL_TASK_STATES.has(task.state) || reviewDone(ctx, hold.runId);
}

/**
 * Whether the hold can be looked at now: a review waits while the task is busy otherwise (a run admitted meanwhile
 * pushes everything itself, a cancel archives it).
 */
function lookNow(ctx: Ctx, task: TaskRow, hold: BranchHold): boolean {
	if (hold.kind === "archive") return true;
	// An interrupted run's changes wait in the worktree for a reply or /cancel: redoing an earlier run's review would
	// commit and push them.
	if (task.reason === INTERRUPTED_KEPT_REASON || effectsOpen(ctx.store, task.id)) return false;
	return task.state === "review" && task.cancel_requested === 0 && !hasRunInProgress(ctx, task.id);
}

/**
 * Can the Coordinator push `local` without force? GitHub's branch is gone, at `local`, or an ancestor of it (a
 * foreign commit is not in the Coordinator's repository, so it is never an ancestor). undefined: unreadable.
 */
async function pushable(ctx: Ctx, hold: BranchHold): Promise<{ ok: boolean; github: string | undefined } | undefined> {
	let remote: string | undefined;
	try {
		remote = await ctx.git.remoteBranchSha(hold.branch);
	} catch (error) {
		ctx.log.warn("held_branch_read_failed", { branch: hold.branch, error: describeError(error) });
		return undefined;
	}
	if (remote === undefined || remote === hold.local) return { ok: true, github: remote };
	return { ok: await ctx.git.isAncestor(remote, hold.local).catch(() => false), github: remote };
}

/** Still changed: keep GitHub's latest head in the hold (shown by /approve and /status); no new message. */
function stillHeld(ctx: Ctx, taskId: number, hold: BranchHold, github: string | undefined): void {
	if (github === undefined || github === hold.github) return;
	tx(ctx, () => ctx.store.setMeta(`${BRANCH_HOLD_PREFIX}${taskId}`, JSON.stringify({ ...hold, github })));
}

/** Look at the held branch (a read, no slot). Restored: an archive is redone now; a review waits for a check slot. */
async function lookAgain(ctx: Ctx, taskId: number, hold: BranchHold): Promise<void> {
	const state = await pushable(ctx, hold);
	if (state === undefined) return;
	if (!state.ok) return stillHeld(ctx, taskId, hold, state.github);
	ctx.log.info("held_branch_restored", { task: taskId, kind: hold.kind });
	// A freeze (or a stop) during the read: nothing more happens now; the next look after the unfreeze decides.
	if (groupHeld(ctx) || ctx.stopped) return;
	if (hold.kind === "review") {
		ctx.heldRestored.add(taskId);
		return;
	}
	try {
		await archiveEnded(ctx, taskId);
	} catch (error) {
		effectFailed(ctx, error, `archiving ${taskRef(taskId)}`);
	}
}

/**
 * A restored review: redo the run's review step in a check slot (its tests run in a check container, like a merge's
 * tests, so the watchdog must be ready). False while no slot is free; it is tried again at the next tick.
 */
function startReview(ctx: Ctx, task: TaskRow, hold: BranchHold, watchdogReady: boolean): boolean {
	if (!watchdogReady || !lookNow(ctx, task, hold)) return false;
	const slotId = reserveCheckSlot(ctx, task.id);
	if (slotId === undefined) return false;
	ctx.heldRestored.delete(task.id);
	ctx.heldDue.set(task.id, ctx.now() + ctx.branchRecheckMs);
	ctx.track("held", task.id, async () => {
		try {
			await reviewStep(ctx, hold.runId as number, { interrupted: hold.interrupted });
		} catch (error) {
			effectFailed(ctx, error, `the review step of ${taskRef(task.id)}`);
		} finally {
			releaseSlot(ctx, slotId);
		}
	});
	return true;
}

/** Start the look at one held task (or its restored review step), if it is due and possible; true if it started. */
function startLook(ctx: Ctx, held: Held, watchdogReady: boolean, now: number): boolean {
	const { taskId, hold } = held;
	if (ctx.busy.has(taskId)) return false;
	const task = ctx.store.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
	if (task === undefined || stale(ctx, task, hold)) {
		tx(ctx, () => clearHold(ctx, taskId));
		return false;
	}
	if (hold.kind === "review" && ctx.heldRestored.has(taskId)) return startReview(ctx, task, hold, watchdogReady);
	if ((ctx.heldDue.get(taskId) ?? 0) > now || !lookNow(ctx, task, hold)) return false;
	ctx.heldDue.set(taskId, now + ctx.branchRecheckMs);
	ctx.track("held", taskId, () => lookAgain(ctx, taskId, hold));
	return true;
}

/**
 * One pass over the group's held tasks (the engine calls it while dispatch and merges are open). Returns true if it
 * started any work.
 */
export function retryHeldTasks(ctx: Ctx, watchdogReady: boolean): boolean {
	const now = ctx.now();
	let started = false;
	for (const held of heldTasks(ctx)) if (startLook(ctx, held, watchdogReady, now)) started = true;
	return started;
}
