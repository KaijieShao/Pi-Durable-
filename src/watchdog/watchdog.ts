/**
 * The watchdog: the independent stop path (Architecture § Watchdog: "It terminates processes and containers and
 * verifies they're gone. It enforces each run's 10-minute deadline independently"; Deployment § Processes: a separate
 * unit that survives a Coordinator crash). In production it is its own process (`pi-durable-telegram watchdog`, its own
 * systemd unit and user, src/cli/watchdog.ts); tests also run this core in-process. It holds no secret: no bot token,
 * no model key, no GitHub token, no network.
 *
 * State is the Coordinator's SQLite file (its own connection; src/watchdog/protocol.ts). It waits until that file
 * exists (the first Coordinator start creates it). Then, every second:
 *
 *   heartbeat   meta watchdog_heartbeat_at (and watchdog_pid), at each pass and from a timer, written only while
 *               this loop makes progress and its last pass did not fail (a watchdog that cannot do its work must not
 *               look healthy); the Coordinator dispatches only while it is fresh
 *   requests    serve each pending sweep request (coordinator_start, recheck) in order: kill everything in the Pi
 *               slice (or every marked Pi process) and every labelled container, verify both are empty, record the
 *               answer; unverified → the group is frozen in the same transaction, with a required notice
 *   no Coordinator
 *               the data directory's lock is gone or its owner is dead (pid gone or reused): if any Pi process or
 *               labelled container is left, sweep and record it on its own (coordinator_dead)
 *   deadlines   while a Coordinator runs (or its lock cannot be read: a deadline holds either way): a run still
 *               starting, running or finalizing past its deadline plus a grace (after the Coordinator's own timer and
 *               stop would have finished) gets its Pi process(es) and its containers (task and generation labels)
 *               killed and verified, recorded once per run start (again only if something had to be killed);
 *               unverified → the run's group is frozen (its task's group, even if this watchdog was configured with
 *               another chat id: that mismatch is logged)
 *
 * Requests are served in id order and a Coordinator asks only while it runs nothing (startup recovery, the recheck),
 * so a sweep never kills a live run of the Coordinator that asked, nor of a later one. That holds for one watchdog:
 * a second one still sweeping after the first answered would kill the runs dispatched meanwhile. So one watchdog acts
 * per database, the one whose pid holds the heartbeat (a lease: another live watchdog's heartbeat younger than 5 s);
 * any other stands by (writes and kills nothing) and takes over once that one is gone, stalled or stopped.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEMO_LIMITS } from "../coordinator/limits.ts";
import { Store } from "../coordinator/store.ts";
import { lockPresence } from "../runtime/lock.ts";
import { errorSummary, type Logger } from "../runtime/log.ts";
import {
	COORDINATOR_DATABASE,
	HEARTBEAT_KEY,
	type SweepReason,
	UNVERIFIED_SWEEP,
	WATCHDOG_PID_KEY,
} from "./protocol.ts";
import { type Reapers, type Scope, type SweepResult, sweep } from "./reapers.ts";

export type WatchdogOptions = {
	readonly dataDir: string;
	/** The group to freeze when a stop cannot be verified. */
	readonly chatId: number;
	readonly reapers: Reapers;
	readonly log: Logger;
	/** The run deadline it enforces: DEMO_LIMITS (tests pass their stack's). */
	readonly runDeadlineMs?: number;
	/** TEST ONLY (never from configuration): loop interval, default 1 s. */
	readonly intervalMs?: number;
	/** TEST ONLY: the grace after the deadline, default 60 s. */
	readonly deadlineGraceMs?: number;
};

export type Watchdog = {
	/** Stop the loop and the heartbeat, close the database. */
	stop(): Promise<void>;
	/** Starts the next loop pass now and resolves once it is complete (tests). */
	nextLoop(): Promise<void>;
};

const INTERVAL_MS = 1000;
/** The heartbeat is written about this often (the Coordinator wants one younger than 15 s). */
const HEARTBEAT_MS = 1000;
/** After the run deadline, the Coordinator's own stop (abort, grace, kill, containers) gets this long first. */
export const DEADLINE_GRACE_MS = 60_000;
/** No heartbeat while the loop made no progress for this long (every step is bounded well below it). */
const STALL_MS = 60_000;
/** While no Coordinator runs, look for leftovers at most this often. */
const LEFTOVER_CHECK_MS = 2_000;
/** An overdue run is looked at again at most this often. */
const DEADLINE_RECHECK_MS = 10_000;
/** Another live watchdog's heartbeat younger than this means it leads: this one stands by. */
const LEASE_MS = 5_000;

type State = {
	store: Store | undefined;
	stopped: boolean;
	/** The last pass threw: no heartbeat until one completes again. */
	failing: boolean;
	/** Another watchdog leads this database (seen at the last pass). */
	standby: boolean;
	progressAt: number;
	/** When the last heartbeat was written. */
	beatAt: number;
	leftoverCheckAt: number;
	readonly deadlineChecks: Map<string, number>;
	/** Passes started and completed so far; a waiter resolves once `after` passes are complete. */
	started: number;
	completed: number;
	readonly waiters: { readonly after: number; readonly resolve: () => void }[];
	wake: (() => void) | undefined;
	readonly noted: Set<string>;
};

type Settings = Required<Omit<WatchdogOptions, "reapers" | "log">> & Pick<WatchdogOptions, "reapers" | "log">;

/** `chat_id`: the group of the run's task (null only if the task row is missing). */
type OverdueRun = { id: number; task_id: number; generation: number; chat_id: number | null };

function noteOnce(s: Settings, state: State, event: string): void {
	if (state.noted.has(event)) return;
	state.noted.add(event);
	s.log.warn(event);
}

function touch(state: State): void {
	state.progressAt = Date.now();
}

/**
 * The Coordinator's database, once it exists and opens (the watchdog never creates it; as its own user it may also
 * have to wait until the Coordinator has created and shared its WAL files, see src/coordinator/state-share.ts).
 */
function openStore(s: Settings, state: State): Store | undefined {
	if (state.store !== undefined) return state.store;
	const path = join(s.dataDir, COORDINATOR_DATABASE);
	if (!existsSync(path)) {
		noteOnce(s, state, "watchdog_waiting_for_database");
		return undefined;
	}
	try {
		state.store = new Store(path);
	} catch (error) {
		if (!state.noted.has("watchdog_database_unavailable"))
			s.log.error("watchdog_database_unavailable", { error: errorSummary(error) });
		state.noted.add("watchdog_database_unavailable");
		return undefined;
	}
	state.noted.delete("watchdog_database_unavailable");
	s.log.info("watchdog_database_open");
	return state.store;
}

/** A live process (of any user: EPERM means it exists). */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Another watchdog leads: its pid holds the heartbeat, the heartbeat is fresh, and that process is alive. */
function otherLeads(store: Store): boolean {
	const holder = Number(store.getMeta(WATCHDOG_PID_KEY));
	if (!Number.isSafeInteger(holder) || holder <= 0 || holder === process.pid) return false;
	const at = Number(store.getMeta(HEARTBEAT_KEY));
	return Number.isFinite(at) && Date.now() - at <= LEASE_MS && pidAlive(holder);
}

/** Inside a transaction: this watchdog's heartbeat and pid, only while it is healthy (not stopped, failing or stalled). */
function beat(s: Settings, state: State, store: Store): void {
	if (state.stopped || state.failing) return;
	if (Date.now() - state.progressAt > STALL_MS) {
		noteOnce(s, state, "watchdog_loop_stalled");
		return;
	}
	const now = Date.now();
	store.setMeta(HEARTBEAT_KEY, String(now));
	store.setMeta(WATCHDOG_PID_KEY, String(process.pid));
	state.beatAt = now;
}

/** The heartbeat timer: about once a second, unless another watchdog leads (a pass claims the lead back). */
function heartbeat(s: Settings, state: State): void {
	const store = state.store;
	if (store === undefined || state.standby || Date.now() - state.beatAt < HEARTBEAT_MS) return;
	try {
		store.tx(() => {
			if (!otherLeads(store)) beat(s, state, store);
		});
	} catch (error) {
		s.log.warn("watchdog_heartbeat_failed", { error: errorSummary(error) });
	}
}

/**
 * Lead this pass (the heartbeat written in the same transaction as the check, so of two watchdogs starting together
 * one leads), or stand by while another live watchdog holds a fresh heartbeat. Logged when it changes.
 */
function claimLead(s: Settings, state: State, store: Store): boolean {
	const leading = store.tx(() => {
		if (otherLeads(store)) return false;
		beat(s, state, store);
		return true;
	});
	if (leading === state.standby) {
		state.standby = !leading;
		if (leading) s.log.info("watchdog_leading");
		else s.log.warn("watchdog_standby", { leader: Number(store.getMeta(WATCHDOG_PID_KEY)) });
	}
	return leading;
}

/** A clean stop hands the lease over at once (another watchdog need not wait for the heartbeat to age). */
function releaseLead(state: State): void {
	const store = state.store;
	try {
		store?.tx(() => {
			if (store.getMeta(WATCHDOG_PID_KEY) === String(process.pid))
				store.run("DELETE FROM meta WHERE key = ?", WATCHDOG_PID_KEY);
		});
	} catch {
		// The lease then ends with the heartbeat's age.
	}
}

/** Freeze the group with the required notice, unless it is frozen already. Inside the caller's transaction. */
function freeze(store: Store, chatId: number, reason: string): void {
	if (!store.freeze(chatId, reason)) return;
	store.enqueue({
		chatId,
		priority: "required",
		kind: "group_frozen",
		text: `Group frozen: ${reason}. Only the owner CLI can unfreeze it.`,
	});
}

const resultColumns = (result: SweepResult): (number | string | null)[] => [
	result.verified ? 1 : 0,
	result.processesKilled,
	result.containersKilled,
	result.processesLeft,
	result.containersLeft,
	result.detail,
];

/** A served request: its answer, and the freeze if unverified, in one transaction. */
function answer(s: Settings, store: Store, id: number, result: SweepResult): void {
	store.tx(() => {
		store.run(
			`UPDATE watchdog_sweeps SET state = 'done', verified = ?, processes_killed = ?, containers_killed = ?,
			   processes_left = ?, containers_left = ?, detail = ?, finished_at = ? WHERE id = ?`,
			...resultColumns(result),
			Date.now(),
			id,
		);
		if (!result.verified) freeze(store, s.chatId, UNVERIFIED_SWEEP);
	});
}

type OwnRecord = {
	readonly reason: Extract<SweepReason, "coordinator_dead" | "deadline">;
	readonly requesterPid: number | null;
	readonly scope: Scope | undefined;
	readonly startedAt: number;
	/** The group to freeze if the stop is unverified. */
	readonly chatId: number;
	readonly freezeReason: string;
};

/** A sweep of the watchdog's own: its record, and the freeze if unverified, in one transaction. */
function record(store: Store, own: OwnRecord, result: SweepResult): void {
	store.tx(() => {
		store.run(
			`INSERT INTO watchdog_sweeps(reason, state, requester_pid, run_id, task_id, generation, verified,
			   processes_killed, containers_killed, processes_left, containers_left, detail, requested_at, started_at,
			   finished_at)
			 VALUES (?, 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			own.reason,
			own.requesterPid,
			own.scope?.runId ?? null,
			own.scope?.taskId ?? null,
			own.scope?.generation ?? null,
			...resultColumns(result),
			own.startedAt,
			own.startedAt,
			Date.now(),
		);
		if (!result.verified) freeze(store, own.chatId, own.freezeReason);
	});
}

function logResult(s: Settings, event: string, fields: Record<string, unknown>, result: SweepResult): void {
	const level = result.verified ? "info" : "error";
	s.log[level](event, {
		...fields,
		verified: result.verified,
		processes_killed: result.processesKilled,
		containers_killed: result.containersKilled,
		processes_left: result.processesLeft ?? undefined,
		containers_left: result.containersLeft ?? undefined,
		detail: result.detail ?? undefined,
	});
}

/** Serve every pending request in id order. */
async function serveRequests(s: Settings, state: State, store: Store): Promise<void> {
	const pending = store.all<{ id: number; reason: SweepReason; requester_pid: number | null }>(
		"SELECT id, reason, requester_pid FROM watchdog_sweeps WHERE state = 'pending' ORDER BY id",
	);
	for (const request of pending) {
		if (state.stopped) return;
		store.tx(() =>
			store.run("UPDATE watchdog_sweeps SET started_at = ? WHERE id = ? AND state = 'pending'", Date.now(), request.id),
		);
		const result = await sweep(s.reapers, undefined, () => touch(state));
		answer(s, store, request.id, result);
		logResult(s, "watchdog_sweep", { request: request.id, reason: request.reason }, result);
	}
}

/** True if any Pi process or labelled container is listed (an unlistable kind counts only next to a found one). */
async function anythingLeft(s: Settings, state: State): Promise<boolean> {
	const counts: (number | undefined)[] = [];
	for (const reaper of [...s.reapers.processes, ...s.reapers.containers]) {
		const items = await reaper.list().catch(() => undefined);
		counts.push(items?.length);
	}
	if (counts.some((count) => count === undefined)) noteOnce(s, state, "watchdog_leftovers_unlistable");
	return counts.some((count) => count !== undefined && count > 0);
}

/** No Coordinator runs (its lock is gone or its owner dead): sweep what it left, on the watchdog's own. */
async function reapLeftovers(s: Settings, state: State, store: Store, deadPid: number | undefined): Promise<void> {
	const now = Date.now();
	if (now - state.leftoverCheckAt < LEFTOVER_CHECK_MS) return;
	state.leftoverCheckAt = now;
	if (!(await anythingLeft(s, state))) return;
	// A Coordinator that started meanwhile asks for its own sweep before it runs anything.
	if (lockPresence(s.dataDir).state === "alive") return;
	s.log.warn("watchdog_coordinator_gone", { pid: deadPid });
	const result = await sweep(s.reapers, undefined, () => touch(state));
	const own: OwnRecord = {
		reason: "coordinator_dead",
		requesterPid: deadPid ?? null,
		scope: undefined,
		startedAt: now,
		chatId: s.chatId,
		freezeReason:
			"the watchdog could not verify that the Pi processes and containers of a stopped Coordinator are gone",
	};
	record(store, own, result);
	logResult(s, "watchdog_sweep", { reason: own.reason }, result);
}

/**
 * The group an overdue run belongs to: its task's, which is the Coordinator's group. A watchdog configured with
 * another TELEGRAM_GROUP_CHAT_ID would otherwise freeze a group nobody serves and leave the real one dispatching.
 */
function runGroup(s: Settings, state: State, run: OverdueRun): number {
	const group = run.chat_id ?? s.chatId;
	if (group !== s.chatId && !state.noted.has("watchdog_group_mismatch")) {
		state.noted.add("watchdog_group_mismatch");
		s.log.error("watchdog_group_mismatch", { configured: s.chatId, run_group: group });
	}
	return group;
}

/** One overdue run: kill and verify its Pi process and containers; record the first time, or when it acted. */
async function enforceDeadline(s: Settings, state: State, store: Store, run: OverdueRun): Promise<void> {
	const now = Date.now();
	const key = `${run.id}:${run.generation}`;
	const last = state.deadlineChecks.get(key);
	if (last !== undefined && now - last < DEADLINE_RECHECK_MS) return;
	state.deadlineChecks.set(key, now);
	const recorded = store.get(
		"SELECT 1 AS found FROM watchdog_sweeps WHERE reason = 'deadline' AND run_id = ? AND generation = ?",
		run.id,
		run.generation,
	);
	const scope: Scope = { runId: run.id, taskId: run.task_id, generation: run.generation };
	const result = await sweep(s.reapers, scope, () => touch(state));
	if (recorded !== undefined && result.verified && result.processesKilled + result.containersKilled === 0) return;
	const own: OwnRecord = {
		reason: "deadline",
		requesterPid: null,
		scope,
		startedAt: now,
		chatId: runGroup(s, state, run),
		freezeReason: `the watchdog could not verify that Task ${run.task_id} was stopped at its run deadline`,
	};
	record(store, own, result);
	logResult(s, "watchdog_deadline", { run: run.id, task: run.task_id, generation: run.generation }, result);
}

/** Runs past their deadline plus the grace, by their start (or, still starting, their dispatch). */
async function enforceDeadlines(s: Settings, state: State, store: Store): Promise<void> {
	const due = Date.now() - s.runDeadlineMs - s.deadlineGraceMs;
	const overdue = store.all<OverdueRun>(
		`SELECT r.id, r.task_id, r.generation, t.chat_id FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
		 WHERE r.state IN ('starting', 'running', 'finalizing') AND r.generation IS NOT NULL
		   AND COALESCE(r.started_at, r.dispatched_at) IS NOT NULL AND COALESCE(r.started_at, r.dispatched_at) <= ?
		 ORDER BY r.id`,
		due,
	);
	const keys = new Set(overdue.map((run) => `${run.id}:${run.generation}`));
	for (const key of [...state.deadlineChecks.keys()]) if (!keys.has(key)) state.deadlineChecks.delete(key);
	for (const run of overdue) {
		if (state.stopped) return;
		await enforceDeadline(s, state, store, run);
	}
}

async function pass(s: Settings, state: State): Promise<void> {
	const store = openStore(s, state);
	touch(state);
	if (store === undefined || !claimLead(s, state, store)) return;
	await serveRequests(s, state, store);
	const presence = lockPresence(s.dataDir);
	if (presence.state === "unknown") noteOnce(s, state, "watchdog_coordinator_lock_unreadable");
	// A run's deadline holds whether or not it can be told that a Coordinator runs; with none, everything goes anyway.
	if (presence.state === "alive" || presence.state === "unknown") await enforceDeadlines(s, state, store);
	else await reapLeftovers(s, state, store, presence.pid);
}

function closeStore(state: State): void {
	try {
		state.store?.close();
	} catch {
		// Closed already.
	}
	state.store = undefined;
}

function pause(state: State, ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			state.wake = undefined;
			resolve();
		}
		state.wake = done;
	});
}

function release(state: State, all: boolean): void {
	const due = state.waiters.filter((waiter) => all || waiter.after <= state.completed);
	for (const waiter of due) {
		state.waiters.splice(state.waiters.indexOf(waiter), 1);
		waiter.resolve();
	}
}

async function loop(s: Settings, state: State): Promise<void> {
	while (!state.stopped) {
		state.started++;
		try {
			await pass(s, state);
			state.failing = false;
		} catch (error) {
			// Reopened on the next pass (the database may have been busy or replaced); no heartbeat until a pass works.
			state.failing = true;
			s.log.error("watchdog_pass_failed", { error: errorSummary(error) });
			closeStore(state);
		}
		state.completed++;
		release(state, false);
		if (!state.stopped) await pause(state, s.intervalMs);
	}
}

export function startWatchdog(options: WatchdogOptions): Watchdog {
	const s: Settings = {
		dataDir: options.dataDir,
		chatId: options.chatId,
		reapers: options.reapers,
		log: options.log,
		runDeadlineMs: options.runDeadlineMs ?? DEMO_LIMITS.runDeadlineMs,
		intervalMs: options.intervalMs ?? INTERVAL_MS,
		deadlineGraceMs: options.deadlineGraceMs ?? DEADLINE_GRACE_MS,
	};
	const state: State = {
		store: undefined,
		stopped: false,
		failing: false,
		standby: false,
		progressAt: Date.now(),
		beatAt: 0,
		leftoverCheckAt: 0,
		deadlineChecks: new Map(),
		started: 0,
		completed: 0,
		waiters: [],
		wake: undefined,
		noted: new Set(),
	};
	const beatTimer = setInterval(() => heartbeat(s, state), HEARTBEAT_MS / 4);
	beatTimer.unref();
	s.log.info("watchdog_started", { interval_ms: s.intervalMs, deadline_ms: s.runDeadlineMs });
	const running = loop(s, state);
	let stopping: Promise<void> | undefined;
	return {
		stop(): Promise<void> {
			stopping ??= (async () => {
				state.stopped = true;
				clearInterval(beatTimer);
				state.wake?.();
				await running;
				release(state, true);
				releaseLead(state);
				closeStore(state);
				s.log.info("watchdog_stopped");
			})();
			return stopping;
		},
		nextLoop(): Promise<void> {
			if (state.stopped) return Promise.resolve();
			const done = new Promise<void>((resolve) => state.waiters.push({ after: state.started + 1, resolve }));
			state.wake?.();
			return done;
		},
	};
}
