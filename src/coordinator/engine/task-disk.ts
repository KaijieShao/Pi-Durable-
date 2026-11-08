/**
 * New worktrees and the task disk (Capacity § Disk: "If a new worktree would exceed it, the task stays queued and the
 * bot says why"; src/coordinator/disk.ts for the measurement).
 *
 * A run whose task has no worktree yet (a first run, or one whose worktree recovery deleted) is checked before main is
 * fetched (at the main fetched last, so nothing is written to a disk without room) and again right before its worktree
 * is created, at the fetched main (runs.ts). If it does not fit, the run goes back to the queue at its
 * position (its slot released, nothing created, the task told once why) and the engine holds every new worktree
 * (`ctx.taskDiskHold`): while the hold lasts, dispatch reserves no slot for such a run and tells each waiting task
 * once why (dispatch.ts). Runs of tasks that have a worktree (follow-ups, conflict fixes) are not held. The hold is
 * measured again without a slot every `diskRecheckMs`, and at once when a worktree was archived or finished being
 * created; when one more worktree fits, it is lifted and the oldest waiting run starts. A hold nobody waits for is
 * dropped (the next new worktree is checked anyway).
 */
import {
	measureTaskDisk,
	TASK_DISK_WAIT_KEY,
	type TaskDiskMeasure,
	type TaskDiskShortfall,
	type WorktreeRoom,
	worktreeRoom,
} from "../disk.ts";
import { taskDiskDetail } from "../messages.ts";
import { type Ctx, tx } from "./context.ts";

/** Production interval of the held task disk's measurement (EngineOptions.diskRecheckMs). */
export const TASK_DISK_RECHECK_MS = 30_000;

/** New worktrees are held: why, and what was measured. */
export type TaskDiskHold = {
	readonly shortfall: TaskDiskShortfall;
	readonly checkedAt: number;
	/** Live worktrees and worktrees being created when it was measured: a change means "measure again now". */
	readonly signature: string;
};

function signature(ctx: Ctx): string {
	const live = ctx.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE worktree_path IS NOT NULL")?.n ?? 0;
	return `${live}:${ctx.creatingWorktrees.size}`;
}

/** A measurement for one more worktree, and the worktrees that were being created when it started. */
export type NewWorktreeMeasure = {
	readonly measure: TaskDiskMeasure | undefined;
	readonly creating: ReadonlySet<number>;
};

/** Measure the task disk for one more worktree whose checkout takes `checkoutBytes()` (Git.checkoutBytes of a base). */
export async function measureNewWorktree(ctx: Ctx, checkoutBytes: () => Promise<number>): Promise<NewWorktreeMeasure> {
	const creating = new Set(ctx.creatingWorktrees);
	const measure = await measureTaskDisk({
		probe: ctx.diskProbe,
		taskDir: ctx.config.paths.taskDir,
		settings: ctx.disk,
		checkoutBytes,
	});
	return { measure, creating };
}

/**
 * Does one more worktree fit, counting those let through and still being created? Synchronous: the caller lets its
 * worktree through (ctx.creatingWorktrees) in the same step, so a concurrent check sees it. A worktree that was being
 * created when the measurement started still counts as pending even if it finished since: the measurement may have
 * seen none or only part of its files.
 */
export function roomForNewWorktree(ctx: Ctx, measured: NewWorktreeMeasure): WorktreeRoom {
	const pending = new Set([...measured.creating, ...ctx.creatingWorktrees]).size;
	return worktreeRoom(measured.measure, ctx.disk, pending);
}

/** Hold new worktrees (dispatch reads it in memory; /status reads the detail from meta). */
export function holdNewWorktrees(ctx: Ctx, shortfall: TaskDiskShortfall, measured = signature(ctx)): void {
	const first = ctx.taskDiskHold === undefined;
	ctx.taskDiskHold = { shortfall, checkedAt: ctx.now(), signature: measured };
	tx(ctx, () => ctx.store.setMeta(TASK_DISK_WAIT_KEY, taskDiskDetail(shortfall)));
	if (first) ctx.log.warn("task_disk_hold", { shortfall: shortfall.kind, ...shortfallBytes(shortfall) });
}

/** Lift the hold (and its /status note). */
export function liftTaskDiskHold(ctx: Ctx, why: "room" | "nobody_waits" | "start"): void {
	const held = ctx.taskDiskHold !== undefined;
	ctx.taskDiskHold = undefined;
	tx(ctx, () => ctx.store.run("DELETE FROM meta WHERE key = ?", TASK_DISK_WAIT_KEY));
	if (held) ctx.log.info("task_disk_hold_lifted", { why });
}

/** Sizes for the log (bytes; metadata only). */
function shortfallBytes(shortfall: TaskDiskShortfall): Record<string, number> {
	if (shortfall.kind === "floor") return { needed: shortfall.needed, free: shortfall.free, floor: shortfall.floor };
	if (shortfall.kind === "budget") return { needed: shortfall.needed, used: shortfall.used, budget: shortfall.budget };
	return {};
}

/** A queued run of this group that needs a new worktree and is not being cancelled. */
function newWorktreeWaiting(ctx: Ctx): boolean {
	return (
		ctx.store.get(
			`SELECT 1 AS n FROM runs r JOIN tasks t ON t.id = r.task_id
			 WHERE r.state = 'queued' AND t.chat_id = ? AND t.worktree_path IS NULL AND t.cancel_requested = 0 LIMIT 1`,
			ctx.chatId,
		) !== undefined
	);
}

/** Measure a held task disk again (no slot is taken) when it is due; true if a measurement started. */
export function recheckTaskDisk(ctx: Ctx): boolean {
	const hold = ctx.taskDiskHold;
	if (hold === undefined || ctx.taskDiskChecking) return false;
	if (!newWorktreeWaiting(ctx)) {
		liftTaskDiskHold(ctx, "nobody_waits");
		return false;
	}
	const seen = signature(ctx);
	if (seen === hold.signature && ctx.now() - hold.checkedAt < ctx.diskRecheckMs) return false;
	ctx.taskDiskChecking = true;
	ctx.track("task_disk_check", undefined, async () => {
		try {
			// The fetched main: the base a new worktree would most likely start from (it is fetched again before one is).
			const measured = await measureNewWorktree(ctx, () => ctx.git.checkoutBytes(ctx.git.baseRef));
			const room = roomForNewWorktree(ctx, measured);
			if (room.ok) liftTaskDiskHold(ctx, "room");
			else holdNewWorktrees(ctx, room.shortfall, seen);
		} finally {
			ctx.taskDiskChecking = false;
		}
	});
	return true;
}
