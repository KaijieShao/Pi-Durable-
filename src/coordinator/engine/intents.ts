/**
 * The effect ledger (Agent Execution § Uncertain Effects) in the Coordinator's SQLite store (table effect_intents):
 *
 *   1. "Intent (target, pre-hash, intended hash) is persisted before execution": every `edit`/`write` the Coordinator
 *      executes in a run's agent container gets a row (pending) first; so does every `run_check` (it cannot mutate the
 *      project, but one in flight at a crash must be reported). The container's answer settles it: applied, failed
 *      (a refusal that left the target as it was), done (a check).
 *   2. "After an unknown outcome, competing mutations are stopped and termination is confirmed": a row still pending
 *      (the Coordinator crashed, or a stop cut the call) is reconciled only by callers that confirmed termination:
 *      restart recovery's jobs (they run after the Coordinator's own verified kills and the watchdog's verified sweep)
 *      and finalize (after the run's Pi process and containers are verified gone).
 *   3. "The target is inspected": its state now (effect-target.ts, on the host, no symlink followed, confined to the
 *      worktree) against the intent: the intended result → applied; the state before → unchanged ("currently
 *      unchanged"); a run_check → failed ("reported as failed once termination is confirmed").
 *   4. "Anything else freezes the group": unresolved; the task's users are told which file (never its content), the
 *      group freezes, and nothing archives, reviews or pushes the task's worktree until the owner's unfreeze records
 *      the resolution (src/cli/owner.ts: state resolved).
 */
import { classifyTarget, type PlannedChange, TargetUnreadable, targetState } from "../effect-target.ts";
import { type ReconciledEffect, unresolvedEffect, unresolvedEffectReason } from "../messages.ts";
import type { Store } from "../store.ts";
import {
	type ActiveRun,
	type Ctx,
	describeError,
	enqueueTask,
	freezeGroup,
	interruptedKey,
	loadTask,
	tx,
	UnknownEffect,
} from "./context.ts";

export type IntentTool = "edit" | "write" | "run_check";
export type IntentState = "pending" | "applied" | "failed" | "unchanged" | "unresolved" | "resolved" | "done";

export type IntentRow = {
	id: number;
	run_id: number;
	task_id: number;
	tool: IntentTool;
	path: string | null;
	operation: string | null;
	pre_hash: string | null;
	intended_hash: string | null;
	state: IntentState;
	observed_hash: string | null;
	reconciled: number;
	resolution: string | null;
	created_at: number;
	settled_at: number | null;
};

/** Save a file change's intent before it runs; returns its id. */
export function recordChange(ctx: Ctx, active: ActiveRun, plan: PlannedChange): number {
	return tx(
		ctx,
		() =>
			ctx.store.run(
				`INSERT INTO effect_intents(run_id, task_id, tool, path, pre_hash, intended_hash, state, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
				active.runId,
				active.taskId,
				plan.tool,
				plan.path,
				plan.pre,
				plan.intended,
				ctx.now(),
			).lastInsertRowid,
	);
}

/** Save a run_check before it runs; returns its id. */
export function recordCheck(ctx: Ctx, active: ActiveRun, operation: string): number {
	return tx(
		ctx,
		() =>
			ctx.store.run(
				`INSERT INTO effect_intents(run_id, task_id, tool, operation, state, created_at)
				 VALUES (?, ?, 'run_check', ?, 'pending', ?)`,
				active.runId,
				active.taskId,
				operation,
				ctx.now(),
			).lastInsertRowid,
	);
}

/** Settle a pending intent (a no-op once something else settled it). Inside a transaction or on its own. */
export function settleIntent(
	ctx: Ctx,
	id: number,
	state: Exclude<IntentState, "pending" | "resolved">,
	observed: { readonly hash?: string | undefined; readonly reconciled?: boolean } = {},
): boolean {
	return (
		tx(ctx, () =>
			ctx.store.run(
				`UPDATE effect_intents SET state = ?, observed_hash = COALESCE(?, observed_hash), reconciled = ?, settled_at = ?
				 WHERE id = ? AND state = 'pending'`,
				state,
				observed.hash ?? null,
				observed.reconciled === true ? 1 : 0,
				ctx.now(),
				id,
			),
		).changes > 0
	);
}

/**
 * The task's effects are not settled: an intent pending or unresolved, or its interrupted run not reconciled yet.
 * Nothing may archive (final checkpoint and push), cancel or review its worktree meanwhile.
 */
export function effectsOpen(store: Store, taskId: number): boolean {
	if (store.getMeta(interruptedKey(taskId)) !== undefined) return true;
	const open = store.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM effect_intents WHERE task_id = ? AND state IN ('pending', 'unresolved')",
		taskId,
	)?.n;
	return (open ?? 0) > 0;
}

/** Intents still waiting for the owner. */
export function unresolvedIntents(store: Store, taskId: number): IntentRow[] {
	return store.all<IntentRow>(
		"SELECT * FROM effect_intents WHERE task_id = ? AND state = 'unresolved' ORDER BY id",
		taskId,
	);
}

/** Tasks with an intent pending or unresolved (restart recovery reconciles them before anything else). */
export function tasksWithOpenIntents(store: Store): number[] {
	return store
		.all<{ task_id: number }>(
			"SELECT DISTINCT task_id FROM effect_intents WHERE state IN ('pending', 'unresolved') ORDER BY task_id",
		)
		.map((row) => row.task_id);
}

/** The run's intents that reconciliation settled, or that wait for (or got) the owner's review: for the users. */
export function reconciledOf(store: Store, runId: number): ReconciledEffect[] {
	const rows = store.all<IntentRow>(
		`SELECT * FROM effect_intents WHERE run_id = ? AND (reconciled = 1 OR state IN ('unresolved', 'resolved'))
		 ORDER BY id`,
		runId,
	);
	return rows.map(toReconciled);
}

export function toReconciled(row: IntentRow): ReconciledEffect {
	const target = row.tool === "run_check" ? (row.operation ?? "?") : (row.path ?? "?");
	const outcome =
		row.state === "unchanged" || row.state === "failed" || row.state === "unresolved" || row.state === "resolved"
			? row.state
			: "applied";
	return { tool: row.tool, target, outcome };
}

/** Inspect one pending file change; termination is confirmed by the caller. */
async function inspect(ctx: Ctx, row: IntentRow, worktree: string | null): Promise<IntentRow> {
	if (row.tool === "run_check") {
		// It cannot mutate the project: reported as failed now that termination is confirmed.
		settleIntent(ctx, row.id, "failed", { reconciled: true });
		return { ...row, state: "failed", reconciled: 1 };
	}
	let observed: string | undefined;
	try {
		if (worktree === null || row.path === null) throw new TargetUnreadable("the worktree is missing");
		observed = await targetState(worktree, row.path);
	} catch (error) {
		ctx.log.warn("intent_target_unreadable", { intent: row.id, task: row.task_id, error: describeError(error) });
	}
	const outcome =
		observed === undefined ? "unresolved" : classifyTarget(observed, row.pre_hash ?? "", row.intended_hash ?? "");
	settleIntent(ctx, row.id, outcome, { hash: observed, reconciled: true });
	ctx.log.info("intent_reconciled", { intent: row.id, run: row.run_id, task: row.task_id, outcome });
	return { ...row, state: outcome, observed_hash: observed ?? null, reconciled: 1 };
}

/**
 * Reconcile the pending intents of a run or of a whole task from its worktree. The caller has confirmed that every
 * process and container that could still execute them is gone. Returns the rows it settled (with their outcome).
 */
export async function reconcilePending(
	ctx: Ctx,
	scope: { readonly runId: number } | { readonly taskId: number },
	worktree: string | null,
): Promise<IntentRow[]> {
	const rows =
		"runId" in scope
			? ctx.store.all<IntentRow>(
					"SELECT * FROM effect_intents WHERE run_id = ? AND state = 'pending' ORDER BY id",
					scope.runId,
				)
			: ctx.store.all<IntentRow>(
					"SELECT * FROM effect_intents WHERE task_id = ? AND state = 'pending' ORDER BY id",
					scope.taskId,
				);
	const settled: IntentRow[] = [];
	for (const row of rows) settled.push(await inspect(ctx, row, worktree));
	return settled;
}

/** The files of the rows that reconciliation just found unresolved. */
export function newlyUnresolved(rows: readonly IntentRow[]): string[] {
	return rows.filter((row) => row.state === "unresolved").map((row) => row.path ?? row.operation ?? "?");
}

/**
 * The task's unresolved intents freeze the group (step 4). The task's users are told once, when files first turn
 * unresolved (`newly`); the freeze keeps its first reason. Returns the freeze reason, or undefined if none is left.
 */
export function freezeOnUnresolved(ctx: Ctx, taskId: number, newly: readonly string[]): string | undefined {
	const unresolved = unresolvedIntents(ctx.store, taskId);
	if (unresolved.length === 0) return undefined;
	const files = [...new Set(unresolved.map((row) => row.path ?? row.operation ?? "?"))];
	const reason = unresolvedEffectReason(taskId, files);
	if (newly.length > 0) {
		tx(ctx, () => {
			const task = loadTask(ctx, taskId);
			enqueueTask(ctx, task, "effect_unresolved", unresolvedEffect({ taskId, files: [...new Set(newly)] }));
		});
		ctx.log.warn("intent_unresolved", { task: taskId, count: newly.length });
	}
	freezeGroup(ctx, reason);
	return reason;
}

/**
 * Restart recovery: reconcile every pending intent of the task (termination is confirmed: recovery jobs run only after
 * the verified kills and the watchdog's verified sweep), then freeze the group if any is unresolved and throw, so the
 * job that needed the worktree stops and is redone after the owner resolves it. Returns the rows settled now.
 */
export async function settleTaskEffects(ctx: Ctx, taskId: number): Promise<IntentRow[]> {
	const task = loadTask(ctx, taskId);
	const settled = await reconcilePending(ctx, { taskId }, task.worktree_path);
	const frozen = freezeOnUnresolved(ctx, taskId, newlyUnresolved(settled));
	if (frozen !== undefined) throw new UnknownEffect(frozen);
	return settled;
}
