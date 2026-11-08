/**
 * Dispatch (Architecture § Request Flow; Capacity § Concurrency and Resource Limits): before every run, in ONE
 * transaction, check the agent is idle and reserve a deployment-wide execution slot; a new task's first run also
 * needs its group to have fewer than the open-task limit; the budget must not be exhausted. The reservation bumps the
 * task's generation, which labels the run's key and containers.
 */
import { openTaskCount } from "../admission.ts";
import { projectTokensSpent } from "../relay.ts";
import { type Ctx, enqueueTask, groupHeld, loadTask, slotsInUse, taskRef } from "./context.ts";

export type Reservation = {
	readonly runId: number;
	readonly taskId: number;
	readonly chatId: number;
	readonly agentId: string;
	readonly generation: number;
	readonly slotId: number;
};

type Candidate = {
	run_id: number;
	task_id: number;
	chat_id: number;
	agent_id: string;
	task_state: string;
	worktree_path: string | null;
	cancel_requested: number;
};

const DISPATCHABLE_TASK_STATES = new Set(["queued", "review", "running"]);

function count(ctx: Ctx, sql: string, ...params: (string | number)[]): number {
	return ctx.store.get<{ n: number }>(sql, ...params)?.n ?? 0;
}

/** Per-candidate checks that need no group-wide count: cancel, deferral, task state, in-flight work, held slots. */
function candidateBlocked(ctx: Ctx, c: Candidate, now: number): boolean {
	if (c.cancel_requested === 1 || !DISPATCHABLE_TASK_STATES.has(c.task_state) || ctx.busy.has(c.task_id)) return true;
	const notBefore = ctx.deferred.get(c.run_id);
	if (notBefore !== undefined && notBefore > now) return true;
	if (count(ctx, "SELECT COUNT(*) AS n FROM slots WHERE task_id = ?", c.task_id) > 0) return true;
	return (
		count(ctx, "SELECT COUNT(*) AS n FROM slots WHERE kind = 'run' AND agent_id = ?", c.agent_id) >=
		ctx.limits.runsPerAgent
	);
}

/** Reserve the slot, bump the generation, mark the run starting. Inside the dispatch transaction. */
function reserve(ctx: Ctx, c: Candidate, now: number): Reservation {
	ctx.deferred.delete(c.run_id);
	const slotId = ctx.store.run(
		"INSERT INTO slots(kind, task_id, run_id, agent_id, acquired_at) VALUES ('run', ?, ?, ?, ?)",
		c.task_id,
		c.run_id,
		c.agent_id,
		now,
	).lastInsertRowid;
	ctx.store.run(
		"UPDATE tasks SET generation = generation + 1, state = 'running', updated_at = ? WHERE id = ?",
		now,
		c.task_id,
	);
	const generation =
		ctx.store.get<{ generation: number }>("SELECT generation FROM tasks WHERE id = ?", c.task_id)?.generation ?? 0;
	ctx.store.run("UPDATE runs SET state = 'starting', generation = ? WHERE id = ?", generation, c.run_id);
	return { runId: c.run_id, taskId: c.task_id, chatId: c.chat_id, agentId: c.agent_id, generation, slotId };
}

/**
 * Open tasks of the group (Capacity § Queue): admission's count (tasks holding a live worktree) plus first runs
 * already dispatched whose worktree is still being created, so two first runs cannot both take the last place.
 */
function openTasks(ctx: Ctx): number {
	const preparing = count(
		ctx,
		`SELECT COUNT(*) AS n FROM tasks t
		 WHERE t.chat_id = ? AND t.worktree_path IS NULL AND t.state NOT IN ('merged', 'failed', 'cancelled')
		   AND EXISTS (SELECT 1 FROM slots s WHERE s.task_id = t.id AND s.kind = 'run')`,
		ctx.chatId,
	);
	return openTaskCount(ctx.store, ctx.chatId) + preparing;
}

/** Reserve a slot for the first dispatchable queued run (FIFO by run id), or undefined. */
export function dispatchOnce(ctx: Ctx): Reservation | undefined {
	return ctx.store.tx(() => {
		if (groupHeld(ctx) || slotsInUse(ctx) >= ctx.limits.maxConcurrentRuns) return undefined;
		if (projectTokensSpent(ctx.store) >= ctx.config.model.projectTokenCeiling) return undefined;
		const candidates = ctx.store.all<Candidate>(
			`SELECT r.id AS run_id, r.task_id, t.chat_id, t.agent_id, t.state AS task_state, t.worktree_path,
			        t.cancel_requested
			 FROM runs r JOIN tasks t ON t.id = r.task_id
			 WHERE r.state = 'queued' AND t.chat_id = ?
			 ORDER BY r.id`,
			ctx.chatId,
		);
		const now = ctx.now();
		const open = openTasks(ctx);
		const first = candidates.find(
			(c) => !candidateBlocked(ctx, c, now) && (c.worktree_path !== null || open < ctx.limits.openTasksPerGroup),
		);
		if (first === undefined) noteWaitingForReviews(ctx, candidates, now, open);
		return first === undefined ? undefined : reserve(ctx, first, now);
	});
}

/**
 * Capacity § Waiting: "the bot tells the user when it is waiting for reviews to finish". A first run that only the
 * open-task limit holds (its agent is idle and a slot is free) is told once, unless the task was told already (its
 * acknowledgement carried the same note when it was accepted while the group was full). Inside the dispatch tx.
 */
function noteWaitingForReviews(ctx: Ctx, candidates: readonly Candidate[], now: number, open: number): void {
	if (open < ctx.limits.openTasksPerGroup) return;
	for (const c of candidates) {
		if (c.worktree_path !== null || candidateBlocked(ctx, c, now)) continue;
		const told = count(
			ctx,
			"SELECT COUNT(*) AS n FROM outbox WHERE task_id = ? AND text LIKE '%waiting for open reviews to finish%'",
			c.task_id,
		);
		if (told > 0) continue;
		enqueueTask(
			ctx,
			loadTask(ctx, c.task_id),
			"task_waiting",
			`${taskRef(c.task_id)} is waiting for open reviews to finish (${open} open tasks); it starts once a task in ` +
				"review is merged or cancelled.",
		);
		ctx.onOutbox();
	}
}
