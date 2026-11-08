/**
 * Uncertain file changes after a crash, end to end on the real stack of test/e2e/harness.ts (the real Coordinator,
 * relay, Pi runner processes, git and in-process watchdog; the test-only local sandbox runs the real fsop.mjs).
 *
 * Spec: agent-execution.md § Uncertain Effects ("Intent (target, pre-hash, intended hash) is persisted before
 * execution. After an unknown outcome, competing mutations are stopped and termination is confirmed. The target is
 * inspected. If it matches the intended result, it's 'applied'; if it matches the pre-hash, it's 'currently
 * unchanged'. Anything else freezes the group." "Dispatch stays blocked until reconciliation finishes."),
 * interfaces-and-storage.md § Recovery After a Restart ("A run that was in progress is marked failed ('interrupted by
 * restart'). Its task keeps its worktree, branch and pull request. If any effect is unresolved, the group freezes until
 * the owner resolves it." "Interrupted runs are never auto-resumed." A later follow-up "is seeded with the original
 * task text, that follow-up and the branch's current changes"), architecture.md § Review and merge (an archive's final
 * checkpoint commits and pushes everything left, only after the run is verified stopped).
 *
 * Each test stops the Coordinator while a file change of Task 1's run is in flight in its agent container: the change's
 * intent is saved (pending) and the container has not answered. The target is then left in one of three states, the
 * Coordinator restarts, and the test checks what recovery makes of it:
 *   intended result → "applied"; as before → "currently unchanged"; a third content → the group freezes for the owner.
 * In every case the interrupted run's changes since the last checkpoint stay in the worktree, uncommitted and
 * unpushed (origin never gets task/1 at recovery), the users are told which files (never their content), nothing
 * resumes on its own, and queued work does not start before reconciliation finished. Then the task moves on only by an
 * explicit command: a reply's fresh run (seeded with those changes; its review pushes them) or /cancel (its final
 * checkpoint pushes them, after reconciliation and, for the third state, after the owner's recorded resolution).
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Git } from "../../src/coordinator/git.ts";
import { INTERRUPTED_KEPT_REASON } from "../../src/coordinator/messages.ts";
import type { FsRequest, FsResponse, Sandbox } from "../../src/coordinator/ports.ts";
import { waitFor } from "../helpers/env.ts";
import { originGit } from "../helpers/fake-github.ts";
import { type FakeStep, userTexts } from "../helpers/fake-model.ts";
import { agentPosition, GROUP, PROJECT_FILES, type Stack, scriptedAgent, startStack, USER1, USER2 } from "./harness.ts";

type TaskRow = {
	id: number;
	state: string;
	reason: string | null;
	worktree_path: string | null;
	base_commit: string | null;
	head_commit: string | null;
	posted_head: string | null;
	pr_number: number | null;
};
type RunRow = { id: number; task_id: number; state: string; reason: string | null; dispatched_at: number | null };
type IntentRow = {
	id: number;
	tool: string;
	path: string | null;
	state: string;
	reconciled: number;
	pre_hash: string;
	intended_hash: string;
	observed_hash: string | null;
	resolution: string | null;
	settled_at: number | null;
};

const TASK_ONE = "KEEP-ONE: add kept.txt, then change the target";
const TASK_TWO = "QUEUED-TWO: add two.txt";
const RESUME = "RESUME-KEPT: carry on from what is there";
const KEPT_CONTENT = "kept by the interrupted run 5e1f\n";
const HELD_CONTENT = "the in-flight write 9a2c\n";
const THIRD_CONTENT = "THIRD-STATE-CONTENT 77b0\n";
const ORIGINAL_INDEX = PROJECT_FILES["index.js"] as string;

/** How the in-flight change left its target when the Coordinator went away. */
type Left = "intended" | "before" | "third";

/** Task 1: a write that answers, then the change that is in flight at the restart. Task 2 and the fresh run finish. */
function agent(change: FakeStep) {
	return scriptedAgent([
		{
			when: /^KEEP-ONE/,
			steps: [
				{ toolCalls: [{ name: "write", args: { path: "kept.txt", content: KEPT_CONTENT } }] },
				change,
				{ text: "unreachable: the change never answers" },
			],
		},
		{
			when: /^QUEUED-TWO/,
			steps: [{ toolCalls: [{ name: "write", args: { path: "two.txt", content: "two\n" } }] }, { text: "Done." }],
		},
		{ when: /RESUME-KEPT/, steps: [{ text: "Continued from the kept changes." }] },
	]);
}

const WRITE_HELD: FakeStep = { toolCalls: [{ name: "write", args: { path: "held.txt", content: HELD_CONTENT } }] };
const EDIT_INDEX: FakeStep = {
	toolCalls: [{ name: "edit", args: { path: "index.js", oldText: "version: 1", newText: "version: 2" } }],
};

type Hold = { held: boolean; used: boolean; readonly tool: string; readonly path: string };

/**
 * The local sandbox (TEST ONLY), except that the agent container's first answer for `path` never comes: the change is
 * left as `left` says (run for real, not run, or replaced by a third content) and the call waits until the container
 * is stopped (the Coordinator going away), as a crash between the effect and its answer would leave it.
 */
function inFlight(path: string, left: Left, hold: Hold): (sandbox: Sandbox) => Sandbox {
	const leave = async (worktree: string, real: () => Promise<FsResponse>): Promise<void> => {
		if (left === "intended") await real();
		if (left === "third") await writeFile(join(worktree, path), THIRD_CONTENT);
	};
	return (local) => ({
		...local,
		async startAgent(spec) {
			const box = await local.startAgent(spec);
			let release: () => void = () => {};
			const stopped = new Promise<void>((resolve) => {
				release = resolve;
			});
			return {
				name: box.name,
				async stop() {
					release();
					await box.stop();
				},
				async fileOp(request: FsRequest, signal?: AbortSignal) {
					if (request.path !== path || hold.used) return box.fileOp(request, signal);
					hold.used = true;
					await leave(spec.worktree, () => box.fileOp(request, signal));
					hold.held = true;
					await stopped;
					return { ok: false, code: "unavailable", message: "the task container is not running" };
				},
			};
		},
	});
}

/** git.uncommittedChanges answers late: the window in which queued work must not start (reconciliation is not done). */
function slowListing(git: Git): Git {
	return {
		...git,
		async uncommittedChanges(path) {
			await new Promise((resolve) => setTimeout(resolve, 1500));
			return git.uncommittedChanges(path);
		},
	};
}

async function startHeld(t: TestContext, change: FakeStep, path: string, left: Left) {
	const hold: Hold = { held: false, used: false, tool: change === EDIT_INDEX ? "edit" : "write", path };
	const stack = await startStack({
		model: agent(change),
		wrap: { sandbox: inFlight(path, left, hold), git: slowListing },
	});
	t.after(() => stack.stop());
	return { stack, hold };
}

const task1 = (stack: Stack): TaskRow => stack.tasks<TaskRow>()[0] as TaskRow;
const intents = (stack: Stack): IntentRow[] =>
	stack.coordinator.store.all<IntentRow>("SELECT * FROM effect_intents WHERE task_id = 1 ORDER BY id");
const requestsFor = (stack: Stack, input: RegExp) =>
	stack.model.requests.filter((request) => input.test(agentPosition(request).input));
const localBranch = async (stack: Stack): Promise<string> =>
	(await originGit(join(stack.config.paths.taskDir, "repo.git"), ["rev-parse", "refs/heads/task/1"])).stdout.trim();

/**
 * Task 1's change is in flight (its intent saved, pending; no answer yet) and Task 2 waits in the queue for the same
 * agent. The caller then restarts the Coordinator. Returns the last bot message id before the restart.
 */
async function midChange(stack: Stack, hold: Hold): Promise<number> {
	const command = stack.sendCommand(USER1, `/task alpha ${TASK_ONE}`);
	await stack.waitForBotMessage((message) => message.replyTo === command);
	await waitFor(() => hold.held, { what: "the change in flight", timeoutMs: 60_000 });
	assert.deepEqual(
		intents(stack).map((row) => [row.tool, row.path, row.state]),
		[
			["write", "kept.txt", "applied"],
			[hold.tool, hold.path, "pending"],
		],
		"the in-flight change's intent was saved before it ran",
	);
	const two = stack.sendCommand(USER2, `/task alpha ${TASK_TWO}`);
	const ack = await stack.waitForBotMessage((message) => message.replyTo === two);
	assert.match(ack.text, /^Task 2 accepted for agent alpha\. Queue position 1\./);
	return stack.lastBotMessageId();
}

/** What every case shares after the restart: interrupted, not resumed, nothing committed or pushed, files named only. */
async function assertKeptNotPushed(stack: Stack, notice: string, requestsBefore: number): Promise<void> {
	assert.match(
		notice,
		/^Task 1 was interrupted by restart \(run 1\)\. It is not resumed, and nothing was committed or pushed\./,
	);
	for (const secret of [KEPT_CONTENT.trim(), HELD_CONTENT.trim(), THIRD_CONTENT.trim(), "version: 2"]) {
		assert.ok(!notice.includes(secret), `no file content in the notice (${secret})`);
	}
	const [run1] = stack.runs<RunRow>();
	assert.deepEqual([run1?.state, run1?.reason], ["failed", "interrupted by restart"]);
	const task = task1(stack);
	assert.deepEqual([task.state, task.reason, task.posted_head], ["review", INTERRUPTED_KEPT_REASON, null]);
	assert.equal(await stack.branchSha("task/1"), undefined, "nothing of Task 1 is on GitHub");
	assert.equal(await localBranch(stack), task.base_commit, "nothing committed either: the branch is at its base");
	assert.equal(task.head_commit, task.base_commit);
	const worktree = task.worktree_path as string;
	assert.ok(existsSync(worktree), "the worktree is kept");
	assert.equal(
		readFileSync(join(worktree, "kept.txt"), "utf8"),
		KEPT_CONTENT,
		"the interrupted run's work is not lost",
	);
	assert.equal(requestsFor(stack, /^KEEP-ONE/).length, 2, "never resumed: no model request after the restart");
	assert.equal(
		stack.model.requests.slice(requestsBefore).filter((r) => /^KEEP-ONE/.test(agentPosition(r).input)).length,
		0,
	);
}

/** Queued work started only after the interrupted run was reconciled and its users told. */
function assertDispatchWaited(stack: Stack, noticeCreatedAt: number): void {
	const two = stack.runs<RunRow>().find((run) => run.task_id === 2);
	assert.ok(two?.dispatched_at !== null && two?.dispatched_at !== undefined, "Task 2 ran after the recovery");
	assert.ok(two.dispatched_at >= noticeCreatedAt, "dispatch stayed blocked until reconciliation finished");
	const settled = intents(stack)[1]?.settled_at ?? Number.POSITIVE_INFINITY;
	assert.ok(two.dispatched_at >= settled, "after the in-flight change was reconciled");
}

function noticeCreatedAt(stack: Stack): number {
	return (
		stack.coordinator.store.get<{ created_at: number }>(
			"SELECT created_at FROM outbox WHERE kind = 'task_interrupted' AND task_id = 1 ORDER BY id LIMIT 1",
		)?.created_at ?? Number.POSITIVE_INFINITY
	);
}

test("restart mid-write, the target as intended → applied; the changes stay uncommitted and unpushed, queued work waits for reconciliation; a reply's fresh run is seeded with them and its review pushes them", {
	timeout: 180_000,
}, async (t) => {
	const { stack, hold } = await startHeld(t, WRITE_HELD, "held.txt", "intended");
	const since = await midChange(stack, hold);
	const requestsBefore = stack.model.requests.length;
	await stack.restart();
	const notice = await stack.waitForBotMessage(/^Task 1 was interrupted by restart/, { since });
	await assertKeptNotPushed(stack, notice.text, requestsBefore);
	assert.ok(notice.text.includes("changed since the last checkpoint: held.txt (new), kept.txt (new)."), notice.text);
	assert.ok(
		notice.text.includes(
			"In flight at the restart, reconciled: held.txt (write): applied (the file has the intended result).",
		),
		notice.text,
	);
	assert.match(notice.text, /Reply to this message to start a fresh run that continues from these changes/);
	assert.deepEqual(
		intents(stack).map((row) => [row.path, row.state, row.reconciled, row.observed_hash === row.intended_hash]),
		[
			["kept.txt", "applied", 0, false],
			["held.txt", "applied", 1, true],
		],
	);
	assert.equal(readFileSync(join(task1(stack).worktree_path as string, "held.txt"), "utf8"), HELD_CONTENT);
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/, { since });
	assertDispatchWaited(stack, noticeCreatedAt(stack));
	assert.equal(await stack.branchSha("task/1"), undefined, "still nothing of Task 1 pushed");

	// No head to approve: the kept changes are in no commit.
	const approve = stack.sendCommand(USER1, "/approve 1");
	const refused = await stack.waitForBotMessage((message) => message.replyTo === approve);
	assert.match(refused.text, /^\/approve rejected: Task 1 was interrupted by a restart and the changes its run made/);

	// A reply starts a fresh run seeded with the branch's current changes, the kept ones included.
	const reply = stack.reply(USER1, notice.id, RESUME);
	await stack.waitForBotMessage((message) => message.replyTo === reply);
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 2\)/, { since: notice.id });
	const seeded = userTexts(requestsFor(stack, /RESUME-KEPT/)[0]?.body)[0] ?? "";
	assert.ok(seeded.includes(`Original task:\n${TASK_ONE}`), seeded);
	assert.ok(seeded.includes(`+${KEPT_CONTENT.trim()}`) && seeded.includes(`+${HELD_CONTENT.trim()}`), seeded);
	assert.ok(
		seeded.includes(
			"Not committed yet (left in the worktree since the last checkpoint): held.txt (new), kept.txt (new).",
		),
		seeded,
	);
	// Its review step commits and pushes them, for review.
	const head = await stack.branchSha("task/1");
	assert.ok(head !== undefined && head === task1(stack).head_commit);
	const at = async (file: string) => (await originGit(stack.origin.bare, ["show", `${head}:${file}`])).stdout;
	assert.equal(await at("kept.txt"), KEPT_CONTENT);
	assert.equal(await at("held.txt"), HELD_CONTENT);
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal");
});

test("restart mid-edit, the target as before → currently unchanged; /cancel's final checkpoint pushes the kept changes after reconciliation", {
	timeout: 180_000,
}, async (t) => {
	const { stack, hold } = await startHeld(t, EDIT_INDEX, "index.js", "before");
	const since = await midChange(stack, hold);
	const requestsBefore = stack.model.requests.length;
	await stack.restart();
	const notice = await stack.waitForBotMessage(/^Task 1 was interrupted by restart/, { since });
	await assertKeptNotPushed(stack, notice.text, requestsBefore);
	assert.ok(notice.text.includes("changed since the last checkpoint: kept.txt (new)."), notice.text);
	assert.ok(
		notice.text.includes(
			"In flight at the restart, reconciled: index.js (edit): currently unchanged (the file is as it was before the change).",
		),
		notice.text,
	);
	const worktree = task1(stack).worktree_path as string;
	assert.equal(readFileSync(join(worktree, "index.js"), "utf8"), ORIGINAL_INDEX);
	assert.deepEqual(
		intents(stack).map((row) => [row.path, row.state, row.observed_hash === row.pre_hash]),
		[
			["kept.txt", "applied", false],
			["index.js", "unchanged", true],
		],
	);
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/, { since });
	assertDispatchWaited(stack, noticeCreatedAt(stack));

	const cancel = stack.sendCommand(USER1, "/cancel 1");
	await stack.waitForBotMessage((message) => message.replyTo === cancel);
	const done = await stack.waitForBotMessage(/^Task 1 cancelled\./, { since: notice.id });
	assert.match(done.text, /Branch task\/1 kept\./);
	const head = await stack.branchSha("task/1");
	assert.ok(head !== undefined, "the final checkpoint is on GitHub");
	assert.equal((await originGit(stack.origin.bare, ["show", `${head}:kept.txt`])).stdout, KEPT_CONTENT);
	assert.equal((await originGit(stack.origin.bare, ["show", `${head}:index.js`])).stdout, ORIGINAL_INDEX);
	assert.equal(existsSync(worktree), false, "archived once GitHub confirmed the push");
	assert.equal(requestsFor(stack, /^KEEP-ONE/).length, 2, "never resumed");
});

test("restart mid-edit, a third content → the group freezes naming the file (no content); nothing dispatches; /cancel waits for the owner, whose unfreeze records the resolution", {
	timeout: 180_000,
}, async (t) => {
	const { stack, hold } = await startHeld(t, EDIT_INDEX, "index.js", "third");
	const since = await midChange(stack, hold);
	const requestsBefore = stack.model.requests.length;
	await stack.restart();
	const frozen = await stack.waitForBotMessage(/^Group frozen: /, { since });
	assert.equal(
		frozen.text,
		"Group frozen: the outcome of a file change of Task 1 could not be reconciled (index.js). Only the owner CLI can unfreeze it.",
	);
	const told = await stack.waitForBotMessage(/^Task 1: the outcome of a file change could not be confirmed/, { since });
	assert.match(told.text, /index\.js matches neither its content before the change nor the intended result/);
	const sent = stack.bot.sent().filter((message) => message.id > since);
	for (const secret of [THIRD_CONTENT.trim(), "version: 2", KEPT_CONTENT.trim()]) {
		assert.ok(!sent.some((message) => message.text.includes(secret)), `no file content in any message (${secret})`);
	}
	const [, change] = intents(stack);
	assert.deepEqual([change?.path, change?.state, change?.reconciled], ["index.js", "unresolved", 1]);
	assert.ok(change?.observed_hash !== change?.pre_hash && change?.observed_hash !== change?.intended_hash);
	await stack.coordinator.idle();
	// Frozen: nothing dispatched (Task 2 stays queued), nothing of Task 1 committed or pushed, its work kept.
	assert.equal(stack.runs<RunRow>().find((run) => run.task_id === 2)?.state, "queued");
	assert.equal(await stack.branchSha("task/1"), undefined);
	assert.equal(await localBranch(stack), task1(stack).base_commit);
	const worktree = task1(stack).worktree_path as string;
	assert.equal(readFileSync(join(worktree, "index.js"), "utf8"), THIRD_CONTENT);
	assert.equal(readFileSync(join(worktree, "kept.txt"), "utf8"), KEPT_CONTENT);
	assert.equal(requestsFor(stack, /^KEEP-ONE/).length, 2);
	assert.equal(stack.model.requests.length, requestsBefore, "no model request at all while frozen");

	// /cancel is accepted, but its archive (final checkpoint, push) waits for the owner's review.
	const cancel = stack.sendCommand(USER1, "/cancel 1");
	await stack.waitForBotMessage((message) => message.replyTo === cancel);
	await stack.coordinator.idle();
	assert.ok(existsSync(worktree), "not archived while the change is unresolved");
	assert.equal(await stack.branchSha("task/1"), undefined);

	// The owner's unfreeze before reviewing the file: the recovery checks find the unresolved change, still frozen.
	const refused = await stack.owner("unfreeze");
	assert.equal(refused.code, 1);
	assert.match(
		refused.stderr,
		new RegExp(
			`FAILED file changes: unresolved: change ${change?.id} \\(Task 1, edit index\\.js in .*\\)\\. Review each file`,
		),
	);
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "frozen");
	await stack.coordinator.idle();
	assert.ok(existsSync(worktree), "still not archived");
	// The owner reviews the file, records the resolution (owner resolve), then unfreezes.
	const resolved = await stack.owner("resolve", String(change?.id));
	assert.equal(resolved.code, 0, resolved.stderr);
	assert.match(resolved.stdout, /resolved, accepted as it is in the worktree/);
	assert.deepEqual(
		[intents(stack)[1]?.state, intents(stack)[1]?.resolution],
		["resolved", "owner resolve: accepted as found in the worktree"],
	);
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "frozen", "resolving is not unfreezing");
	const unfrozen = await stack.owner("unfreeze");
	assert.equal(unfrozen.code, 0, unfrozen.stderr);
	const notice = await stack.waitForBotMessage(/^Task 1 was interrupted by restart/, { since });
	assert.ok(notice.text.includes("index.js (edit): reviewed by the owner"), notice.text);
	assert.match(
		notice.text,
		/It is being cancelled: its final checkpoint, with these changes, is pushed to branch task\/1\./,
	);
	await stack.waitForBotMessage(/^Task 1 cancelled\./, { since: notice.id });
	const head = await stack.branchSha("task/1");
	assert.ok(head !== undefined);
	assert.equal((await originGit(stack.origin.bare, ["show", `${head}:index.js`])).stdout, THIRD_CONTENT);
	assert.equal(existsSync(worktree), false);
	// Dispatch reopened after the recheck: Task 2 runs once.
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/, { since });
	assert.equal(requestsFor(stack, /^KEEP-ONE/).length, 2, "never resumed");
});
