/**
 * Trial evaluations in the Coordinator's store (table `evaluations`, schema v4; src/coordinator/engine/seal.ts runs
 * them). Shared by the engine, the command front (waiting notes), the owner socket's status and the CLI's read-only
 * status: what is being sealed, and what the last evaluation found. Metadata only.
 *
 * Architecture § Sealing: "Dispatch is held deployment-wide" while a group is sealing; § Request Flow: "Evaluation holds
 * all deployment-wide dispatch from sealing until the evaluator exits and cleanup is verified" — deploymentHeld().
 */
import { clip, sha7, taskRef } from "./messages.ts";
import type { EvaluatorSuite } from "./ports.ts";
import type { Store } from "./store.ts";

/** A trial id: letters, digits, ".", "_" and "-", starting with a letter or digit, at most 64 characters. */
export const TRIAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type EvaluationState = "sealing" | "snapshot" | "evaluating" | "cleanup" | "done";
export type EvaluationOutcome = "passed" | "not_passed" | "interrupted" | "error";

export type EvaluationRow = {
	id: number;
	chat_id: number;
	trial: string;
	state: EvaluationState;
	detail: string | null;
	tasks: string;
	tasks_named: number;
	last_task_id: number;
	requested_at: number;
	sealed_at: number | null;
	snapshot_commit: string | null;
	snapshot_tree: string | null;
	snapshot_hash: string | null;
	snapshot_path: string | null;
	scratch_path: string | null;
	started_ok: number | null;
	started_at: number | null;
	finished_at: number | null;
	outcome: EvaluationOutcome | null;
	reason: string | null;
	suites: string | null;
	facts: string | null;
	cleanup_verified: number | null;
};

/** The evaluation still in progress (not done) of any group, or of `chatId`. */
export function activeEvaluation(store: Store, chatId?: number): EvaluationRow | undefined {
	return chatId === undefined
		? store.get<EvaluationRow>("SELECT * FROM evaluations WHERE state != 'done' ORDER BY id LIMIT 1")
		: store.get<EvaluationRow>(
				"SELECT * FROM evaluations WHERE state != 'done' AND chat_id = ? ORDER BY id LIMIT 1",
				chatId,
			);
}

/** The group's most recent finished evaluation. */
export function lastEvaluation(store: Store, chatId: number): EvaluationRow | undefined {
	return store.get<EvaluationRow>(
		"SELECT * FROM evaluations WHERE state = 'done' AND chat_id = ? ORDER BY id DESC LIMIT 1",
		chatId,
	);
}

/**
 * Dispatch (and merges, and follow-up delivery) is held deployment-wide: some group of this deployment is sealing, or
 * an evaluation has not finished (its evaluator may still run or its cleanup is not verified yet).
 */
export function deploymentHeld(store: Store): boolean {
	const row = store.get<{ n: number }>(
		`SELECT (SELECT COUNT(*) FROM groups WHERE state = 'sealing') + (SELECT COUNT(*) FROM evaluations WHERE state != 'done')
		 AS n`,
	);
	return (row?.n ?? 0) > 0;
}

/**
 * Some evaluation of this deployment is in its evaluator or cleanup phase: its evaluator may run, or its cleanup's stop
 * step (every container removed, the watchdog's sweep) is due. Nothing that runs a check (a recovery job) may start
 * then (Architecture § Sealing: "Evaluation and execution never overlap").
 */
export function evaluatorPhase(store: Store): boolean {
	return store.get("SELECT 1 AS found FROM evaluations WHERE state IN ('evaluating', 'cleanup') LIMIT 1") !== undefined;
}

/** The trial's task ids recorded at the request. */
export function trialTasks(row: Pick<EvaluationRow, "tasks">): number[] {
	try {
		const parsed = JSON.parse(row.tasks) as unknown;
		return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isSafeInteger(id)) : [];
	} catch {
		return [];
	}
}

export function suitesOf(row: Pick<EvaluationRow, "suites">): EvaluatorSuite[] {
	if (row.suites === null) return [];
	try {
		const parsed = JSON.parse(row.suites) as unknown;
		return Array.isArray(parsed) ? (parsed as EvaluatorSuite[]) : [];
	} catch {
		return [];
	}
}

export function taskList(ids: readonly number[]): string {
	return ids.length === 0 ? "none" : ids.map(taskRef).join(", ");
}

const OUTCOME_WORDS: Readonly<Record<EvaluationOutcome, string>> = {
	passed: "PASSED",
	not_passed: "NOT PASSED",
	interrupted: "INTERRUPTED (not graded; reported as not tested)",
	error: "NOT EVALUATED",
};

export function outcomeWord(outcome: EvaluationOutcome | null): string {
	return outcome === null ? "unknown" : OUTCOME_WORDS[outcome];
}

/** "module:signup passed, integration failed (exit 1)". */
export function suiteSummary(suites: readonly EvaluatorSuite[]): string {
	if (suites.length === 0) return "none graded";
	return suites
		.map((suite) => {
			const exit = suite.outcome === "failed" && suite.exitCode !== undefined ? ` (exit ${suite.exitCode})` : "";
			return `${suite.name} ${suite.outcome.replace("_", " ")}${exit}`;
		})
		.join(", ");
}

const PHASE_WORDS: Readonly<Record<EvaluationState, string>> = {
	sealing: "sealing (finishing the runs and merge tests in progress)",
	snapshot: "taking the snapshot of main",
	evaluating: "the evaluator is grading the snapshot",
	cleanup: "verifying the evaluator's cleanup",
	done: "done",
};

function iso(ms: number | null): string {
	return ms === null ? "?" : new Date(ms).toISOString();
}

/** The evaluation in progress, as owner status shows it (sealing progress). */
function activeLine(active: EvaluationRow, chatId: number): string {
	const where = active.chat_id === chatId ? "" : ` (group ${active.chat_id})`;
	const detail = active.detail === null ? "" : `; ${clip(active.detail, 200)}`;
	const snapshot = active.snapshot_commit === null ? "" : `; snapshot of main at ${sha7(active.snapshot_commit)}`;
	return (
		`Evaluation in progress: trial ${active.trial}${where}, ${PHASE_WORDS[active.state]} since ` +
		`${iso(active.requested_at)}${detail}${snapshot}; trial tasks: ${taskList(trialTasks(active))}. Dispatch is ` +
		"held deployment-wide until the evaluator has exited and its cleanup is verified."
	);
}

const CLEANUP_WORDS = ["; cleanup NOT verified", "; cleanup verified"];

/** A finished evaluation, as owner status shows it: outcome, snapshot, tasks, per-suite outcomes, cleanup. */
function lastLine(last: EvaluationRow): string {
	const snapshot =
		last.snapshot_commit === null ? "no snapshot" : `snapshot ${sha7(last.snapshot_commit)} at ${last.snapshot_path}`;
	const cleanup = last.cleanup_verified === null ? "" : CLEANUP_WORDS[last.cleanup_verified];
	const reason = last.reason === null ? "" : ` (${clip(last.reason, 200)})`;
	return (
		`Last evaluation: trial ${last.trial} ${outcomeWord(last.outcome)}${reason} at ${iso(last.finished_at)}; ` +
		`${snapshot}; trial tasks: ${taskList(trialTasks(last))}; suites: ${suiteSummary(suitesOf(last))}${cleanup}`
	);
}

/** owner status: the evaluation in progress, then the group's last finished one. */
export function evaluationLines(store: Store, chatId: number): string[] {
	const active = activeEvaluation(store);
	const last = lastEvaluation(store, chatId);
	return [
		...(active === undefined ? [] : [activeLine(active, chatId)]),
		last === undefined ? "Last evaluation: none" : lastLine(last),
	];
}
