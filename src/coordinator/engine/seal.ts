/**
 * Sealing and the isolated evaluator (Architecture § Sealing, § Isolated evaluator, § Request Flow; Capacity
 * § Evaluator, § Exclusive phases; Deployment § Evaluation exclusivity; Evaluation § What's Graded, § Frozen Before
 * Trial 1). The trial harness's trigger is the owner CLI: `owner seal [<group>] [--trial <id>] [--tasks <id,...>]`.
 *
 * Request (requestSeal): refused, with the reason, unless the group is normal, nothing else is being evaluated, the
 * trial id is new (a trial is evaluated once: never rerun or replaced), the hidden tests are configured and outside the
 * task and data directories, the evaluator is available, and every one of the trial's tasks is merged. The trial's
 * tasks: those named with --tasks, else every task of the group created since the previous evaluation's request. Then,
 * in one transaction, the group turns "sealing" and the evaluation is recorded: dispatch, merges and follow-up delivery
 * are held deployment-wide (deploymentHeld) from here until the evaluator has exited and its cleanup is verified.
 *
 * Phases (evaluations.state), each persisted before the next starts:
 *   sealing     wait until everything in progress is finalized: no active run, no merge, no execution slot, no
 *               recovery job, cancel or reconciliation in flight, the watchdog ready. New /task requests and replies
 *               are saved and queued meanwhile; replies are not delivered to running tasks (a reply to a running task
 *               becomes another run of it when that run ends, or expires with it). Then execution is verified stopped:
 *               the recovery stop step (kills verified) and the watchdog's sweep, verified (else the group freezes).
 *   snapshot    fetch main, check it contains every trial task's merged head, export that commit read-only with its
 *               manifest (engine/snapshot.ts); record the commit, tree and content hash. Resumed after a restart, it
 *               first waits like sealing (restart recovery's jobs, the watchdog) and verifies execution stopped again.
 *   evaluating  the evaluator container, 2 vCPU / 2 GiB, no network, the snapshot and the hidden tests read-only, a
 *               fresh scratch directory (sandbox/evaluator.ts); its suites one after another; the outcome per suite and
 *               "passed" only if every one passed; what the trial records (versions, image digests, tool policy
 *               version, container limits, the hidden tests' and snapshot's hashes).
 *   cleanup     the evaluator container verified gone, the scratch directory wiped and verified gone, the snapshot
 *               verified unchanged, then the watchdog's sweep verified; then, in one transaction, the result is recorded
 *               and posted to the group and the group turns normal: dispatch reopens and queued work runs.
 * The evaluator failing to start, or a cleanup that cannot be verified, freezes the group instead (the result is
 * recorded either way). A restart during an evaluation: the evaluator was removed by recovery; it is recorded as
 * interrupted (not graded: "not tested", never a pass), its cleanup verified, and dispatch reopens. No recovery job
 * runs while an evaluation is in its evaluating or cleanup phase (engine.ts): its checks would overlap the evaluator,
 * and the cleanup's stop step removes every container. A freeze while sealing stops the evaluation (its evaluator is
 * stopped and cleaned up) and leaves the group frozen.
 */
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_POLICY_VERSION } from "../../runner/policy.ts";
import { buildVersions } from "../../runtime/version.ts";
import { pathsOverlap } from "../config.ts";
import {
	activeEvaluation,
	type EvaluationOutcome,
	type EvaluationRow,
	outcomeWord,
	suiteSummary,
	suitesOf,
	TRIAL_ID,
	taskList,
	trialTasks,
} from "../evaluation.ts";
import { describeState, sha7, type TaskState } from "../messages.ts";
import type { Evaluator, EvaluatorRun } from "../ports.ts";
import { evaluationPassed } from "../sandbox/evaluator-output.ts";
import { type Ctx, describeError, freezeGroup, freezeInTx, taskRef, tx } from "./context.ts";
import { stopLeftovers, stopProblem } from "./recovery.ts";
import { exportSnapshot, removeTree, snapshotIntact, snapshotPaths, treeHash } from "./snapshot.ts";

export type SealRequest = {
	readonly trial?: string | undefined;
	/** The trial's tasks; undefined: every task of the group since the previous evaluation's request. */
	readonly tasks?: readonly number[] | undefined;
};

export type SealOutcome =
	| { readonly kind: "started"; readonly trial: string; readonly tasks: readonly number[]; readonly named: boolean }
	| { readonly kind: "refused"; readonly reason: string };

/** What the engine knows that the seal machine needs (engine.ts). */
export type SealHooks = {
	/** What the sealing still waits for before execution is verified stopped, or undefined when nothing is in flight. */
	waitingFor(): string | undefined;
	/** The watchdog is ready (a verified sweep, a fresh heartbeat). */
	watchdogReady(): boolean;
};

/** An evaluator for an engine built without one: sealing is refused. */
export const NO_EVALUATOR: Evaluator = {
	available: async () => ({ ok: false, reason: "no evaluator is configured" }),
	facts: () => undefined,
	run: async () => ({ kind: "not_started", reason: "no evaluator is configured" }),
	live: async () => [],
	killAll: async () => {},
	createScratch: async () => {
		throw new Error("no evaluator is configured");
	},
	wipeScratch: async () => true,
};

const SCRATCH_DIR = "eval-scratch";
const RETRY_FACTOR = 20;

const refused = (reason: string): SealOutcome => ({ kind: "refused", reason });

function loadEvaluation(ctx: Ctx, id: number): EvaluationRow | undefined {
	return ctx.store.get<EvaluationRow>("SELECT * FROM evaluations WHERE id = ?", id);
}

// ---------------------------------------------------------------------------------------------------------------
// The request

/** A new trial id when the owner names none: trial-<n>, the first free one. */
function newTrialId(ctx: Ctx): string {
	const count = ctx.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM evaluations")?.n ?? 0;
	for (let n = count + 1; ; n++) {
		const id = `trial-${n}`;
		if (ctx.store.get("SELECT 1 AS found FROM evaluations WHERE trial = ?", id) === undefined) return id;
	}
}

/** The checks that read the database only (repeated in the transaction that starts the sealing). */
function stateBlocker(ctx: Ctx, trial: string): string | undefined {
	const group = ctx.store.groupState(ctx.chatId);
	if (group.state === "frozen") return "the group is frozen; owner unfreeze first (it repeats the recovery checks)";
	const active = activeEvaluation(ctx.store);
	if (group.state === "sealing" || active !== undefined)
		return `trial ${active?.trial ?? "?"} is being sealed and evaluated; one evaluation at a time`;
	if (group.recheck) return "a recovery recheck is pending; try again in a moment";
	if (ctx.store.get("SELECT 1 AS found FROM evaluations WHERE trial = ?", trial) !== undefined)
		return `trial ${trial} was evaluated already (a trial is never rerun or replaced); name a new one with --trial`;
	return undefined;
}

/** The hidden tests: configured, a real directory, and outside the task and data directories (resolved). */
async function hiddenTestsProblem(ctx: Ctx): Promise<string | undefined> {
	const dir = ctx.config.evaluation.hiddenTestsDir;
	if (dir === undefined) return "no hidden tests are configured (set PI_EVAL_HIDDEN_TESTS_DIR)";
	try {
		if (!(await lstat(dir)).isDirectory()) return "PI_EVAL_HIDDEN_TESTS_DIR is not a directory (or is a symlink)";
		const real = await realpath(dir);
		const roots = await Promise.all([ctx.config.paths.taskDir, ctx.config.paths.dataDir].map((path) => realpath(path)));
		if (roots.some((root) => pathsOverlap(real, root)))
			return "PI_EVAL_HIDDEN_TESTS_DIR overlaps PI_TASK_DIR or PI_DATA_DIR (agents' containers mount from there)";
		return undefined;
	} catch {
		return "PI_EVAL_HIDDEN_TESTS_DIR cannot be read";
	}
}

type TaskBrief = { id: number; state: TaskState; chat_id: number };

/** The trial's tasks and the highest task id now: named ones, or every task since the previous evaluation. */
function trialSelection(ctx: Ctx, named: readonly number[] | undefined): { ids: number[]; last: number } {
	const last =
		ctx.store.get<{ n: number | null }>("SELECT MAX(id) AS n FROM tasks WHERE chat_id = ?", ctx.chatId)?.n ?? 0;
	if (named !== undefined) return { ids: [...new Set(named)].sort((a, b) => a - b), last };
	const since =
		ctx.store.get<{ n: number | null }>("SELECT MAX(last_task_id) AS n FROM evaluations WHERE chat_id = ?", ctx.chatId)
			?.n ?? 0;
	const rows = ctx.store.all<{ id: number }>(
		"SELECT id FROM tasks WHERE chat_id = ? AND id > ? ORDER BY id",
		ctx.chatId,
		since,
	);
	return { ids: rows.map((row) => row.id), last };
}

/** Every trial task must be the group's and merged; otherwise the reason names each one that is not. */
function unmergedReason(ctx: Ctx, ids: readonly number[], named: boolean): string | undefined {
	const problems = ids.flatMap((id) => {
		const task = ctx.store.get<TaskBrief>("SELECT id, state, chat_id FROM tasks WHERE id = ?", id);
		if (task === undefined || task.chat_id !== ctx.chatId) return [`${taskRef(id)} (no such task in this group)`];
		return task.state === "merged" ? [] : [`${taskRef(id)} (${describeState(task.state)})`];
	});
	if (problems.length === 0) return undefined;
	const which = named
		? "the tasks named with --tasks"
		: "every task of the group since the last evaluation; name them with --tasks <id,...> to choose";
	return `the trial's tasks must all be merged first; not merged: ${problems.join(", ")}. The trial's tasks are ${which}`;
}

function sealStartedText(trial: string, ids: readonly number[]): string {
	const tasks = ids.length === 0 ? "no trial task of its own" : `the trial's tasks (${taskList(ids)}) are merged`;
	return (
		`Sealing for trial ${trial}: ${tasks}. Dispatch is held across the ` +
		"deployment until the evaluator has graded a snapshot of main and its cleanup is verified; runs and merge tests " +
		"in progress finish first. New /task requests and replies are saved and queued meanwhile, and replies are not " +
		"delivered to running tasks."
	);
}

/** In one transaction: the checks again, the trial's tasks, the evaluation recorded, the group sealing, the notice. */
function beginSeal(ctx: Ctx, trial: string, request: SealRequest): SealOutcome {
	return tx(ctx, (): SealOutcome => {
		const blocked = stateBlocker(ctx, trial);
		if (blocked !== undefined) return refused(blocked);
		const named = request.tasks !== undefined;
		const { ids, last } = trialSelection(ctx, request.tasks);
		const unmerged = unmergedReason(ctx, ids, named);
		if (unmerged !== undefined) return refused(unmerged);
		const now = ctx.now();
		ctx.store.run(
			`INSERT INTO evaluations(chat_id, trial, state, detail, tasks, tasks_named, last_task_id, requested_at)
			 VALUES (?, ?, 'sealing', NULL, ?, ?, ?, ?)`,
			ctx.chatId,
			trial,
			JSON.stringify(ids),
			named ? 1 : 0,
			last,
			now,
		);
		ctx.store.run(
			`INSERT INTO groups(chat_id, state, reason, recheck_required, updated_at) VALUES (?, 'sealing', ?, 0, ?)
			 ON CONFLICT(chat_id) DO UPDATE SET state = 'sealing', reason = excluded.reason, updated_at = excluded.updated_at`,
			ctx.chatId,
			`trial ${trial}`,
			now,
		);
		ctx.store.enqueue({
			chatId: ctx.chatId,
			priority: "required",
			kind: "seal_started",
			text: sealStartedText(trial, ids),
		});
		return { kind: "started", trial, tasks: ids, named };
	});
}

/** The owner's seal request (owner socket). */
export async function requestSeal(ctx: Ctx, request: SealRequest): Promise<SealOutcome> {
	if (request.trial !== undefined && !TRIAL_ID.test(request.trial))
		return refused("a trial id is letters, digits, '.', '_' or '-' (at most 64, starting with a letter or digit)");
	const trial = request.trial ?? newTrialId(ctx);
	const blocked = stateBlocker(ctx, trial) ?? (await hiddenTestsProblem(ctx));
	if (blocked !== undefined) return refused(blocked);
	const available = await ctx.evaluator.available().catch(() => ({ ok: false, reason: "the check failed" }) as const);
	if (!available.ok) return refused(`the evaluator is not available: ${available.reason}`);
	const outcome = beginSeal(ctx, trial, request);
	if (outcome.kind === "started") {
		ctx.log.info("seal_started", { trial, tasks: outcome.tasks.length, named: outcome.named });
		ctx.kick();
	}
	return outcome;
}

// ---------------------------------------------------------------------------------------------------------------
// Recording

function setDetail(ctx: Ctx, id: number, detail: string | null): void {
	const row = loadEvaluation(ctx, id);
	if (row === undefined || row.detail === detail) return;
	tx(ctx, () => ctx.store.run("UPDATE evaluations SET detail = ? WHERE id = ?", detail, id));
}

/**
 * Move to the next phase only while the group is still sealing (a freeze meanwhile leaves the phase as it was, and the
 * next tick stops the evaluation). True if it moved.
 */
function moveIfSealing(
	ctx: Ctx,
	id: number,
	state: EvaluationRow["state"],
	fields: Record<string, string | number | null>,
): boolean {
	return tx(ctx, () => {
		if (ctx.store.groupState(ctx.chatId).state !== "sealing") return false;
		moveTo(ctx, id, state, fields);
		return true;
	});
}

function moveTo(ctx: Ctx, id: number, state: EvaluationRow["state"], fields: Record<string, string | number | null>) {
	const names = Object.keys(fields);
	ctx.store.run(
		`UPDATE evaluations SET state = ?, detail = NULL${names.map((name) => `, ${name} = ?`).join("")} WHERE id = ?`,
		state,
		...names.map((name) => fields[name] ?? null),
		id,
	);
}

/** What the trial records about the build (Evaluation § Frozen Before Trial 1). */
function trialFacts(ctx: Ctx, hidden: { hash: string; files: number }): string {
	const { limits } = ctx;
	return JSON.stringify({
		versions: buildVersions(),
		model: { id: ctx.config.model.modelId, thinking: ctx.config.model.thinkingLevel },
		toolPolicyVersion: TOOL_POLICY_VERSION,
		checkOps: [...ctx.sandbox.checkOps()].sort(),
		images: { ...(ctx.sandbox.images?.() ?? {}), evaluator: ctx.evaluator.facts() },
		hiddenTests: hidden,
		limits: {
			agent: { cpus: limits.agentCpus, memoryMiB: limits.agentMemoryMiB, pids: limits.agentPids },
			check: { cpus: limits.checkCpus, memoryMiB: limits.checkMemoryMiB, pids: limits.checkPids },
			evaluator: { cpus: limits.evaluatorCpus, memoryMiB: limits.evaluatorMemoryMiB, pids: limits.evaluatorPids },
			runDeadlineMs: limits.runDeadlineMs,
			checkDeadlineMs: limits.checkDeadlineMs,
			evaluatorDeadlineMs: limits.evaluatorDeadlineMs,
			modelRequestsPerRun: limits.modelRequestsPerRun,
			maxInputTokens: limits.maxInputTokens,
			maxOutputTokens: limits.maxOutputTokens,
		},
	});
}

/** The evaluator's run as recorded: outcome, reason, whether it started. */
function judged(ctx: Ctx, result: EvaluatorRun): { outcome: EvaluationOutcome; reason: string | null; started: 0 | 1 } {
	if (result.kind === "not_started") return { outcome: "error", reason: "the evaluator could not start", started: 0 };
	if (evaluationPassed(result)) return { outcome: "passed", reason: null, started: 1 };
	const minutes = Math.round(ctx.limits.evaluatorDeadlineMs / 60_000);
	const reasons: Readonly<Record<typeof result.end, string | null>> = {
		exited: null,
		timeout: `the ${minutes}-minute evaluation deadline stopped it`,
		aborted: "the evaluator was stopped: the group left sealing",
		error: "the evaluator did not finish cleanly (a limit, or its launcher failed)",
	};
	const outcome = result.end === "aborted" ? "interrupted" : "not_passed";
	return { outcome, reason: reasons[result.end], started: 1 };
}

// ---------------------------------------------------------------------------------------------------------------
// Phases

/** Execution verified stopped (kills verified, the watchdog's sweep verified); an unverified stop freezes. */
async function stoppedVerified(ctx: Ctx, row: EvaluationRow): Promise<boolean> {
	const stop = await stopLeftovers(ctx, "recheck");
	const problem = stopProblem(stop);
	if (problem !== undefined) {
		freezeGroup(ctx, `before the evaluation of trial ${row.trial}: ${problem}`);
		return false;
	}
	if (stop.sweep === "unavailable") {
		setDetail(ctx, row.id, "waiting for the watchdog to answer its sweep");
		return false;
	}
	ctx.seal.verified = row.id;
	return true;
}

/** sealing → snapshot: execution verified stopped. */
async function verifyStopped(ctx: Ctx, row: EvaluationRow): Promise<boolean> {
	if (!(await stoppedVerified(ctx, row))) return false;
	if (!moveIfSealing(ctx, row.id, "snapshot", { sealed_at: ctx.now() })) return false;
	ctx.log.info("seal_sealed", { trial: row.trial });
	return true;
}

/** Trial tasks whose merged head is not in `commit` (main changed outside the Coordinator). */
async function notOnMain(ctx: Ctx, row: EvaluationRow, commit: string): Promise<number[]> {
	const missing: number[] = [];
	for (const id of trialTasks(row)) {
		const head = ctx.store.get<{ head_commit: string | null }>("SELECT head_commit FROM tasks WHERE id = ?", id);
		const contained =
			head?.head_commit != null && (await ctx.git.isAncestor(head.head_commit, commit).catch(() => false));
		if (!contained) missing.push(id);
	}
	return missing;
}

/** Done without an evaluator run: nothing to clean; the group turns normal unless it froze. */
function endUnevaluated(ctx: Ctx, row: EvaluationRow, reason: string, freeze: string | undefined): void {
	tx(ctx, () => {
		const now = ctx.now();
		moveTo(ctx, row.id, "done", { outcome: "error", reason, finished_at: now, started_ok: 0 });
		const text = `Trial ${row.trial} was not evaluated: ${reason}. Nothing was graded.`;
		ctx.store.enqueue({
			chatId: ctx.chatId,
			priority: "required",
			kind: "seal_result",
			text: `${text}${reopenNote(freeze)}`,
		});
		if (freeze !== undefined) freezeInTx(ctx, freeze);
		else reopen(ctx, now);
	});
	ctx.log.warn("seal_not_evaluated", { trial: row.trial });
	ctx.kick();
}

function reopenNote(freeze: string | undefined): string {
	return freeze === undefined ? " Dispatch has reopened." : " The group is frozen; only the owner CLI can unfreeze it.";
}

/** The group leaves sealing: dispatch reopens for the queued work. Inside the transaction. */
function reopen(ctx: Ctx, now: number): void {
	ctx.store.run(
		"UPDATE groups SET state = 'normal', reason = NULL, updated_at = ? WHERE chat_id = ? AND state = 'sealing'",
		now,
		ctx.chatId,
	);
}

/**
 * snapshot → evaluating: main fetched, the trial's merges on it, the commit exported read-only and recorded. Found in
 * this phase after a restart (not verified by this process), execution is verified stopped again first: restart
 * recovery's jobs (e.g. a review step's tests) may have run since (Capacity § Exclusive phases).
 */
async function snapshotPhase(ctx: Ctx, row: EvaluationRow): Promise<boolean> {
	if (ctx.seal.verified !== row.id && !(await stoppedVerified(ctx, row))) return false;
	let commit: string;
	try {
		commit = await ctx.git.fetchBase();
	} catch (error) {
		ctx.log.warn("seal_fetch_failed", { trial: row.trial, error: describeError(error) });
		ctx.seal.retryAt = Date.now() + ctx.retryDelayMs * RETRY_FACTOR;
		setDetail(ctx, row.id, "fetching main failed; trying again");
		return false;
	}
	const missing = await notOnMain(ctx, row, commit);
	if (missing.length > 0) {
		const reason = `main at ${sha7(commit)} does not contain the merge of ${taskList(missing)} (main changed outside the Coordinator?)`;
		endUnevaluated(ctx, row, reason, undefined);
		return false;
	}
	let snapshot: Awaited<ReturnType<typeof exportSnapshot>>;
	try {
		snapshot = await exportSnapshot(ctx.git, ctx.config.paths.taskDir, { trial: row.trial, commit });
	} catch (error) {
		ctx.log.error("seal_snapshot_failed", { trial: row.trial, error: describeError(error) });
		endUnevaluated(ctx, row, "the snapshot of main could not be taken", `the snapshot for trial ${row.trial} failed`);
		return false;
	}
	const moved = moveIfSealing(ctx, row.id, "evaluating", {
		snapshot_commit: snapshot.commit,
		snapshot_tree: snapshot.tree,
		snapshot_hash: snapshot.hash,
		snapshot_path: snapshot.path,
	});
	if (!moved) return false;
	const text = `Trial ${row.trial}: main is sealed at ${sha7(snapshot.commit)}; the evaluator is grading that snapshot.`;
	tx(ctx, () => ctx.store.enqueue({ chatId: ctx.chatId, priority: "progress", kind: "seal_snapshot", text }));
	ctx.log.info("seal_snapshot", { trial: row.trial, files: snapshot.files, bytes: snapshot.bytes });
	return true;
}

/** Why the evaluator must not start now, if anything: the snapshot changed, hidden tests unreadable, execution live. */
type Preflight =
	| { readonly problem: string; readonly hidden?: undefined }
	| { readonly hidden: { hash: string; files: number } };

async function preflight(ctx: Ctx, row: EvaluationRow): Promise<Preflight> {
	if (
		row.snapshot_path === null ||
		row.snapshot_hash === null ||
		!(await snapshotIntact(row.snapshot_path, row.snapshot_hash))
	)
		return { problem: "the sealed snapshot changed or is missing" };
	const hiddenProblem = await hiddenTestsProblem(ctx);
	const hidden = await treeHash(ctx.config.evaluation.hiddenTestsDir ?? "").catch(() => undefined);
	if (hiddenProblem !== undefined || hidden === undefined)
		return { problem: hiddenProblem ?? "the hidden tests cannot be read" };
	const live = await ctx.sandbox.live().catch(() => undefined);
	if (live === undefined || live.length > 0 || ctx.active.size > 0)
		return { problem: "execution containers could not be verified gone" };
	return { hidden: { hash: hidden.hash, files: hidden.files } };
}

/** evaluating → cleanup: the evaluator runs once; its result is recorded. */
async function evaluatePhase(ctx: Ctx, row: EvaluationRow): Promise<boolean> {
	const checked = await preflight(ctx, row);
	if (checked.hidden === undefined) {
		ctx.log.error("seal_preflight_failed", { trial: row.trial });
		tx(ctx, () => moveTo(ctx, row.id, "cleanup", { outcome: "error", reason: checked.problem, started_ok: 0 }));
		return true;
	}
	const scratch = await newScratch(ctx, row);
	if (scratch === undefined) {
		// The evaluator cannot start without its scratch space: recorded as not started, so the group freezes.
		const reason = "the evaluator's scratch space could not be created";
		tx(ctx, () => moveTo(ctx, row.id, "cleanup", { outcome: "error", reason, started_ok: 0 }));
		return true;
	}
	const facts = trialFacts(ctx, checked.hidden);
	// Recorded before the container starts, so a restart finds the scratch space to wipe; not if the group froze.
	const recorded = moveIfSealing(ctx, row.id, "evaluating", { scratch_path: scratch, started_at: ctx.now(), facts });
	if (!recorded) {
		await ctx.evaluator.wipeScratch(scratch).catch(() => false);
		return false;
	}
	const result = await runEvaluator(ctx, row, scratch);
	if (ctx.stopped) return false;
	const verdict = judged(ctx, result);
	tx(ctx, () =>
		moveTo(ctx, row.id, "cleanup", {
			outcome: verdict.outcome,
			reason: verdict.reason,
			started_ok: verdict.started,
			suites: JSON.stringify(result.kind === "ran" ? result.suites : []),
			finished_at: ctx.now(),
		}),
	);
	ctx.log.info("seal_evaluated", { trial: row.trial, outcome: verdict.outcome });
	return true;
}

/** A fresh scratch directory under `<taskDir>/eval-scratch`, or undefined if it cannot be created. */
async function newScratch(ctx: Ctx, row: EvaluationRow): Promise<string | undefined> {
	try {
		const root = join(ctx.config.paths.taskDir, SCRATCH_DIR);
		await mkdir(root, { recursive: true, mode: 0o700 });
		return await ctx.evaluator.createScratch(root);
	} catch (error) {
		ctx.log.error("evaluator_scratch_failed", { trial: row.trial, error: describeError(error) });
		return undefined;
	}
}

async function runEvaluator(ctx: Ctx, row: EvaluationRow, scratch: string): Promise<EvaluatorRun> {
	const controller = new AbortController();
	ctx.seal.abort = controller;
	try {
		return await ctx.evaluator.run({
			trial: row.trial,
			snapshot: row.snapshot_path ?? "",
			hiddenTests: ctx.config.evaluation.hiddenTestsDir ?? "",
			scratch,
			deadlineMs: ctx.limits.evaluatorDeadlineMs,
			signal: controller.signal,
		});
	} catch (error) {
		ctx.log.error("evaluator_run_failed", { trial: row.trial, error: describeError(error) });
		return { kind: "not_started", reason: "the evaluator run failed" };
	} finally {
		ctx.seal.abort = undefined;
	}
}

/** The evaluator's containers gone (killed if needed), its scratch wiped, the snapshot unchanged. The problems. */
async function verifyCleanup(ctx: Ctx, row: EvaluationRow): Promise<string[]> {
	const problems: string[] = [];
	const gone = async (): Promise<boolean> => (await ctx.evaluator.live().catch(() => undefined))?.length === 0;
	if (!(await gone())) {
		await ctx.evaluator.killAll().catch(() => undefined);
		if (!(await gone())) problems.push("the evaluator container could not be verified gone");
	}
	if (row.scratch_path !== null && !(await ctx.evaluator.wipeScratch(row.scratch_path).catch(() => false)))
		problems.push("the evaluator's scratch space could not be wiped");
	if (
		row.snapshot_path !== null &&
		row.snapshot_hash !== null &&
		!(await snapshotIntact(row.snapshot_path, row.snapshot_hash))
	)
		problems.push("the sealed snapshot changed during the evaluation");
	return problems;
}

function resultText(row: EvaluationRow, tail: string): string {
	const suites = suitesOf(row);
	const passed = suites.filter((suite) => suite.outcome === "passed").length;
	const snapshot = row.snapshot_commit === null ? "" : ` Snapshot of main at ${sha7(row.snapshot_commit)}.`;
	const reason = row.reason === null ? "" : `: ${row.reason}`;
	return (
		`Evaluation of trial ${row.trial}: ${outcomeWord(row.outcome)}${reason}.${snapshot} Trial tasks: ` +
		`${taskList(trialTasks(row))}. Suites (${passed} of ${suites.length} passed): ${suiteSummary(suites)}.${tail}`
	);
}

/** The freeze reason a finished evaluation leaves, if any: cleanup not verified, or the evaluator never started. */
function freezeReason(row: EvaluationRow, problems: readonly string[]): string | undefined {
	if (problems.length > 0)
		return `the evaluator's cleanup for trial ${row.trial} could not be verified (${problems.join("; ")})`;
	if (row.started_ok === 0) return `the evaluator for trial ${row.trial} could not start`;
	return undefined;
}

/** What the result message ends with: dispatch reopened, or the group frozen (by this evaluation or before). */
function resultTail(group: string, freeze: string | undefined): string {
	if (group === "sealing") return reopenNote(freeze);
	return group === "frozen" ? " The group is frozen; only the owner CLI can unfreeze it." : "";
}

/**
 * cleanup → done, in one transaction: recorded and posted; a group still sealing reopens (its cleanup verified and the
 * evaluator started) or freezes; a group that left sealing stays as it is.
 */
function finish(ctx: Ctx, row: EvaluationRow, problems: readonly string[]): void {
	const freeze = freezeReason(row, problems);
	const reopened = tx(ctx, () => {
		const now = ctx.now();
		const group = ctx.store.groupState(ctx.chatId).state;
		moveTo(ctx, row.id, "done", {
			cleanup_verified: problems.length === 0 ? 1 : 0,
			finished_at: row.finished_at ?? now,
		});
		const done = loadEvaluation(ctx, row.id) ?? row;
		const text = resultText(done, resultTail(group, freeze));
		ctx.store.enqueue({ chatId: ctx.chatId, priority: "required", kind: "seal_result", text });
		if (group !== "sealing") return false;
		if (freeze !== undefined) freezeInTx(ctx, freeze);
		else reopen(ctx, now);
		return freeze === undefined;
	});
	ctx.log.info("seal_done", { trial: row.trial, outcome: row.outcome, cleanup: problems.length === 0, reopened });
	ctx.kick();
}

/**
 * The cleanup phase. While the group is still sealing, the watchdog's sweep must verify execution stopped (as at a
 * restart) before dispatch reopens; unanswered, the evaluation waits in this phase. A frozen group skips it: the
 * owner's unfreeze repeats it.
 */
async function cleanupPhase(ctx: Ctx, row: EvaluationRow): Promise<boolean> {
	const sealing = ctx.store.groupState(ctx.chatId).state === "sealing";
	const problems = await verifyCleanup(ctx, row);
	if (sealing && problems.length === 0) {
		const stop = await stopLeftovers(ctx, "recheck");
		const problem = stopProblem(stop);
		if (problem === undefined && stop.sweep === "unavailable") {
			setDetail(ctx, row.id, "waiting for the watchdog to answer its sweep");
			return false;
		}
		if (problem !== undefined) problems.push(problem);
	}
	if (ctx.stopped) return false;
	finish(ctx, row, problems);
	return false;
}

type Phase = (ctx: Ctx, row: EvaluationRow) => Promise<boolean>;

const PHASES: Readonly<Record<Exclude<EvaluationRow["state"], "done">, Phase>> = {
	sealing: verifyStopped,
	snapshot: snapshotPhase,
	evaluating: evaluatePhase,
	cleanup: cleanupPhase,
};

/** Run the phases one after another while the group stays sealing (cleanup also runs for a frozen group). */
async function advance(ctx: Ctx, id: number): Promise<void> {
	for (;;) {
		const row = loadEvaluation(ctx, id);
		if (row === undefined || row.state === "done" || ctx.stopped) return;
		const sealing = ctx.store.groupState(ctx.chatId).state === "sealing";
		if (!sealing && row.state !== "cleanup") return;
		if (!(await PHASES[row.state](ctx, row))) return;
	}
}

/** An evaluation this process did not start was in its evaluator phase: a restart removed the evaluator. */
function markInterrupted(ctx: Ctx, row: EvaluationRow, why: string): void {
	tx(ctx, () =>
		moveTo(ctx, row.id, "cleanup", {
			outcome: "interrupted",
			reason: why,
			suites: row.suites ?? "[]",
			finished_at: ctx.now(),
		}),
	);
	ctx.log.warn("seal_interrupted", { trial: row.trial });
}

/** The group left sealing (it froze) before the evaluator ran: the evaluation ends, ungraded; the group stays. */
async function stopBeforeEvaluator(ctx: Ctx, row: EvaluationRow, state: string): Promise<void> {
	await removeTree(snapshotPaths(ctx.config.paths.taskDir, row.trial, "x").partial).catch(() => false);
	tx(ctx, () => {
		moveTo(ctx, row.id, "done", {
			outcome: "error",
			reason: `the group was ${state} while sealing`,
			finished_at: ctx.now(),
		});
		const text = `Trial ${row.trial} was not evaluated: the group was ${state} while sealing. Nothing was graded.`;
		ctx.store.enqueue({ chatId: ctx.chatId, priority: "required", kind: "seal_result", text });
	});
	ctx.log.warn("seal_stopped", { trial: row.trial, group: state });
}

/** Tracked work of the seal machine; one at a time. */
function startWork(ctx: Ctx, work: () => Promise<void>): true {
	ctx.seal.working = true;
	ctx.track("seal", undefined, async () => {
		try {
			await work();
		} finally {
			ctx.seal.working = false;
		}
	});
	return true;
}

/** The group is sealing but no evaluation holds it (an older version, a lost row): fail closed. */
function strayHold(ctx: Ctx): boolean {
	if (ctx.store.groupState(ctx.chatId).state !== "sealing") return false;
	freezeGroup(ctx, "the group was sealing without an evaluation in progress");
	return true;
}

/** The group is no longer sealing (it froze): stop the evaluation. */
function leftSealing(ctx: Ctx, row: EvaluationRow, state: string): boolean {
	if (row.state === "sealing" || row.state === "snapshot")
		return startWork(ctx, () => stopBeforeEvaluator(ctx, row, state));
	return startWork(ctx, async () => {
		if (row.state === "evaluating") markInterrupted(ctx, row, `the group was ${state} during the evaluation`);
		await advance(ctx, row.id);
	});
}

/**
 * The phase may start now: sealing (and a snapshot phase resumed after a restart, whose recovery jobs may still run)
 * waits for everything in flight and the watchdog; cleanup for the watchdog.
 */
function phaseReady(ctx: Ctx, hooks: SealHooks, row: EvaluationRow): boolean {
	if (Date.now() < ctx.seal.retryAt) return false;
	if (row.state === "cleanup") return hooks.watchdogReady();
	if (row.state === "evaluating") return true;
	const waiting = hooks.waitingFor();
	setDetail(ctx, row.id, waiting === undefined ? null : `waiting for ${waiting}`);
	return waiting === undefined;
}

/** The evaluation of a sealing group: its next phase, or (found in its evaluator phase) the interrupted one. */
function nextPhase(ctx: Ctx, hooks: SealHooks, row: EvaluationRow): boolean {
	if (!phaseReady(ctx, hooks, row)) return false;
	// Not started by this process (this process's run is tracked work): a restart removed its evaluator.
	if (row.state === "evaluating")
		return startWork(ctx, async () => {
			markInterrupted(ctx, row, "interrupted by a restart");
			await advance(ctx, row.id);
		});
	return startWork(ctx, () => advance(ctx, row.id));
}

/** One look at the evaluation in progress (each engine tick); true if it started work. */
export function sealTick(ctx: Ctx, hooks: SealHooks): boolean {
	const group = ctx.store.groupState(ctx.chatId).state;
	// A freeze while the evaluator runs stops it at once; the run then records and cleans up.
	if (group !== "sealing") ctx.seal.abort?.abort();
	if (ctx.seal.working || ctx.stopped) return false;
	const row = activeEvaluation(ctx.store, ctx.chatId);
	if (row === undefined) return strayHold(ctx);
	return group === "sealing" ? nextPhase(ctx, hooks, row) : leftSealing(ctx, row, group);
}
