/** Shared read-only queue descriptions; dispatch/admission behavior is unchanged. */
import { agentQueuePosition, openTaskCount } from "./admission.ts";
import { EXECUTION_DISK_WAIT_KEY, TASK_DISK_WAIT_KEY } from "./disk.ts";
import { deploymentHeld } from "./evaluation.ts";
import type { Limits } from "./limits.ts";
import { sealingWait, waitingForAgent, waitingForReviews, waitingForSlot, waitingForTaskDisk } from "./messages.ts";
import type { Store } from "./store.ts";

/** Queue position and waiting note of a task's queued run, if it has one. */
export function queueInfo(
	store: Store,
	limits: Limits,
	task: { id: number; chat_id: number; agent_id: string },
): { position?: number; note?: string } {
	const queued = store.get<{ id: number; kind: string }>(
		"SELECT id, kind FROM runs WHERE task_id = ? AND state = 'queued' ORDER BY id LIMIT 1",
		task.id,
	);
	if (queued === undefined) return {};
	return {
		position: agentQueuePosition(store, queued.id),
		note: waitNote(store, limits, { chatId: task.chat_id, agent: task.agent_id, initial: queued.kind === "initial" }),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers

/**
 * Why a queued run is not starting right away (Capacity § Waiting): a first run waits for the group to have fewer
 * than `openTasksPerGroup` open tasks and for room on the task disk for its new worktree (Capacity § Disk, while the
 * engine holds new worktrees: engine/task-disk.ts); every run waits for its agent and for a deployment-wide execution
 * slot.
 */
export function waitNote(
	store: Store,
	limits: Limits,
	p: { chatId: number; agent: string; initial: boolean },
): string | undefined {
	if (deploymentHeld(store)) return sealingWait();
	const pressure = store.getMeta(EXECUTION_DISK_WAIT_KEY)?.split("|").slice(1).join("|");
	if (pressure !== undefined) return `waiting for disk safety: ${pressure}`;
	if (p.initial) {
		const open = openTaskCount(store, p.chatId);
		if (open >= limits.openTasksPerGroup) return waitingForReviews(open);
		const disk = taskDiskNote(store);
		if (disk !== undefined) return disk;
	}
	const agentBusy =
		store.get<{ n: number }>(
			`SELECT COUNT(*) AS n FROM slots s JOIN tasks t ON t.id = s.task_id
			 WHERE s.kind = 'run' AND t.chat_id = ? AND t.agent_id = ?`,
			p.chatId,
			p.agent,
		)?.n ?? 0;
	if (agentBusy >= limits.runsPerAgent) return waitingForAgent(p.agent);
	const inUse = slotsInUse(store);
	if (inUse >= limits.maxConcurrentRuns) return waitingForSlot(inUse, limits.maxConcurrentRuns);
	return undefined;
}

/** The note of a held task disk (engine/task-disk.ts), if new worktrees are held now. */
export function taskDiskNote(store: Store): string | undefined {
	const detail = store.getMeta(TASK_DISK_WAIT_KEY);
	return detail === undefined ? undefined : waitingForTaskDisk(detail);
}

function slotsInUse(store: Store): number {
	return store.get<{ n: number }>("SELECT COUNT(*) AS n FROM slots")?.n ?? 0;
}
