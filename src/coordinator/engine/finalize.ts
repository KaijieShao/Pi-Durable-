/**
 * Finalizing a run (Architecture § Finalizing a run; Agent Execution § Finalize and Pending Inputs).
 *
 * Normal completion: Pi reported `finished` only once it was idle and any successor drained. Close the key, let the
 * process exit (kill after the grace), stop the container and verify it gone, mark the conversation reusable, then
 * the post-run review step runs while the run still holds its slot. Once the run's request cap was reached, its
 * unsettled steers expire and none becomes another run. A refusal over the cap after the run's own input was answered
 * (only a successor whose input never reached the model was cut) is also a normal completion, without reuse.
 *
 * Cancel / limit / failure: revoke FIRST (close the key, so no successor or new request starts; pending follow-ups
 * expire), then abort Pi, let the in-flight tool round settle, terminate and verify; the task ends failed or
 * cancelled and its worktree is archived. A stop that cannot be confirmed freezes the group.
 *
 * Either way, once termination is verified the run's file changes still pending (a tool call cut by the stop, or one
 * whose outcome was unknown) are reconciled from their targets before the worktree is reviewed or archived (Agent
 * Execution § Uncertain Effects; engine/intents.ts): unresolved → the group freezes and the worktree waits for the
 * owner. Dispatch stays blocked until this reconciliation is done (ctx.reconciling).
 */
import { admitRun } from "../admission.ts";
import { followupExpired, followupStarted, reconciledEffects } from "../messages.ts";
import type { RunnerHandle } from "../ports.ts";
import {
	type ActiveRun,
	type Ctx,
	clipText,
	type Decision,
	describeError,
	enqueueTask,
	type FinishedMessage,
	type FollowupRow,
	freezeGroup,
	loadTask,
	releaseSlot,
	sleep,
	taskRef,
	tx,
} from "./context.ts";
import { archiveTask, effectFailed, terminalText } from "./effects.ts";
import { freezeOnUnresolved, type IntentRow, newlyUnresolved, reconcilePending, toReconciled } from "./intents.ts";
import { closeRunKeys } from "./keys.ts";
import { reviewStep } from "./review.ts";

const ANSWER_CHARS = 4000;

// ---------------------------------------------------------------------------------------------------------------
// Follow-up outcomes. Each accepted follow-up ends with exactly one outcome: the updates below only move rows that
// are still pending/submitted, and the message is enqueued in the same transaction.

/** Mark a steer delivered and tell the user. Call inside `store.tx()`. */
export function deliverFollowup(ctx: Ctx, followup: FollowupRow): void {
	const changes = ctx.store.run(
		"UPDATE followups SET state = 'delivered', settled_at = ? WHERE id = ? AND state IN ('pending', 'submitted')",
		ctx.now(),
		followup.id,
	).changes;
	if (changes === 0) return;
	ctx.store.enqueue({
		chatId: ctx.chatId,
		taskId: followup.task_id,
		priority: "required",
		kind: "followup_delivered",
		text: `Follow-up delivered to ${taskRef(followup.task_id)}.`,
		replyTo: followup.message_id,
	});
}

/** Expire one follow-up with `cause` and tell the user. Call inside `store.tx()`. */
export function expireFollowup(ctx: Ctx, followup: FollowupRow, cause: string): void {
	const changes = ctx.store.run(
		`UPDATE followups SET state = 'expired', reason = ?, settled_at = ?
		 WHERE id = ? AND state IN ('pending', 'submitted')`,
		`expired (${cause})`,
		ctx.now(),
		followup.id,
	).changes;
	if (changes === 0) return;
	ctx.store.enqueue({
		chatId: ctx.chatId,
		taskId: followup.task_id,
		priority: "required",
		kind: "followup_expired",
		text: followupExpired(followup.task_id, cause),
		replyTo: followup.message_id,
	});
}

/** Expire every unsettled follow-up of a run (or of a whole task). Call inside `store.tx()`. */
export function expireFollowups(ctx: Ctx, scope: { runId: number } | { taskId: number }, cause: string): number {
	const rows =
		"runId" in scope
			? ctx.store.all<FollowupRow>(
					"SELECT * FROM followups WHERE run_id = ? AND state IN ('pending', 'submitted') ORDER BY id",
					scope.runId,
				)
			: ctx.store.all<FollowupRow>(
					"SELECT * FROM followups WHERE task_id = ? AND state IN ('pending', 'submitted') ORDER BY id",
					scope.taskId,
				);
	for (const row of rows) expireFollowup(ctx, row, cause);
	return rows.length;
}

/** Steers the runner reports as placed into the conversation. Call inside `store.tx()`. */
export function applyDelivered(ctx: Ctx, active: ActiveRun, requestIds: readonly string[]): void {
	for (const requestId of requestIds) {
		const followup = ctx.store.get<FollowupRow>(
			"SELECT * FROM followups WHERE run_id = ? AND CAST(update_id AS TEXT) = ?",
			active.runId,
			requestId,
		);
		if (followup !== undefined) deliverFollowup(ctx, followup);
	}
}

/**
 * Follow-ups left after a normal completion (run already 'finished'). Delivered ones are marked delivered; once the
 * run's request cap was reached, every other one expires (Agent Execution § Finalize: "if the cap is already
 * reached, it expires"; Evaluation "Steer with cap used": no new run), as does one still unconsumed by an idle Pi;
 * one Pi never took (it arrived as the run ended) is admitted as another run of the task, like a reply during
 * review, or expires with the admission's reason. Call inside `store.tx()`.
 */
function settleAfterNormal(ctx: Ctx, active: ActiveRun, finished: FinishedMessage): void {
	applyDelivered(ctx, active, finished.delivered);
	const rows = ctx.store.all<FollowupRow>(
		"SELECT * FROM followups WHERE run_id = ? AND state IN ('pending', 'submitted') ORDER BY id",
		active.runId,
	);
	for (const row of rows) {
		const requestId = String(row.update_id);
		if (active.capReached || finished.unconsumed.includes(requestId)) {
			expireFollowup(ctx, row, "limit");
			continue;
		}
		const admitted = admitRun(ctx.store, ctx.limits, {
			taskId: row.task_id,
			kind: "followup",
			requestedBy: row.user_id,
			requestId,
			inputText: row.text,
			followupId: row.id,
		});
		if (!admitted.ok) {
			expireFollowup(ctx, row, admitted.reason);
			continue;
		}
		ctx.store.run(
			"UPDATE followups SET mode = 'run', state = 'started', run_id = ?, settled_at = ? WHERE id = ?",
			admitted.runId,
			ctx.now(),
			row.id,
		);
		const task = loadTask(ctx, row.task_id);
		ctx.store.enqueue({
			chatId: ctx.chatId,
			taskId: row.task_id,
			priority: "required",
			kind: "followup_started",
			text: followupStarted({
				taskId: row.task_id,
				position: admitted.position,
				hasPullRequest: task.pr_number !== null,
			}),
			replyTo: row.message_id,
		});
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Decision

/**
 * Record how the run ends; the first decision wins. Revocation happens here, synchronously, before any abort: the
 * run key is closed, the run leaves 'running' (the relay refuses it), and for an abnormal end every unsettled
 * follow-up expires. A run refused over its request cap was revoked already (`onCapRefused`: 'finalizing', no decision
 * yet); its answer or reason is recorded here.
 */
export function decide(ctx: Ctx, active: ActiveRun, decision: Decision): void {
	if (active.decision !== undefined) return;
	active.decision = decision;
	if (active.deadline !== undefined) clearTimeout(active.deadline);
	active.deadline = undefined;
	if (active.capTimer !== undefined) clearTimeout(active.capTimer);
	active.capTimer = undefined;
	if (!ctx.stopped) {
		try {
			tx(ctx, () => {
				const now = ctx.now();
				closeRunKeys(ctx.store, active, now);
				if (decision.kind === "normal") {
					ctx.store.run(
						`UPDATE runs SET state = 'finalizing', answer = ?
						 WHERE id = ? AND state IN ('starting', 'running', 'finalizing')`,
						clipText(decision.finished.answer ?? "", ANSWER_CHARS),
						active.runId,
					);
				} else {
					ctx.store.run(
						`UPDATE runs SET state = 'finalizing', reason = ?
						 WHERE id = ? AND state IN ('starting', 'running', 'finalizing')`,
						decision.reason,
						active.runId,
					);
					expireFollowups(ctx, { runId: active.runId }, decision.cause);
				}
			});
		} catch (error) {
			ctx.log.error("run_revoke_failed", { run: active.runId, error: describeError(error) });
		}
	}
	ctx.log.info("run_decided", {
		run: active.runId,
		task: active.taskId,
		outcome: decision.kind,
		...(decision.kind === "normal" ? {} : { cause: decision.cause }),
	});
	active.resolveDecision(decision);
}

// ---------------------------------------------------------------------------------------------------------------
// Stop and verify

/** Resolve true if `promise` settles within `ms`, false otherwise (the timer never keeps the process alive). */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
		timer.unref?.();
	});
	try {
		return await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			timeout,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function waitExit(handle: RunnerHandle, ms: number): Promise<boolean> {
	return settlesWithin(handle.exited, ms);
}

/**
 * Abort (abnormal only), wait for the Pi process to exit (kill after the grace), let in-flight tools settle, stop
 * the agent container and verify every container of the run's generation is gone.
 */
function quietly(work: () => void): void {
	try {
		work();
	} catch {
		// The channel or the process is gone already.
	}
}

/** Abort (abnormal only), wait for the Pi process to exit, kill it after the grace. True once it has exited. */
async function stopProcess(ctx: Ctx, active: ActiveRun, handle: RunnerHandle, decision: Decision): Promise<boolean> {
	const grace = ctx.limits.stopGraceMs;
	if (decision.kind !== "normal" && !active.exited) {
		quietly(() => handle.send({ type: "abort", reason: decision.reason }));
	}
	if (await waitExit(handle, grace)) return true;
	quietly(() => handle.kill());
	return waitExit(handle, grace);
}

/** Stop the agent container and verify every container of the run's generation is gone. */
async function stopContainers(ctx: Ctx, active: ActiveRun): Promise<boolean> {
	await active.agentBox?.stop().catch((error: unknown) => {
		ctx.log.warn("container_stop_failed", { run: active.runId, error: describeError(error) });
	});
	const filter = { taskId: active.taskId, generation: active.generation };
	const gone = async (): Promise<boolean> => (await ctx.sandbox.live(filter).catch(() => undefined))?.length === 0;
	if (await gone()) return true;
	await ctx.sandbox.killAll(filter).catch(() => undefined);
	await sleep(50);
	return gone();
}

/**
 * Abort (abnormal only), wait for the Pi process to exit (kill after the grace), let in-flight tools settle, stop
 * the agent container and verify every container of the run's generation is gone. Returns what could not be
 * confirmed, if anything.
 */
async function stopWorkload(ctx: Ctx, active: ActiveRun, decision: Decision): Promise<string | undefined> {
	const task = taskRef(active.taskId);
	const problems: string[] = [];
	const handle = active.handle;
	if (handle !== undefined && !(await stopProcess(ctx, active, handle, decision))) {
		problems.push(`the Pi process of ${task} could not be confirmed stopped`);
	}
	const settleMs = ctx.limits.checkDeadlineMs + ctx.limits.stopGraceMs;
	const settled = active.tools.size === 0 || (await settlesWithin(Promise.allSettled([...active.tools]), settleMs));
	const gone = await stopContainers(ctx, active);
	if (!gone) problems.push(`the containers of ${task} could not be verified gone`);
	// A tool call still unsettled once the Pi process and every container of the run are verified gone can no longer
	// act (its file operation or check ran in one of them): its effect is reconciled from its intent (reconcileRun).
	// Without that verification it stays unconfirmed.
	if (!settled) {
		ctx.log.warn("tool_unsettled_after_stop", { run: active.runId, verified: problems.length === 0 });
		if (problems.length > 0) problems.push(`a tool call of ${task} could not be confirmed settled`);
	}
	return problems[0];
}

type RunEffects = {
	/** Intents of the run that reconciliation settled now. */
	readonly reconciled: readonly IntentRow[];
	/** The freeze reason, when an intent of the task is unresolved (the worktree waits for the owner). */
	readonly frozen: string | undefined;
};

/**
 * Termination is verified: close the run's effects (no new intent, no late answer settles one) and reconcile what is
 * still pending from the targets (Agent Execution § Uncertain Effects, steps 2–4).
 */
async function reconcileRun(ctx: Ctx, active: ActiveRun): Promise<RunEffects> {
	const worktree = active.worktree ?? loadTask(ctx, active.taskId).worktree_path;
	const reconciled = await reconcilePending(ctx, { runId: active.runId }, worktree);
	const frozen = freezeOnUnresolved(ctx, active.taskId, newlyUnresolved(reconciled));
	if (reconciled.length > 0) ctx.log.info("run_effects_reconciled", { run: active.runId, count: reconciled.length });
	return { reconciled, frozen };
}

/** " Reconciled after the stop: a.js (edit): applied (…)." for a final message, or "". */
function effectsNote(effects: RunEffects | undefined): string {
	if (effects === undefined || effects.reconciled.length === 0) return "";
	return ` Reconciled after the stop: ${reconciledEffects(effects.reconciled.map(toReconciled))}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Finalize

/** Finalize a decided run, run the review step or the archive procedure, then release the slot. */
export async function finalizeRun(ctx: Ctx, active: ActiveRun, decision: Decision): Promise<void> {
	const problem = await stopWorkload(ctx, active, decision);
	// From here on no late answer settles an intent and no new one is saved: reconciliation (below, or recovery's after
	// an unconfirmed stop or a shutdown) owns what is still pending.
	active.effectsClosed = true;
	if (ctx.stopped) return;
	try {
		// An unconfirmed stop leaves pending intents pending: recovery reconciles them after the owner's unfreeze.
		const effects = problem === undefined ? await reconcileRun(ctx, active) : undefined;
		ctx.reconciling.delete(active.runId);
		if (decision.kind === "normal") await finalizeNormal(ctx, active, decision, problem, effects);
		else await finalizeAbnormal(ctx, active, decision, problem, effects);
	} finally {
		ctx.reconciling.delete(active.runId);
		// The slot is released only after verified cleanup (Architecture § Request Flow). An unconfirmed stop keeps it
		// (the group is frozen anyway); the recheck clears it once the leftovers are verified gone.
		if (!ctx.stopped && problem === undefined) {
			releaseSlot(ctx, active.slotId);
			ctx.log.info("slot_released", { run: active.runId, task: active.taskId });
		}
	}
}

async function finalizeNormal(
	ctx: Ctx,
	active: ActiveRun,
	decision: Extract<Decision, { kind: "normal" }>,
	problem: string | undefined,
	effects: RunEffects | undefined,
): Promise<void> {
	tx(ctx, () => {
		const now = ctx.now();
		ctx.store.run("UPDATE runs SET state = 'finished', ended_at = ? WHERE id = ?", now, active.runId);
		if (problem === undefined && decision.reusable) {
			// Quiescence confirmed: the next run of this task may reuse the conversation.
			ctx.store.run(
				`UPDATE conversations SET reusable = 1
				 WHERE id = (SELECT conversation_id FROM runs WHERE id = ?) AND quarantined = 0`,
				active.runId,
			);
		}
		settleAfterNormal(ctx, active, decision.finished);
	});
	if (problem !== undefined) {
		// review_done stays 0: the review step runs at the recheck after the owner resolves the freeze.
		freezeGroup(ctx, problem);
		return;
	}
	// A file change could not be reconciled: the group is frozen, and the review step (which commits and pushes the
	// worktree) runs at the recheck after the owner resolved it.
	if (effects?.frozen !== undefined) return;
	try {
		await reviewStep(ctx, active.runId, { interrupted: false });
	} catch (error) {
		effectFailed(ctx, error, `the review step of ${taskRef(active.taskId)}`);
	}
}

async function finalizeAbnormal(
	ctx: Ctx,
	active: ActiveRun,
	decision: Extract<Decision, { kind: "cancelled" | "failed" }>,
	problem: string | undefined,
	effects: RunEffects | undefined,
): Promise<void> {
	const kind = decision.kind;
	tx(ctx, () => {
		const now = ctx.now();
		ctx.store.run(
			"UPDATE runs SET state = ?, reason = COALESCE(reason, ?), ended_at = ? WHERE id = ?",
			kind,
			decision.reason,
			now,
			active.runId,
		);
		// The task ends here (a cancel or a limit ends the task); queued runs of it cannot start any more.
		ctx.store.run(
			"UPDATE runs SET state = 'cancelled', reason = ?, ended_at = ? WHERE task_id = ? AND state = 'queued'",
			kind === "cancelled" ? "cancelled" : "task failed",
			now,
			active.taskId,
		);
		expireFollowups(ctx, { taskId: active.taskId }, decision.cause);
		ctx.store.run(
			"UPDATE approvals SET state = 'invalidated', reason = ? WHERE task_id = ? AND state = 'valid'",
			kind === "cancelled" ? "task cancelled" : "task failed",
			active.taskId,
		);
		ctx.store.run(
			"UPDATE tasks SET state = ?, reason = ?, updated_at = ? WHERE id = ?",
			kind,
			decision.reason,
			now,
			active.taskId,
		);
		if (problem !== undefined) {
			const task = loadTask(ctx, active.taskId);
			const head =
				kind === "failed" ? `${taskRef(task.id)} failed: ${decision.reason}.` : `${taskRef(task.id)} cancelled.`;
			enqueueTask(
				ctx,
				task,
				"task_final",
				`${head} Its stop could not be confirmed, so the group is frozen; the worktree is archived after the owner resolves it.`,
			);
		}
	});
	if (problem !== undefined) {
		freezeGroup(ctx, problem);
		return;
	}
	if (effects?.frozen !== undefined) {
		// Never archive (final checkpoint, push) a worktree with an unresolved file change: after the owner's review.
		archivePending(ctx, active.taskId, kind, decision.reason);
		return;
	}
	const note = effectsNote(effects);
	try {
		await archiveTask(
			ctx,
			active.taskId,
			(result) => `${terminalText(loadTask(ctx, active.taskId), kind, decision.reason, result)}${note}`,
		);
	} catch (error) {
		effectFailed(ctx, error, `archiving ${taskRef(active.taskId)}`);
		archivePending(ctx, active.taskId, kind, decision.reason);
	}
}

/** The task ended but its worktree could not be archived yet (the group is frozen; recovery redoes the archive). */
export function archivePending(ctx: Ctx, taskId: number, kind: "failed" | "cancelled", reason: string | null): void {
	if (ctx.stopped) return;
	try {
		tx(ctx, () => {
			const task = loadTask(ctx, taskId);
			const head =
				kind === "failed" ? `${taskRef(taskId)} failed: ${reason ?? "run failed"}.` : `${taskRef(taskId)} cancelled.`;
			enqueueTask(
				ctx,
				task,
				"task_final",
				`${head} Its worktree could not be archived yet, so the group is frozen; the archive is retried after the owner resolves it.`,
			);
		});
	} catch (error) {
		ctx.log.error("archive_pending_notice_failed", { task: taskId, error: describeError(error) });
	}
}
