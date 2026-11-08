/**
 * Cancel processor (design "Cancel processor"; Interfaces § Telegram: "/cancel on a task in review closes its pull
 * request and archives its worktree"). commands.ts sets cancel_requested=1 (it cancels a never-started first run
 * itself); the engine finishes the job:
 *   queued, no worktree → cancelled directly;
 *   running → the run is finalized as cancelled (revoke, abort, verify, final checkpoint, push, close PR, archive);
 *   queued with a worktree (a later run waiting) → the queued run is cancelled, then the archive procedure;
 *   review → close the PR and archive (the final checkpoint is a no-op: each run ended with one).
 * Merging tasks are not cancellable. A final push GitHub refuses because the branch changed outside the Coordinator
 * keeps the worktree: the task is cancelled, held until the branch is restored, then archived (engine/held.ts).
 */
import { taskCancelled } from "../messages.ts";
import {
	type Ctx,
	enqueueTask,
	loadTask,
	type TaskRow,
	TERMINAL_TASK_STATES,
	taskRef,
	tx,
	worktreeCheckKey,
} from "./context.ts";
import { archiveTask, effectFailed, terminalText } from "./effects.ts";
import { archivePending, decide, expireFollowups } from "./finalize.ts";

/** Start the work for every pending cancel request; returns true if any work was started. */
export function processCancels(ctx: Ctx): boolean {
	const tasks = ctx.store.all<TaskRow>(
		`SELECT * FROM tasks WHERE chat_id = ? AND cancel_requested = 1
		   AND state NOT IN ('merged', 'failed', 'cancelled', 'merging') ORDER BY id`,
		ctx.chatId,
	);
	let started = false;
	for (const task of tasks) if (cancelOne(ctx, task)) started = true;
	return started;
}

function cancelOne(ctx: Ctx, task: TaskRow): boolean {
	const active = [...ctx.active.values()].find((run) => run.taskId === task.id);
	if (active !== undefined) {
		// A normal completion already decided runs its review step first; the task is cancelled from review.
		if (active.decision !== undefined) return false;
		decide(ctx, active, { kind: "cancelled", reason: "cancelled", cause: "cancelled" });
		return true;
	}
	if (ctx.busy.has(task.id)) return false;
	// A first run's worktree still to be reconciled after a restart (recovery.ts): wait for it, so a worktree that may
	// be half set up is never checkpointed or pushed (the reconciliation discards it for a task being cancelled).
	if (ctx.store.getMeta(worktreeCheckKey(task.id)) !== undefined) return false;
	if (task.state === "queued" && task.worktree_path === null) cancelQueued(ctx, task.id);
	else ctx.track("cancel", task.id, () => cancelWithArchive(ctx, task.id));
	return true;
}

/** A task whose first run never started: nothing to stop or archive. */
function cancelQueued(ctx: Ctx, taskId: number): void {
	tx(ctx, () => {
		const task = loadTask(ctx, taskId);
		if (TERMINAL_TASK_STATES.has(task.state)) return;
		const now = ctx.now();
		ctx.store.run(
			"UPDATE runs SET state = 'cancelled', reason = 'cancelled', ended_at = ? WHERE task_id = ? AND state = 'queued'",
			now,
			taskId,
		);
		expireFollowups(ctx, { taskId }, "cancelled");
		ctx.store.run(
			"UPDATE tasks SET state = 'cancelled', reason = 'cancelled', updated_at = ? WHERE id = ?",
			now,
			taskId,
		);
		enqueueTask(ctx, task, "task_final", taskCancelled(taskId));
	});
	ctx.log.info("task_cancelled", { task: taskId, archived: false });
}

/** Cancel a task that holds a worktree but no running run, then archive it. */
async function cancelWithArchive(ctx: Ctx, taskId: number): Promise<void> {
	const proceed = tx(ctx, () => {
		const task = loadTask(ctx, taskId);
		if (TERMINAL_TASK_STATES.has(task.state) || task.state === "merging") return false;
		const now = ctx.now();
		ctx.store.run(
			"UPDATE runs SET state = 'cancelled', reason = 'cancelled', ended_at = ? WHERE task_id = ? AND state = 'queued'",
			now,
			taskId,
		);
		expireFollowups(ctx, { taskId }, "cancelled");
		ctx.store.run(
			"UPDATE approvals SET state = 'invalidated', reason = 'task cancelled' WHERE task_id = ? AND state = 'valid'",
			taskId,
		);
		ctx.store.run(
			"UPDATE tasks SET state = 'cancelled', reason = 'cancelled', updated_at = ? WHERE id = ?",
			now,
			taskId,
		);
		return true;
	});
	if (!proceed) return;
	try {
		const done = await archiveTask(ctx, taskId, (result) =>
			terminalText(loadTask(ctx, taskId), "cancelled", "cancelled", result),
		);
		// "held": the final push was refused because the branch changed outside the Coordinator; the worktree is kept
		// and archived once the branch is restored (engine/held.ts).
		ctx.log.info("task_cancelled", { task: taskId, archived: done === "archived" });
	} catch (error) {
		effectFailed(ctx, error, `archiving the cancelled ${taskRef(taskId)}`);
		archivePending(ctx, taskId, "cancelled", "cancelled");
	}
}
