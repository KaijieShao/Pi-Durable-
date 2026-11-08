/**
 * The owner's unfreeze (Architecture § Frozen group: "Only the owner CLI unfreezes the group, after resolution";
 * Interfaces and Storage § Recovery After a Restart: "Owner review resolves and unfreezes the group, then recovery
 * checks are repeated before dispatch opens for admitted work; interrupted tasks never resume automatically", and
 * § After owner resolution: "The owner unfreezes through the CLI, then recovery checks repeat before dispatch opens
 * for admitted work"). Asked over the owner socket (src/coordinator/owner/service.ts).
 *
 * The group stays frozen while the checks run; it becomes normal only if every one passes, else it stays frozen and
 * the owner is told which check failed (the checks after it are not run):
 *
 *   runs        nothing of the group is still stopping (the freeze cancelled its runs; their finalize, a merge, a
 *               recovery job or a cancel in flight ends first; bounded wait)
 *   run keys    step 1: every run key closed
 *   leftovers   step 2: the Coordinator's own kills of leftover Pi processes and containers, verified
 *   watchdog    step 2: the watchdog's sweep (reason recheck) answered and verified
 *   merges      step 3: every saved merge intent checked against GitHub (main contains its head → merged, no second
 *               merge; it does not → returned); a GitHub read that fails leaves it unknown
 *   file changes  step 3: every pending file change reconciled from its target; none unresolved without the owner's
 *               resolution (`owner resolve <change>` records it)
 *   relay       step 4: the relay is running
 *   no new freeze  nothing froze the group again while the checks ran: no freeze by the engine (e.g. a /cancel's
 *               archive that could not reach GitHub; cancels go on while the group is frozen) and no stop the
 *               watchdog could not verify (its own freeze of a frozen group changes nothing in the database)
 *
 * Then, in one step, the group is set normal and the recovery jobs the checks found (redo a review step or an archive,
 * tell an interrupted run's users what its worktree keeps) are queued; dispatch reopens once they are done and the
 * watchdog's heartbeat is fresh. Tasks cancelled by the freeze stay cancelled, and nothing interrupted resumes.
 */
import type { CheckReport } from "../owner/protocol.ts";
import { type Ctx, loadTask, sleep, taskRef, tx } from "./context.ts";
import {
	freezeOnUnresolved,
	type IntentRow,
	newlyUnresolved,
	reconcilePending,
	tasksWithOpenIntents,
	unresolvedIntents,
} from "./intents.ts";
import {
	pendingMergeIntents,
	type RecoveryJob,
	reconcileDatabase,
	resolveIntent,
	type StopOutcome,
	stopLeftovers,
} from "./recovery.ts";

export type UnfreezeOutcome =
	| { readonly kind: "not_frozen"; readonly state: "normal" | "sealing" }
	| { readonly kind: "in_progress" }
	| { readonly kind: "refused"; readonly reason: string | null; readonly checks: readonly CheckReport[] }
	| {
			readonly kind: "unfrozen";
			readonly reason: string | null;
			readonly checks: readonly CheckReport[];
			readonly jobs: number;
	  };

/** Production bound on the wait for the group's runs (and other work in flight) to finish stopping. */
export const UNFREEZE_QUIET_MS = 60_000;

export type UnfreezeHooks = {
	/** Nothing of the engine is in flight: no live run, merge, recovery job, cancel or reconciliation. */
	quiet(): boolean;
	/** Queue the recovery jobs the checks found (before the group turns normal). */
	addJobs(jobs: readonly RecoveryJob[]): void;
	readonly quietMs: number;
};

type Checks = { readonly checks: CheckReport[]; readonly jobs: RecoveryJob[] };

const pass = (checks: CheckReport[], name: string, detail: string): void => {
	checks.push({ name, ok: true, detail });
};

async function waitQuiet(ctx: Ctx, hooks: UnfreezeHooks): Promise<boolean> {
	const deadline = Date.now() + hooks.quietMs;
	while (!hooks.quiet()) {
		if (ctx.stopped || Date.now() >= deadline) return false;
		await sleep(100);
	}
	return true;
}

/** Steps 1 and 2; the problem of the first that failed, if any. */
function stopChecks(stop: StopOutcome, ctx: Ctx, checks: CheckReport[]): CheckReport | undefined {
	pass(checks, "run keys", `${stop.closed} open run key${stop.closed === 1 ? "" : "s"} closed`);
	if (stop.own !== undefined) return { name: "leftovers", ok: false, detail: stop.own };
	pass(checks, "leftovers", `${stop.killed} leftover Pi process${stop.killed === 1 ? "" : "es"} killed; none left`);
	if (stop.sweep === "unavailable") {
		const seconds = Math.round(ctx.watchdog.answerTimeoutMs / 1000);
		return { name: "watchdog", ok: false, detail: `the watchdog did not answer its sweep request within ${seconds} s` };
	}
	if (stop.sweep === "unverified")
		return { name: "watchdog", ok: false, detail: "the watchdog could not verify that the leftovers are gone" };
	pass(checks, "watchdog", "its sweep verified the Pi slice and every labelled container empty");
	return undefined;
}

/** Step 3 against GitHub: every saved merge intent; the first GitHub cannot confirm fails the check. */
async function mergeCheck(ctx: Ctx, jobs: RecoveryJob[], checks: CheckReport[]): Promise<CheckReport | undefined> {
	const intents = pendingMergeIntents(ctx);
	for (const intent of intents) {
		try {
			await resolveIntent(ctx, intent, jobs);
		} catch (error) {
			const why = error instanceof Error && error.name === "UnknownEffect" ? error.message : "the check failed";
			ctx.log.warn("unfreeze_merge_unknown", { task: intent.task_id });
			return {
				name: "merges",
				ok: false,
				detail: `the saved merge of ${taskRef(intent.task_id)} is still unknown: ${why}`,
			};
		}
	}
	pass(checks, "merges", `${intents.length} saved merge intent${intents.length === 1 ? "" : "s"} checked on GitHub`);
	return undefined;
}

function unresolvedLine(row: IntentRow, worktree: string | null): string {
	const target = row.tool === "run_check" ? `run_check ${row.operation ?? "?"}` : `${row.tool} ${row.path ?? "?"}`;
	return `change ${row.id} (${taskRef(row.task_id)}, ${target}${worktree === null ? "" : ` in ${worktree}`})`;
}

/**
 * Step 3 on the worktrees: every pending file change reconciled (termination is confirmed: the stop checks passed);
 * a newly unresolved one tells its task's users once, as at a restart. Any unresolved change fails the check.
 */
async function fileCheck(ctx: Ctx, checks: CheckReport[]): Promise<CheckReport | undefined> {
	const unresolved: string[] = [];
	let reconciled = 0;
	for (const taskId of tasksWithOpenIntents(ctx.store)) {
		ctx.busy.set(taskId, "unfreeze");
		try {
			const task = loadTask(ctx, taskId);
			const settled = await reconcilePending(ctx, { taskId }, task.worktree_path);
			reconciled += settled.length;
			freezeOnUnresolved(ctx, taskId, newlyUnresolved(settled));
			for (const row of unresolvedIntents(ctx.store, taskId)) unresolved.push(unresolvedLine(row, task.worktree_path));
		} finally {
			ctx.busy.delete(taskId);
		}
	}
	if (unresolved.length > 0) {
		const detail =
			`unresolved: ${unresolved.join("; ")}. Review each file, then record your resolution with ` +
			"owner resolve <change> (the file is accepted as it is in the worktree)";
		return { name: "file changes", ok: false, detail };
	}
	pass(
		checks,
		"file changes",
		`${reconciled} pending change${reconciled === 1 ? "" : "s"} reconciled; none unresolved`,
	);
	return undefined;
}

/** The recovery checks in order; stops at the first that fails. */
async function runChecks(ctx: Ctx): Promise<Checks & { readonly failed: CheckReport | undefined }> {
	const checks: CheckReport[] = [];
	const jobs: RecoveryJob[] = [];
	const stop = await stopLeftovers(ctx, "recheck");
	const stopFailed = stopChecks(stop, ctx, checks);
	if (stopFailed !== undefined) return { checks, jobs, failed: stopFailed };
	// Step 3 in the database: nothing runs (quiet), so this only collects the jobs left to do and frees the slots. A task
	// an authorized /cancel archives meanwhile (cancels go on while the group is frozen) gets no job: that archive is
	// the cancel's own (a job would redo it and tell the task's users again); if it fails, the group freezes again.
	const found: RecoveryJob[] = [];
	reconcileDatabase(ctx, true, found);
	jobs.push(...found.filter((job) => !ctx.busy.has(job.taskId)));
	const failed = (await mergeCheck(ctx, jobs, checks)) ?? (await fileCheck(ctx, checks));
	if (failed !== undefined) return { checks, jobs, failed };
	if (ctx.relayUrl === undefined)
		return { checks, jobs, failed: { name: "relay", ok: false, detail: "the relay is not running" } };
	pass(checks, "relay", "running");
	return { checks, jobs, failed: undefined };
}

function refused(ctx: Ctx, reason: string | null, checks: readonly CheckReport[]): UnfreezeOutcome {
	const failed = checks.find((check) => !check.ok);
	ctx.log.warn("unfreeze_refused", { chat: ctx.chatId, check: failed?.name });
	return { kind: "refused", reason, checks };
}

/** What a new freeze is measured against: the engine's freezes and the watchdog's unverified sweeps so far. */
type FreezeMark = { readonly freezes: number; readonly unverified: number };

/**
 * Sweeps the watchdog answered "not verified", whatever their reason (a run's deadline, an earlier request answered
 * late): it freezes the group in the same transaction, which changes nothing while the group is frozen already.
 */
function unverifiedSweeps(ctx: Ctx): number {
	const sql = "SELECT COUNT(*) AS n FROM watchdog_sweeps WHERE state = 'done' AND verified = 0";
	return ctx.store.get<{ n: number }>(sql)?.n ?? 0;
}

const freezeMark = (ctx: Ctx): FreezeMark => ({ freezes: ctx.freezes, unverified: unverifiedSweeps(ctx) });

/** Something froze the group again while the checks ran, or the Coordinator is stopping. */
function interrupted(ctx: Ctx, mark: FreezeMark): CheckReport | undefined {
	const failed = (detail: string): CheckReport => ({ name: "no new freeze", ok: false, detail });
	if (ctx.stopped) return failed("the Coordinator is stopping");
	if (ctx.freezes !== mark.freezes) return failed(`the group froze again meanwhile (${ctx.lastFreezeReason})`);
	if (unverifiedSweeps(ctx) !== mark.unverified)
		return failed("the watchdog could not verify a stop meanwhile (owner status shows its last sweep)");
	return undefined;
}

/** How the last step ended: the group turned normal, it was no longer frozen, or the last check failed. */
type Settled =
	| { readonly kind: "unfrozen" }
	| { readonly kind: "not_frozen"; readonly state: "normal" | "sealing" }
	| { readonly kind: "refused"; readonly check: CheckReport };

/**
 * The last check (no new freeze) and, only if it passes, the group turned normal with the jobs queued: one
 * transaction, so a watchdog answer (its own transaction, with its freeze) lands either before it, and is seen, or after.
 */
function setNormal(ctx: Ctx, hooks: UnfreezeHooks, jobs: readonly RecoveryJob[], mark: FreezeMark): Settled {
	return tx(ctx, (): Settled => {
		const late = interrupted(ctx, mark);
		if (late !== undefined) return { kind: "refused", check: late };
		const updated = ctx.store.run(
			`UPDATE groups SET state = 'normal', reason = NULL, recheck_required = 0, updated_at = ?
			 WHERE chat_id = ? AND state = 'frozen'`,
			ctx.now(),
			ctx.chatId,
		).changes;
		if (updated > 0) {
			hooks.addJobs(jobs);
			return { kind: "unfrozen" };
		}
		const state = ctx.store.groupState(ctx.chatId).state;
		if (state !== "frozen") return { kind: "not_frozen", state };
		return { kind: "refused", check: { name: "group", ok: false, detail: "the group could not be updated" } };
	});
}

/** Run the checks of a frozen group and unfreeze it only if every one passes (see the module comment). */
export async function unfreezeGroup(ctx: Ctx, hooks: UnfreezeHooks): Promise<UnfreezeOutcome> {
	const { reason } = ctx.store.groupState(ctx.chatId);
	ctx.log.info("unfreeze_requested", { chat: ctx.chatId });
	if (!(await waitQuiet(ctx, hooks))) {
		const detail = ctx.stopped
			? "the Coordinator is stopping"
			: `the group's stopped runs (or other work in flight) did not finish within ${Math.round(hooks.quietMs / 1000)} s; try again`;
		return refused(ctx, reason, [{ name: "runs", ok: false, detail }]);
	}
	const mark = freezeMark(ctx);
	const result = await runChecks(ctx);
	const checks: CheckReport[] = [
		{ name: "runs", ok: true, detail: "nothing of the group is running" },
		...result.checks,
	];
	if (result.failed !== undefined) return refused(ctx, reason, [...checks, result.failed]);
	const settled = setNormal(ctx, hooks, result.jobs, mark);
	if (settled.kind === "not_frozen") return settled;
	if (settled.kind === "refused") return refused(ctx, reason, [...checks, settled.check]);
	ctx.log.info("group_unfrozen", { chat: ctx.chatId, jobs: result.jobs.length });
	ctx.kick();
	return { kind: "unfrozen", reason, checks, jobs: result.jobs.length };
}
