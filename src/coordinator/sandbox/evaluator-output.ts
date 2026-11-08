/**
 * The trusted evaluator's version 3 protocol. The plan binds each suite to immutable hidden-test IDs; each result
 * names the tests attempted and passed. Missing, duplicate, truncated, unplanned or inconsistent records fail closed.
 * This parser is defense in depth: generated code executes in a separate app container and cannot emit this stream.
 */
import type { EvaluatorRun, EvaluatorSuite, EvaluatorSuiteOutcome } from "../ports.ts";

const SUITE_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const TEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REPORTED: ReadonlySet<string> = new Set(["passed", "failed", "timeout", "error"]);
export const LAUNCHER_DEADLINE_EXIT = 124;
const MAX_SUITES = 256;
const MAX_TESTS = 4096;

type Parsed = {
	plan: Map<string, string[]> | undefined;
	readonly results: Map<string, EvaluatorSuite>;
	done: boolean;
	invalid: boolean;
};

function asObject(line: string): Record<string, unknown> {
	const value = JSON.parse(line) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid record");
	return value as Record<string, unknown>;
}

function testIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > MAX_TESTS) throw new Error("invalid test IDs");
	const ids = value.filter((id): id is string => typeof id === "string" && TEST_ID.test(id));
	if (ids.length !== value.length || new Set(ids).size !== ids.length) throw new Error("invalid test IDs");
	return ids;
}

function same(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function planOf(fields: Record<string, unknown>): Map<string, string[]> {
	const { version, suites, expectedTests } = fields;
	if (version !== 3 || !Array.isArray(suites) || suites.length === 0 || suites.length > MAX_SUITES)
		throw new Error("invalid suite plan");
	if (typeof expectedTests !== "object" || expectedTests === null || Array.isArray(expectedTests))
		throw new Error("missing expected tests");
	const tests = expectedTests as Record<string, unknown>;
	const plan = new Map<string, string[]>();
	for (const name of suites) {
		if (typeof name !== "string" || !SUITE_NAME.test(name) || plan.has(name)) throw new Error("invalid suite name");
		plan.set(name, testIds(tests[name]));
	}
	if (Object.keys(tests).length !== plan.size) throw new Error("unplanned expected tests");
	return plan;
}

function validPassing(
	outcome: string,
	exitCode: unknown,
	expected: readonly string[],
	passed: readonly string[],
): boolean {
	return outcome !== "passed" || (exitCode === 0 && expected.length > 0 && same(passed, expected));
}

function suiteOf(fields: Record<string, unknown>, plan: Map<string, string[]>): EvaluatorSuite {
	const { name, outcome, exitCode, durationMs } = fields;
	if (typeof name !== "string" || typeof outcome !== "string" || !REPORTED.has(outcome))
		throw new Error("invalid suite result");
	const expected = plan.get(name);
	const declared = testIds(fields.expectedTests);
	const executed = testIds(fields.executedTests);
	const passed = testIds(fields.passedTests);
	if (expected === undefined || !same(declared, expected) || !same(executed, expected.slice(0, executed.length)))
		throw new Error("unexpected or missing test");
	if (
		!same(
			passed,
			executed.filter((id) => passed.includes(id)),
		)
	)
		throw new Error("test did not execute");
	if (!validPassing(outcome, exitCode, expected, passed)) throw new Error("incomplete passing suite");
	return {
		name,
		outcome: outcome as EvaluatorSuiteOutcome,
		exitCode: typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? exitCode : undefined,
		durationMs: typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
		expectedTests: expected,
		executedTests: executed,
		passedTests: passed,
	};
}

function readLine(parsed: Parsed, line: string): void {
	const fields = asObject(line);
	if (parsed.done) throw new Error("record after done");
	if (fields.type === "plan") {
		if (parsed.plan !== undefined) throw new Error("duplicate plan");
		parsed.plan = planOf(fields);
		return;
	}
	if (parsed.plan === undefined) throw new Error("no plan");
	if (fields.type === "done") {
		if (parsed.results.size !== parsed.plan.size) throw new Error("missing suite");
		parsed.done = true;
		return;
	}
	if (fields.type !== "suite") throw new Error("unrecognized record");
	const suite = suiteOf(fields, parsed.plan);
	if (parsed.results.has(suite.name)) throw new Error("duplicate suite");
	parsed.results.set(suite.name, suite);
}

function planned(parsed: Parsed, timedOut: boolean): EvaluatorSuite[] {
	let marked = !timedOut;
	return Array.from(parsed.plan ?? []).map(([name, expectedTests]) => {
		const result = parsed.results.get(name);
		if (result !== undefined) {
			if (result.outcome === "timeout") marked = true;
			return result;
		}
		const outcome: EvaluatorSuiteOutcome = marked ? "not_run" : "timeout";
		marked = true;
		return { name, outcome, exitCode: undefined, durationMs: 0, expectedTests, executedTests: [], passedTests: [] };
	});
}

export type LauncherEnd = {
	readonly exitCode: number | undefined;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly failed: boolean;
	readonly durationMs: number;
};

type End = Extract<EvaluatorRun, { kind: "ran" }>["end"];

function endOf(parsed: Parsed, end: LauncherEnd, count: number): End {
	if (end.timedOut || end.exitCode === LAUNCHER_DEADLINE_EXIT) return "timeout";
	if (end.aborted) return "aborted";
	const finished = parsed.done && !parsed.invalid && end.exitCode === 0 && !end.failed && count > 0;
	return finished ? "exited" : "error";
}

export function evaluatorRunOf(stdout: string, end: LauncherEnd): Extract<EvaluatorRun, { kind: "ran" }> {
	const parsed: Parsed = { plan: undefined, results: new Map(), done: false, invalid: false };
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		try {
			readLine(parsed, line);
		} catch {
			parsed.invalid = true;
		}
	}
	const suites = planned(parsed, end.timedOut || end.exitCode === LAUNCHER_DEADLINE_EXIT);
	return { kind: "ran", suites, end: endOf(parsed, end, suites.length), durationMs: end.durationMs };
}

function allTestsPassed(suite: EvaluatorSuite): boolean {
	const expected = suite.expectedTests ?? [];
	return (
		suite.outcome === "passed" &&
		suite.exitCode === 0 &&
		expected.length > 0 &&
		same(expected, suite.executedTests ?? []) &&
		same(expected, suite.passedTests ?? [])
	);
}

export function evaluationPassed(run: EvaluatorRun): boolean {
	return (
		run.kind === "ran" &&
		run.subjectFailed !== true &&
		run.end === "exited" &&
		run.suites.length > 0 &&
		run.suites.every(allTestsPassed)
	);
}
