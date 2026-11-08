/**
 * What the Coordinator and the watchdog share: rows of `watchdog_sweeps` and two meta keys in the Coordinator's SQLite
 * file (Store schema v2, WAL; each side has its own connection). No socket, no secret: the watchdog never holds the
 * bot token, the model key or the GitHub token (src/watchdog/config.ts).
 *
 *   Coordinator → watchdog   a pending sweep request (reason coordinator_start at recovery step 2, or recheck after the
 *                            owner unfroze the group), with the requesting Coordinator's pid
 *   watchdog → Coordinator   the same row, done: verified (every Pi process and labelled container gone) or not, with
 *                            the counts; an unverified stop also freezes the group in the same transaction, with a
 *                            required notice in the outbox
 *   watchdog alone           rows it records on its own: coordinator_dead (it found leftovers while no Coordinator
 *                            runs) and deadline (it stopped a run past its deadline); a heartbeat in meta every second,
 *                            with its pid (only that watchdog acts; another one stands by)
 */

export const SWEEP_REASONS = ["coordinator_start", "recheck", "coordinator_dead", "deadline"] as const;
export type SweepReason = (typeof SWEEP_REASONS)[number];
/** Reasons the Coordinator asks for; the other two the watchdog records on its own. */
export type RequestedSweepReason = Extract<SweepReason, "coordinator_start" | "recheck">;

/** meta: epoch ms of the watchdog's latest heartbeat. */
export const HEARTBEAT_KEY = "watchdog_heartbeat_at";
/** meta: pid of the watchdog that wrote the heartbeat: the one that acts (a lease, src/watchdog/watchdog.ts). */
export const WATCHDOG_PID_KEY = "watchdog_pid";

/** A row of `watchdog_sweeps`. Metadata only: counts, ids, times and a fixed detail word. */
export type SweepRow = {
	id: number;
	reason: SweepReason;
	state: "pending" | "done";
	requester_pid: number | null;
	run_id: number | null;
	task_id: number | null;
	generation: number | null;
	/** 1 verified gone, 0 not verified; NULL while pending. */
	verified: number | null;
	processes_killed: number | null;
	containers_killed: number | null;
	/** What was still listed at the end; NULL when it could not be listed at all. */
	processes_left: number | null;
	containers_left: number | null;
	/** A fixed word (e.g. processes_unlistable, containers_left), never free text. */
	detail: string | null;
	requested_at: number;
	started_at: number | null;
	finished_at: number | null;
};

/** The database file both open, inside PI_DATA_DIR. */
export const COORDINATOR_DATABASE = "coordinator.sqlite";

/** The freeze reason of a sweep the Coordinator asked for that could not be verified (posted to the group). */
export const UNVERIFIED_SWEEP = "the watchdog could not verify that every leftover Pi process and container is gone";
