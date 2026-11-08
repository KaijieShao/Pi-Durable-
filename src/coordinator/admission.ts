/**
 * Admission: the waiting-queue caps every run passes before it is queued (Capacity § Queue, § Fixed limits:
 * "Waiting queue (demo) 2 per agent / 4 per group / 4 per user — Coordinator admission; excess submissions
 * rejected"; Requirements § Limits always apply: every run, including a follow-up or conflict-fix run, goes through
 * the same queue). The queue is the set of runs in state 'queued', FIFO by run id. Open tasks (worktrees) are not
 * an admission cap: queued first runs wait for them at dispatch (Capacity § Queue).
 *
 * Every function reads or writes the Store synchronously; `admitRun` must run inside the caller's `store.tx()`
 * so the run, the task change and the acknowledgement commit together.
 */
import type { Limits } from "./limits.ts";
import type { Store } from "./store.ts";

export type WaitingCounts = { agent: number; group: number; user: number };

const TERMINAL = new Set(["merged", "failed", "cancelled"]);

/**
 * Queued runs that count against each cap: the agent's queue (agent ids are unique within a group, so the agent
 * is `chatId` + `agentId`), the group's queue, and the user's queue (runs.requested_by). The per-user count spans
 * every group: the stricter reading of "4 waiting tasks per user".
 */
export function waitingCounts(store: Store, q: { agentId: string; chatId: number; userId: number }): WaitingCounts {
	const row = store.get<{ agent: number; grp: number; usr: number }>(
		`SELECT
		   COALESCE(SUM(CASE WHEN t.chat_id = ? AND t.agent_id = ? THEN 1 ELSE 0 END), 0) AS agent,
		   COALESCE(SUM(CASE WHEN t.chat_id = ? THEN 1 ELSE 0 END), 0) AS grp,
		   COALESCE(SUM(CASE WHEN r.requested_by = ? THEN 1 ELSE 0 END), 0) AS usr
		 FROM runs r JOIN tasks t ON t.id = r.task_id
		 WHERE r.state = 'queued'`,
		q.chatId,
		q.agentId,
		q.chatId,
		q.userId,
	);
	return { agent: row?.agent ?? 0, group: row?.grp ?? 0, user: row?.usr ?? 0 };
}

/**
 * The "queue full" reason for the first cap that one more queued run would exceed, else undefined.
 * `agentId` only names the agent in the text.
 */
export function waitingCapReason(limits: Limits, counts: WaitingCounts, agentId?: string): string | undefined {
	if (counts.agent >= limits.waitingPerAgent) {
		const agent = agentId === undefined ? "this agent" : `agent ${agentId}`;
		return `queue full: ${agent} already has ${waiting(counts.agent)}`;
	}
	if (counts.group >= limits.waitingPerGroup) return `queue full: the group already has ${waiting(counts.group)}`;
	if (counts.user >= limits.waitingPerUser) return `queue full: you already have ${waiting(counts.user)}`;
	return undefined;
}

function waiting(n: number): string {
	return `${n} waiting ${n === 1 ? "task" : "tasks"}`;
}

/**
 * Open tasks of a group (Capacity § Queue: "running or waiting for review"): tasks holding a live worktree that
 * are not terminal. A queued first run has no worktree yet and does not count; a queued follow-up run of a task
 * in review reuses its worktree and counts once, as that task.
 */
export function openTaskCount(store: Store, chatId: number): number {
	return (
		store.get<{ n: number }>(
			`SELECT COUNT(*) AS n FROM tasks
			 WHERE chat_id = ? AND worktree_path IS NOT NULL AND archived = 0
			   AND state NOT IN ('merged', 'failed', 'cancelled')`,
			chatId,
		)?.n ?? 0
	);
}

/** 1-based position of a queued run among the queued runs of the same agent (FIFO by run id); 0 if not queued. */
export function agentQueuePosition(store: Store, runId: number): number {
	const run = store.get<{ state: string; chat_id: number; agent_id: string }>(
		"SELECT r.state, t.chat_id, t.agent_id FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?",
		runId,
	);
	if (run === undefined || run.state !== "queued") return 0;
	return (
		store.get<{ n: number }>(
			`SELECT COUNT(*) AS n FROM runs r JOIN tasks t ON t.id = r.task_id
			 WHERE r.state = 'queued' AND r.id <= ? AND t.chat_id = ? AND t.agent_id = ?`,
			runId,
			run.chat_id,
			run.agent_id,
		)?.n ?? 0
	);
}

type AdmitTask = { chat_id: number; agent_id: string; state: string };

function admissionBlocker(
	store: Store,
	limits: Limits,
	p: { taskId: number; kind: string; requestedBy: number },
	task: AdmitTask,
): string | undefined {
	if (TERMINAL.has(task.state)) return `Task ${p.taskId} is already ${task.state}`;
	const runs = store.get<{ busy: number; total: number }>(
		`SELECT COALESCE(SUM(CASE WHEN state IN ('queued', 'starting', 'running', 'finalizing') THEN 1 ELSE 0 END), 0)
		          AS busy,
		        COUNT(*) AS total
		 FROM runs WHERE task_id = ?`,
		p.taskId,
	);
	if ((runs?.busy ?? 0) > 0) return `Task ${p.taskId} already has a run queued or running`;
	if (p.kind === "initial" && (runs?.total ?? 0) > 0) return `Task ${p.taskId} already had its first run`;
	const counts = waitingCounts(store, { agentId: task.agent_id, chatId: task.chat_id, userId: p.requestedBy });
	return waitingCapReason(limits, counts, task.agent_id);
}

export type AdmitResult = { ok: true; runId: number; position: number } | { ok: false; reason: string };

/**
 * Admit one run of a task: check the waiting caps (counted against `requestedBy`), insert the run as queued,
 * move a non-initial task back to 'queued' (Architecture § States: "a follow-up or conflict fix queues another run
 * of the same task"), and invalidate any valid approval (Architecture § Review and merge: an approval is rejected
 * once "a new run has been admitted"). Must be called inside `store.tx()`.
 *
 * Refuses a terminal task, and a task that already has a run queued or in progress (each task runs one run at a
 * time; a follow-up to a busy task is a steer, not a second run).
 */
export function admitRun(
	store: Store,
	limits: Limits,
	p: {
		taskId: number;
		kind: "initial" | "followup" | "conflict";
		requestedBy: number;
		requestId: string;
		inputText: string;
		followupId?: number;
	},
): AdmitResult {
	if (!store.inTransaction) throw new Error("admitRun must be called inside store.tx()");
	const task = store.get<AdmitTask>("SELECT chat_id, agent_id, state FROM tasks WHERE id = ?", p.taskId);
	if (task === undefined) return { ok: false, reason: `there is no Task ${p.taskId}` };
	const blocked = admissionBlocker(store, limits, p, task);
	if (blocked !== undefined) return { ok: false, reason: blocked };

	const now = store.now();
	const runId = store.run(
		`INSERT INTO runs(task_id, kind, state, requested_by, request_id, input_text, followup_id, queued_at)
		 VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`,
		p.taskId,
		p.kind,
		p.requestedBy,
		p.requestId,
		p.inputText,
		p.followupId ?? null,
		now,
	).lastInsertRowid;
	if (p.kind !== "initial") {
		// The review note (e.g. "interrupted by restart; reply to start another run") no longer applies.
		store.run("UPDATE tasks SET state = 'queued', reason = NULL, updated_at = ? WHERE id = ?", now, p.taskId);
	}
	store.run(
		"UPDATE approvals SET state = 'invalidated', reason = 'new run admitted' WHERE task_id = ? AND state = 'valid'",
		p.taskId,
	);
	return { ok: true, runId, position: agentQueuePosition(store, runId) };
}
