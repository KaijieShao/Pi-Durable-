/**
 * The transactional command front (Interfaces and Storage § Telegram; Architecture § Request Flow).
 *
 * `handleUpdate` handles one Telegram update in ONE `store.tx()`: the `commands` row (update id primary key, so a
 * redelivered update is a no-op: Requirements § No duplicate submissions), the state change (task, run, follow-up,
 * approval, cancel request) and the acknowledgement or rejection in the outbox. "An accepted command, its task or
 * follow-up change and its acknowledgement event are saved in one database transaction, so a crash keeps all three
 * or none." Nothing but SQLite runs inside the transaction: no network, no IPC (the boot disk's free space is read
 * before it).
 * After commit the caller kicks the engine when `kick` is true; the engine reads the database.
 *
 * The engine consumes: runs in state 'queued'; follow-ups (mode 'steer' + state 'pending' → steer into run_id;
 * mode 'run' + state 'started' → its run is the queued run); tasks.cancel_requested = 1; tasks in state 'merging'
 * with a 'valid' approval.
 *
 * Every reply is a required outbox message replying to the user's message. Ignored updates are recorded (so
 * redelivery stays deduplicated) but get no reply. Logs carry metadata only (ids, kinds, outcomes, codes).
 */
import type { Update } from "grammy/types";
import type { Logger } from "../runtime/log.ts";
import { admitRun, agentQueuePosition, openTaskCount, waitingCapReason, waitingCounts } from "./admission.ts";
import { type BranchHold, readBranchHold } from "./branch-hold.ts";
import type { CoordinatorConfig } from "./config.ts";
import {
	type BootDiskCheck,
	checkBootDisk,
	type DiskProbe,
	diskSettings,
	systemDiskProbe,
	TASK_DISK_WAIT_KEY,
	taskDiskToldKey,
} from "./disk.ts";
import type { Limits } from "./limits.ts";
import {
	approved,
	beingCancelled,
	cancelling,
	cannotFollowUp,
	emptyText,
	followupExpired,
	followupLimit,
	followupStarted,
	followupSteered,
	frozenNotice,
	heldApproval,
	heldFollowupNote,
	helpText,
	holdNote,
	INTERRUPTED_KEPT_REASON,
	interruptedApproval,
	interruptedNext,
	MERGE_CONFLICT_REASON,
	mergeInProgress,
	noPullRequest,
	noSuchTask,
	notAMember,
	notInReview,
	notPermitted,
	type RejectSubject,
	rejected,
	rejectedApprovalNote,
	runAdmitted,
	runStopping,
	type StatusTaskLine,
	staleHead,
	statusDetail,
	statusSummary,
	type TaskState,
	taskAccepted,
	taskCancelled,
	taskRef,
	terminalForCommand,
	terminalTask,
	tooLong,
	unknownAgent,
	usageTask,
	usageTaskId,
	waitingForAgent,
	waitingForReviews,
	waitingForSlot,
	waitingForTaskDisk,
} from "./messages.ts";
import type { OutboxMessage, Store } from "./store.ts";
import { type ParsedUpdate, parseUpdate } from "./telegram/parse.ts";

export type CommandContext = {
	config: CoordinatorConfig;
	limits: Limits;
	log: Logger;
	/** How the boot disk is measured (src/coordinator/disk.ts); default the system's statfs. Tests inject one. */
	diskProbe?: DiskProbe;
};

type CommandKind = "task" | "followup" | "status" | "cancel" | "approve" | "help" | "ignored";
type Outcome = "accepted" | "rejected" | "answered" | "ignored";

type Result = {
	kind: CommandKind;
	outcome: Outcome;
	/** Short machine code for logs (never user text). */
	code?: string;
	/** Human reason, stored in commands.reason. */
	reason?: string;
	taskId?: number;
	/** The reply to the user's message; undefined = no reply (ignored). */
	reply?: string;
	/** Further required messages (e.g. follow-ups expired by a direct cancel), sent after the reply. */
	extra?: OutboxMessage[];
	kick: boolean;
};

type CommandMessage = Extract<ParsedUpdate, { kind: "command" }>;
type ReplyMessage = Extract<ParsedUpdate, { kind: "reply" }>;

type TaskRow = {
	id: number;
	chat_id: number;
	creator_id: number;
	agent_id: string;
	text: string;
	state: TaskState;
	reason: string | null;
	branch: string | null;
	worktree_path: string | null;
	archived: number;
	head_commit: string | null;
	posted_head: string | null;
	tests_passed_head: string | null;
	pr_number: number | null;
	pr_url: string | null;
	followup_count: number;
	cancel_requested: number;
};

type RunRow = { id: number; kind: string; state: string; reason: string | null };

const TERMINAL: ReadonlySet<TaskState> = new Set(["merged", "failed", "cancelled"]);
const ACTIVE_RUN = new Set(["queued", "starting", "running"]);
const TASK_COLUMNS = `id, chat_id, creator_id, agent_id, text, state, reason, branch, worktree_path, archived,
	head_commit, posted_head, tests_passed_head, pr_number, pr_url, followup_count, cancel_requested`;

export function handleUpdate(store: Store, ctx: CommandContext, update: Update): { kick: boolean } {
	const { telegram } = ctx.config;
	const parsed = parseUpdate(update, {
		groupChatId: telegram.groupChatId,
		topicId: telegram.topicId,
		botUsername: telegram.botUsername,
	});
	// Read the boot disk's free space before the transaction: only SQLite work happens inside it.
	const disk = parsed.kind === "command" && parsed.name === "task" ? bootDisk(ctx) : undefined;

	const result = store.tx((): Result | undefined => {
		// Redelivered update: already handled (it has its row), so no second effect and no second reply.
		if (!recordCommand(store, update, parsed)) return undefined;
		const outcome = route(store, ctx, parsed, disk);
		enqueueReplies(store, parsed, outcome);
		store.run(
			"UPDATE commands SET kind = ?, task_id = ?, outcome = ?, reason = ? WHERE update_id = ?",
			outcome.kind,
			outcome.taskId ?? null,
			outcome.outcome,
			outcome.reason ?? null,
			update.update_id,
		);
		return outcome;
	});

	if (result === undefined) {
		ctx.log.debug("command_duplicate", { update_id: update.update_id });
		return { kick: false };
	}
	ctx.log.info("command", {
		update_id: update.update_id,
		kind: result.kind,
		outcome: result.outcome,
		code: result.code,
		task_id: result.taskId,
	});
	return { kick: result.kick };
}

/** Insert the commands row keyed by the update id; false if the update was already saved. */
function recordCommand(store: Store, update: Update, parsed: ParsedUpdate): boolean {
	const meta = parsed.kind === "ignored" ? rawMeta(update) : parsed;
	const kind: CommandKind = parsed.kind === "command" ? parsed.name : parsed.kind === "reply" ? "followup" : "ignored";
	return (
		store.run(
			`INSERT INTO commands(update_id, chat_id, user_id, message_id, kind, outcome, received_at)
			 VALUES (?, ?, ?, ?, ?, 'ignored', ?) ON CONFLICT(update_id) DO NOTHING`,
			update.update_id,
			meta.chatId,
			meta.userId,
			meta.messageId,
			kind,
			store.now(),
		).changes === 1
	);
}

function enqueueReplies(store: Store, parsed: ParsedUpdate, outcome: Result): void {
	if (parsed.kind === "ignored" || outcome.reply === undefined) return;
	store.enqueue({
		chatId: parsed.chatId,
		taskId: outcome.taskId,
		priority: "required",
		kind: `${outcome.kind}_${outcome.outcome}`,
		text: outcome.reply,
		replyTo: parsed.messageId,
	});
	for (const message of outcome.extra ?? []) store.enqueue(message);
}

function route(store: Store, ctx: CommandContext, parsed: ParsedUpdate, disk: BootDiskCheck | undefined): Result {
	if (parsed.kind === "ignored") return ignored(parsed.reason);
	if (parsed.kind === "reply") return onReply(store, ctx, parsed);
	switch (parsed.name) {
		case "task":
			return onTask(store, ctx, parsed, disk ?? { ok: true });
		case "status":
			return onStatus(store, ctx, parsed);
		case "cancel":
			return onCancel(store, ctx, parsed);
		case "approve":
			return onApprove(store, ctx, parsed);
		case "help":
			return {
				kind: "help",
				outcome: "answered",
				reply: helpText(ctx.config.agents, ctx.config.telegram.botUsername, ctx.limits),
				kick: false,
			};
	}
}

function ignored(reason: string): Result {
	return { kind: "ignored", outcome: "ignored", code: reason, reason, kick: false };
}

/** [code, reason] of a rejection. */
type Blocker = readonly [code: string, reason: string];

function rejection(kind: CommandKind, subject: RejectSubject, blocker: Blocker, taskId?: number): Result {
	const [code, reason] = blocker;
	return { kind, outcome: "rejected", code, reason, reply: rejected(subject, reason), taskId, kick: false };
}

// ---------------------------------------------------------------------------------------------------------------
// /task <agent> <text>

function onTask(store: Store, ctx: CommandContext, cmd: CommandMessage, disk: BootDiskCheck): Result {
	const { limits } = ctx;
	const request = taskRequest(store, ctx, cmd, disk);
	if ("blocker" in request) return rejection("task", "Task request", request.blocker);
	const { agent, text } = request;

	const now = store.now();
	const taskId = store.run(
		`INSERT INTO tasks(chat_id, creator_id, agent_id, text, update_id, state, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
		cmd.chatId,
		cmd.userId,
		agent,
		text,
		cmd.updateId,
		now,
		now,
	).lastInsertRowid;
	const admitted = admitRun(store, limits, {
		taskId,
		kind: "initial",
		requestedBy: cmd.userId,
		requestId: String(cmd.updateId),
		inputText: text,
	});
	if (!admitted.ok) {
		// Not reachable after the cap check (same transaction), but never leave a task without its run.
		store.run("DELETE FROM tasks WHERE id = ?", taskId);
		return rejection("task", "Task request", ["admission", admitted.reason]);
	}
	const note = waitNote(store, limits, { chatId: cmd.chatId, agent, initial: true });
	// Told in the acknowledgement: the engine does not say it again when it holds the run (dispatch.ts).
	if (note !== undefined && note === taskDiskNote(store)) store.setMeta(taskDiskToldKey(admitted.runId), String(now));
	return {
		kind: "task",
		outcome: "accepted",
		taskId,
		reply: taskAccepted({ taskId, agent, position: admitted.position, note }),
		kick: true,
	};
}

/** Validate a /task in rule order: member allowlist, frozen group, agent, text, boot disk, waiting caps. */
function taskRequest(
	store: Store,
	ctx: CommandContext,
	cmd: CommandMessage,
	disk: BootDiskCheck,
): { agent: string; text: string } | { blocker: Blocker } {
	const { config, limits } = ctx;
	const members = config.telegram.memberIds;
	const isMember = cmd.userId === config.telegram.ownerId || members === undefined || members.includes(cmd.userId);
	if (!isMember) return { blocker: ["not_member", notAMember()] };
	const group = store.groupState(cmd.chatId);
	if (group.state === "frozen") return { blocker: ["frozen", frozenNotice(group.reason)] };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(cmd.args);
	const given = match?.[1];
	if (given === undefined) return { blocker: ["usage", usageTask(config.agents)] };
	const agent = given.toLowerCase();
	if (!config.agents.includes(agent)) return { blocker: ["unknown_agent", unknownAgent(given, config.agents)] };
	const text = (match?.[2] ?? "").trim();
	if (text === "") return { blocker: ["empty", `${emptyText("task")}; ${usageTask(config.agents)}`] };
	if (text.length > limits.taskChars) return { blocker: ["too_long", tooLong("task", text.length, limits.taskChars)] };
	if (!disk.ok) return { blocker: [disk.code, disk.reason] };
	const counts = waitingCounts(store, { agentId: agent, chatId: cmd.chatId, userId: cmd.userId });
	const full = waitingCapReason(limits, counts, agent);
	return full === undefined ? { agent, text } : { blocker: ["queue_full", full] };
}

// ---------------------------------------------------------------------------------------------------------------
// A reply to a task's bot message: a follow-up (Requirements § Follow-ups; Architecture § Request Flow).
// The mode comes from the task's latest run and state; the user never picks it.

function onReply(store: Store, ctx: CommandContext, reply: ReplyMessage): Result {
	const task = repliedTask(store, reply);
	if (task === undefined) return ignored("reply_not_task");
	const reject = (blocker: Blocker) => rejection("followup", "Follow-up", blocker, task.id);
	const blocked = followupBlocker(store, ctx, task, reply);
	if (blocked !== undefined) return reject(blocked);
	const text = reply.text.trim();
	const latest = latestRun(store, task.id);
	// Busy (queued, starting or running): steer into that run.
	if (latest !== undefined && ACTIVE_RUN.has(latest.state)) return steerFollowup(store, task, reply, text, latest);
	// Finalizing: the run may still end in review (normal completion) or fail (a limit). Neither a steer (it would
	// only expire) nor another run (it could outlive a failed task) is safe to promise yet.
	if (latest?.state === "finalizing") return reject(["stopping", runStopping(task.id)]);
	const runEnded = task.state === "review" || (task.state === "running" && latest?.state === "finished");
	if (!runEnded) return reject(["state", cannotFollowUp(task.id, task.state)]);
	return runFollowup(store, ctx, task, reply, text);
}

/** The task whose bot message this replies to; undefined = not a task message (ignored, no reply). */
function repliedTask(store: Store, reply: ReplyMessage): TaskRow | undefined {
	const mapped = store.get<{ task_id: number }>(
		"SELECT task_id FROM task_messages WHERE chat_id = ? AND message_id = ?",
		reply.chatId,
		reply.replyToMessageId,
	);
	const task = mapped === undefined ? undefined : loadTask(store, mapped.task_id);
	return task?.chat_id === reply.chatId ? task : undefined;
}

/** Rule order: permission, frozen group, task state, text, follow-up count. */
function followupBlocker(store: Store, ctx: CommandContext, task: TaskRow, reply: ReplyMessage): Blocker | undefined {
	const { limits } = ctx;
	if (!permitted(ctx.config, task, reply.userId)) return ["permission", notPermitted("follow up on", task.id)];
	const group = store.groupState(reply.chatId);
	if (group.state === "frozen") return ["frozen", frozenNotice(group.reason)];
	const state = followupStateBlocker(task);
	if (state !== undefined) return state;
	const text = reply.text.trim();
	if (text === "") return ["empty", emptyText("follow-up")];
	if (text.length > limits.followUpChars) return ["too_long", tooLong("follow-up", text.length, limits.followUpChars)];
	if (task.followup_count >= limits.followUpsPerTask) return ["limit", followupLimit(task.id, limits.followUpsPerTask)];
	return undefined;
}

function followupStateBlocker(task: TaskRow): Blocker | undefined {
	if (isTerminal(task.state)) return ["state", terminalTask(task.id, task.state, task.reason)];
	if (task.cancel_requested === 1)
		return ["cancelling", `${beingCancelled(task.id)}; send a new /task for further work`];
	if (task.state === "merging") {
		return ["merging", `${mergeInProgress(task.id)}; reply again if it returns to review, or send a new /task`];
	}
	return undefined;
}

function steerFollowup(store: Store, task: TaskRow, reply: ReplyMessage, text: string, run: RunRow): Result {
	// Pi gets it with whenBusy "steer" and requestId = this update id; the engine submits pending steers when the
	// run's Pi process starts, or right away while it runs.
	const now = store.now();
	store.run(
		`INSERT INTO followups(task_id, update_id, user_id, message_id, text, mode, run_id, state, created_at)
		 VALUES (?, ?, ?, ?, ?, 'steer', ?, 'pending', ?)`,
		task.id,
		reply.updateId,
		reply.userId,
		reply.messageId,
		text,
		run.id,
		now,
	);
	bumpFollowups(store, task.id, now);
	const running = run.state !== "queued";
	const position = running ? 0 : agentQueuePosition(store, run.id);
	return {
		kind: "followup",
		outcome: "accepted",
		code: "steer",
		taskId: task.id,
		reply: followupSteered({ taskId: task.id, running, position }),
		kick: true,
	};
}

/**
 * After the run ended, before the merge: another run of the same task on its branch and pull request, admitted
 * like new work and counted against the follow-up's author (Capacity § Follow-up runs are admitted like new work).
 */
function runFollowup(store: Store, ctx: CommandContext, task: TaskRow, reply: ReplyMessage, text: string): Result {
	const admitted = admitRun(store, ctx.limits, {
		taskId: task.id,
		kind: "followup",
		requestedBy: reply.userId,
		requestId: String(reply.updateId),
		inputText: text,
	});
	if (!admitted.ok) {
		const code = admitted.reason.startsWith("queue full") ? "queue_full" : "admission";
		return rejection("followup", "Follow-up", [code, admitted.reason], task.id);
	}
	const now = store.now();
	const followupId = store.run(
		`INSERT INTO followups(task_id, update_id, user_id, message_id, text, mode, run_id, state, created_at, settled_at)
		 VALUES (?, ?, ?, ?, ?, 'run', ?, 'started', ?, ?)`,
		task.id,
		reply.updateId,
		reply.userId,
		reply.messageId,
		text,
		admitted.runId,
		now,
		now,
	).lastInsertRowid;
	store.run("UPDATE runs SET followup_id = ? WHERE id = ?", followupId, admitted.runId);
	bumpFollowups(store, task.id, now);
	const note = followupNote(store, ctx.limits, task);
	const hasPullRequest = task.pr_number !== null || task.pr_url !== null;
	return {
		kind: "followup",
		outcome: "accepted",
		code: "run",
		taskId: task.id,
		reply: followupStarted({ taskId: task.id, position: admitted.position, hasPullRequest, note }),
		kick: true,
	};
}

/** The waiting note of a follow-up run, and, if its task is held in review, that its result waits for the branch. */
function followupNote(store: Store, limits: Limits, task: TaskRow): string | undefined {
	const wait = waitNote(store, limits, { chatId: task.chat_id, agent: task.agent_id, initial: false });
	const hold = readBranchHold(store, task.id);
	if (hold?.kind !== "review") return wait;
	const held = heldFollowupNote(hold.branch);
	return wait === undefined ? held : `${wait}. ${held}`;
}

function bumpFollowups(store: Store, taskId: number, now: number): void {
	store.run("UPDATE tasks SET followup_count = followup_count + 1, updated_at = ? WHERE id = ?", now, taskId);
}

// ---------------------------------------------------------------------------------------------------------------
// /cancel <task>

function onCancel(store: Store, ctx: CommandContext, cmd: CommandMessage): Result {
	const found = commandTask(store, cmd, "/cancel");
	if ("blocker" in found) return rejection("cancel", "/cancel", found.blocker);
	const { task } = found;
	const blocked = cancelBlocker(ctx, task, cmd);
	if (blocked !== undefined) return rejection("cancel", "/cancel", blocked, task.id);
	if (neverStarted(store, task)) return cancelDirectly(store, task, cmd);
	// Running, in review, or queued with a worktree (a later run waiting): the engine stops the run, saves and
	// pushes the work, closes the pull request, archives the worktree and posts "Task N cancelled.".
	store.run(
		"UPDATE tasks SET cancel_requested = 1, cancel_requested_by = ?, updated_at = ? WHERE id = ?",
		cmd.userId,
		store.now(),
		task.id,
	);
	return {
		kind: "cancel",
		outcome: "accepted",
		code: "cancel_requested",
		taskId: task.id,
		reply: cancelling(task.id, task.state),
		kick: true,
	};
}

function cancelBlocker(ctx: CommandContext, task: TaskRow, cmd: CommandMessage): Blocker | undefined {
	if (!permitted(ctx.config, task, cmd.userId)) return ["permission", notPermitted("cancel", task.id)];
	// No frozen check: Architecture § Frozen group, "/status and authorized /cancel still work".
	if (isTerminal(task.state)) return ["state", terminalForCommand(task.id, task.state)];
	if (task.state === "merging") return ["merging", `${mergeInProgress(task.id)}; it cannot be cancelled now`];
	if (task.cancel_requested === 1) return ["cancelling", `${beingCancelled(task.id)} already`];
	return undefined;
}

/** Queued, no worktree, and no run ever left the queue: nothing runs and nothing is on disk or GitHub. */
function neverStarted(store: Store, task: TaskRow): boolean {
	if (task.state !== "queued" || task.worktree_path !== null) return false;
	const started = store.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND state NOT IN ('queued', 'cancelled')",
		task.id,
	);
	return (started?.n ?? 0) === 0;
}

function cancelDirectly(store: Store, task: TaskRow, cmd: CommandMessage): Result {
	const now = store.now();
	const reason = `cancelled by ${cmd.userId === task.creator_id ? "its creator" : "the group owner"}`;
	store.run(
		"UPDATE runs SET state = 'cancelled', reason = ?, ended_at = ? WHERE task_id = ? AND state = 'queued'",
		reason,
		now,
		task.id,
	);
	// Every accepted follow-up ends with an outcome the user sees: steers waiting for this run expire.
	const pending = store.all<{ id: number; message_id: number }>(
		"SELECT id, message_id FROM followups WHERE task_id = ? AND state IN ('pending', 'submitted') ORDER BY id",
		task.id,
	);
	store.run(
		`UPDATE followups SET state = 'expired', reason = 'expired (cancelled)', settled_at = ?
		 WHERE task_id = ? AND state IN ('pending', 'submitted')`,
		now,
		task.id,
	);
	const extra: OutboxMessage[] = pending.map((followup) => ({
		chatId: task.chat_id,
		taskId: task.id,
		priority: "required",
		kind: "followup_expired",
		text: followupExpired(task.id, "cancelled"),
		replyTo: followup.message_id,
	}));
	store.run(
		"UPDATE approvals SET state = 'invalidated', reason = 'task cancelled' WHERE task_id = ? AND state = 'valid'",
		task.id,
	);
	store.run(
		"UPDATE tasks SET state = 'cancelled', reason = ?, cancel_requested_by = ?, updated_at = ? WHERE id = ?",
		reason,
		cmd.userId,
		now,
		task.id,
	);
	return {
		kind: "cancel",
		outcome: "accepted",
		code: "cancelled",
		taskId: task.id,
		reply: taskCancelled(task.id),
		extra,
		kick: true,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// /approve <task>: approves the head commit the bot last posted (Interfaces and Storage § Telegram).

function onApprove(store: Store, ctx: CommandContext, cmd: CommandMessage): Result {
	const found = commandTask(store, cmd, "/approve");
	if ("blocker" in found) return rejection("approve", "/approve", found.blocker);
	const { task } = found;
	const blocked = approveBlocker(store, ctx, task, cmd);
	if (blocked !== undefined || task.posted_head === null) {
		return rejection("approve", "/approve", blocked ?? staleHeadBlocker(task), task.id);
	}
	const head = task.posted_head;
	const now = store.now();
	const approvalId = store.run(
		`INSERT INTO approvals(task_id, user_id, update_id, head_commit, state, created_at)
		 VALUES (?, ?, ?, ?, 'valid', ?)`,
		task.id,
		cmd.userId,
		cmd.updateId,
		head,
		now,
	).lastInsertRowid;
	store.run("UPDATE tasks SET state = 'merging', updated_at = ? WHERE id = ?", now, task.id);
	// Merges run one at a time, FIFO by approval id.
	const position =
		store.get<{ n: number }>(
			`SELECT COUNT(*) AS n FROM approvals a JOIN tasks t ON t.id = a.task_id
			 WHERE a.state = 'valid' AND t.state = 'merging' AND a.id <= ?`,
			approvalId,
		)?.n ?? 1;
	const testsPassed = task.tests_passed_head === head;
	return {
		kind: "approve",
		outcome: "accepted",
		taskId: task.id,
		reply: approved({ taskId: task.id, head, position, testsPassed }),
		kick: true,
	};
}

/**
 * Rule order: permission, frozen group, task state, no run admitted since the post, the task not held because its
 * branch changed on GitHub, a pull request to merge, and the branch head still equal to the head the bot posted.
 */
function approveBlocker(store: Store, ctx: CommandContext, task: TaskRow, cmd: CommandMessage): Blocker | undefined {
	if (!permitted(ctx.config, task, cmd.userId)) return ["permission", notPermitted("approve", task.id)];
	const group = store.groupState(cmd.chatId);
	if (group.state === "frozen") return ["frozen", frozenNotice(group.reason)];
	if (isTerminal(task.state)) return ["state", terminalForCommand(task.id, task.state)];
	if (task.cancel_requested === 1) return ["cancelling", beingCancelled(task.id)];
	if (task.state === "merging") return ["merging", `${taskRef(task.id)} is already approved and merging`];
	return reviewBlocker(store, task);
}

/** The /approve rules that look at the task's review: its runs, a branch hold, its pull request and posted head. */
function reviewBlocker(store: Store, task: TaskRow): Blocker | undefined {
	const busy = busyRunKind(store, task.id);
	if (busy !== undefined) {
		return ["run_admitted", runAdmitted({ taskId: task.id, postedHead: task.posted_head, kind: busy })];
	}
	if (task.state !== "review") return ["state", notInReview(task.id, task.state)];
	// An interrupted run's changes since the last checkpoint wait in the worktree: no posted head holds them.
	if (task.reason === INTERRUPTED_KEPT_REASON) return ["interrupted", interruptedApproval(task.id)];
	const hold = readBranchHold(store, task.id);
	if (hold?.kind === "review") return ["branch_held", heldApproval(holdFacts(task.id, hold))];
	if (task.pr_number === null) return ["no_pr", noPullRequest(task.id)];
	if (task.posted_head === null || task.head_commit !== task.posted_head) return staleHeadBlocker(task);
	return undefined;
}

function holdFacts(taskId: number, hold: BranchHold) {
	return { taskId, branch: hold.branch, github: hold.github, local: hold.local, pushed: hold.pushed };
}

function staleHeadBlocker(task: TaskRow): Blocker {
	const conflict = task.reason === MERGE_CONFLICT_REASON;
	return ["stale_head", staleHead({ taskId: task.id, head: task.head_commit, postedHead: task.posted_head, conflict })];
}

/** The kind of the task's latest queued or in-progress run ("initial", "followup", "conflict"), if any. */
function busyRunKind(store: Store, taskId: number): string | undefined {
	return store.get<{ kind: string }>(
		`SELECT kind FROM runs WHERE task_id = ? AND state IN ('queued', 'starting', 'running', 'finalizing')
		 ORDER BY id DESC LIMIT 1`,
		taskId,
	)?.kind;
}

// ---------------------------------------------------------------------------------------------------------------
// /status [task]: no state change.

function onStatus(store: Store, ctx: CommandContext, cmd: CommandMessage): Result {
	if (cmd.args === "") {
		return { kind: "status", outcome: "answered", reply: groupStatus(store, ctx.limits, cmd.chatId), kick: false };
	}
	const found = commandTask(store, cmd, "/status");
	if ("blocker" in found) return rejection("status", "/status", found.blocker);
	return {
		kind: "status",
		outcome: "answered",
		taskId: found.task.id,
		reply: taskStatus(store, ctx.limits, found.task),
		kick: false,
	};
}

function groupStatus(store: Store, limits: Limits, chatId: number): string {
	const active = store
		.all<TaskRow>(
			`SELECT ${TASK_COLUMNS} FROM tasks WHERE chat_id = ? AND state NOT IN ('merged', 'failed', 'cancelled')
			 ORDER BY id`,
			chatId,
		)
		.map((task) => statusLineOf(store, limits, task));
	const recent = store
		.all<TaskRow>(
			`SELECT ${TASK_COLUMNS} FROM tasks WHERE chat_id = ? AND state IN ('merged', 'failed', 'cancelled')
			 ORDER BY updated_at DESC, id DESC LIMIT 5`,
			chatId,
		)
		.map((task) => statusLineOf(store, limits, task));
	return statusSummary({
		group: store.groupState(chatId),
		slotsInUse: slotsInUse(store),
		maxSlots: limits.maxConcurrentRuns,
		active,
		recent,
	});
}

function taskStatus(store: Store, limits: Limits, task: TaskRow): string {
	const runs = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?", task.id)?.n ?? 0;
	const queue = queueInfo(store, limits, task);
	return statusDetail({
		id: task.id,
		agent: task.agent_id,
		state: task.state,
		reason: task.reason,
		creatorId: task.creator_id,
		text: task.text,
		branch: task.branch,
		prUrl: task.pr_url,
		head: task.head_commit,
		postedHead: task.posted_head,
		testsPassedHead: task.tests_passed_head,
		runs,
		latestRun: latestRun(store, task.id),
		followups: task.followup_count,
		followupLimit: limits.followUpsPerTask,
		position: queue.position,
		note: queue.note,
		cancelling: task.cancel_requested === 1,
		archived: task.archived === 1,
		rejectedNote:
			task.reason === INTERRUPTED_KEPT_REASON
				? interruptedNext(task.id)
				: rejectedApprovalNote(store.latestApproval(task.id), task.posted_head),
		heldNote: heldNoteOf(store, task.id),
	});
}

function heldNoteOf(store: Store, taskId: number): string | undefined {
	const hold = readBranchHold(store, taskId);
	return hold === undefined ? undefined : holdNote({ ...holdFacts(taskId, hold), kind: hold.kind });
}

function statusLineOf(store: Store, limits: Limits, task: TaskRow): StatusTaskLine {
	const queue = isTerminal(task.state) ? {} : queueInfo(store, limits, task);
	return {
		id: task.id,
		agent: task.agent_id,
		state: task.state,
		position: queue.position,
		note: queue.note,
		cancelling: task.cancel_requested === 1,
		prUrl: task.pr_url,
		held: readBranchHold(store, task.id) !== undefined,
	};
}

/** Queue position and waiting note of a task's queued run, if it has one. */
function queueInfo(store: Store, limits: Limits, task: TaskRow): { position?: number; note?: string } {
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
function waitNote(
	store: Store,
	limits: Limits,
	p: { chatId: number; agent: string; initial: boolean },
): string | undefined {
	const group = store.groupState(p.chatId);
	if (group.state === "sealing") return "Waiting: dispatch is held while the group is sealed";
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
function taskDiskNote(store: Store): string | undefined {
	const detail = store.getMeta(TASK_DISK_WAIT_KEY);
	return detail === undefined ? undefined : waitingForTaskDisk(detail);
}

function slotsInUse(store: Store): number {
	return store.get<{ n: number }>("SELECT COUNT(*) AS n FROM slots")?.n ?? 0;
}

/** The task a /cancel, /approve or /status <id> names, checked against the command's group. */
function commandTask(
	store: Store,
	cmd: CommandMessage,
	command: "/cancel" | "/approve" | "/status",
): { task: TaskRow } | { blocker: Blocker } {
	const id = parseTaskId(cmd.args);
	if (id === undefined) return { blocker: ["usage", usageTaskId(command)] };
	const task = loadTask(store, id);
	// Interfaces and Storage § Telegram: the chat id of every command is checked against the task's group.
	if (task === undefined || task.chat_id !== cmd.chatId) return { blocker: ["not_found", noSuchTask(id)] };
	return { task };
}

function latestRun(store: Store, taskId: number): RunRow | undefined {
	return store.get<RunRow>(
		"SELECT id, kind, state, reason FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1",
		taskId,
	);
}

function loadTask(store: Store, id: number): TaskRow | undefined {
	return store.get<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`, id);
}

/** Requirements § Permissions: only the task's creator and the group's owner. */
function permitted(config: CoordinatorConfig, task: TaskRow, userId: number): boolean {
	return userId === task.creator_id || userId === config.telegram.ownerId;
}

function isTerminal(state: TaskState): state is "merged" | "failed" | "cancelled" {
	return TERMINAL.has(state);
}

/** "12" or "#12" (first word of the arguments). */
function parseTaskId(args: string): number | undefined {
	const first = args.split(/\s+/, 1)[0] ?? "";
	const match = /^#?(\d{1,15})$/.exec(first);
	if (match === null || match[1] === undefined) return undefined;
	const id = Number(match[1]);
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** Metadata of an ignored update, for the commands row only. */
function rawMeta(update: Update): { chatId: number | null; userId: number | null; messageId: number | null } {
	const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
	return {
		chatId: message?.chat.id ?? null,
		userId: message?.from?.id ?? null,
		messageId: message?.message_id ?? null,
	};
}

/**
 * Capacity § Disk: "When its free space runs low, new tasks are rejected with a reason." The boot disk (PI_DATA_DIR's
 * filesystem) only; fails closed if it cannot be read. A full task disk does not reject a /task: the task is accepted
 * and stays queued until its worktree fits (engine/task-disk.ts; Evaluation "Task disk full": commands are still
 * saved and acknowledged).
 */
function bootDisk(ctx: CommandContext): BootDiskCheck {
	const min = diskSettings(ctx.config, ctx.limits).bootMinFreeBytes;
	return checkBootDisk(ctx.diskProbe ?? systemDiskProbe, ctx.config.paths.dataDir, min);
}
