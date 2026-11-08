/**
 * A restart while a run is starting (slot reserved; worktree, setup, run key, container and Pi process may or may
 * not have happened), end to end on the real stack of test/e2e/harness.ts. Spec: interfaces-and-storage.md § Recovery
 * After a Restart (step 3 "Reconcile effect evidence", "Effects are reconciled before anything is dispatched", "A
 * run that was in progress is marked failed", "Interrupted runs are never auto-resumed", "requestId covers live
 * retries only"); requirements.md § Durability ("Accepted tasks and follow-ups survive a process crash or restart")
 * and § No duplicate submissions ("An interrupted run is never resubmitted automatically"); capacity.md (open-task
 * limit); architecture.md § Request Flow "New task".
 *
 * Reading: a run starts, from Pi's point of view, when it is submitted to Pi. Until the Pi process is launched or a
 * run key is opened for it, a restart puts the same run back in the queue (an accepted task survives) and its
 * worktree is reconciled from evidence; once either happened, the run was in progress and today's rule applies.
 *
 * - Before the worktree: back to the queue (same run row and request id), the steer saved meanwhile stays pending
 *   and is delivered when the run really starts, the task completes, the model got the task once.
 * - During the setup script (the worktree may be changed part-way): the local worktree and branch are discarded and
 *   recreated from the latest main; the open-task limit holds across the restart (a later first run does not take
 *   the place).
 * - After setup, before the run key: the pristine worktree at its recorded base is kept (setup not repeated).
 * - A follow-up run before its run key: back to the queue on the same worktree, branch, pull request and
 *   conversation.
 * - After the run key was opened, and after the Pi process was launched: failed "interrupted by restart", worktree
 *   kept, conversation quarantined, steer expired, never resubmitted; a reply runs it on a fresh conversation.
 * - A restart loop while starting: returned to the queue 3 times (the count is saved), the 4th restart fails the
 *   task; its local worktree and branch are discarded, nothing reaches Pi or GitHub, the agent is free again.
 *
 * Holds: a one-shot `Hold` around one start step (the real git module or local sandbox wrapped through the
 * harness's `wrap` option, or the setup check). The engine is stopped while the step is held, then the held step
 * fails, so nothing after it happens (as if the process had died there), then a new Coordinator starts on the same
 * directories. Limits are DEMO_LIMITS except where a test says why.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Git } from "../../src/coordinator/git.ts";
import type { Sandbox } from "../../src/coordinator/ports.ts";
import type { LocalCheck } from "../../src/coordinator/sandbox/local.ts";
import { waitFor } from "../helpers/env.ts";
import { commitOnOrigin, originGit } from "../helpers/fake-github.ts";
import { type FakeStep, userTexts } from "../helpers/fake-model.ts";
import { agentPosition, PROJECT_FILES, type Stack, scriptedAgent, startStack, USER1, USER2 } from "./harness.ts";

type TaskRow = {
	id: number;
	state: string;
	reason: string | null;
	update_id: number;
	branch: string | null;
	worktree_path: string | null;
	base_commit: string | null;
	head_commit: string | null;
	pr_number: number | null;
};
type RunRow = {
	id: number;
	task_id: number;
	state: string;
	reason: string | null;
	request_id: string;
	conversation_id: string | null;
	pid: number | null;
};
type FollowupRow = { id: number; task_id: number; state: string; reason: string | null; run_id: number };
type ConversationRow = { id: string; task_id: number; parent_id: string | null; quarantined: number; reusable: number };

// ---------------------------------------------------------------------------------------------------------------
// Holds

/**
 * A one-shot hold on one start step: armed by the test, entered by the step, then failed by the test. It may be
 * armed again while a step is held: `fail()` fails the step held now, the next step waits on the new arming.
 */
class Hold {
	#armed = false;
	#entered: () => void = () => {};
	#enteredPromise: Promise<void> = Promise.resolve();
	#held: (() => void) | undefined;

	get armed(): boolean {
		return this.#armed;
	}

	/** Resolves once the step is held (since the last `arm()`). */
	get entered(): Promise<void> {
		return this.#enteredPromise;
	}

	arm(): void {
		this.#armed = true;
		this.#enteredPromise = new Promise((resolve) => {
			this.#entered = resolve;
		});
	}

	/** Called by the wrapped step: if armed, waits (once) until `fail()`, then throws. */
	async pass(): Promise<void> {
		if (!this.#armed) return;
		this.#armed = false;
		await new Promise<void>((_, reject) => {
			this.#held = () => reject(new Error("held start step abandoned"));
			this.#entered();
		});
	}

	/** The held step fails, as if the process had died there: nothing after it happens. */
	fail(): void {
		const held = this.#held;
		this.#held = undefined;
		assert.ok(held !== undefined, "a start step is held");
		held();
	}
}

type GitHolds = { readonly createWorktree?: Hold; readonly showFile?: Hold; readonly deleteBranch?: Hold };

/**
 * The real git module with optional holds before `git worktree add`, before reading AGENTS.md, and before recovery
 * deletes a local branch.
 */
function holdingGit(holds: GitHolds): (git: Git) => Git {
	return (git) => ({
		...git,
		deleteBranch: async (branch, createdAt) => {
			await holds.deleteBranch?.pass();
			return git.deleteBranch(branch, createdAt);
		},
		createWorktree: async (branch, path, base) => {
			await holds.createWorktree?.pass();
			return git.createWorktree(branch, path, base);
		},
		showFile: async (rev, path) => {
			await holds.showFile?.pass();
			return git.showFile(rev, path);
		},
	});
}

/** The local sandbox with a hold before the agent container starts (the run key is open by then). */
function holdingSandbox(hold: Hold): (sandbox: Sandbox) => Sandbox {
	return (sandbox) => ({
		...sandbox,
		startAgent: async (spec) => {
			await hold.pass();
			return sandbox.startAgent(spec);
		},
	});
}

/**
 * A setup check that counts its runs and installs into node_modules/ (ignored by git). While `hold` is armed it
 * leaves a half-done install there and holds: git status still says clean, only the saved setup state can tell.
 */
function setupCheck(hold: Hold, counter: { runs: number }): LocalCheck {
	return async (worktree) => {
		counter.runs++;
		await mkdir(join(worktree, "node_modules"), { recursive: true });
		if (hold.armed) await writeFile(join(worktree, "node_modules", ".partial"), "half done\n");
		await hold.pass();
		await writeFile(join(worktree, "node_modules", ".installed"), "set up\n");
		return { exitCode: 0, output: "set up" };
	};
}

/**
 * The Coordinator goes away while `hold` keeps a start step waiting: the engine stops first (the run is abandoned;
 * its rows stay as they are), then the held step fails, then a new Coordinator starts on the same directories.
 */
async function restartWhileHeld(stack: Stack, hold: Hold): Promise<void> {
	const stopping = stack.coordinator.engine.stop();
	hold.fail();
	await stopping;
	await stack.restart();
}

// ---------------------------------------------------------------------------------------------------------------
// Inspection

function slots(stack: Stack): number {
	return stack.coordinator.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM slots")?.n ?? 0;
}

function meta(stack: Stack, key: string): string | undefined {
	return stack.coordinator.store.getMeta(key);
}

function conversations(stack: Stack, taskId: number): ConversationRow[] {
	return stack.coordinator.store.all<ConversationRow>(
		"SELECT * FROM conversations WHERE task_id = ? ORDER BY created_at, rowid",
		taskId,
	);
}

function task(stack: Stack, id: number): TaskRow {
	const row = stack.tasks<TaskRow>().find((each) => each.id === id);
	assert.ok(row !== undefined, `task ${id}`);
	return row;
}

function runsOf(stack: Stack, taskId: number): RunRow[] {
	return stack.runs<RunRow>().filter((run) => run.task_id === taskId);
}

/** Wait until the outbox recorded bot message `messageId` as a task message (a reply to it is then a follow-up). */
async function mapped(stack: Stack, messageId: number): Promise<number> {
	await waitFor(
		() =>
			stack.coordinator.store.get(
				"SELECT task_id FROM task_messages WHERE chat_id = ? AND message_id = ?",
				stack.config.telegram.groupChatId,
				messageId,
			),
		{ what: `bot message ${messageId} mapped to its task` },
	);
	return messageId;
}

/**
 * Submissions of `input` to Pi: model requests where it is the newest user message before any tool round, i.e. the
 * first request after it was submitted. Every request carries it at most once (nothing replayed).
 */
function submissions(stack: Stack, input: string): number {
	for (const request of stack.model.requests) {
		const copies = userTexts(request.body).filter((text) => text.startsWith(input)).length;
		assert.ok(copies <= 1, "the input appears at most once per model request");
	}
	return stack.model.requests.filter((request) => {
		const position = agentPosition(request);
		return position.round === 0 && position.input.startsWith(input);
	}).length;
}

function localBranch(stack: Stack, branch: string): Promise<string | undefined> {
	const repo = join(stack.config.paths.taskDir, "repo.git");
	return originGit(repo, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`], { okCodes: [0, 1] }).then((r) =>
		r.code === 0 ? r.stdout.trim() : undefined,
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Scripted agents

const write = (path: string, content: string): FakeStep => ({
	toolCalls: [{ name: "write", args: { path, content } }],
});

/** Each task text writes its file, then answers; a steer writes the same file (it may land before or after). */
function writer(files: Readonly<Record<string, string>>, extra: { when: RegExp; steps: FakeStep[] }[] = []) {
	return scriptedAgent([
		...extra,
		...Object.entries(files).map(([prefix, file]) => ({
			when: new RegExp(`^${prefix}`),
			steps: [write(file, `${prefix}\n`), { text: `Wrote ${file}.` }],
		})),
	]);
}

const SETUP_FILES = { ...PROJECT_FILES, ".gitignore": "node_modules/\n", ".pi/setup.sh": "npm ci --offline\n" };

// ---------------------------------------------------------------------------------------------------------------
// Back to the queue

test("restart before the first run's worktree exists: the same run goes back to the queue, its steer stays pending and is delivered when it starts; it completes and the model gets the task once", {
	timeout: 120_000,
}, async (t) => {
	const createWorktree = new Hold();
	const ONE = "QUEUED-AGAIN-ONE: write one.txt";
	const STEER = "STEER-KEPT: and mention it";
	const stack = await startStack({
		model: writer({ "QUEUED-AGAIN-ONE": "one.txt", "STEER-KEPT": "one.txt" }),
		wrap: { git: holdingGit({ createWorktree }) },
	});
	t.after(() => stack.stop());
	createWorktree.arm();
	const command = stack.sendCommand(USER1, `/task alpha ${ONE}`);
	const ack = await stack.waitForBotMessage((message) => message.replyTo === command);
	await createWorktree.entered;
	const [run] = stack.runs<RunRow>();
	assert.ok(run !== undefined);
	assert.deepEqual(
		[run.state, slots(stack), task(stack, 1).state, task(stack, 1).worktree_path],
		["starting", 1, "running", null],
	);
	const steer = stack.reply(USER1, await mapped(stack, ack.id), STEER);
	const saved = await stack.waitForBotMessage((message) => message.replyTo === steer);
	assert.match(saved.text, /^Follow-up saved; it will be steered into the running Task 1/);
	const since = stack.lastBotMessageId();

	await restartWhileHeld(stack, createWorktree);
	const requeued = await stack.waitForBotMessage(/^Task 1 is queued again/, { since });
	assert.equal(requeued.text, "Task 1 is queued again after a restart: its run had not started yet. Queue position 1.");
	assert.equal(requeued.replyTo, command, "it replies to the /task message");
	const delivered = await stack.waitForBotMessage((message) => message.replyTo === steer && message.id > since);
	assert.equal(delivered.text, "Follow-up delivered to Task 1.");
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/, { since });
	await stack.coordinator.idle();

	// No double admission: the same run row, the same request id, no second task.
	assert.deepEqual(
		stack.runs<RunRow>().map((row) => [row.id, row.request_id, row.state]),
		[[run.id, run.request_id, "finished"]],
	);
	assert.equal(run.request_id, String(task(stack, 1).update_id));
	assert.equal(stack.tasks().length, 1);
	assert.deepEqual(
		stack.followups<FollowupRow>().map((row) => [row.run_id, row.state]),
		[[run.id, "delivered"]],
	);
	// Submitted to Pi once, in one conversation.
	assert.equal(submissions(stack, ONE), 1);
	assert.equal(conversations(stack, 1).length, 1);
	assert.equal(slots(stack), 0, "the slot is released");
	assert.equal(meta(stack, "restart_returns:1"), undefined, "the count is dropped once the run started");
	assert.equal(stack.lastBotMessages(30).filter((message) => /queued again/.test(message.text)).length, 1);
});

test("restart while the setup script runs: the part-done worktree and its local branch are discarded and recreated from the latest main; the open-task limit holds across the restart", {
	timeout: 180_000,
}, async (t) => {
	const setupHold = new Hold();
	const setups = { runs: 0 };
	const ONE = "OPEN-ONE: write one.txt";
	const TWO = "PARTIAL-TWO: write two.txt";
	const THREE = "WAITING-THREE: write three.txt";
	const stack = await startStack({
		files: SETUP_FILES,
		checks: { setup: setupCheck(setupHold, setups) },
		model: writer({ "OPEN-ONE": "one.txt", "PARTIAL-TWO": "two.txt", "WAITING-THREE": "three.txt" }),
		// Two open tasks instead of 4, so the limit is reached with one task in review and one starting.
		limits: { openTasksPerGroup: 2 },
	});
	t.after(() => stack.stop());
	stack.sendCommand(USER1, `/task alpha ${ONE}`);
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	setupHold.arm();
	const two = stack.sendCommand(USER1, `/task alpha ${TWO}`);
	await setupHold.entered;
	const before = task(stack, 2);
	assert.ok(before.worktree_path !== null && before.base_commit !== null);
	assert.ok(existsSync(join(before.worktree_path, "node_modules", ".partial")), "setup changed the worktree part-way");
	assert.equal(meta(stack, "setup:2"), "started");
	const three = stack.sendCommand(USER2, `/task beta ${THREE}`);
	const ackThree = await stack.waitForBotMessage((message) => message.replyTo === three);
	assert.match(ackThree.text, /Waiting for open reviews to finish \(2 open tasks\)/, "Task 3 waits: two are open");
	assert.equal(runsOf(stack, 3)[0]?.state, "queued");
	const moved = await commitOnOrigin(stack.origin.bare, "main", { "moved.txt": "main moved on\n" });
	const runTwo = runsOf(stack, 2)[0];
	const since = stack.lastBotMessageId();

	await restartWhileHeld(stack, setupHold);
	const requeued = await stack.waitForBotMessage(/^Task 2 is queued again/, { since });
	assert.equal(requeued.replyTo, two);
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/, { since });
	await stack.coordinator.idle();

	const after = task(stack, 2);
	assert.equal(after.base_commit, moved, "recreated from the latest main");
	assert.notEqual(before.base_commit, moved);
	assert.ok(after.worktree_path !== null);
	assert.ok(existsSync(join(after.worktree_path, "moved.txt")));
	assert.ok(!existsSync(join(after.worktree_path, "node_modules", ".partial")), "the part-done worktree was discarded");
	assert.ok(existsSync(join(after.worktree_path, "node_modules", ".installed")), "set up again");
	assert.equal(setups.runs, 3, "Task 1, Task 2 held, Task 2 again on the new worktree");
	assert.deepEqual(
		runsOf(stack, 2).map((run) => [run.id, run.request_id, run.state]),
		[[runTwo?.id, runTwo?.request_id, "finished"]],
	);
	assert.equal(submissions(stack, TWO), 1);
	assert.equal(meta(stack, "restart_worktree:2"), undefined);
	// The open-task limit held: Task 3 never started while Tasks 1 and 2 were open.
	assert.deepEqual(
		[task(stack, 3).state, task(stack, 3).worktree_path, runsOf(stack, 3)[0]?.state],
		["queued", null, "queued"],
	);
	assert.equal(submissions(stack, THREE), 0);
	assert.equal(slots(stack), 0);
	// A place frees: Task 3 starts and completes.
	stack.sendCommand(USER1, "/cancel 1");
	await stack.waitForBotMessage(/^Task 1 cancelled/, { since });
	await stack.waitForBotMessage(/^Task 3 is ready for review \(run 1\)/, { since });
	await stack.coordinator.idle();
	assert.equal(slots(stack), 0);
});

test("a restart in the middle of the worktree reconciliation redoes it from the saved intent; the run is queued again once and completes", {
	timeout: 120_000,
}, async (t) => {
	const setupHold = new Hold();
	const deleteBranch = new Hold();
	const setups = { runs: 0 };
	const ONE = "RECONCILED-ONE: write one.txt";
	const stack = await startStack({
		files: SETUP_FILES,
		checks: { setup: setupCheck(setupHold, setups) },
		model: writer({ "RECONCILED-ONE": "one.txt" }),
		wrap: { git: holdingGit({ deleteBranch }) },
	});
	t.after(() => stack.stop());
	setupHold.arm();
	stack.sendCommand(USER1, `/task alpha ${ONE}`);
	await setupHold.entered;
	const since = stack.lastBotMessageId();
	deleteBranch.arm();
	await restartWhileHeld(stack, setupHold);
	// Recovery forgot the worktree and removed its folder; the local branch is not deleted yet.
	await deleteBranch.entered;
	assert.deepEqual([task(stack, 1).worktree_path, runsOf(stack, 1)[0]?.state], [null, "queued"]);
	assert.equal(meta(stack, "restart_worktree:1"), "check");
	assert.deepEqual(await stack.worktrees(), []);
	assert.ok((await localBranch(stack, "task/1")) !== undefined);

	await restartWhileHeld(stack, deleteBranch);
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/, { since });
	await stack.coordinator.idle();
	const requeued = stack.bot.sent().filter((message) => message.id > since && /queued again/.test(message.text));
	assert.equal(requeued.length, 1, "the second restart found a queued run, not a starting one");
	assert.equal(stack.bot.sent().filter((message) => /^Group frozen/.test(message.text)).length, 0);
	assert.equal(meta(stack, "restart_worktree:1"), undefined);
	assert.equal(setups.runs, 2);
	assert.equal(stack.runs().length, 1);
	assert.equal(submissions(stack, ONE), 1);
});

test("restart after setup, before the run key: the pristine worktree at its recorded base is kept and setup is not repeated", {
	timeout: 120_000,
}, async (t) => {
	const showFile = new Hold();
	const setups = { runs: 0 };
	const ONE = "KEPT-ONE: write one.txt";
	const stack = await startStack({
		files: SETUP_FILES,
		checks: { setup: setupCheck(new Hold(), setups) },
		model: writer({ "KEPT-ONE": "one.txt" }),
		wrap: { git: holdingGit({ showFile }) },
	});
	t.after(() => stack.stop());
	showFile.arm();
	stack.sendCommand(USER1, `/task alpha ${ONE}`);
	await showFile.entered;
	const before = task(stack, 1);
	const [conversation] = conversations(stack, 1);
	assert.ok(before.worktree_path !== null && conversation !== undefined);
	assert.equal(meta(stack, "setup:1"), "done");
	const moved = await commitOnOrigin(stack.origin.bare, "main", { "moved.txt": "main moved on\n" });
	const since = stack.lastBotMessageId();

	await restartWhileHeld(stack, showFile);
	await stack.waitForBotMessage(/^Task 1 is queued again after a restart: its run had not started yet\./, { since });
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/, { since });
	await stack.coordinator.idle();

	const after = task(stack, 1);
	assert.equal(after.worktree_path, before.worktree_path);
	assert.equal(after.base_commit, before.base_commit, "kept at its recorded base");
	assert.notEqual(after.base_commit, moved);
	assert.ok(existsSync(join(before.worktree_path, "node_modules", ".installed")), "the setup output is kept");
	assert.equal(setups.runs, 1, "setup is not repeated");
	assert.deepEqual(
		conversations(stack, 1).map((row) => row.id),
		[conversation.id],
		"the run keeps its conversation",
	);
	assert.equal(runsOf(stack, 1)[0]?.conversation_id, conversation.id);
	assert.equal(submissions(stack, ONE), 1);
	assert.equal(stack.runs().length, 1);
});

test("restart of a follow-up run before its run key: back to the queue on the same worktree, branch, pull request and conversation", {
	timeout: 120_000,
}, async (t) => {
	const showFile = new Hold();
	const ONE = "FOLLOW-ONE: write one.txt";
	const TWO = "FOLLOW-TWO: write two.txt";
	const stack = await startStack({
		model: writer({ "FOLLOW-ONE": "one.txt", "FOLLOW-TWO": "two.txt" }),
		wrap: { git: holdingGit({ showFile }) },
	});
	t.after(() => stack.stop());
	stack.sendCommand(USER1, `/task alpha ${ONE}`);
	const review = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	await stack.coordinator.idle();
	const headOne = task(stack, 1).head_commit;
	showFile.arm();
	const reply = stack.reply(USER1, await mapped(stack, review.id), TWO);
	await stack.waitForBotMessage((message) => message.replyTo === reply);
	await showFile.entered;
	const runTwo = runsOf(stack, 1)[1];
	assert.equal(runTwo?.state, "starting");
	const since = stack.lastBotMessageId();

	await restartWhileHeld(stack, showFile);
	await stack.waitForBotMessage(/^Task 1 is queued again after a restart/, { since });
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 2\)/, { since });
	await stack.coordinator.idle();

	assert.deepEqual(
		runsOf(stack, 1).map((run) => [run.id, run.state]),
		[
			[runsOf(stack, 1)[0]?.id, "finished"],
			[runTwo?.id, "finished"],
		],
	);
	const after = task(stack, 1);
	assert.ok(after.worktree_path !== null);
	assert.ok(existsSync(join(after.worktree_path, "one.txt")) && existsSync(join(after.worktree_path, "two.txt")));
	assert.ok(headOne !== null && (await stack.isAncestor(headOne, after.head_commit ?? "")), "run 1's work is kept");
	assert.equal(await stack.branchSha("task/1"), after.head_commit);
	assert.equal(stack.github.pulls.size, 1, "the same pull request");
	assert.equal(after.pr_number, 1);
	const [conversation] = conversations(stack, 1);
	assert.equal(conversations(stack, 1).length, 1, "the clean conversation is reused, not quarantined");
	assert.equal(conversation?.quarantined, 0);
	assert.equal(runsOf(stack, 1)[1]?.conversation_id, conversation?.id);
	assert.equal(submissions(stack, TWO), 1);
});

// ---------------------------------------------------------------------------------------------------------------
// Interrupted (Pi launched or a run key opened): today's rule

async function interruptedAt(t: { after(fn: () => unknown): void }, point: "run key" | "Pi process"): Promise<void> {
	const startAgent = new Hold();
	const ONE = "INTERRUPTED-ONE: write one.txt";
	const STEER = "STEER-EXPIRES: and a footer";
	const FRESH = "RESUMED-FRESH: write one.txt again";
	const hang: FakeStep = { hang: true };
	const stack = await startStack({
		model: scriptedAgent([
			{ when: /^INTERRUPTED-ONE/, steps: [hang] },
			{ when: /RESUMED-FRESH/, steps: [write("one.txt", "fresh\n"), { text: "Wrote one.txt." }] },
		]),
		wrap: { sandbox: holdingSandbox(startAgent) },
	});
	t.after(() => stack.stop());
	if (point === "run key") startAgent.arm();
	const command = stack.sendCommand(USER1, `/task alpha ${ONE}`);
	const ack = await stack.waitForBotMessage((message) => message.replyTo === command);
	if (point === "run key") await startAgent.entered;
	else await stack.model.waitForRequests(1, 30_000);
	const run = await waitFor(() => stack.runs<RunRow>()[0], { what: "run 1" });
	const keys = stack.coordinator.store.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM run_keys WHERE run_id = ?",
		run.id,
	);
	assert.equal(keys?.n, 1, "a run key was opened");
	if (point === "Pi process") {
		await waitFor(() => stack.runs<RunRow>()[0]?.pid, { what: "Pi process recorded" });
	}
	const steer = stack.reply(USER1, await mapped(stack, ack.id), STEER);
	await stack.waitForBotMessage((message) => message.replyTo === steer);
	const since = stack.lastBotMessageId();

	if (point === "run key") await restartWhileHeld(stack, startAgent);
	else await stack.restart();
	const interrupted = await stack.waitForBotMessage(/^Task 1 was interrupted by restart \(run 1\)/, { since });
	const expired = await stack.waitForBotMessage((message) => message.replyTo === steer && message.id > since);
	assert.equal(expired.text, "Follow-up to Task 1 expired: the run was interrupted by a restart.");
	await stack.coordinator.idle();
	assert.deepEqual([runsOf(stack, 1)[0]?.state, runsOf(stack, 1)[0]?.reason], ["failed", "interrupted by restart"]);
	assert.equal(task(stack, 1).state, "review");
	assert.ok(existsSync(task(stack, 1).worktree_path ?? ""), "the worktree is kept");
	assert.deepEqual(
		conversations(stack, 1).map((row) => [row.quarantined, row.reusable]),
		[[1, 0]],
	);
	assert.equal(stack.lastBotMessages(30).filter((message) => /queued again/.test(message.text)).length, 0);
	// Never resubmitted: Pi got it once if its process had started, else never.
	assert.equal(submissions(stack, ONE), point === "Pi process" ? 1 : 0);

	// Only an authorized follow-up runs it again, on a fresh conversation seeded with the task text.
	const reply = stack.reply(USER1, await mapped(stack, interrupted.id), FRESH);
	await stack.waitForBotMessage((message) => message.replyTo === reply, { since });
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 2\)/, { since });
	await stack.coordinator.idle();
	assert.equal(submissions(stack, ONE), point === "Pi process" ? 1 : 0, "still not resubmitted");
	const fresh = conversations(stack, 1)[1];
	assert.equal(fresh?.parent_id, conversations(stack, 1)[0]?.id);
	const seeded = stack.model.requests.filter((request) =>
		userTexts(request.body).some((text) => text.includes(`Original task:\n${ONE}`)),
	);
	assert.ok(seeded.length > 0, "the fresh conversation is seeded with the task text");
	assert.equal(stack.runs().length, 2);
}

test(
	"restart after the run key was opened (Pi not launched yet): failed 'interrupted by restart', worktree kept, conversation quarantined, steer expired, never submitted; a reply runs it fresh",
	{
		timeout: 120_000,
	},
	(t) => interruptedAt(t, "run key"),
);

test(
	"restart after the Pi process was launched: failed 'interrupted by restart', submitted once and never again; a reply runs it fresh",
	{
		timeout: 120_000,
	},
	(t) => interruptedAt(t, "Pi process"),
);

// ---------------------------------------------------------------------------------------------------------------
// Restart loop

test("a restart loop while the first run starts: back to the queue 3 times (count saved), the 4th restart fails the task; its local worktree and branch are discarded, nothing reaches Pi or GitHub", {
	timeout: 180_000,
}, async (t) => {
	const setupHold = new Hold();
	const setups = { runs: 0 };
	const ONE = "LOOPING-ONE: write one.txt";
	const NEXT = "AFTER-LOOP: write next.txt";
	const stack = await startStack({
		files: SETUP_FILES,
		checks: { setup: setupCheck(setupHold, setups) },
		model: writer({ "LOOPING-ONE": "one.txt", "AFTER-LOOP": "next.txt" }),
	});
	t.after(() => stack.stop());
	setupHold.arm();
	const command = stack.sendCommand(USER1, `/task alpha ${ONE}`);
	await stack.waitForBotMessage((message) => message.replyTo === command);
	const runId = (await waitFor(() => stack.runs<RunRow>()[0], { what: "run 1" })).id;
	let since = 0;
	for (let restart = 1; restart <= 4; restart++) {
		await setupHold.entered;
		assert.ok(existsSync(join(stack.config.paths.taskDir, "worktrees", "task-1")), "a worktree is being set up");
		since = stack.lastBotMessageId();
		// Armed again before the restart, so the next start is held too (the first three restarts).
		if (restart < 4) setupHold.arm();
		await restartWhileHeld(stack, setupHold);
		if (restart === 4) break;
		const requeued = await stack.waitForBotMessage(/^Task 1 is queued again/, { since });
		assert.equal(
			requeued.text,
			"Task 1 is queued again after a restart: its run had not started yet. Queue position 1.",
		);
		assert.equal(meta(stack, `restart_returns:${runId}`), String(restart), "the count is saved");
	}
	const failed = await stack.waitForBotMessage(/^Task 1 failed/, { since });
	assert.equal(
		failed.text,
		"Task 1 failed: the Coordinator restarted 4 times before its run could start, so it is not queued again. " +
			"Send a new /task for further work.",
	);
	await stack.coordinator.idle();
	assert.deepEqual(
		stack.runs<RunRow>().map((run) => [run.id, run.state, run.reason]),
		[[runId, "failed", "the Coordinator restarted 4 times before its run could start, so it is not queued again"]],
	);
	assert.equal(task(stack, 1).state, "failed");
	assert.equal(meta(stack, `restart_returns:${runId}`), "3");
	assert.equal(stack.model.requests.length, 0, "nothing reached Pi");
	assert.equal(setups.runs, 4);
	assert.deepEqual(await stack.worktrees(), [], "the local worktree is discarded");
	assert.equal(await localBranch(stack, "task/1"), undefined, "the local branch is discarded");
	assert.deepEqual(await stack.branches(), ["main"], "nothing was pushed");
	assert.equal(stack.github.pulls.size, 0);
	assert.equal(slots(stack), 0);
	// The agent and the slots are free: the next task runs normally.
	stack.sendCommand(USER1, `/task alpha ${NEXT}`);
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/, { since });
	await stack.coordinator.idle();
	assert.equal(submissions(stack, NEXT), 1);
	assert.equal(slots(stack), 0);
});
