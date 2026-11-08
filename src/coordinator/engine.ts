/**
 * The execution engine: admission-time dispatch, runs, finalize, the post-run review step, merges, cancels,
 * frozen-group handling and restart recovery (Architecture § Request Flow, § Review and merge, § Frozen group;
 * Interfaces and Storage § Recovery After a Restart; Agent Execution § Finalize and Pending Inputs).
 *
 * The engine reads the Coordinator SQLite store: commands.ts records commands (tasks, follow-ups, cancels,
 * approvals) and kicks the engine, which then acts. Every engine write is one synchronous `store.tx()`; network,
 * git, container and IPC work happens outside transactions. A tick (on kick, every second, and after each piece of
 * work) runs, in order: frozen-group cancels, the recheck of a database an earlier version unfroze, the watchdog's
 * late answer, recovery jobs, cancels, steers, review reminders, the merge worker, the look at tasks held because their
 * branch changed on GitHub (engine/held.ts), the look at a task disk too full for a new worktree (engine/task-disk.ts),
 * and dispatch. Recovery jobs, merges, held reviews and dispatch wait for this Coordinator's verified watchdog sweep
 * and a fresh watchdog heartbeat (engine/watchdog.ts). The owner's unfreeze (unfreeze(), engine/unfreeze.ts) runs the
 * recovery checks while the group is still frozen and turns it normal only if they all pass.
 */

import type { Logger } from "../runtime/log.ts";
import { readBranchHold } from "./branch-hold.ts";
import type { CoordinatorConfig } from "./config.ts";
import { diskSettings, systemDiskProbe } from "./disk.ts";
import { processCancels } from "./engine/cancel.ts";
import {
	type ActiveRun,
	BRANCH_RECHECK_MS,
	type Ctx,
	describeError,
	type EngineOptions,
	enqueueTask,
	freezeGroup,
	slotsInUse,
	type TaskRow,
	tx,
} from "./engine/context.ts";
import { dispatchOnce } from "./engine/dispatch.ts";
import { decide } from "./engine/finalize.ts";
import { retryHeldTasks } from "./engine/held.ts";
import { mergeTask, nextMergeTask } from "./engine/merge.ts";
import { type RecoveryJob, reconcile, runRecoveryJob } from "./engine/recovery.ts";
import {
	limitReason,
	newActiveRun,
	onCapReached,
	onCapRefused,
	runLifecycle,
	sendPendingSteers,
} from "./engine/runs.ts";
import { liftTaskDiskHold, recheckTaskDisk, TASK_DISK_RECHECK_MS } from "./engine/task-disk.ts";
import { UNFREEZE_QUIET_MS, type UnfreezeOutcome, unfreezeGroup } from "./engine/unfreeze.ts";
import { newWatchdogGate, pollWatchdog, watchdogReady } from "./engine/watchdog.ts";
import {
	holdNote,
	INTERRUPTED_KEPT_REASON,
	interruptedNext,
	rejectedApprovalNote,
	reviewReminder,
	taskRef,
} from "./messages.ts";
import type { Availability, RunLauncher, Sandbox } from "./ports.ts";
import { projectTokensSpent } from "./relay.ts";

export type { EngineOptions } from "./engine/context.ts";
export type { UnfreezeOutcome } from "./engine/unfreeze.ts";

export type Engine = {
	/** The relay's base URL (http://127.0.0.1:P/v1); no run is dispatched before it is set. */
	setRelayUrl(url: string): void;
	/**
	 * Relay callback: a run hit a limit or a fatal upstream answer → it is revoked and finalized as failed. Over the
	 * request cap it is revoked at once but decided on the runner's report: if the cap only cut a successor whose input
	 * never reached the model (the run's own input was answered), the run completes; otherwise it fails.
	 */
	onRunLimit(runId: number, reason: string): void;
	/** Relay callback: the run's last allowed model request was admitted → its Pi process takes no more steers. */
	onCapReached(runId: number): void;
	/** Look at the store now (after a command was saved). */
	kick(): void;
	/**
	 * Restart recovery steps 1–3, step 2 with the watchdog's sweep (it waits for the answer, bounded); call before the
	 * relay, the poller and start().
	 */
	recover(): Promise<void>;
	/** Periodic ticks (dispatch every second, reminders every minute). */
	start(): void;
	/** Stop dispatching and abort live runs; recovery marks them interrupted on the next start. */
	stop(): Promise<void>;
	/** Resolves when no engine work is in flight and nothing is dispatchable (tests). */
	idle(): Promise<void>;
	/** Runs currently dispatched (tests and /status diagnostics). */
	activeRuns(): readonly number[];
	/**
	 * The owner's unfreeze (owner socket): while the group stays frozen, repeat the recovery checks; set it normal and
	 * reopen dispatch only if every one passes (engine/unfreeze.ts). Call after start().
	 */
	unfreeze(): Promise<UnfreezeOutcome>;
};

const TICK_MS = 1000;
const REMINDER_EVERY_MS = 60_000;
const ENFORCEMENT_RECHECK_MS = 30_000;
const STOP_WAIT_MS = 5000;

type Flag = "recheckRunning" | "merging" | "recoveryRunning" | "enforcementChecking";

/** In-memory engine state (everything durable lives in the Store). */
type EngineState = {
	readonly inflight: Set<Promise<void>>;
	ticking: Promise<boolean> | undefined;
	tickAgain: boolean;
	interval: NodeJS.Timeout | undefined;
	lastReminder: number;
	frozenSeen: boolean;
	recheckRunning: boolean;
	merging: boolean;
	recoveryRunning: boolean;
	enforcementChecking: boolean;
	budgetNoticed: boolean;
	/** Review/archive redo jobs from recovery; dispatch and merges wait until they are done. */
	readonly recoveryJobs: RecoveryJob[];
};

type GroupState = ReturnType<Ctx["store"]["groupState"]>;

function newState(): EngineState {
	return {
		inflight: new Set(),
		ticking: undefined,
		tickAgain: false,
		interval: undefined,
		lastReminder: 0,
		frozenSeen: false,
		recheckRunning: false,
		merging: false,
		recoveryRunning: false,
		enforcementChecking: false,
		budgetNoticed: false,
		recoveryJobs: [],
	};
}

/** An escaped error is unexpected: fail closed (freeze the group), unless the engine is stopping. */
function workFailed(ctx: Ctx, kind: string, taskId: number | undefined, error: unknown): void {
	if (ctx.stopped) return;
	ctx.log.error("engine_work_failed", { kind, task: taskId, error: describeError(error) });
	const where = taskId === undefined ? "" : ` of ${taskRef(taskId)}`;
	freezeGroup(ctx, `internal error in ${kind}${where}`);
}

/** Run background work, tracked for idle(); the task is busy meanwhile. */
function track(
	ctx: Ctx,
	state: EngineState,
	kind: string,
	taskId: number | undefined,
	work: () => Promise<void>,
): void {
	if (taskId !== undefined) ctx.busy.set(taskId, kind);
	const release = (): void => {
		if (taskId !== undefined && ctx.busy.get(taskId) === kind) ctx.busy.delete(taskId);
	};
	// Started synchronously: work runs until its first await inside this tick (a merge reserves its slot before
	// dispatch looks at the slots).
	let started: Promise<void>;
	try {
		started = work();
	} catch (error) {
		started = Promise.reject(error);
	}
	const promise = started.catch((error: unknown) => workFailed(ctx, kind, taskId, error)).finally(release);
	state.inflight.add(promise);
	void promise.finally(() => {
		state.inflight.delete(promise);
		ctx.kick();
	});
}

/** Tracked work guarded by a flag: at most one of each kind at a time. */
function flagged(
	ctx: Ctx,
	state: EngineState,
	flag: Flag,
	taskId: number | undefined,
	work: () => Promise<void>,
): true {
	state[flag] = true;
	track(ctx, state, flag, taskId, async () => {
		try {
			await work();
		} finally {
			state[flag] = false;
		}
	});
	return true;
}

/** Architecture § Frozen group: nothing dispatched or merged; every running task is cancelled "group frozen". */
function cancelFrozenRuns(ctx: Ctx, state: EngineState, group: GroupState): boolean {
	if (group.state !== "frozen") {
		state.frozenSeen = false;
		return false;
	}
	if (!state.frozenSeen) ctx.log.warn("group_frozen_seen", { chat: ctx.chatId });
	state.frozenSeen = true;
	const undecided = [...ctx.active.values()].filter((active) => active.decision === undefined);
	for (const active of undecided)
		decide(ctx, active, { kind: "cancelled", reason: "group frozen", cause: "cancelled" });
	return undecided.length > 0;
}

/**
 * A database an earlier version's owner CLI unfroze directly (state normal, recheck_required=1): repeat recovery steps
 * 1–4 once nothing is in flight, then reopen dispatch. The owner socket's unfreeze checks before the group turns normal
 * (ownerUnfreeze below) and never sets the flag.
 */
function maybeRecheck(ctx: Ctx, state: EngineState, group: GroupState): boolean {
	if (group.state !== "normal" || !group.recheck) return false;
	if (state.recheckRunning || state.recoveryRunning || state.merging || ctx.active.size > 0) return false;
	return flagged(ctx, state, "recheckRunning", undefined, () => recheck(ctx, state));
}

async function recheck(ctx: Ctx, state: EngineState): Promise<void> {
	const jobs = await reconcile(ctx, "recheck");
	addRecoveryJobs(ctx, state, jobs);
	tx(ctx, () => {
		ctx.store.run(
			"UPDATE groups SET recheck_required = 0, updated_at = ? WHERE chat_id = ? AND state = 'normal'",
			ctx.now(),
			ctx.chatId,
		);
	});
	ctx.log.info("recheck_done", { chat: ctx.chatId, jobs: jobs.length });
}

/** Nothing of the engine in flight that the unfreeze checks could race: runs, merges, recovery jobs, cancels. */
function quiet(ctx: Ctx, state: EngineState): boolean {
	if (ctx.active.size > 0 || state.merging || state.recoveryRunning) return false;
	return ctx.busy.size === 0 && ctx.reconciling.size === 0;
}

/**
 * The owner's unfreeze, one at a time; tracked (idle() waits for it). recheckRunning keeps recovery jobs, merges and
 * dispatch closed meanwhile; the group stays frozen until every check passed (engine/unfreeze.ts).
 */
function ownerUnfreeze(ctx: Ctx, state: EngineState, quietMs: number): Promise<UnfreezeOutcome> {
	const group = ctx.store.groupState(ctx.chatId);
	if (group.state !== "frozen") return Promise.resolve({ kind: "not_frozen", state: group.state });
	if (state.recheckRunning) return Promise.resolve({ kind: "in_progress" });
	state.recheckRunning = true;
	const outcome = unfreezeGroup(ctx, {
		quiet: () => quiet(ctx, state),
		addJobs: (jobs) => addRecoveryJobs(ctx, state, jobs),
		quietMs,
	}).finally(() => {
		state.recheckRunning = false;
	});
	track(ctx, state, "unfreeze", undefined, () => outcome.then(() => undefined));
	return outcome;
}

function addRecoveryJobs(ctx: Ctx, state: EngineState, jobs: readonly RecoveryJob[]): void {
	for (const job of jobs) {
		const duplicate = state.recoveryJobs.some(
			(existing) => existing.kind === job.kind && existing.taskId === job.taskId,
		);
		if (!duplicate) state.recoveryJobs.push(job);
	}
	ctx.recoveryPending = state.recoveryJobs.length;
}

function maybeRecoveryJobs(ctx: Ctx, state: EngineState, group: GroupState): boolean {
	if (state.recoveryJobs.length === 0 || state.recoveryRunning || state.recheckRunning) return false;
	// Their checks run in containers: like merges and dispatch, they wait for the watchdog (verified, heartbeat fresh).
	if (group.state === "frozen" || group.recheck || !watchdogReady(ctx)) return false;
	return flagged(ctx, state, "recoveryRunning", undefined, () => runRecoveryJobs(ctx, state));
}

/** Run one job; false (and the group frozen) if it could not complete. */
async function runOneRecoveryJob(ctx: Ctx, job: RecoveryJob): Promise<boolean> {
	ctx.busy.set(job.taskId, "recovery");
	try {
		await runRecoveryJob(ctx, job);
		return true;
	} catch (error) {
		ctx.log.error("recovery_job_failed", { kind: job.kind, task: job.taskId, error: describeError(error) });
		const unknown = error instanceof Error && error.name === "UnknownEffect";
		freezeGroup(ctx, unknown ? error.message : `recovery of ${taskRef(job.taskId)} (${job.kind}) failed`);
		return false;
	} finally {
		ctx.busy.delete(job.taskId);
	}
}

async function runRecoveryJobs(ctx: Ctx, state: EngineState): Promise<void> {
	while (state.recoveryJobs.length > 0 && !ctx.stopped) {
		if (ctx.store.groupState(ctx.chatId).state === "frozen") return;
		if (!(await runOneRecoveryJob(ctx, state.recoveryJobs[0] as RecoveryJob))) return;
		state.recoveryJobs.shift();
		ctx.recoveryPending = state.recoveryJobs.length;
	}
}

export type Enforcement =
	| { readonly ok: true }
	/** `containers`: the sandbox (Docker, images); `isolation`: the Pi process isolation (systemd slice and user). */
	| { readonly ok: false; readonly reason: string; readonly kind: "containers" | "isolation" };

/**
 * Execution enforcement (Architecture § Fails closed): the sandbox's containers, then the launcher's Pi process
 * isolation. A failing check counts as unavailable. Logged here, metadata only.
 */
export async function enforcementAvailable(sandbox: Sandbox, launcher: RunLauncher, log: Logger): Promise<Enforcement> {
	const box = await sandbox.available().catch((): Availability => ({ ok: false, reason: "sandbox check failed" }));
	if (!box.ok) {
		log.error("sandbox_unavailable", { reason: box.reason });
		return { ok: false, reason: box.reason, kind: "containers" };
	}
	const isolation = await launcher
		.available()
		.catch((): Availability => ({ ok: false, reason: "the Pi process isolation check failed" }));
	if (!isolation.ok) {
		log.error("runner_isolation_unavailable", { isolation: launcher.isolation, reason: isolation.reason });
		return { ok: false, reason: isolation.reason, kind: "isolation" };
	}
	return { ok: true };
}

/** Fail closed: no execution starts while enforcement is unavailable (re-checked every 30 s). */
function checkEnforcement(ctx: Ctx, state: EngineState): void {
	const current = ctx.enforcement;
	if (state.enforcementChecking || current?.ok === true) return;
	if (current !== undefined && ctx.now() - current.checkedAt < ENFORCEMENT_RECHECK_MS) return;
	flagged(ctx, state, "enforcementChecking", undefined, async () => {
		const result = await enforcementAvailable(ctx.sandbox, ctx.launcher, ctx.log);
		const reason = result.ok ? undefined : result.reason;
		ctx.enforcement = { ok: result.ok, reason, checkedAt: ctx.now() };
		if (result.ok && current !== undefined) ctx.log.info("sandbox_available");
	});
}

/** Dispatch and merges are open: group normal, no recheck or recovery job pending, the relay running. */
function dispatchOpen(ctx: Ctx, state: EngineState): boolean {
	const group = ctx.store.groupState(ctx.chatId);
	// STUB(spec: architecture.md § Sealing; capacity.md § Exclusive phases): sealing and the isolated evaluator are
	// not built; a group in state 'sealing' only holds dispatch and merges here, nothing seals it.
	if (group.state !== "normal" || group.recheck || state.recheckRunning) return false;
	// Agent Execution § Uncertain Effects: "Dispatch stays blocked until reconciliation finishes".
	return ctx.recoveryPending === 0 && ctx.reconciling.size === 0 && ctx.relayUrl !== undefined;
}

/** One merge at a time, and only with a free execution slot for its tests. */
function maybeMerge(ctx: Ctx, state: EngineState): boolean {
	if (state.merging || slotsInUse(ctx) >= ctx.limits.maxConcurrentRuns) return false;
	const taskId = nextMergeTask(ctx);
	if (taskId === undefined || ctx.busy.has(taskId)) return false;
	return flagged(ctx, state, "merging", taskId, () => mergeTask(ctx, taskId));
}

function dispatchAll(ctx: Ctx, state: EngineState): boolean {
	if (ctx.enforcement?.ok !== true) return false;
	let did = false;
	for (let reservation = dispatchOnce(ctx); reservation !== undefined; reservation = dispatchOnce(ctx)) {
		const active = newActiveRun(ctx, reservation);
		ctx.active.set(reservation.runId, active);
		did = true;
		ctx.log.info("run_dispatched", { run: reservation.runId, task: reservation.taskId, agent: reservation.agentId });
		track(ctx, state, "run", reservation.taskId, () => runLifecycle(ctx, active));
	}
	budgetNotice(ctx, state);
	return did;
}

/** Tell the group once when queued work waits because the project token ceiling is used up. */
function budgetNotice(ctx: Ctx, state: EngineState): void {
	if (state.budgetNoticed) return;
	const queued = ctx.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE state = 'queued'")?.n ?? 0;
	if (queued === 0 || projectTokensSpent(ctx.store) < ctx.config.model.projectTokenCeiling) return;
	state.budgetNoticed = true;
	tx(ctx, () =>
		ctx.store.enqueue({
			chatId: ctx.chatId,
			priority: "required",
			kind: "budget_exhausted",
			text: "Queued tasks are waiting: the project token budget is used up. The owner can raise the ceiling.",
		}),
	);
}

/** Architecture § Review and merge: a task in review past the configured time gets one reminder. */
function reminders(ctx: Ctx, state: EngineState): void {
	const now = ctx.now();
	if (state.lastReminder !== 0 && now - state.lastReminder < REMINDER_EVERY_MS) return;
	state.lastReminder = now;
	const due = ctx.store.all<TaskRow>(
		`SELECT * FROM tasks WHERE chat_id = ? AND state = 'review' AND review_reminded = 0
		   AND review_since IS NOT NULL AND review_since <= ?`,
		ctx.chatId,
		now - ctx.limits.reviewReminderMs,
	);
	for (const task of due) remind(ctx, task);
}

function remind(ctx: Ctx, task: TaskRow): void {
	tx(ctx, () => {
		const changes = ctx.store.run(
			"UPDATE tasks SET review_reminded = 1 WHERE id = ? AND review_reminded = 0 AND state = 'review'",
			task.id,
		).changes;
		if (changes === 0) return;
		const hold = readBranchHold(ctx.store, task.id);
		const rejectedNote =
			hold !== undefined
				? holdNote({ ...hold, taskId: task.id })
				: task.reason === INTERRUPTED_KEPT_REASON
					? interruptedNext(task.id)
					: rejectedApprovalNote(ctx.store.latestApproval(task.id), task.posted_head);
		enqueueTask(ctx, task, "review_reminder", reviewReminder({ taskId: task.id, prUrl: task.pr_url, rejectedNote }));
	});
}

/** One pass; returns true if it started any work. Synchronous: work runs in tracked promises. */
function tickOnce(ctx: Ctx, state: EngineState): boolean {
	if (ctx.stopped) return false;
	checkEnforcement(ctx, state);
	const group = ctx.store.groupState(ctx.chatId);
	const did = [
		cancelFrozenRuns(ctx, state, group),
		maybeRecheck(ctx, state, group),
		pollWatchdog(ctx),
		maybeRecoveryJobs(ctx, state, group),
		processCancels(ctx),
	];
	sendPendingSteers(ctx);
	reminders(ctx, state);
	// Merges first: a merge waiting for a check slot gets the next free one before new runs. Both need the watchdog;
	// so does a held task's review step (its tests), while a held archive only pushes. A task disk too full for a new
	// worktree is measured again (no slot, no container) before dispatch looks at the queue.
	if (dispatchOpen(ctx, state)) {
		const ready = watchdogReady(ctx);
		if (ready) did.push(maybeMerge(ctx, state));
		did.push(retryHeldTasks(ctx, ready));
		did.push(recheckTaskDisk(ctx));
		if (ready) did.push(dispatchAll(ctx, state));
	}
	return did.some(Boolean);
}

/** Serialized ticks; a kick during a tick runs one more pass. */
function tick(ctx: Ctx, state: EngineState): Promise<boolean> {
	if (state.ticking !== undefined) {
		state.tickAgain = true;
		return state.ticking;
	}
	state.ticking = (async () => {
		let did = false;
		do {
			state.tickAgain = false;
			if (tickOnce(ctx, state)) did = true;
		} while (state.tickAgain && !ctx.stopped);
		return did;
	})().finally(() => {
		state.ticking = undefined;
	});
	return state.ticking;
}

function waitAtMost(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** Abort a live run's process and stop its container; no database change (recovery marks it interrupted). */
function abandonRun(ctx: Ctx, active: ActiveRun): Promise<unknown>[] {
	if (active.deadline !== undefined) clearTimeout(active.deadline);
	if (active.capTimer !== undefined) clearTimeout(active.capTimer);
	if (active.decision === undefined) {
		active.decision = { kind: "cancelled", reason: "coordinator stopping", cause: "interrupted" };
		active.resolveDecision(active.decision);
	}
	const work: Promise<unknown>[] = [];
	const handle = active.handle;
	if (handle !== undefined) {
		const quiet = (fn: () => void) => {
			try {
				fn();
			} catch {
				// Gone already.
			}
		};
		quiet(() => handle.send({ type: "abort", reason: "coordinator stopping" }));
		work.push(Promise.race([handle.exited, waitAtMost(ctx.limits.stopGraceMs)]).then(() => quiet(() => handle.kill())));
	}
	if (active.agentBox !== undefined) work.push(active.agentBox.stop().catch(() => undefined));
	return work;
}

async function stopEngine(ctx: Ctx, state: EngineState): Promise<void> {
	if (ctx.stopped) return;
	ctx.stopped = true;
	if (state.interval !== undefined) clearInterval(state.interval);
	state.interval = undefined;
	await Promise.allSettled([...ctx.active.values()].flatMap((active) => abandonRun(ctx, active)));
	if (state.inflight.size > 0) await Promise.race([Promise.allSettled([...state.inflight]), waitAtMost(STOP_WAIT_MS)]);
}

async function idle(ctx: Ctx, state: EngineState): Promise<void> {
	for (;;) {
		if (state.ticking !== undefined) await state.ticking;
		if (state.inflight.size > 0) {
			await Promise.allSettled([...state.inflight]);
			continue;
		}
		const did = await tick(ctx, state);
		if (!did && state.inflight.size === 0 && state.ticking === undefined) return;
	}
}

export function createEngine(options: EngineOptions): Engine {
	const state = newState();
	const ctx: Ctx = {
		store: options.store,
		config: options.config,
		limits: options.limits,
		git: options.git,
		github: options.github,
		sandbox: options.sandbox,
		launcher: options.launcher,
		log: options.log,
		now: options.now ?? options.store.now,
		chatId: options.config.telegram.groupChatId,
		retryDelayMs: options.retryDelayMs ?? 1000,
		branchRecheckMs: options.branchRecheckMs ?? BRANCH_RECHECK_MS,
		heldDue: new Map<number, number>(),
		heldRestored: new Set<number>(),
		diskProbe: options.diskProbe ?? systemDiskProbe,
		disk: diskSettings(options.config, options.limits),
		diskRecheckMs: options.diskRecheckMs ?? TASK_DISK_RECHECK_MS,
		taskDiskHold: undefined,
		taskDiskChecking: false,
		creatingWorktrees: new Set<number>(),
		onOutbox: options.onOutbox ?? (() => {}),
		watchdog: options.watchdog,
		watchdogGate: newWatchdogGate(),
		stopped: false,
		relayUrl: undefined,
		active: new Map<number, ActiveRun>(),
		busy: new Map<number, string>(),
		enforcement: undefined,
		recoveryPending: 0,
		reconciling: new Set<number>(),
		freezes: 0,
		lastFreezeReason: undefined,
		track: (kind, taskId, work) => track(ctx, state, kind, taskId, work),
		kick,
	};

	function kick(): void {
		if (ctx.stopped) return;
		void tick(ctx, state).catch((error: unknown) =>
			ctx.log.error("engine_tick_failed", { error: describeError(error) }),
		);
	}

	return {
		setRelayUrl(url: string): void {
			ctx.relayUrl = url;
			kick();
		},
		onRunLimit(runId: number, reason: string): void {
			const active = ctx.active.get(runId);
			if (active === undefined || active.decision !== undefined) return;
			if (reason === "request_cap") onCapRefused(ctx, active);
			else decide(ctx, active, { kind: "failed", reason: limitReason(reason, ctx.limits), cause: "limit" });
		},
		onCapReached(runId: number): void {
			const active = ctx.active.get(runId);
			if (active !== undefined) onCapReached(ctx, active);
		},
		kick,
		async recover(): Promise<void> {
			// A hold on new worktrees lives in memory: a note left by the previous process no longer applies.
			liftTaskDiskHold(ctx, "start");
			addRecoveryJobs(ctx, state, await reconcile(ctx, "coordinator_start"));
		},
		start(): void {
			if (state.interval !== undefined || ctx.stopped) return;
			state.interval = setInterval(kick, TICK_MS);
			kick();
		},
		stop: () => stopEngine(ctx, state),
		idle: () => idle(ctx, state),
		activeRuns: () => [...ctx.active.keys()],
		unfreeze: () => ownerUnfreeze(ctx, state, options.unfreezeQuietMs ?? UNFREEZE_QUIET_MS),
	};
}

/** Exported for the Coordinator wiring and tests. */
export type { CoordinatorConfig };
