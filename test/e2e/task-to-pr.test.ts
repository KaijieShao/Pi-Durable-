/**
 * The first working path of the acceptance list, end to end through the real Coordinator (commands, engine, relay,
 * outbox, poller, git, GitHub client, Pi runner process) against 127.0.0.1 fakes (Telegram, GitHub, model):
 *
 *   /task@bot alpha <text> → ack with task id and queue position → the agent writes files and runs the tests →
 *   one branch, one worktree, one pull request → review message with PR link, test result and head →
 *   reply during review → another run on the same conversation, branch and PR → /status → /approve →
 *   merged into main by a merge commit, worktree deleted, branch kept → a later reply is rejected.
 *
 * The same path also runs on the production Docker sandbox (opt-in: E2E_DOCKER=1). Neighbouring paths of the
 * acceptance list on the same stack: failing tests reported and blocking the merge, a steer while the run is busy,
 * a restart mid-run (interrupted run, its work kept uncommitted and unpushed in the worktree, quarantined
 * conversation, fresh conversation on reply whose review pushes it), and two users with two agents overlapping, the
 * second merge combined with the moved main and approved again.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { waitFor } from "../helpers/env.ts";
import type { RecordedRequest } from "../helpers/fake-model.ts";
import {
	agentPosition,
	dockerUnavailable,
	OWNER,
	REPO,
	type Stack,
	type StackOptions,
	scriptedAgent,
	startStack,
	USER1,
	USER2,
} from "./harness.ts";

const TASK_TEXT = "add a greet(name) helper in greet.js with a test";
const FOLLOWUP_TEXT = "also export farewell(name) from greet.js";
const RUN1_ANSWER = "Added greet.js and test/greet.test.js; the tests pass.";
const RUN2_ANSWER = "Added farewell(name) to greet.js; the tests still pass.";

const GREET_JS = 'exports.greet = (name) => "Hello, " + name + "!";\n';
const GREET_TEST = [
	'const assert = require("node:assert/strict");',
	'const { test } = require("node:test");',
	'const { greet } = require("../greet.js");',
	'test("greet", () => assert.equal(greet("Ada"), "Hello, Ada!"));',
	"",
].join("\n");
const FAREWELL_LINE = 'exports.farewell = (name) => "Goodbye, " + name + "!";\n';

const agent = scriptedAgent([
	{
		when: /add a greet\(name\) helper/,
		steps: [
			{ toolCalls: [{ name: "write", args: { path: "greet.js", content: GREET_JS } }] },
			{ toolCalls: [{ name: "write", args: { path: "test/greet.test.js", content: GREET_TEST } }] },
			{ toolCalls: [{ name: "run_check", args: { operation: "test" } }] },
			{ text: RUN1_ANSWER },
		],
	},
	{
		when: /also export farewell/,
		steps: [
			{
				toolCalls: [
					{ name: "edit", args: { path: "greet.js", oldText: GREET_JS, newText: `${GREET_JS}${FAREWELL_LINE}` } },
				],
			},
			{ toolCalls: [{ name: "run_check", args: { operation: "test" } }] },
			{ text: RUN2_ANSWER },
		],
	},
]);

type TaskRow = {
	id: number;
	state: string;
	branch: string | null;
	worktree_path: string | null;
	head_commit: string | null;
	posted_head: string | null;
	tests_passed_head: string | null;
	pr_number: number | null;
	pr_url: string | null;
};
type RunRow = { id: number; task_id: number; kind: string; state: string; request_id: string; conversation_id: string };

const sha7 = (sha: string): string => sha.slice(0, 7);

/** Model requests of one run: those whose newest user message is that run's input. */
function requestsFor(stack: Stack, input: RegExp): RecordedRequest[] {
	return stack.model.requests.filter((request) => input.test(agentPosition(request).input));
}

/** The whole first path; run with the local test sandbox and with the production Docker sandbox. */
async function taskToMergedPullRequest(t: TestContext, options: Pick<StackOptions, "sandbox">): Promise<void> {
	const stack = await startStack({ model: agent, ...options });
	t.after(() => stack.stop());
	const mainBefore = await stack.mainSha();

	// 1. /task@bot alpha <text> → acknowledgement with the task id and queue position, replying to the command.
	const taskMessage = stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	const ack = await stack.waitForBotMessage(/^Task 1 accepted for agent alpha\. Queue position 1\./);
	assert.equal(ack.replyTo, taskMessage);

	// 2. The agent writes two new files and runs the tests; the review message carries the PR, tests and head.
	const review1 = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/, { since: ack.id });
	const [task1] = stack.tasks<TaskRow>();
	assert.ok(task1 !== undefined);
	assert.equal(task1.state, "review");
	assert.equal(task1.branch, "task/1");
	assert.equal(task1.pr_number, 1);
	assert.equal(task1.pr_url, `https://github.com/${REPO}/pull/1`);
	const head1 = task1.head_commit;
	assert.ok(head1 !== null);
	assert.equal(task1.posted_head, head1);
	assert.equal(task1.tests_passed_head, head1);
	assert.match(review1.text, /Tests: passed\./);
	assert.ok(review1.text.includes(`Pull request: https://github.com/${REPO}/pull/1.`), review1.text);
	assert.ok(review1.text.includes(`Head: ${sha7(head1)}.`), review1.text);
	assert.match(review1.text, /Test files changed: test\/greet\.test\.js\./);
	assert.ok(review1.text.includes(RUN1_ANSWER), review1.text);
	assert.equal(review1.replyTo, taskMessage);

	// Exactly one branch, one worktree, one pull request; the branch on origin is the posted head.
	assert.deepEqual(await stack.branches(), ["main", "task/1"]);
	assert.equal(await stack.branchSha("task/1"), head1);
	assert.deepEqual(await stack.worktrees(), ["task-1"]);
	assert.equal(stack.github.pulls.size, 1);
	const pull = stack.github.pulls.get(1);
	assert.ok(pull !== undefined);
	assert.equal(pull.head, "task/1");
	assert.equal(pull.base, "main");
	assert.equal(pull.state, "open");
	assert.match(pull.title, /^Task 1: add a greet\(name\) helper/);
	assert.ok(await stack.isAncestor(mainBefore, head1));

	// The agent really worked through the relay with tools: write, write, run_check, answer = 4 model requests; the
	// relay swapped each run key for the upstream key, and the real check's result reached the model.
	const run1Requests = requestsFor(stack, /add a greet\(name\) helper/);
	assert.equal(run1Requests.length, 4);
	assert.ok(stack.model.requests.every((request) => request.auth === "Bearer sk-e2e-upstream-not-real"));
	const lastRun1 = JSON.stringify(run1Requests.at(-1)?.body.input);
	assert.match(lastRun1, /run_check test: passed/);
	assert.match(JSON.stringify(run1Requests[0]?.body), /Keep modules small/, "AGENTS.md reaches the instructions");

	// 3. A reply to the review message during review → another run on the same branch and pull request.
	const followup = stack.reply(USER1, review1.id, FOLLOWUP_TEXT);
	const started = await stack.waitForBotMessage(/^Follow-up started another run of Task 1/, { since: review1.id });
	assert.equal(started.replyTo, followup);
	assert.match(started.text, /on the same branch and pull request\. Queue position 1\./);
	const review2 = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 2\)/, { since: started.id });
	const [task2] = stack.tasks<TaskRow>();
	assert.ok(task2 !== undefined);
	const head2 = task2.head_commit;
	assert.ok(head2 !== null && head2 !== head1);
	assert.equal(task2.posted_head, head2);
	assert.equal(task2.tests_passed_head, head2);
	assert.ok(review2.text.includes(`Head: ${sha7(head2)}.`), review2.text);
	assert.ok(review2.text.includes(`Pull request: https://github.com/${REPO}/pull/1.`), review2.text);
	assert.ok(review2.text.includes(RUN2_ANSWER), review2.text);
	assert.ok(await stack.isAncestor(head1, head2), "run 2 builds on run 1 (no force push)");
	assert.equal(await stack.branchSha("task/1"), head2);
	assert.equal(stack.github.pulls.size, 1, "still exactly one pull request");
	const body = stack.github.pulls.get(1)?.body ?? "";
	assert.ok(body.includes(`Latest run: run 2. Tests: passed. Head: ${head2}.`), body);
	assert.ok(body.includes(TASK_TEXT) && body.includes(RUN2_ANSWER), body);
	assert.deepEqual(await stack.branches(), ["main", "task/1"]);
	assert.deepEqual(await stack.worktrees(), ["task-1"]);

	// The second run reused the conversation: its first model request replays run 1's history.
	const runs = stack.runs<RunRow>();
	assert.equal(runs.length, 2);
	assert.equal(runs[1]?.kind, "followup");
	assert.equal(runs[1]?.conversation_id, runs[0]?.conversation_id);
	const run2Requests = requestsFor(stack, /also export farewell/);
	assert.equal(run2Requests.length, 3);
	const firstOfRun2 = JSON.stringify(run2Requests[0]?.body.input);
	assert.ok(firstOfRun2.includes(TASK_TEXT), "run 1's task text is in run 2's history");
	assert.ok(firstOfRun2.includes(RUN1_ANSWER), "run 1's answer is in run 2's history");
	assert.match(firstOfRun2, /run_check test: passed/);

	// 4. /status lists the task and its state.
	const statusMessage = stack.sendCommand(USER2, "/status");
	const status = await stack.waitForBotMessage((message) => message.replyTo === statusMessage, {
		since: review2.id,
	});
	assert.match(status.text, /Task 1 · alpha · in review/);
	assert.ok(status.text.includes(`https://github.com/${REPO}/pull/1`), status.text);

	// 5. /approve 1 → merged into main through a merge commit; worktree deleted; branch kept.
	const approveMessage = stack.sendCommand(OWNER, "/approve 1");
	const approved = await stack.waitForBotMessage((message) => message.replyTo === approveMessage, {
		since: status.id,
	});
	assert.ok(approved.text.startsWith(`Approved Task 1 at ${sha7(head2)}`), approved.text);
	const merged = await stack.waitForBotMessage(/^Task 1 merged into main \(([0-9a-f]{7})\)\./, { since: approved.id });
	await stack.coordinator.idle();
	const mainAfter = await stack.mainSha();
	assert.ok(merged.text.includes(sha7(mainAfter)), merged.text);
	assert.deepEqual(await stack.parents(mainAfter), [mainBefore, head2], "a merge commit of main and the task head");
	assert.ok(await stack.isAncestor(head2, mainAfter));
	assert.equal(await stack.fileAtMain("greet.js"), `${GREET_JS}${FAREWELL_LINE}`);
	assert.equal(await stack.fileAtMain("test/greet.test.js"), GREET_TEST);
	const [task3] = stack.tasks<TaskRow>();
	assert.equal(task3?.state, "merged");
	assert.equal(task3?.worktree_path, null);
	assert.equal(existsSync(join(stack.config.paths.taskDir, "worktrees", "task-1")), false);
	assert.deepEqual(await stack.worktrees(), []);
	assert.deepEqual(await stack.branches(), ["main", "task/1"], "the task branch is kept on origin");
	assert.equal(await stack.branchSha("task/1"), head2);
	assert.equal(stack.github.pulls.get(1)?.merged, true);

	// 6. A later reply to the task is rejected with a hint to send a new /task.
	const late = stack.reply(USER1, review2.id, "one more change please");
	const rejection = await stack.waitForBotMessage((message) => message.replyTo === late, { since: merged.id });
	assert.match(rejection.text, /^Follow-up rejected: Task 1 is already merged; send a new \/task for further work\./);
	await stack.coordinator.idle();
	assert.equal(stack.runs<RunRow>().length, 2, "no run was started after the merge");
	assert.equal(stack.github.pulls.size, 1);
}

test(
	"task to merged pull request: /task, review, follow-up run on the same PR, /status, /approve, merged",
	{
		timeout: 180_000,
	},
	(t) => taskToMergedPullRequest(t, {}),
);

test(
	"the same path with the production Docker sandbox (agent and check containers)",
	{
		timeout: 300_000,
		skip: dockerUnavailable(),
	},
	(t) => taskToMergedPullRequest(t, { sandbox: "docker" }),
);

test("the review step really runs the project's tests: a failing test is reported and blocks the merge", {
	timeout: 120_000,
}, async (t) => {
	const broken = 'exports.greet = (name) => "Hi " + name;\n';
	const stack = await startStack({
		model: scriptedAgent([
			{
				when: /add a greet\(name\) helper/,
				steps: [
					{ toolCalls: [{ name: "write", args: { path: "greet.js", content: broken } }] },
					{ toolCalls: [{ name: "write", args: { path: "test/greet.test.js", content: GREET_TEST } }] },
					{ toolCalls: [{ name: "run_check", args: { operation: "test" } }] },
					{ text: "Done; the tests fail, please check." },
				],
			},
		]),
	});
	t.after(() => stack.stop());
	const mainBefore = await stack.mainSha();
	stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	const review = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	assert.match(review.text, /Tests: failed \(failed\)\./);
	// The model saw the real failing check through run_check.
	assert.match(JSON.stringify(stack.model.requests.at(-1)?.body.input), /run_check test: failed/);
	const [task] = stack.tasks<TaskRow>();
	assert.equal(task?.tests_passed_head, null);
	const approve = stack.sendCommand(USER1, "/approve 1");
	const ack = await stack.waitForBotMessage((message) => message.replyTo === approve, { since: review.id });
	assert.match(ack.text, /Tests have not passed at this head/);
	const blocked = await stack.waitForBotMessage(/^Task 1 cannot merge: the tests did not pass/, { since: ack.id });
	assert.ok(blocked.text.includes(sha7(task?.head_commit ?? "")), blocked.text);
	await stack.coordinator.idle();
	assert.equal(await stack.mainSha(), mainBefore, "main did not change");
	assert.equal(stack.tasks<TaskRow>()[0]?.state, "review");
	assert.equal(stack.github.pulls.get(1)?.merged, false);
});

test("a reply during the run is steered into the same run and conversation, then reported delivered", {
	timeout: 120_000,
}, async (t) => {
	const steerText = "STEER: also mention the README";
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const stack = await startStack({
		model: scriptedAgent([
			{
				when: /add a greet\(name\) helper/,
				steps: [
					{ toolCalls: [{ name: "write", args: { path: "greet.js", content: GREET_JS } }] },
					// Held until the steer is with Pi, so it lands at the next tool-round boundary of this same run.
					gate.then(() => ({ toolCalls: [{ name: "write", args: { path: "notes.txt", content: "notes\n" } }] })),
				],
			},
			{ when: /^STEER: also mention the README/, steps: [{ text: "Done, README mentioned." }] },
		]),
	});
	t.after(() => {
		release();
		return stack.stop();
	});
	stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	const ack = await stack.waitForBotMessage(/^Task 1 accepted/);
	await stack.model.waitForRequests(2, 30_000);
	const steer = stack.reply(USER1, ack.id, steerText);
	const saved = await stack.waitForBotMessage((message) => message.replyTo === steer, { since: ack.id });
	assert.match(saved.text, /^Follow-up saved; it will be steered into the running Task 1/);
	await waitFor(() => stack.followups<{ state: string }>()[0]?.state === "submitted", {
		what: "steer submitted to Pi",
		timeoutMs: 30_000,
	});
	release();
	const delivered = await stack.waitForBotMessage(/^Follow-up delivered to Task 1\./, { since: saved.id });
	assert.equal(delivered.replyTo, steer);
	const review = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/, { since: saved.id });
	assert.ok(review.text.includes("Done, README mentioned."), review.text);
	// One run, one conversation: the steered request carries the task's own history.
	const runs = stack.runs<RunRow>();
	assert.equal(runs.length, 1);
	const steered = requestsFor(stack, /^STEER: also mention the README/);
	assert.equal(steered.length, 1);
	const history = JSON.stringify(steered[0]?.body.input);
	assert.ok(history.includes(TASK_TEXT) && history.includes("notes.txt"), "steer placed after the held tool round");
	const [followup] = stack.followups<{ state: string; mode: string; run_id: number }>();
	assert.deepEqual([followup?.mode, followup?.state, followup?.run_id], ["steer", "delivered", runs[0]?.id]);
	assert.equal(await stack.branchSha("task/1"), stack.tasks<TaskRow>()[0]?.head_commit);
});

test("a restart during a run: the run is interrupted, its work kept in the worktree (not pushed), and a reply starts a fresh conversation that pushes it", {
	timeout: 180_000,
}, async (t) => {
	const stack = await startStack({
		model: scriptedAgent([
			{
				when: /^add a greet\(name\) helper/,
				steps: [{ toolCalls: [{ name: "write", args: { path: "greet.js", content: GREET_JS } }] }, { hang: true }],
			},
			// The fresh conversation's input is seeded: it also quotes the original task text.
			{ when: /also export farewell/, steps: [{ text: "Continued in a fresh conversation." }] },
		]),
	});
	t.after(() => stack.stop());
	stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	await stack.waitForBotMessage(/^Task 1 accepted/);
	// The agent wrote greet.js and is now waiting on the model (the second request hangs).
	await stack.model.waitForRequests(2, 30_000);
	await stack.restart();
	const interrupted = await stack.waitForBotMessage(/^Task 1 was interrupted by restart \(run 1\)/);
	assert.ok(interrupted.text.includes("changed since the last checkpoint: greet.js (new)."), interrupted.text);
	const [run1] = stack.runs<RunRow & { reason: string }>();
	assert.equal(run1?.state, "failed");
	assert.match(run1?.reason ?? "", /interrupted/);
	const [task] = stack.tasks<TaskRow>();
	assert.equal(task?.state, "review");
	// Edits since the last checkpoint are neither pushed nor dropped: they wait in the worktree for a reply or /cancel.
	assert.equal(await stack.branchSha("task/1"), undefined, "nothing of the interrupted run is pushed");
	assert.equal(stack.github.pulls.size, 0);
	assert.ok(task?.worktree_path !== null && task?.worktree_path !== undefined);
	assert.ok(existsSync(join(task.worktree_path, "greet.js")), "its work is kept in the worktree");
	const conversations = stack.coordinator.store.all<{ id: string; quarantined: number; parent_id: string | null }>(
		"SELECT id, quarantined, parent_id FROM conversations ORDER BY created_at",
	);
	assert.deepEqual(
		conversations.map((c) => c.quarantined),
		[1],
	);

	// A reply starts another run in a fresh conversation whose parent is the quarantined one.
	stack.reply(USER1, interrupted.id, FOLLOWUP_TEXT);
	const review = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 2\)/, { since: interrupted.id });
	assert.ok(review.text.includes("Continued in a fresh conversation."), review.text);
	const runs = stack.runs<RunRow>();
	assert.equal(runs.length, 2);
	assert.notEqual(runs[1]?.conversation_id, runs[0]?.conversation_id);
	const after = stack.coordinator.store.all<{ id: string; quarantined: number; parent_id: string | null }>(
		"SELECT id, quarantined, parent_id FROM conversations ORDER BY created_at",
	);
	assert.equal(after.length, 2);
	assert.equal(after[1]?.parent_id, after[0]?.id);
	// The fresh conversation is seeded with the original task, the follow-up and the branch's changes.
	const seeded = JSON.stringify(requestsFor(stack, /also export farewell/)[0]?.body.input);
	assert.ok(seeded.includes(TASK_TEXT) && seeded.includes("greet.js"), seeded.slice(0, 400));
	// That run's review step commits and pushes the kept work with its own, and opens the one pull request.
	assert.equal(stack.github.pulls.size, 1);
	assert.ok(review.text.includes(`Pull request: https://github.com/${REPO}/pull/1.`), review.text);
	assert.equal(await stack.branchSha("task/1"), stack.tasks<TaskRow>()[0]?.head_commit);
});

test("two users, two agents at the same time: both PRs merge; the second is combined with the moved main and re-approved", {
	timeout: 180_000,
}, async (t) => {
	const sumJs = "exports.sum = (a, b) => a + b;\n";
	const plans = scriptedAgent([
		{
			when: /^add a greet\(name\) helper/,
			steps: [
				{ toolCalls: [{ name: "write", args: { path: "greet.js", content: GREET_JS } }] },
				{ toolCalls: [{ name: "run_check", args: { operation: "test" } }] },
				{ text: "greet added" },
			],
		},
		{
			when: /^add a sum\(a, b\) helper/,
			steps: [
				{ toolCalls: [{ name: "write", args: { path: "sum.js", content: sumJs } }] },
				{ toolCalls: [{ name: "run_check", args: { operation: "test" } }] },
				{ text: "sum added" },
			],
		},
	]);
	// Overlap: neither agent gets its first answer before both runs are talking to the model.
	const arrived = new Set<string>();
	let bothArrived: () => void = () => {};
	const both = new Promise<void>((resolve) => {
		bothArrived = resolve;
	});
	let overlapped = false;
	const stack = await startStack({
		model: async (request) => {
			const { input, round } = agentPosition(request);
			if (round === 0) {
				arrived.add(input.slice(0, 12));
				if (arrived.size === 2) {
					overlapped = true;
					bothArrived();
				}
				await Promise.race([both, new Promise((resolve) => setTimeout(resolve, 20_000).unref())]);
			}
			return plans(request);
		},
	});
	t.after(() => {
		bothArrived();
		return stack.stop();
	});
	const mainBefore = await stack.mainSha();
	stack.sendCommand(USER1, `/task alpha ${TASK_TEXT}`);
	stack.sendCommand(USER2, "/task beta add a sum(a, b) helper in sum.js");
	const review1 = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	const review2 = await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/);
	assert.ok(overlapped, "both agents were running at the same time");
	assert.deepEqual(await stack.branches(), ["main", "task/1", "task/2"]);
	assert.deepEqual(await stack.worktrees(), ["task-1", "task-2"]);
	assert.equal(stack.github.pulls.size, 2);

	// Both approved by their creators; merges run one at a time, so Task 2 meets a main that moved.
	const since = Math.max(review1.id, review2.id);
	stack.sendCommand(USER1, "/approve 1");
	stack.sendCommand(USER2, "/approve 2");
	await stack.waitForBotMessage(/^Task 1 merged into main/, { since });
	const moved = await stack.waitForBotMessage(/^Main moved; Task 2 was combined with the latest main and retested/, {
		since,
	});
	assert.match(moved.text, /retested \(passed\)/);
	await stack.coordinator.idle();
	const main1 = await stack.mainSha();
	const task2 = stack.tasks<TaskRow>()[1];
	assert.equal(task2?.state, "review", "approval is required again");
	assert.ok(task2?.head_commit !== null && task2?.head_commit !== undefined);
	assert.ok(moved.text.includes(`Head: ${sha7(task2.head_commit)}.`), moved.text);
	assert.equal(await stack.branchSha("task/2"), task2.head_commit, "the combined result is pushed");
	assert.ok(await stack.isAncestor(main1, task2.head_commit));
	assert.equal(await stack.fileAtMain("sum.js"), undefined, "nothing of Task 2 merged yet");

	// Approve again: Task 2 merges on top of Task 1.
	stack.sendCommand(USER2, "/approve 2");
	await stack.waitForBotMessage(/^Task 2 merged into main/, { since: moved.id });
	await stack.coordinator.idle();
	const main2 = await stack.mainSha();
	assert.deepEqual(await stack.parents(main2), [main1, task2.head_commit]);
	assert.ok(await stack.isAncestor(mainBefore, main1));
	assert.equal(await stack.fileAtMain("greet.js"), GREET_JS);
	assert.equal(await stack.fileAtMain("sum.js"), sumJs);
	assert.deepEqual(
		stack.tasks<TaskRow>().map((task) => task.state),
		["merged", "merged"],
	);
	assert.deepEqual(await stack.worktrees(), []);
	assert.deepEqual(await stack.branches(), ["main", "task/1", "task/2"]);
});
