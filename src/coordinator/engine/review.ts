/**
 * Post-run review step (Architecture § Review and merge, first bullet): after a run is finalized and its process
 * and container are verified gone, run the approved tests on the worktree (read-only check container), commit a
 * checkpoint, push the branch (compared with GitHub first), open the task's pull request once or update it, and
 * post the link, the test result, the head commit and the test files the task changed. The task is then in review
 * and its agent is free. Idempotent: recovery redoes it for runs whose review did not complete.
 */

import { clip, listFiles, sha7 } from "../messages.ts";
import type { CheckOutcome, PullRequest } from "../ports.ts";
import {
	type Ctx,
	clipText,
	describeError,
	enqueueTask,
	loadRun,
	loadTask,
	runNumber,
	type TaskRow,
	TERMINAL_TASK_STATES,
	taskRef,
	tx,
} from "./context.ts";
import { ensurePullRequest, pushBranch } from "./effects.ts";

const ANSWER_IN_MESSAGE = 1500;
const TEST_FILE =
	/(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]*$|_test\.[A-Za-z0-9]+$/;

export const INTERRUPTED_NOTE = "interrupted by restart; reply to start another run (fresh conversation)";

export type TestResult = { readonly outcome: CheckOutcome; readonly passed: boolean };

/** The approved tests ("test" op) in a fresh check container with the worktree read-only. */
export async function runTests(ctx: Ctx, task: TaskRow, worktree: string): Promise<TestResult> {
	if (!ctx.sandbox.checkOps().includes("test")) return { outcome: "unknown_operation", passed: false };
	try {
		const result = await ctx.sandbox.runCheck({
			taskId: task.id,
			generation: task.generation,
			worktree,
			op: "test",
			writable: false,
			timeoutMs: ctx.limits.checkDeadlineMs,
		});
		return { outcome: result.outcome, passed: result.outcome === "passed" };
	} catch (error) {
		ctx.log.warn("tests_failed_to_run", { task: task.id, error: describeError(error) });
		return { outcome: "error", passed: false };
	}
}

export function testsText(tests: TestResult): string {
	return tests.passed ? "passed" : `failed (${tests.outcome})`;
}

export function isTestFile(path: string): boolean {
	return TEST_FILE.test(path);
}

export function pullRequestTitle(task: { id: number; text: string }): string {
	const firstLine = task.text.split("\n").find((line) => line.trim() !== "") ?? task.text;
	return `${taskRef(task.id)}: ${clip(firstLine, 60)}`;
}

function pullRequestBody(task: TaskRow, p: { runNo: number; tests: TestResult; head: string; answer: string }): string {
	return [
		`${taskRef(task.id)} for agent ${task.agent_id}, requested in Telegram by user ${task.creator_id}.`,
		"",
		clipText(task.text, 3000),
		"",
		`Latest run: run ${p.runNo}. Tests: ${testsText(p.tests)}. Head: ${p.head}.`,
		"",
		"The agent's answer (its claim, not a test result):",
		"",
		clipText(p.answer.trim() === "" ? "(none)" : p.answer, 3000),
	].join("\n");
}

type ReviewFacts = {
	readonly taskId: number;
	readonly runNo: number;
	readonly branch: string;
	readonly head: string;
	readonly tests: TestResult;
	readonly pr: PullRequest | undefined;
	readonly testFiles: readonly string[];
	readonly answer: string;
	readonly interrupted: boolean;
};

function reviewLead(f: ReviewFacts): string {
	const task = taskRef(f.taskId);
	if (f.interrupted)
		return `${task} was interrupted by restart (run ${f.runNo}); its work so far is saved on branch ${f.branch}.`;
	if (f.pr === undefined) return `${task} finished with no changes (run ${f.runNo}).`;
	return `${task} is ready for review (run ${f.runNo}).`;
}

function reviewNext(f: ReviewFacts, queued: boolean): string {
	if (queued) return "\nA follow-up run is queued; review again when it finishes.";
	const approve = f.pr === undefined ? "" : `, or send /approve ${f.taskId}`;
	if (f.interrupted) return `\nReply to this message to start another run (fresh conversation)${approve}.`;
	return `\nReply to this message for a follow-up${approve}.`;
}

/**
 * "Task 12 is ready for review (run 3). Tests: passed. Pull request: <url>. Head: <sha7>. Test files changed: <list|
 * none>." + the agent's answer (its claim) + how to continue.
 */
export function reviewText(f: ReviewFacts, queued: boolean): string {
	const files = f.testFiles.length === 0 ? "none" : listFiles(f.testFiles);
	const where =
		f.pr === undefined
			? ` Branch ${f.branch} is at main (${sha7(f.head)}); there is no pull request, so there is nothing to approve.`
			: ` Pull request: ${f.pr.url}. Head: ${sha7(f.head)}. Test files changed: ${files}.`;
	const answer = f.answer.trim();
	const said =
		answer === "" ? "" : `\nAgent's answer (its claim, not a test result): ${clipText(answer, ANSWER_IN_MESSAGE)}`;
	return `${reviewLead(f)} Tests: ${testsText(f.tests)}.${where}${said}${reviewNext(f, queued)}`;
}

function hasQueuedRun(ctx: Ctx, taskId: number): boolean {
	const n = ctx.store.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND state = 'queued'",
		taskId,
	)?.n;
	return (n ?? 0) > 0;
}

/** Record the review result and post it, in one transaction. */
function recordReview(ctx: Ctx, runId: number, f: ReviewFacts): void {
	const postedHead = f.pr === undefined ? null : f.head;
	const passedHead = f.tests.passed ? f.head : null;
	const note = f.interrupted ? INTERRUPTED_NOTE : null;
	const prNumber = f.pr?.number ?? null;
	const prUrl = f.pr?.url ?? null;
	tx(ctx, () => {
		const now = ctx.now();
		const current = loadTask(ctx, f.taskId);
		ctx.store.run("UPDATE runs SET checkpoint_commit = ?, review_done = 1 WHERE id = ?", f.head, runId);
		if (TERMINAL_TASK_STATES.has(current.state)) return;
		// A follow-up admitted during the review step keeps the task queued (approval waits for that run).
		const queued = hasQueuedRun(ctx, f.taskId);
		ctx.store.run(
			`UPDATE tasks SET state = ?, reason = ?, head_commit = ?, posted_head = ?, tests_passed_head = ?,
			   pr_number = COALESCE(?, pr_number), pr_url = COALESCE(?, pr_url),
			   review_since = ?, review_reminded = 0, updated_at = ?
			 WHERE id = ?`,
			queued ? "queued" : "review",
			note,
			f.head,
			postedHead,
			passedHead,
			prNumber,
			prUrl,
			now,
			now,
			f.taskId,
		);
		enqueueTask(ctx, current, "task_review", reviewText(f, queued));
	});
}

/**
 * The review step for `runId`; the caller holds an execution slot. Throws on an unknown effect (the caller
 * freezes the group; review_done stays 0 so the step is redone after resolution).
 */
export async function reviewStep(ctx: Ctx, runId: number, options: { interrupted: boolean }): Promise<void> {
	const run = loadRun(ctx, runId);
	if (run.review_done === 1) return;
	const task = loadTask(ctx, run.task_id);
	const { worktree_path: path, branch, base_commit: base } = task;
	if (path === null || branch === null || base === null) {
		tx(ctx, () => ctx.store.run("UPDATE runs SET review_done = 1 WHERE id = ?", runId));
		return;
	}
	const runNo = runNumber(ctx, run);
	const tests = await runTests(ctx, task, path);
	const head = (await ctx.git.checkpoint(path, `${taskRef(task.id)}: run ${runNo} checkpoint`)).commit;
	await pushBranch(ctx, branch, path, head);
	const answer = run.answer ?? "";
	const changed = head !== base;
	const pr = changed
		? await ensurePullRequest(ctx, task, {
				title: pullRequestTitle(task),
				body: pullRequestBody(task, { runNo, tests, head, answer }),
			})
		: undefined;
	const testFiles = changed ? (await ctx.git.changedFiles(base, head)).filter(isTestFile) : [];
	const facts: ReviewFacts = {
		taskId: task.id,
		runNo,
		branch,
		head,
		tests,
		pr,
		testFiles,
		answer,
		interrupted: options.interrupted,
	};
	recordReview(ctx, runId, facts);
	ctx.log.info("review_posted", {
		task: task.id,
		run: runId,
		tests: tests.outcome,
		pr: pr?.number,
		test_files: testFiles.length,
		interrupted: options.interrupted,
	});
}
