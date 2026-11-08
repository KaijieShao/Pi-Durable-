/**
 * One dispatched run, from its slot reservation to the release of that slot (Architecture § New task, § Follow-up
 * during a run; design "Admission and dispatch" start steps, "Runs, steering, tools").
 *
 * Start (outside any transaction): first run → fetch main, create the branch and worktree at it (record the base
 * commit), run the checked-in setup script in a check container with the worktree writable; choose the
 * conversation (reuse a clean one, else a fresh one seeded with the task text, this input and the branch's
 * changes); open the run key; start the agent container; launch the Pi process with the pending steers; arm the run
 * deadline. Then the run reacts to its Pi process (tools, steer statuses, finished) and to stop requests until a
 * decision is made, and is finalized.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { FromRunner, RunnerStart } from "../../runner/protocol.ts";
import { clip } from "../messages.ts";
import type { RunnerHandle } from "../ports.ts";
import {
	type ActiveRun,
	branchName,
	type ConversationRow,
	type Ctx,
	capBytes,
	conversationPath,
	type Decision,
	describeError,
	enqueueTask,
	type FollowupRow,
	loadRun,
	loadTask,
	type RunRow,
	runNumber,
	type TaskRow,
	taskRef,
	tx,
	worktreePath,
} from "./context.ts";
import type { Reservation } from "./dispatch.ts";
import { applyDelivered, decide, deliverFollowup, expireFollowup, finalizeRun } from "./finalize.ts";
import { closeRunKeys, newRunKey, openRunKey } from "./keys.ts";
import { executeTool } from "./tools.ts";

const AGENTS_MD_BYTES = 8 * 1024;
const DIFF_SUMMARY_BYTES = 12 * 1024;
const CONTAINER_LIFETIME_MARGIN_MS = 60_000;
/** A run requeued because the task disk is low is offered again after this. */
const DISK_RETRY_MS = 30_000;
/** After the Pi process exits, wait this long for messages still in the IPC channel before calling it a failure. */
const EXIT_MESSAGE_GRACE_MS = 500;

/** A preparation failure with the reason shown to the user. */
class PrepareError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrepareError";
	}
}

/** The run was decided (cancel, limit, freeze) while it was being prepared. */
class Stopped extends Error {
	constructor() {
		super("run stopped during preparation");
		this.name = "Stopped";
	}
}

type Prepared = { readonly key: string; readonly start: RunnerStart; readonly steers: readonly FollowupRow[] };

export function newActiveRun(ctx: Ctx, reservation: Reservation): ActiveRun {
	let resolveDecision: (decision: Decision) => void = () => {};
	const decided = new Promise<Decision>((resolve) => {
		resolveDecision = resolve;
	});
	const run = loadRun(ctx, reservation.runId);
	return {
		runId: reservation.runId,
		taskId: reservation.taskId,
		chatId: reservation.chatId,
		agentId: reservation.agentId,
		generation: reservation.generation,
		slotId: reservation.slotId,
		runNo: runNumber(ctx, run),
		worktree: undefined,
		branch: undefined,
		handle: undefined,
		agentBox: undefined,
		decision: undefined,
		decided,
		resolveDecision,
		tools: new Set(),
		sentSteers: new Set(),
		deadline: undefined,
		exited: false,
		finished: undefined,
	};
}

const START_FAILED = "the run could not be started";

/** Prepare the run; a failure (not a stop) decides it as failed with the user-facing reason. */
async function prepareOrFail(ctx: Ctx, active: ActiveRun): Promise<Prepared | "requeued" | undefined> {
	try {
		return await prepare(ctx, active);
	} catch (error) {
		if (error instanceof Stopped || active.decision !== undefined) return undefined;
		const reason = error instanceof PrepareError ? error.message : START_FAILED;
		ctx.log.warn("run_prepare_failed", { run: active.runId, task: active.taskId, error: describeError(error) });
		decide(ctx, active, { kind: "failed", reason, cause: START_FAILED });
		return undefined;
	}
}

function launchOrFail(ctx: Ctx, active: ActiveRun, prepared: Prepared): void {
	try {
		launch(ctx, active, prepared);
	} catch (error) {
		ctx.log.warn("run_launch_failed", { run: active.runId, error: describeError(error) });
		decide(ctx, active, { kind: "failed", reason: "the Pi process could not be started", cause: START_FAILED });
	}
}

/** The whole life of a dispatched run; resolves after its slot is released. */
export async function runLifecycle(ctx: Ctx, active: ActiveRun): Promise<void> {
	try {
		const prepared = await prepareOrFail(ctx, active);
		if (prepared === "requeued") return;
		if (prepared !== undefined && active.decision === undefined) launchOrFail(ctx, active, prepared);
		await finalizeRun(ctx, active, await active.decided);
	} finally {
		if (active.deadline !== undefined) clearTimeout(active.deadline);
		ctx.active.delete(active.runId);
	}
}

function checkStop(active: ActiveRun): void {
	if (active.decision !== undefined) throw new Stopped();
}

async function defaultFreeBytes(path: string): Promise<number> {
	const stats = await statfs(path);
	return Number(stats.bavail) * Number(stats.bsize);
}

export { defaultFreeBytes };

async function isRegularFile(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isFile();
	} catch {
		return false;
	}
}

/** Put a run whose worktree cannot be created yet back in the queue (Capacity § Disk), and say why once. */
function requeue(ctx: Ctx, active: ActiveRun, why: string, kind: "disk" | "enforcement"): void {
	tx(ctx, () => {
		const now = ctx.now();
		// Nothing reached Pi: the run goes back to the queue (never resubmitted after it ran).
		closeRunKeys(ctx.store, active, now);
		ctx.store.run("UPDATE runs SET state = 'queued' WHERE id = ? AND state = 'starting'", active.runId);
		ctx.store.run(
			"UPDATE tasks SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'running'",
			now,
			active.taskId,
		);
		ctx.store.run("DELETE FROM slots WHERE id = ?", active.slotId);
		const task = loadTask(ctx, active.taskId);
		const notedKey = `wait_noted:${kind}:${active.runId}`;
		if (ctx.store.getMeta(notedKey) === undefined) {
			ctx.store.setMeta(notedKey, String(now));
			enqueueTask(ctx, task, "task_waiting", `${taskRef(task.id)} stays queued: ${why}.`);
		}
	});
}

async function prepare(ctx: Ctx, active: ActiveRun): Promise<Prepared | "requeued"> {
	let task = loadTask(ctx, active.taskId);
	const run = loadRun(ctx, active.runId);
	checkStop(active);
	if (task.worktree_path === null) {
		const prepared = await createWorktree(ctx, active, task);
		if (prepared === "requeued") return "requeued";
		task = loadTask(ctx, active.taskId);
	}
	const worktree = task.worktree_path;
	const branch = task.branch;
	const base = task.base_commit;
	if (worktree === null || branch === null || base === null) throw new PrepareError("the task's worktree is missing");
	active.worktree = worktree;
	active.branch = branch;
	checkStop(active);

	const conversation = await chooseConversation(ctx, active, task, run);
	checkStop(active);

	const agentsMd = await ctx.git.showFile(base, "AGENTS.md").catch(() => undefined);
	checkStop(active);

	// Open the run key (the relay accepts it while the run is starting or running).
	const key = newRunKey();
	tx(ctx, () => {
		if (active.decision !== undefined) return;
		openRunKey(ctx.store, active, key, ctx.now());
	});
	checkStop(active);

	try {
		active.agentBox = await ctx.sandbox.startAgent({
			taskId: active.taskId,
			generation: active.generation,
			worktree,
			lifetimeMs: ctx.limits.runDeadlineMs + CONTAINER_LIFETIME_MARGIN_MS,
		});
	} catch (error) {
		ctx.log.warn("agent_container_failed", { run: active.runId, error: describeError(error) });
		// Fails closed: if enforcement went away, the run waits in the queue instead of failing the task.
		const available = await ctx.sandbox
			.available()
			.catch(() => ({ ok: false as const, reason: "sandbox check failed" }));
		if (!available.ok && active.decision === undefined) {
			ctx.enforcement = { ok: false, reason: available.reason, checkedAt: ctx.now() };
			requeue(ctx, active, "container enforcement is unavailable, so no run starts", "enforcement");
			return "requeued";
		}
		throw new PrepareError("the agent container could not be started");
	}
	checkStop(active);

	const relayBaseUrl = ctx.relayUrl;
	if (relayBaseUrl === undefined) throw new PrepareError("the model relay is not running");
	const start: RunnerStart = {
		type: "start",
		runId: active.runId,
		taskId: active.taskId,
		conversationPath: conversation.path,
		fresh: conversation.fresh,
		model: {
			modelId: ctx.config.model.modelId,
			thinkingLevel: ctx.config.model.thinkingLevel,
			relayBaseUrl,
			codexGateway: ctx.config.model.codexGateway,
		},
		input: { content: conversation.input, requestId: run.request_id },
		steers: [],
		instructions: instructions(ctx, task, agentsMd),
		limits: {
			maxRetries: ctx.limits.retriesPerCall,
			toolResultBytes: ctx.limits.toolResultBytes,
			deadlineMs: ctx.limits.runDeadlineMs,
		},
		checkOps: ctx.sandbox.checkOps(),
	};
	return { key, start, steers: [] };
}

/** One preparation step; any error becomes a PrepareError with the user-facing `reason`. */
async function step<T>(ctx: Ctx, active: ActiveRun, event: string, reason: string, work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		ctx.log.warn(event, { run: active.runId, task: active.taskId, error: describeError(error) });
		throw new PrepareError(reason);
	}
}

/** Capacity § Disk: if a new worktree would not fit, the task stays queued and the bot says why. */
async function taskDiskLow(ctx: Ctx, active: ActiveRun): Promise<boolean> {
	// STUB(spec: capacity.md § Disk; evaluation.md § Fault Track "Task disk full"): only this free-space check before
	// a worktree is created; a task disk that fills up during a run is not detected separately (writes fail in the
	// container and the run ends on its own terms).
	const free = await ctx.freeBytes(ctx.config.paths.taskDir).catch(() => 0);
	if (free >= ctx.limits.minFreeDiskBytes) return false;
	requeue(ctx, active, "the task disk is low on free space, so its worktree cannot be created yet", "disk");
	ctx.deferred.set(active.runId, ctx.now() + DISK_RETRY_MS);
	ctx.log.warn("run_requeued_disk", { run: active.runId, task: active.taskId });
	return true;
}

/** The project's checked-in setup script, in a check container with the worktree writable for that step only. */
async function runSetup(ctx: Ctx, active: ActiveRun, task: TaskRow, path: string): Promise<void> {
	if (!(await isRegularFile(join(path, ctx.config.setupScript)))) return;
	const result = await ctx.sandbox
		.runCheck({
			taskId: task.id,
			generation: active.generation,
			worktree: path,
			op: "setup",
			writable: true,
			timeoutMs: ctx.limits.checkDeadlineMs,
		})
		.catch(() => undefined);
	const outcome = result?.outcome ?? "error";
	tx(ctx, () =>
		enqueueTask(ctx, loadTask(ctx, task.id), "task_setup", `${taskRef(task.id)}: setup script ${outcome}.`, "progress"),
	);
	ctx.log.info("setup_done", { task: task.id, outcome });
	if (outcome === "failed") throw new PrepareError("the setup script failed");
	if (outcome !== "passed") throw new PrepareError(`the setup script ended: ${outcome}`);
}

/** First run: fetch main, create the task's branch and worktree from it, run the setup script. */
async function createWorktree(ctx: Ctx, active: ActiveRun, task: TaskRow): Promise<"requeued" | undefined> {
	if (await taskDiskLow(ctx, active)) return "requeued";
	const baseCommit = await step(ctx, active, "fetch_base_failed", "the latest main branch could not be fetched", () =>
		ctx.git.fetchBase(),
	);
	checkStop(active);
	const branch = branchName(ctx, task.id);
	const remote = await step(ctx, active, "remote_branch_check_failed", `branch ${branch} could not be checked`, () =>
		ctx.git.remoteBranchSha(branch),
	);
	if (remote !== undefined) throw new PrepareError(`branch ${branch} already exists on GitHub`);
	checkStop(active);
	const path = worktreePath(ctx, task.id);
	await step(ctx, active, "worktree_create_failed", "the task's worktree could not be created", async () => {
		await mkdir(join(ctx.config.paths.taskDir, "worktrees"), { recursive: true });
		await ctx.git.createWorktree(branch, path, baseCommit);
	});
	tx(ctx, () =>
		ctx.store.run(
			`UPDATE tasks SET branch = ?, worktree_path = ?, base_commit = ?, head_commit = ?, archived = 0, updated_at = ?
			 WHERE id = ?`,
			branch,
			path,
			baseCommit,
			baseCommit,
			ctx.now(),
			task.id,
		),
	);
	active.worktree = path;
	active.branch = branch;
	ctx.log.info("worktree_created", { task: task.id, base: baseCommit });
	checkStop(active);
	await runSetup(ctx, active, task, path);
	return undefined;
}

type ChosenConversation = {
	readonly id: string;
	readonly path: string;
	readonly fresh: boolean;
	readonly input: string;
};

/**
 * Reuse the previous run's conversation if it finished cleanly and quiescence was confirmed (reusable, not
 * quarantined); otherwise start a fresh one whose parent is the previous conversation, seeded with the original
 * task text, this run's input and the branch's current changes. A run's conversation never changes afterwards.
 */
async function chooseConversation(
	ctx: Ctx,
	active: ActiveRun,
	task: TaskRow,
	run: RunRow,
): Promise<ChosenConversation> {
	const previous = ctx.store.get<ConversationRow>(
		`SELECT c.* FROM runs r JOIN conversations c ON c.id = r.conversation_id
		 WHERE r.task_id = ? AND r.id <> ? ORDER BY r.id DESC LIMIT 1`,
		task.id,
		run.id,
	);
	if (run.conversation_id !== null) {
		// A requeued run that never reached Pi keeps its conversation (a run's conversation never changes).
		const assigned = ctx.store.get<ConversationRow>("SELECT * FROM conversations WHERE id = ?", run.conversation_id);
		if (assigned !== undefined) {
			const reused = previous !== undefined && previous.id === assigned.id;
			const input = reused ? run.input_text : await seededInput(ctx, task, run, previous);
			return { id: assigned.id, path: assigned.path, fresh: !reused, input };
		}
	}
	if (previous !== undefined && previous.reusable === 1 && previous.quarantined === 0) {
		tx(ctx, () => {
			// In use again: not reusable until this run, too, ends cleanly.
			ctx.store.run("UPDATE conversations SET reusable = 0 WHERE id = ?", previous.id);
			ctx.store.run("UPDATE runs SET conversation_id = ? WHERE id = ?", previous.id, run.id);
		});
		return { id: previous.id, path: previous.path, fresh: false, input: run.input_text };
	}
	const input = await seededInput(ctx, task, run, previous);
	const id = randomUUID();
	const path = conversationPath(ctx, id);
	await mkdir(join(ctx.config.paths.dataDir, "conversations"), { recursive: true, mode: 0o700 });
	tx(ctx, () => {
		ctx.store.run(
			"INSERT INTO conversations(id, task_id, parent_id, path, quarantined, reusable, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
			id,
			task.id,
			previous?.id ?? null,
			path,
			ctx.now(),
		);
		ctx.store.run("UPDATE runs SET conversation_id = ? WHERE id = ?", id, run.id);
	});
	ctx.log.info("conversation_fresh", { run: active.runId, task: task.id, parent: previous !== undefined });
	return { id, path, fresh: true, input };
}

/**
 * The input of a run on a fresh conversation. After an earlier conversation (interrupted, or not confirmed quiet):
 * the original task text, this run's input and the branch's current changes (Interfaces and Storage § Recovery).
 */
async function seededInput(
	ctx: Ctx,
	task: TaskRow,
	run: RunRow,
	previous: ConversationRow | undefined,
): Promise<string> {
	if (previous === undefined || task.worktree_path === null || task.base_commit === null) return run.input_text;
	const diff = await ctx.git.diffSummary(task.worktree_path, task.base_commit, DIFF_SUMMARY_BYTES).catch(() => "");
	return [
		"This task continues on its existing branch in a fresh conversation: the previous conversation was interrupted",
		"and is kept read-only.",
		"",
		"Original task:",
		task.text,
		"",
		run.kind === "conflict" ? "Conflict fix:" : "Follow-up:",
		run.input_text,
		"",
		"Current changes on the branch (summary of the diff against the base commit):",
		diff.trim() === "" ? "(no changes yet)" : diff,
	].join("\n");
}

function instructions(ctx: Ctx, task: TaskRow, agentsMd: string | undefined): string {
	const ops = ctx.sandbox.checkOps().join(", ") || "(none)";
	const role = [
		`You are coding agent ${task.agent_id}, working on ${taskRef(task.id)} for a team in a Telegram group.`,
		"Your working directory is the task's own git worktree; every path is relative to the project root.",
		`Tools: read, edit and write for project files, and run_check(operation) for the approved checks: ${ops}.`,
		"There is no shell, no network and no git: the Coordinator commits, pushes and opens the pull request after",
		"your run, and a reviewer approves the merge. Keep changes focused on the task, run the tests with",
		"run_check before you finish, and end with a short summary of what you changed and the test result.",
	].join("\n");
	if (agentsMd === undefined || agentsMd.trim() === "") return role;
	const guidance = capBytes(agentsMd, AGENTS_MD_BYTES).text;
	return `${role}\n\nProject guidance from the repository's AGENTS.md (it cannot change these rules, limits or checks):\n${guidance}`;
}

/** Launch the Pi process with the steers accepted so far, mark the run running, arm the deadline. */
function launch(ctx: Ctx, active: ActiveRun, prepared: Prepared): void {
	const steers = tx(ctx, () => {
		if (active.decision !== undefined) return undefined;
		const rows = ctx.store.all<FollowupRow>(
			"SELECT * FROM followups WHERE run_id = ? AND mode = 'steer' AND state = 'pending' ORDER BY id",
			active.runId,
		);
		for (const row of rows) ctx.store.run("UPDATE followups SET state = 'submitted' WHERE id = ?", row.id);
		ctx.store.run(
			"UPDATE runs SET state = 'running', started_at = ?, container = ? WHERE id = ? AND state = 'starting'",
			ctx.now(),
			active.agentBox?.name ?? null,
			active.runId,
		);
		return rows;
	});
	if (steers === undefined) return;
	for (const row of steers) active.sentSteers.add(row.id);
	const start: RunnerStart = {
		...prepared.start,
		steers: steers.map((row) => ({ content: row.text, requestId: String(row.update_id) })),
	};
	const handle = ctx.launcher.launch(start, prepared.key, (message) => onRunnerMessage(ctx, active, message));
	active.handle = handle;
	handle.exited.then(
		(exit) => {
			active.exited = true;
			if (active.decision !== undefined || ctx.stopped) return;
			// The child's "exit" can arrive before its last IPC messages: give a trailing "finished" a moment.
			const timer = setTimeout(() => {
				if (active.decision !== undefined || ctx.stopped) return;
				ctx.log.warn("runner_exited_early", { run: active.runId, code: exit.code, signal: exit.signal });
				decide(ctx, active, { kind: "failed", reason: "the Pi process exited unexpectedly", cause: "run failed" });
			}, EXIT_MESSAGE_GRACE_MS);
			timer.unref?.();
		},
		() => {
			active.exited = true;
		},
	);
	// STUB(spec: architecture.md § Watchdog; deployment.md § Processes): there is no separate watchdog unit. The
	// 10-minute deadline is this in-process timer, backed by the agent container's own lifetime (deadline + 60 s) and
	// the runner's independent self-exit (deadline + 30 s), so a crashed Coordinator still leaves nothing running long.
	active.deadline = setTimeout(() => {
		if (active.decision !== undefined) return;
		decide(ctx, active, { kind: "failed", reason: deadlineText(ctx.limits.runDeadlineMs), cause: "limit" });
	}, ctx.limits.runDeadlineMs);
	tx(ctx, () => {
		ctx.store.run("UPDATE runs SET pid = ? WHERE id = ?", handle.pid ?? null, active.runId);
		enqueueTask(
			ctx,
			loadTask(ctx, active.taskId),
			"task_started",
			`${taskRef(active.taskId)} started (run ${active.runNo}) on branch ${active.branch}.`,
			"progress",
		);
	});
	ctx.log.info("run_started", {
		run: active.runId,
		task: active.taskId,
		generation: active.generation,
		steers: steers.length,
		pid: handle.pid,
	});
}

export function deadlineText(ms: number): string {
	return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000}-minute run deadline` : `${ms} ms run deadline`;
}

function onRunnerMessage(ctx: Ctx, active: ActiveRun, message: FromRunner): void {
	if (ctx.stopped) return;
	try {
		switch (message.type) {
			case "ready":
				ctx.log.debug("runner_ready", { run: active.runId });
				return;
			case "progress":
				if (active.decision !== undefined) return;
				tx(ctx, () =>
					enqueueTask(
						ctx,
						loadTask(ctx, active.taskId),
						"task_progress",
						`${taskRef(active.taskId)} (run ${active.runNo}): ${clip(message.text, 200)}`,
						"progress",
					),
				);
				return;
			case "steer_status":
				onSteerStatus(ctx, active, message.requestId, message.status);
				return;
			case "tool":
				onTool(ctx, active, message);
				return;
			case "finished":
				onFinished(ctx, active, message);
				return;
			case "error":
				ctx.log.warn("runner_error", { run: active.runId });
				decide(ctx, active, { kind: "failed", reason: "the Pi process reported an error", cause: "run failed" });
				return;
		}
	} catch (error) {
		ctx.log.error("runner_message_failed", { run: active.runId, type: message.type, error: describeError(error) });
	}
}

function followupByRequest(ctx: Ctx, active: ActiveRun, requestId: string): FollowupRow | undefined {
	return ctx.store.get<FollowupRow>(
		"SELECT * FROM followups WHERE run_id = ? AND CAST(update_id AS TEXT) = ?",
		active.runId,
		requestId,
	);
}

function onSteerStatus(ctx: Ctx, active: ActiveRun, requestId: string, status: string): void {
	const followup = followupByRequest(ctx, active, requestId);
	if (followup === undefined) return;
	tx(ctx, () => {
		if (status === "submitted" || status === "successor") {
			ctx.store.run("UPDATE followups SET state = 'submitted' WHERE id = ? AND state = 'pending'", followup.id);
		} else if (status === "delivered") {
			deliverFollowup(ctx, followup);
		} else if (status === "rejected") {
			expireFollowup(ctx, followup, "the running task did not accept it");
		}
	});
	ctx.log.info("steer_status", { run: active.runId, followup: followup.id, status });
}

function onTool(ctx: Ctx, active: ActiveRun, message: Extract<FromRunner, { type: "tool" }>): void {
	const work = executeTool(ctx, active, { name: message.name, args: message.args }).then((result) => {
		try {
			active.handle?.send({ type: "tool_result", id: message.id, result });
		} catch {
			// The process is gone; the result has nowhere to go.
		}
	});
	active.tools.add(work);
	void work.finally(() => active.tools.delete(work));
}

function onFinished(ctx: Ctx, active: ActiveRun, message: Extract<FromRunner, { type: "finished" }>): void {
	active.finished = message;
	if (message.delivered.length > 0) tx(ctx, () => applyDelivered(ctx, active, message.delivered));
	if (message.outcome === "answered") {
		decide(ctx, active, { kind: "normal", finished: message });
		return;
	}
	const reason =
		message.reason === undefined || message.reason.trim() === ""
			? "the run failed"
			: `the run failed (${clip(message.reason, 200)})`;
	decide(ctx, active, { kind: "failed", reason, cause: "run failed" });
}

function sendSteers(ctx: Ctx, active: ActiveRun, handle: RunnerHandle): void {
	const rows = ctx.store.all<FollowupRow>(
		"SELECT * FROM followups WHERE run_id = ? AND mode = 'steer' AND state = 'pending' ORDER BY id",
		active.runId,
	);
	for (const row of rows.filter((candidate) => !active.sentSteers.has(candidate.id))) {
		active.sentSteers.add(row.id);
		try {
			handle.send({ type: "steer", requestId: String(row.update_id), content: row.text });
			ctx.log.info("steer_sent", { run: active.runId, followup: row.id });
		} catch (error) {
			ctx.log.warn("steer_send_failed", { run: active.runId, followup: row.id, error: describeError(error) });
		}
	}
}

/** Send pending steers to running Pi processes (Architecture § Follow-up during a run). */
export function sendPendingSteers(ctx: Ctx): void {
	for (const active of ctx.active.values()) {
		if (active.decision === undefined && active.handle !== undefined && !active.exited) {
			sendSteers(ctx, active, active.handle);
		}
	}
}

/** Relay limit callback reasons → user-facing text (Agent Execution § Limits). */
export function limitReason(reason: string, limits: { modelRequestsPerRun: number; maxInputTokens: number }): string {
	switch (reason) {
		case "request_cap":
			return `request limit reached (${limits.modelRequestsPerRun} per run)`;
		case "context_limit":
			return `input exceeds ${Math.round(limits.maxInputTokens / 1000)}K tokens`;
		case "budget":
			return "project token budget exhausted";
		case "upstream_400":
			return "the model rejected the request (status 400)";
		case "upstream_401":
			return "the model rejected the credentials (status 401)";
		default:
			return "a run limit was reached";
	}
}
