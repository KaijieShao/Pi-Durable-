/**
 * Shared state and helpers of the execution engine (src/coordinator/engine.ts). Every SQLite write goes through
 * `store.tx()` (synchronous callback, no awaits inside); every user-facing message is enqueued in the same
 * transaction as the state change it reports.
 */
import { join } from "node:path";
import type { FromRunner } from "../../runner/protocol.ts";
import type { Logger } from "../../runtime/log.ts";
import type { BranchHoldCause } from "../branch-hold.ts";
import type { CoordinatorConfig } from "../config.ts";
import type { DiskProbe, DiskSettings, ExecutionDiskPressure } from "../disk.ts";
import { deploymentHeld } from "../evaluation.ts";
import type { Git } from "../git.ts";
import type { Limits } from "../limits.ts";
import { taskRef } from "../messages.ts";
import {
	type AgentSandbox,
	type Evaluator,
	type GitHubApi,
	GitHubError,
	type RunLauncher,
	type RunnerHandle,
	type Sandbox,
	type WatchdogLink,
} from "../ports.ts";
import type { OutboxMessage, Store } from "../store.ts";
import type { WatchdogTimings } from "../watchdog-link.ts";
import type { TaskDiskHold } from "./task-disk.ts";

export type TaskState = "queued" | "running" | "review" | "merging" | "merged" | "failed" | "cancelled";
export type RunState = "queued" | "starting" | "running" | "finalizing" | "finished" | "failed" | "cancelled";

export type TaskRow = {
	id: number;
	chat_id: number;
	creator_id: number;
	agent_id: string;
	text: string;
	update_id: number;
	state: TaskState;
	reason: string | null;
	generation: number;
	branch: string | null;
	worktree_path: string | null;
	archived: number;
	base_commit: string | null;
	head_commit: string | null;
	posted_head: string | null;
	tests_passed_head: string | null;
	pr_number: number | null;
	pr_url: string | null;
	followup_count: number;
	cancel_requested: number;
	cancel_requested_by: number | null;
	review_since: number | null;
	review_reminded: number;
	created_at: number;
	updated_at: number;
};

export type RunRow = {
	id: number;
	task_id: number;
	kind: "initial" | "followup" | "conflict";
	state: RunState;
	reason: string | null;
	requested_by: number;
	request_id: string;
	input_text: string;
	followup_id: number | null;
	conversation_id: string | null;
	generation: number | null;
	model_requests: number;
	pid: number | null;
	container: string | null;
	answer: string | null;
	checkpoint_commit: string | null;
	review_done: number;
	queued_at: number;
	started_at: number | null;
	ended_at: number | null;
};

export type FollowupRow = {
	id: number;
	task_id: number;
	update_id: number;
	user_id: number;
	message_id: number;
	text: string;
	mode: "steer" | "run";
	run_id: number | null;
	state: "pending" | "submitted" | "delivered" | "started" | "expired";
	reason: string | null;
	created_at: number;
	settled_at: number | null;
};

export type ConversationRow = {
	id: string;
	task_id: number;
	parent_id: string | null;
	path: string;
	quarantined: number;
	reusable: number;
	created_at: number;
};

export type FinishedMessage = Extract<FromRunner, { type: "finished" }>;

/** How a run ends. The first decision wins; an abnormal one revokes the run before anything else happens. */
export type Decision =
	| {
			readonly kind: "normal";
			readonly finished: FinishedMessage;
			/**
			 * The next run of the task may reuse the conversation (once stop and cleanup are verified). False when the
			 * request cap cut off a successor run Pi had started (Pi was aborted): the conversation holds unanswered input.
			 */
			readonly reusable: boolean;
	  }
	| {
			readonly kind: "cancelled" | "failed";
			/** Shown to the user ("Task 12 failed: <reason>"). */
			readonly reason: string;
			/** followupExpired() cause: "cancelled" | "limit" | free text. */
			readonly cause: string;
	  };

/** In-memory state of a dispatched run, from slot reservation until its slot is released. */
export type ActiveRun = {
	readonly runId: number;
	readonly taskId: number;
	readonly chatId: number;
	readonly agentId: string;
	readonly generation: number;
	readonly runNo: number;
	readonly slotId: number;
	worktree: string | undefined;
	branch: string | undefined;
	handle: RunnerHandle | undefined;
	agentBox: AgentSandbox | undefined;
	decision: Decision | undefined;
	readonly decided: Promise<Decision>;
	resolveDecision: (decision: Decision) => void;
	/** In-flight tool executions; finalize waits for them to settle. */
	readonly tools: Set<Promise<void>>;
	/**
	 * The run's file changes run one at a time (engine/tools.ts): each inspects its target, saves its intent, executes
	 * and settles before the next starts, so a pre-hash is never stale and nothing competes with a change being
	 * reconciled. The tail of that chain.
	 */
	effects: Promise<void>;
	/**
	 * Set once finalize has confirmed termination and reconciles the run's pending intents: no new intent is saved and
	 * no late answer settles one any more (engine/intents.ts owns them from here).
	 */
	effectsClosed: boolean;
	/** Follow-up ids already sent to the Pi process as steers. */
	readonly sentSteers: Set<number>;
	deadline: NodeJS.Timeout | undefined;
	exited: boolean;
	finished: FinishedMessage | undefined;
	/** The relay admitted the run's last allowed model request: no steer can reach the model any more. */
	capReached: boolean;
	/**
	 * The relay refused a request over the cap. The run is revoked (key closed, Pi aborted) and decided once the runner
	 * reports what the cap cut (`finished`), or as a limit failure when `capTimer` fires first.
	 */
	capRefused: boolean;
	capTimer: NodeJS.Timeout | undefined;
};

export type EngineOptions = {
	readonly store: Store;
	readonly config: CoordinatorConfig;
	readonly limits: Limits;
	readonly git: Git;
	readonly github: GitHubApi;
	readonly sandbox: Sandbox;
	readonly launcher: RunLauncher;
	readonly log: Logger;
	readonly now?: () => number;
	/** Called after a transaction that enqueued Telegram messages (the Coordinator kicks its outbox). */
	readonly onOutbox?: () => void;
	/** Base delay between attempts of a GitHub change or a push (doubles per attempt). Tests shorten it. */
	readonly retryDelayMs?: number;
	/**
	 * How often a task held because its branch changed on GitHub outside the Coordinator is looked at again
	 * (engine/held.ts; default BRANCH_RECHECK_MS). Tests shorten it.
	 */
	readonly branchRecheckMs?: number;
	/** How the task disk is measured (src/coordinator/disk.ts); default the system's (statfs, a directory walk). */
	readonly diskProbe?: DiskProbe;
	/**
	 * How often a task disk too full for a new worktree is measured again (engine/task-disk.ts; default
	 * TASK_DISK_RECHECK_MS). Tests shorten it.
	 */
	readonly diskRecheckMs?: number;
	/** The watchdog: its link (the Coordinator's SQLite in production) and how long to wait for it. */
	readonly watchdog: WatchdogOptions;
	/**
	 * How long the owner's unfreeze waits for the group's stopped runs and other work in flight to finish before it
	 * refuses (engine/unfreeze.ts; default UNFREEZE_QUIET_MS). Tests shorten it.
	 */
	readonly unfreezeQuietMs?: number;
	/**
	 * The isolated evaluator (engine/seal.ts): the Docker evaluator in production (coordinator.ts), a local test
	 * evaluator in tests. Without one, sealing is refused.
	 */
	readonly evaluator?: Evaluator;
};

/** In-memory state of the seal machine (engine/seal.ts); everything durable is in the evaluations table. */
export type SealRuntime = {
	/** A phase of the evaluation in progress is running (tracked work). */
	working: boolean;
	/** Stops the evaluator container of this process, while it runs. */
	abort: AbortController | undefined;
	/** A failed step (fetching main) is tried again after this time. */
	retryAt: number;
	/**
	 * The evaluation whose execution this process verified stopped (the sealing phase's stop step). An evaluation found
	 * in its snapshot phase without it (a restart: recovery's jobs may have run checks since) is verified again first.
	 */
	verified: number | undefined;
};

export type WatchdogOptions = { readonly link: WatchdogLink } & WatchdogTimings;

/** This Coordinator's standing with the watchdog (src/coordinator/engine/watchdog.ts). */
export type WatchdogGate = {
	/** A sweep this Coordinator asked for was verified (since the last request). */
	verified: boolean;
	/** The request not answered yet, if any. */
	pending: number | undefined;
	/** Recovery stopped waiting for `pending`: the watchdog is unavailable until it answers. */
	gaveUp: boolean;
	/** The heartbeat was last seen too old. */
	stale: boolean;
};

export type Ctx = {
	readonly store: Store;
	readonly config: CoordinatorConfig;
	readonly limits: Limits;
	readonly git: Git;
	readonly github: GitHubApi;
	readonly sandbox: Sandbox;
	readonly launcher: RunLauncher;
	readonly log: Logger;
	readonly now: () => number;
	readonly chatId: number;
	readonly retryDelayMs: number;
	/** See EngineOptions.branchRecheckMs. */
	readonly branchRecheckMs: number;
	/** Held tasks (branch-hold.ts): task id → when its branch is looked at again (engine/held.ts). */
	readonly heldDue: Map<number, number>;
	/** Held reviews whose branch was seen restored: their review step waits for a check slot (engine/held.ts). */
	readonly heldRestored: Set<number>;
	readonly diskProbe: DiskProbe;
	/** The effective disk limits (configuration, else DEMO_LIMITS). */
	readonly disk: DiskSettings;
	/** See EngineOptions.diskRecheckMs. */
	readonly diskRecheckMs: number;
	/** New worktrees do not fit on the task disk: runs that need one stay queued (engine/task-disk.ts). */
	taskDiskHold: TaskDiskHold | undefined;
	/** A measurement of the held task disk is in flight. */
	taskDiskChecking: boolean;
	/** The boot/task safety floor holds all execution, even when its worktree already exists. */
	executionDiskHold: ExecutionDiskPressure | undefined;
	/** Runs whose new worktree passed the task disk check and is being created (with its setup), by run id. */
	readonly creatingWorktrees: Set<number>;
	readonly onOutbox: () => void;
	readonly watchdog: WatchdogOptions;
	readonly watchdogGate: WatchdogGate;
	stopped: boolean;
	relayUrl: string | undefined;
	/** Dispatched runs by run id. */
	readonly active: Map<number, ActiveRun>;
	/** Tasks with engine work in flight (run, review, archive, merge, cancel), by task id → what. */
	readonly busy: Map<number, string>;
	/** Sandbox enforcement as last checked. */
	enforcement: { ok: boolean; reason: string | undefined; checkedAt: number } | undefined;
	/** Recovery jobs (review / archive redo) not yet completed; dispatch and merges wait for them. */
	recoveryPending: number;
	/**
	 * Runs with a file change whose outcome is unknown, until finalize has reconciled it (Agent Execution § Uncertain
	 * Effects: "Dispatch stays blocked until reconciliation finishes"). Dispatch and merges wait while any is here.
	 */
	readonly reconciling: Set<number>;
	/**
	 * Freezes this engine asked for (freezeGroup), counted even when the group was frozen already (the first reason is
	 * kept): the owner's unfreeze refuses if one came while its checks ran (engine/unfreeze.ts).
	 */
	freezes: number;
	lastFreezeReason: string | undefined;
	/** The isolated evaluator (EngineOptions.evaluator). */
	readonly evaluator: Evaluator;
	readonly seal: SealRuntime;
	/** Run queued work in the background, tracked for idle(); marks `taskId` busy while it runs. */
	track(kind: string, taskId: number | undefined, work: () => Promise<void>): void;
	kick(): void;
};

/** Thrown when an effect (GitHub change, push, stop) cannot be confirmed: the group freezes. */
export class UnknownEffect extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnknownEffect";
	}
}

/**
 * GitHub refused a push because the task branch changed outside the Coordinator: it is at `github`, which is neither
 * the commit being pushed nor what the Coordinator believes it pushed last. A definite outcome (nothing was pushed),
 * so it holds only this task (branch-hold.ts) instead of freezing the group. Also thrown when the branch moved right
 * after a confirmed push (the review step looks again after updating the pull request).
 */
export class BranchMoved extends Error {
	readonly branch: string;
	/** GitHub's branch head (full sha). */
	readonly github: string | null;
	/** The commit the Coordinator was pushing or had just pushed (full sha). */
	readonly local: string;
	override readonly cause: BranchHoldCause;
	constructor(branch: string, github: string | null, local: string, cause: BranchHoldCause = "branch_moved") {
		super(`branch ${branch} changed on GitHub outside the Coordinator`);
		this.name = "BranchMoved";
		this.branch = branch;
		this.github = github;
		this.local = local;
		this.cause = cause;
	}
}

/** Production interval of the held-task check (EngineOptions.branchRecheckMs). */
export const BRANCH_RECHECK_MS = 30_000;

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(["merged", "failed", "cancelled"]);

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadTask(ctx: Ctx, taskId: number): TaskRow {
	const task = ctx.store.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
	if (task === undefined) throw new Error(`task ${taskId} not found`);
	return task;
}

export function loadRun(ctx: Ctx, runId: number): RunRow {
	const run = ctx.store.get<RunRow>("SELECT * FROM runs WHERE id = ?", runId);
	if (run === undefined) throw new Error(`run ${runId} not found`);
	return run;
}

/** 1-based number of a run within its task ("run 2"). */
export function runNumber(ctx: Ctx, run: { id: number; task_id: number }): number {
	return (
		ctx.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND id <= ?", run.task_id, run.id)
			?.n ?? 1
	);
}

/** The Telegram message id of the task's /task command (task messages reply to it). */
export function taskReplyTo(ctx: Ctx, task: { update_id: number }): number | undefined {
	return (
		ctx.store.get<{ message_id: number | null }>("SELECT message_id FROM commands WHERE update_id = ?", task.update_id)
			?.message_id ?? undefined
	);
}

/** Enqueue a message about a task, replying to its /task message. Call inside `store.tx()`. */
export function enqueueTask(
	ctx: Ctx,
	task: { id: number; chat_id: number; update_id: number },
	kind: string,
	text: string,
	priority: OutboxMessage["priority"] = "required",
): void {
	ctx.store.enqueue({ chatId: task.chat_id, taskId: task.id, priority, kind, text, replyTo: taskReplyTo(ctx, task) });
}

/** Run a write transaction and kick the outbox afterwards. */
export function tx<T>(ctx: Ctx, fn: () => T): T {
	const result = ctx.store.tx(fn);
	ctx.onOutbox();
	return result;
}

export function worktreePath(ctx: Ctx, taskId: number): string {
	return join(ctx.config.paths.taskDir, "worktrees", `task-${taskId}`);
}

export function branchName(ctx: Ctx, taskId: number): string {
	return `${ctx.config.git.branchPrefix}${taskId}`;
}

/**
 * Meta key of a task's setup step (runs.ts writes it, restart recovery reads it): "started" before the setup script
 * runs, "done" once it passed (or there is none). Absent: not reached, or written before this key existed (unknown).
 * Deleted when the run starts its Pi process.
 */
export function setupStateKey(taskId: number): string {
	return `setup:${taskId}`;
}

/** Meta key: how many times a restart before the run started returned it to the queue. Deleted when it starts. */
export function restartReturnsKey(runId: number): string {
	return `restart_returns:${runId}`;
}

export const INTERRUPTED_PREFIX = "restart_interrupted:";

/**
 * Meta key of a task whose run was interrupted by a restart (value: that run's id) until its effects are reconciled
 * and its users are told what its worktree keeps (recovery.ts). While it is set nothing archives, cancels or reviews
 * the worktree; another restart finds it again.
 */
export function interruptedKey(taskId: number): string {
	return `${INTERRUPTED_PREFIX}${taskId}`;
}

export const WORKTREE_CHECK_PREFIX = "restart_worktree:";

/**
 * Meta key of a first run's worktree reconciliation still to do after a restart ("check": keep a pristine one or
 * start over; "discard": the task failed). Deleted once done, so another restart finds it again.
 */
export function worktreeCheckKey(taskId: number): string {
	return `${WORKTREE_CHECK_PREFIX}${taskId}`;
}

export function conversationPath(ctx: Ctx, id: string): string {
	return join(ctx.config.paths.dataDir, "conversations", `${id}.sqlite`);
}

/**
 * Freeze the group (Architecture § Frozen group; Fails closed). Posts the notice once; the next tick cancels the
 * group's running tasks with "group frozen". Never throws.
 */
export function freezeGroup(ctx: Ctx, reason: string): void {
	if (ctx.stopped) return;
	try {
		tx(ctx, () => freezeInTx(ctx, reason));
	} catch (error) {
		ctx.log.error("group_freeze_failed", { chat: ctx.chatId, error: describeError(error) });
	}
	ctx.kick();
}

/**
 * freezeGroup's work inside the caller's transaction (with the state change that freezes, e.g. a recorded evaluation
 * whose cleanup could not be verified). Posts the notice once. The caller kicks the engine.
 */
export function freezeInTx(ctx: Ctx, reason: string): void {
	ctx.freezes += 1;
	ctx.lastFreezeReason = reason;
	if (ctx.store.freeze(ctx.chatId, reason)) {
		ctx.store.enqueue({
			chatId: ctx.chatId,
			priority: "required",
			kind: "group_frozen",
			text: `Group frozen: ${reason}. Only the owner CLI can unfreeze it.`,
		});
	}
	ctx.log.warn("group_frozen", { chat: ctx.chatId, reason });
}

/** No dispatch, merge or follow-up delivery: the group is not normal, or sealing holds the whole deployment. */
export function groupHeld(ctx: Ctx): boolean {
	const group = ctx.store.groupState(ctx.chatId);
	return group.state !== "normal" || group.recheck || deploymentHeld(ctx.store);
}

export function releaseSlot(ctx: Ctx, slotId: number): void {
	tx(ctx, () => ctx.store.run("DELETE FROM slots WHERE id = ?", slotId));
}

/** Slots in use deployment-wide (runs and checks). */
export function slotsInUse(ctx: Ctx): number {
	return ctx.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM slots")?.n ?? 0;
}

/** Reserve a 'check' slot atomically if one is free (Capacity § Concurrent execution: merge tests reserve one too). */
export function reserveCheckSlot(ctx: Ctx, taskId: number): number | undefined {
	return tx(ctx, () => {
		if (slotsInUse(ctx) >= ctx.limits.maxConcurrentRuns) return undefined;
		return ctx.store.run(
			"INSERT INTO slots(kind, task_id, run_id, agent_id, acquired_at) VALUES ('check', ?, NULL, NULL, ?)",
			taskId,
			ctx.now(),
		).lastInsertRowid;
	});
}

/** Metadata-only error description for logs: class, code and status; never the message (it may carry paths). */
export function describeError(error: unknown): string {
	if (error instanceof GitHubError) return `GitHubError:${error.status ?? "network"}`;
	if (error instanceof Error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" ? `${error.name}:${code}` : error.name;
	}
	return typeof error;
}

/** Text clipped to `max` characters, with a marker. */
export function clipText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** UTF-8 safe byte cap with a "[truncated]" marker (Agent Execution § Output and Context). */
export function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return { text, truncated: false };
	const marker = "\n[truncated]";
	let end = Math.max(0, maxBytes - Buffer.byteLength(marker));
	// Do not cut inside a multi-byte sequence.
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return { text: `${bytes.subarray(0, end).toString("utf8")}${marker}`, truncated: true };
}

export { taskRef };
