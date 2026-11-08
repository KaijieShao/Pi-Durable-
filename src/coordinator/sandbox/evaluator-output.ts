/**
 * What the evaluator's launcher (deploy/docker/run-eval.mjs) prints on its stdout, one JSON object per line, and how
 * the Coordinator reads it (shared by the Docker evaluator and the local test evaluator):
 *
 *   {"type":"plan","suites":["module:signup","integration","baseline"]}      the suites it will grade, in order
 *   {"type":"suite","name":"module:signup","outcome":"passed","exitCode":0,"durationMs":812}   one per suite
 *   {"type":"done"}                                                          every planned suite has a result
 *
 * Suite outcomes: passed (exit 0), failed (another exit code), timeout (its own bound or the overall deadline),
 * error (it could not run: no hidden tests for it, a launcher failure). Nothing else on stdout counts; a suite the
 * plan does not name is ignored, a planned suite without a result is not_run (or timeout, the one in progress when the
 * deadline stopped the container). No test output reaches the Coordinator: the launcher discards it.
 */
import type { EvaluatorRun, EvaluatorSuite, EvaluatorSuiteOutcome } from "../ports.ts";

const SUITE_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const REPORTED: ReadonlySet<string> = new Set(["passed", "failed", "timeout", "error"]);
/** deploy/docker/run-eval.mjs exits with this once its own deadline (PI_EVAL_DEADLINE_MS) has passed. */
export const LAUNCHER_DEADLINE_EXIT = 124;
/** At most this many suites are read from one plan. */
const MAX_SUITES = 256;

type Parsed = {
	plan: string[] | undefined;
	readonly results: Map<string, EvaluatorSuite>;
	done: boolean;
};

function asObject(line: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(line) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function planOf(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_SUITES) return undefined;
	const names = value.filter((name): name is string => typeof name === "string" && SUITE_NAME.test(name));
	return names.length === value.length && new Set(names).size === names.length ? names : undefined;
}

function suiteOf(fields: Record<string, unknown>): EvaluatorSuite | undefined {
	const { name, outcome, exitCode, durationMs } = fields;
	if (typeof name !== "string" || typeof outcome !== "string" || !REPORTED.has(outcome)) return undefined;
	return {
		name,
		outcome: outcome as EvaluatorSuiteOutcome,
		exitCode: typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? exitCode : undefined,
		durationMs: typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
	};
}

function readLine(parsed: Parsed, line: string): void {
	const fields = asObject(line);
	if (fields === undefined) return;
	if (fields.type === "plan" && parsed.plan === undefined) {
		parsed.plan = planOf(fields.suites);
		return;
	}
	if (fields.type === "done") {
		parsed.done = parsed.plan !== undefined;
		return;
	}
	if (fields.type !== "suite" || parsed.plan === undefined) return;
	const suite = suiteOf(fields);
	if (suite !== undefined && parsed.plan.includes(suite.name) && !parsed.results.has(suite.name))
		parsed.results.set(suite.name, suite);
}

/** The planned suites with their results, in plan order; the first missing one is "timeout" after a deadline. */
function planned(parsed: Parsed, timedOut: boolean): EvaluatorSuite[] {
	let marked = !timedOut;
	return (parsed.plan ?? []).map((name) => {
		const result = parsed.results.get(name);
		if (result !== undefined) return result;
		const outcome: EvaluatorSuiteOutcome = marked ? "not_run" : "timeout";
		marked = true;
		return { name, outcome, exitCode: undefined, durationMs: 0 };
	});
}

export type LauncherEnd = {
	/** The launcher's exit code (undefined when the container was stopped). */
	readonly exitCode: number | undefined;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	/** The container hit a limit (memory, output) or its state could not be read. */
	readonly failed: boolean;
	readonly durationMs: number;
};

type End = Extract<EvaluatorRun, { kind: "ran" }>["end"];

function endOf(parsed: Parsed, end: LauncherEnd, planned: number): End {
	// The launcher's own deadline (exit 124) is the evaluation's deadline too.
	if (end.timedOut || end.exitCode === LAUNCHER_DEADLINE_EXIT) return "timeout";
	if (end.aborted) return "aborted";
	const finished = parsed.done && end.exitCode === 0 && !end.failed && planned > 0;
	return finished ? "exited" : "error";
}

/** The run as the Coordinator records it, from the launcher's stdout and how its container ended. */
export function evaluatorRunOf(stdout: string, end: LauncherEnd): Extract<EvaluatorRun, { kind: "ran" }> {
	const parsed: Parsed = { plan: undefined, results: new Map(), done: false };
	for (const line of stdout.split("\n")) if (line.trim() !== "") readLine(parsed, line.trim());
	// Stopped by the Coordinator's deadline, the suite in progress has no line: it timed out. At its own deadline the
	// launcher reports that suite itself.
	const suites = planned(parsed, end.timedOut);
	return { kind: "ran", suites, end: endOf(parsed, end, suites.length), durationMs: end.durationMs };
}

/** "passed" only if the launcher ran every planned suite and each one passed (Evaluation § What's Graded). */
export function evaluationPassed(run: EvaluatorRun): boolean {
	return (
		run.kind === "ran" &&
		run.end === "exited" &&
		run.suites.length > 0 &&
		run.suites.every((suite) => suite.outcome === "passed")
	);
}
