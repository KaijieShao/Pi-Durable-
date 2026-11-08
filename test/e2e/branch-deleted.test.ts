/** At-most-one PR through the real Coordinator/Pi/git against local fake Telegram, model and GitHub APIs. */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { type TestContext, test } from "node:test";
import type { Git } from "../../src/coordinator/git.ts";
import { waitFor } from "../helpers/env.ts";
import { originGit } from "../helpers/fake-github.ts";
import { GROUP, type Stack, scriptedAgent, startStack, USER1, USER2 } from "./harness.ts";

type Task = {
	id: number;
	state: string;
	branch: string | null;
	head_commit: string | null;
	posted_head: string | null;
	pr_number: number | null;
	worktree_path: string | null;
};
const plans = () =>
	scriptedAgent([
		{
			when: /^ALPHA-FIRST/,
			steps: [
				{ toolCalls: [{ name: "write", args: { path: "a.js", content: "exports.a=()=>1;\n" } }] },
				{ text: "Added a." },
			],
		},
		{
			when: /^BETA-OTHER/,
			steps: [
				{ toolCalls: [{ name: "write", args: { path: "b.js", content: "exports.b=()=>2;\n" } }] },
				{ text: "Added b." },
			],
		},
		{
			when: /FOLLOW/,
			steps: [
				{ toolCalls: [{ name: "write", args: { path: "more.js", content: "exports.more=1;\n" } }] },
				{ text: "More." },
			],
		},
	]);
const row = (stack: Stack, id = 1): Task => {
	const found = stack.tasks<Task>().find((task) => task.id === id);
	assert.ok(found);
	return found;
};
async function command(stack: Stack, user: number, text: string) {
	const sent = stack.sendCommand(user, text);
	return stack.waitForBotMessage((message) => message.replyTo === sent);
}
async function reviewed(stack: Stack, id = 1, since = 0) {
	const message = await stack.waitForBotMessage(new RegExp(`^Task ${id} is ready for review`), { since });
	const task = row(stack, id);
	assert.ok(task.head_commit && task.pr_number);
	return { message, head: task.head_commit, number: task.pr_number };
}
async function deleteBranch(stack: Stack, id = 1) {
	const task = row(stack, id),
		head = await stack.branchSha(task.branch as string);
	assert.ok(head);
	const pr = stack.github.pulls.get(task.pr_number as number);
	assert.ok(pr);
	pr.closedHeadSha = head;
	pr.state = "closed";
	await originGit(stack.origin.bare, ["update-ref", "-d", `refs/heads/${task.branch}`]);
	return head;
}
async function stackFor(t: TestContext, wrap?: (git: Git) => Git) {
	const stack = await startStack({ model: plans(), ...(wrap === undefined ? {} : { wrap: { git: wrap } }) });
	t.after(() => stack.stop());
	return stack;
}
const taskPulls = (stack: Stack) => [...stack.github.pulls.values()].filter((pr) => pr.head === "task/1");

test("idle deletion: one persistent task hold, follow-up/approval refused, restart does not push, other tasks run, original PR restores", {
	timeout: 180_000,
}, async (t) => {
	const stack = await stackFor(t);
	await command(stack, USER1, "/task alpha ALPHA-FIRST");
	const initial = await reviewed(stack),
		worktree = row(stack).worktree_path as string;
	await deleteBranch(stack);
	const held = await stack.waitForBotMessage(/^Task 1 is held for review/, { since: initial.message.id });
	assert.match(held.text, /deleted on GitHub/);
	assert.match(held.text, new RegExp(`original pull request #${initial.number}`));
	assert.match(held.text, /No replacement pull request/);
	const requests = stack.model.requests.length;
	const reply = stack.reply(USER1, initial.message.id, "FOLLOW while missing");
	const refused = await stack.waitForBotMessage((message) => message.replyTo === reply);
	assert.match(refused.text, /Follow-up rejected: Task 1 is held/);
	assert.match((await command(stack, USER1, "/approve 1")).text, /\/approve rejected: Task 1 is held/);
	assert.equal(stack.model.requests.length, requests);
	await stack.restart();
	await stack.coordinator.idle();
	assert.equal(await stack.branchSha("task/1"), undefined);
	assert.equal(row(stack).pr_number, initial.number);
	assert.ok(existsSync(worktree));
	assert.equal(taskPulls(stack).length, 1);
	assert.equal(stack.bot.sent().filter((message) => /^Task 1 is held for review/.test(message.text)).length, 1);
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal");
	await command(stack, USER2, "/task beta BETA-OTHER");
	await reviewed(stack, 2, held.id);
	assert.equal(row(stack, 2).state, "review", "other tasks continue without unfreezing");
	assert.equal((await stack.owner("status")).stdout.includes("no replacement PR"), true);
	await originGit(stack.origin.bare, ["update-ref", "refs/heads/task/1", initial.head]);
	// Restoring just the branch does not consume a test slot or repost a closed PR.
	await waitFor(() => JSON.parse(stack.coordinator.store.getMeta("branch_hold:1") ?? "{}").cause === "pr_closed", {
		what: "original PR still closed",
		timeoutMs: 20_000,
	});
	assert.equal(stack.coordinator.store.get("SELECT 1 FROM slots WHERE task_id = 1"), undefined);
	const original = stack.github.pulls.get(initial.number);
	assert.ok(original);
	original.state = "open";
	original.closedHeadSha = undefined;
	const restored = await reviewed(stack, 1, held.id);
	assert.equal(restored.number, initial.number);
	await command(stack, USER1, "/approve 1");
	await stack.waitForBotMessage(/^Task 1 merged into main/, { since: restored.message.id });
	assert.equal(taskPulls(stack).length, 1);
	assert.equal(stack.github.count("POST", /\/pulls$/), 2, "exactly one PR for each of two tasks");
});

test("lost creation response with an already-closed historical PR never creates or recreates a branch/PR", {
	timeout: 120_000,
}, async (t) => {
	const stack = await stackFor(t);
	stack.github.afterCreate = async (pr) => {
		if (pr.head !== "task/1") return;
		pr.closedHeadSha = await stack.github.headSha(pr);
		pr.state = "closed";
		await originGit(stack.origin.bare, ["update-ref", "-d", "refs/heads/task/1"]);
	};
	stack.github.dropResponseAfterEffect("POST", /\/pulls$/);
	await command(stack, USER1, "/task alpha ALPHA-FIRST");
	await stack.waitForBotMessage(/^Task 1 is held for review/);
	assert.equal(stack.github.count("POST", /\/pulls$/), 1);
	assert.equal(taskPulls(stack).length, 1);
	assert.equal(row(stack).pr_number, 1);
	assert.equal(await stack.branchSha("task/1"), undefined);
	await stack.restart();
	await stack.coordinator.idle();
	assert.equal(stack.github.count("POST", /\/pulls$/), 1);
	assert.equal(await stack.branchSha("task/1"), undefined);
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal");
});

test("deletion after the engine pre-read but before the real Git push is rejected atomically, without force or a replacement PR", {
	timeout: 120_000,
}, async (t) => {
	let stack: Stack | undefined;
	const control = { deleteBeforePush: false, deleted: false };
	const wrap = (git: Git): Git => ({
		...git,
		async push(path, branch, options) {
			if (control.deleteBeforePush && branch === "task/1") {
				control.deleteBeforePush = false;
				control.deleted = true;
				assert.ok(stack);
				await deleteBranch(stack);
			}
			return git.push(path, branch, options);
		},
	});
	stack = await stackFor(t, wrap);
	await command(stack, USER1, "/task alpha ALPHA-FIRST");
	const initial = await reviewed(stack);
	control.deleteBeforePush = true;
	const reply = stack.reply(USER1, initial.message.id, "FOLLOW before push");
	await stack.waitForBotMessage((message) => message.replyTo === reply);
	await stack.waitForBotMessage(/^Task 1 is held for review/, { since: initial.message.id });
	assert.equal(control.deleted, true);
	assert.equal(await stack.branchSha("task/1"), undefined);
	assert.equal(stack.github.count("POST", /\/pulls$/), 1);
	assert.equal(row(stack).pr_number, initial.number);
	assert.equal(taskPulls(stack).length, 1);
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal");
});

test("cancel after deletion still saves and archives its final work using the same closed PR; completed task stays completed", {
	timeout: 120_000,
}, async (t) => {
	const stack = await stackFor(t);
	await command(stack, USER1, "/task alpha ALPHA-FIRST");
	const initial = await reviewed(stack);
	await deleteBranch(stack);
	await command(stack, USER1, "/cancel 1");
	await stack.waitForBotMessage(/^Task 1 cancelled\./, { since: initial.message.id });
	assert.equal(row(stack).state, "cancelled");
	assert.equal(row(stack).worktree_path, null);
	assert.equal(row(stack).pr_number, initial.number);
	assert.equal(await stack.branchSha("task/1"), initial.head, "terminal final-checkpoint push still preserves work");
	assert.equal(stack.github.count("POST", /\/pulls$/), 1);
	await deleteBranch(stack);
	await stack.restart();
	await stack.coordinator.idle();
	assert.equal(row(stack).state, "cancelled");
	assert.equal(await stack.branchSha("task/1"), undefined, "already archived completed tasks are not monitored");
	assert.equal(stack.coordinator.store.getMeta("branch_hold:1"), undefined);
});
