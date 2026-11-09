/**
 * The boot disk and the task disk end to end (Capacity § Disk; Deployment § Disk and Data), through the real
 * Coordinator against 127.0.0.1 fakes:
 *
 * - "When its free space runs low, new tasks are rejected with a reason": a /task is refused while the boot disk
 *   (PI_DATA_DIR's filesystem) has less than PI_BOOT_DISK_MIN_FREE free, naming the boot disk and both amounts;
 *   follow-ups, /status, /cancel and /approve still work; an unreadable boot disk refuses new tasks (fails closed).
 * - "If a new worktree would exceed it, the task stays queued and the bot says why": with PI_TASK_DISK_BUDGET, the
 *   real usage of PI_TASK_DIR (a setup script that writes build output into the first task's worktree) leaves no
 *   room for the next worktree; the task stays queued at its position, is told once, takes no slot and gets no
 *   worktree, while a follow-up run of a task with a worktree is not held; it starts by itself once another task's
 *   worktree is archived. And with an injected probe (TEST ONLY: CoordinatorDeps.diskProbe): a task disk that cannot
 *   be measured holds new worktrees (fails closed), one below the free-space floor too, until there is room.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { type DiskProbe, systemDiskProbe } from "../../src/coordinator/disk.ts";
import type { Sandbox } from "../../src/coordinator/ports.ts";
import type { ServerMessage } from "../fixtures/fake-bot-api.ts";
import { waitFor } from "../helpers/env.ts";
import { originGit } from "../helpers/fake-github.ts";
import type { FakeHandler } from "../helpers/fake-model.ts";
import {
	agentPosition,
	OWNER,
	PROJECT_FILES,
	type Stack,
	type StackOptions,
	startStack,
	USER1,
	USER2,
} from "./harness.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

type TaskRow = { id: number; state: string; worktree_path: string | null };
type RunRow = {
	id: number;
	task_id: number;
	kind: string;
	state: string;
	dispatched_at: number | null;
	started_at: number | null;
};

/** Every run writes `<job>.txt` (its input starts with the job name), then answers. */
const jobAgent: FakeHandler = (request) => {
	const { input, round } = agentPosition(request);
	const job = /\b(job-\d+[a-z]?)\b/.exec(input)?.[1] ?? "job-x";
	if (round === 0) return { toolCalls: [{ name: "write", args: { path: `${job}.txt`, content: `${job}\n` } }] };
	return { text: `Wrote ${job}.txt.` };
};

async function stackFor(t: TestContext, options: StackOptions): Promise<Stack> {
	const stack = await startStack({ model: jobAgent, ...options });
	t.after(() => stack.stop());
	return stack;
}

/** The bot's reply to the command message `messageId`. */
function replyTo(stack: Stack, messageId: number): Promise<ServerMessage> {
	return stack.waitForBotMessage((message) => message.replyTo === messageId);
}

async function command(stack: Stack, userId: number, text: string): Promise<string> {
	return (await replyTo(stack, stack.sendCommand(userId, text))).text;
}

function task(stack: Stack, id: number): TaskRow {
	const row = stack.tasks<TaskRow>().find((candidate) => candidate.id === id);
	assert.ok(row !== undefined, `task ${id} exists`);
	return row;
}

function firstRun(stack: Stack, taskId: number): RunRow {
	const run = stack.runs<RunRow>().find((candidate) => candidate.task_id === taskId);
	assert.ok(run !== undefined, `task ${taskId} has a run`);
	return run;
}

const slots = (stack: Stack): number => stack.coordinator.store.all("SELECT id FROM slots").length;

/** How many "Task N stays queued" messages the bot sent for task `id`. */
const toldWaiting = (stack: Stack, id: number): number =>
	stack.lastBotMessages(1000).filter((message) => new RegExp(`^Task ${id} stays queued: `).test(message.text)).length;

/** /status line of task `id`. */
async function statusLine(stack: Stack, id: number): Promise<string> {
	const text = await command(stack, USER2, "/status");
	return text.split("\n").find((line) => line.startsWith(`Task ${id} · `)) ?? text;
}

/** Engine passes after pending work, so a run still queued afterwards is held by a limit, not by timing. */
async function settle(stack: Stack): Promise<void> {
	await stack.coordinator.idle();
	for (let pass = 0; pass < 2; pass++) {
		await new Promise((resolve) => setImmediate(resolve));
		stack.coordinator.engine.kick();
	}
	await stack.coordinator.idle();
}

/** A probe that answers for the data dir (boot disk) or the task dir from `state`, and measures the rest for real. */
function probeFor(state: { boot?: number | "unreadable"; task?: number | "unreadable" }): DiskProbe {
	const answer = (value: number | "unreadable", path: string) => {
		if (value === "unreadable") throw new Error(`EIO: ${path}`);
		return { free: value, size: 4 * 1024 * GiB, used: 4 * 1024 * GiB - value };
	};
	return {
		space: (path) => {
			if (path.endsWith("/data") && state.boot !== undefined) return answer(state.boot, path);
			if (path.endsWith("/tasks") && state.task !== undefined) return answer(state.task, path);
			return systemDiskProbe.space(path);
		},
		isMountPoint: systemDiskProbe.isMountPoint,
		treeBytes: systemDiskProbe.treeBytes,
	};
}

test("boot disk low: new tasks are refused, follow-ups wait without a slot, status/cancel work and execution recovers", {
	timeout: 180_000,
}, async (t) => {
	const disk: { boot: number | "unreadable" } = { boot: 50 * GiB };
	// PI_BOOT_DISK_MIN_FREE (default 1 GiB from DEMO_LIMITS) is a setting: 2 GiB here, to show it is the one used.
	const stack = await stackFor(t, {
		diskProbe: probeFor(disk),
		env: { PI_AGENTS: "alpha,beta,gamma", PI_BOOT_DISK_MIN_FREE: "2GiB" },
	});
	assert.match(await command(stack, USER1, "/task alpha job-1 first task"), /^Task 1 accepted for agent alpha\./);
	const review1 = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	assert.match(await command(stack, USER2, "/task beta job-2 second task"), /^Task 2 accepted for agent beta\./);
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/);

	disk.boot = 1.5 * GiB;
	assert.equal(
		await command(stack, USER1, "/task gamma job-3 a new task while the boot disk is low"),
		"Task request rejected: the boot disk is low on free space: 1.5 GiB free, at least 2.0 GiB needed for new " +
			"tasks; follow-ups, /status, /cancel and /approve still work.",
	);
	assert.deepEqual(
		stack.tasks<TaskRow>().map((row) => row.id),
		[1, 2],
		"no task was created",
	);

	// Commands remain durable, but a follow-up cannot execute below the safety floor.
	await settle(stack);
	assert.match(await command(stack, USER2, "/status"), /^Group: normal\..*\nTask 1 · alpha · in review/s);
	const followup = stack.reply(USER1, review1.id, "job-1b follow-up while the boot disk is low");
	assert.match(
		(await replyTo(stack, followup)).text,
		/^Follow-up started another run of Task 1 on the same branch and pull request\./,
	);
	await settle(stack);
	assert.equal(stack.runs<RunRow>().at(-1)?.state, "queued");
	assert.equal(slots(stack), 0, "no execution slot below the safety floor");
	assert.match(await command(stack, USER2, "/status"), /Execution paused: the boot disk/);
	assert.match(await command(stack, USER2, "/cancel 2"), /^Cancelling Task 2…/);
	await stack.waitForBotMessage(/^Task 2 cancelled\./);
	disk.boot = 50 * GiB;
	stack.coordinator.engine.kick();
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 2\)/, { since: review1.id });
	assert.match(await command(stack, USER1, "/approve 1"), /^Approved Task 1 at [0-9a-f]{7}/);
	await stack.waitForBotMessage(/^Task 1 merged into main/);

	// The boot disk cannot be measured: new tasks are refused (fails closed).
	disk.boot = "unreadable";
	assert.equal(
		await command(stack, OWNER, "/task gamma job-4 while the boot disk cannot be read"),
		"Task request rejected: the free space of the boot disk cannot be read, so new tasks are refused; follow-ups, " +
			"/status, /cancel and /approve still work.",
	);
	// Room again: accepted.
	disk.boot = 50 * GiB;
	assert.match(await command(stack, USER1, "/task gamma job-5 room again"), /^Task 3 accepted for agent gamma\./);
	await stack.waitForBotMessage(/^Task 3 is ready for review \(run 1\)/);
	assert.equal(stack.tasks<TaskRow>().length, 3);
});

test("task disk budget: a new worktree that would exceed it stays queued, told once, with no slot and no worktree; a follow-up run is not held; it starts once another task's worktree is archived", {
	timeout: 240_000,
}, async (t) => {
	// The setup script's "build output": 9 MiB in each worktree (ignored by git, so never pushed). Each new worktree is
	// estimated at its files (a few 4 KiB blocks) + 10 MiB headroom; the budget of 16 MiB holds the repository and
	// one such worktree, not two. Every other limit is DEMO_LIMITS; the task disk's free space is the real one.
	const setup = async (worktree: string) => {
		await mkdir(join(worktree, "build"), { recursive: true });
		await writeFile(join(worktree, "build", "deps.bin"), randomBytes(9 * MiB));
		return { exitCode: 0, output: "installed" };
	};
	const stack = await stackFor(t, {
		files: { ...PROJECT_FILES, ".gitignore": "build/\n", ".pi/setup.sh": "#!/bin/sh\nexit 0\n" },
		checks: { setup },
		env: { PI_AGENTS: "alpha,beta", PI_TASK_DISK_BUDGET: "16MiB", PI_WORKTREE_HEADROOM: "10MiB" },
	});
	assert.match(await command(stack, USER1, "/task alpha job-1 first task"), /^Task 1 accepted/);
	const review1 = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);

	// Task 2 finds out right before its worktree would be created: back in the queue, its slot released, told why.
	assert.equal(
		await command(stack, USER2, "/task beta job-2 second task"),
		"Task 2 accepted for agent beta. Queue position 1.",
	);
	const waiting = await stack.waitForBotMessage(/^Task 2 stays queued: /);
	assert.match(
		waiting.text,
		/^Task 2 stays queued: its new worktree needs about 10\.\d MiB, but the task disk budget of 16\.0 MiB has only \d+\.\d MiB left \(\d+\.\d MiB in use\)\. It starts by itself once there is room, for example when another task is merged or cancelled and its worktree is archived\.$/,
	);
	// Task 3 arrives while new worktrees are held: told in its acknowledgement, it never takes a slot.
	const ack3 = await command(stack, USER2, "/task beta job-3 third task");
	assert.match(
		ack3,
		/^Task 3 accepted for agent beta\. Queue position 2\. Waiting for room on the task disk: its new worktree needs about 10\.\d MiB, but the task disk budget of 16\.0 MiB/,
	);
	await settle(stack);
	assert.deepEqual([task(stack, 2).state, task(stack, 3).state], ["queued", "queued"]);
	assert.deepEqual([firstRun(stack, 2).state, firstRun(stack, 3).state], ["queued", "queued"]);
	assert.equal(firstRun(stack, 3).dispatched_at, null, "task 3 never took a slot");
	assert.equal(task(stack, 2).worktree_path, null);
	assert.deepEqual(await stack.worktrees(), ["task-1"], "no worktree for the waiting tasks");
	assert.equal(slots(stack), 0, "no slot is held while they wait");
	assert.match(
		await statusLine(stack, 2),
		/^Task 2 · beta · queued · queue position 1 · waiting for room on the task disk: its new worktree needs about 10\.\d MiB/,
	);

	// A follow-up run of task 1 reuses its worktree: the task disk does not hold it.
	const followup = stack.reply(USER1, review1.id, "job-1b follow-up while the task disk is full");
	assert.match((await replyTo(stack, followup)).text, /^Follow-up started another run of Task 1/);
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 2\)/, { since: review1.id });
	await settle(stack);
	assert.deepEqual([task(stack, 2).state, task(stack, 3).state], ["queued", "queued"]);
	assert.deepEqual(await stack.worktrees(), ["task-1"]);

	// Cancelling task 1 archives its worktree: room for one, and task 2 (first in the queue) starts by itself.
	assert.match(await command(stack, USER1, "/cancel 1"), /^Cancelling Task 1…/);
	await stack.waitForBotMessage(/^Task 1 cancelled\./);
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/);
	// Task 3 is next (same agent): task 2's build output fills the budget again, so it keeps waiting, not told again.
	await settle(stack);
	await waitFor(() => slots(stack) === 0, { what: "slots released" });
	assert.equal(task(stack, 3).state, "queued");
	assert.deepEqual(await stack.worktrees(), ["task-2"]);
	assert.match(await command(stack, USER2, "/cancel 2"), /^Cancelling Task 2…/);
	await stack.waitForBotMessage(/^Task 3 is ready for review \(run 1\)/);
	assert.deepEqual(await stack.worktrees(), ["task-3"]);
	// Each waiting task was told once: task 2 when it was requeued, task 3 in its acknowledgement only.
	assert.deepEqual([toldWaiting(stack, 2), toldWaiting(stack, 3)], [1, 0]);
});

test("task disk unreadable or below its free-space floor: new worktrees wait (fails closed), told once, no slot; they start once there is room", {
	timeout: 180_000,
}, async (t) => {
	const disk: { task: number | "unreadable" } = { task: "unreadable" };
	const stack = await stackFor(t, { diskProbe: probeFor(disk) });
	// The task disk does not reject a /task (Evaluation "Task disk full": commands are still saved and acknowledged).
	assert.match(
		await command(stack, USER1, "/task alpha job-1 first task"),
		/^Task 1 accepted for agent alpha\. Queue position 1\./,
	);
	await stack.waitForBotMessage(/^Execution paused: the task disk free space cannot be measured/);
	assert.match(
		await command(stack, USER2, "/task beta job-2 second task"),
		/^Task 2 accepted for agent beta\. Queue position 1\. waiting for disk safety: the task disk free space cannot be measured\.$/i,
	);
	// Readable, but 1.5 GiB free: the worktree (its files + 1 GiB headroom) would leave less than the 1 GiB floor.
	disk.task = 1.5 * GiB;
	await waitFor(
		async () => /needs about 1\.0 GiB on the task disk, but only 1\.5 GiB is free/.test(await statusLine(stack, 1)),
		{ what: "the measurement of the readable task disk", timeoutMs: 20_000 },
	);
	assert.equal(
		await statusLine(stack, 1),
		"Task 1 · alpha · queued · queue position 1 · waiting for room on the task disk: its new worktree needs about " +
			"1.0 GiB on the task disk, but only 1.5 GiB is free and 1.0 GiB must stay free",
	);
	await settle(stack);
	assert.deepEqual([firstRun(stack, 1).state, firstRun(stack, 2).state], ["queued", "queued"]);
	assert.equal(
		firstRun(stack, 2).started_at,
		null,
		"a worktree estimate may reserve and requeue, but no Pi execution starts",
	);
	assert.equal(slots(stack), 0);
	assert.deepEqual(await stack.worktrees(), []);

	disk.task = 100 * GiB;
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/);
	assert.deepEqual(await stack.worktrees(), ["task-1", "task-2"]);
	assert.deepEqual(
		[toldWaiting(stack, 1), toldWaiting(stack, 2)],
		[1, 1],
		"each new-worktree estimate is told once after free-space recovery",
	);
});

test("task disk falls below its floor during execution: revoke and verify stop, keep the final checkpoint, hold all queued runs and resume only queued work", {
	timeout: 180_000,
}, async (t) => {
	const disk: { task: number | "unreadable" } = { task: 100 * GiB };
	let sandbox: Sandbox | undefined;
	const stack = await stackFor(t, {
		diskProbe: probeFor(disk),
		wrap: {
			sandbox: (box) => {
				sandbox = box;
				return box;
			},
		},
		model: (request) => {
			const { input, round } = agentPosition(request);
			if (!input.includes("job-1")) return jobAgent(request);
			if (round === 0)
				return { toolCalls: [{ name: "write", args: { path: "kept.txt", content: "unpublished work\n" } }] };
			return { hang: true };
		},
	});
	await command(stack, USER1, "/task alpha job-1 stop safely on disk pressure");
	await waitFor(
		async () => {
			const path = task(stack, 1).worktree_path;
			return path !== null && (await readFile(join(path, "kept.txt"), "utf8").catch(() => "")) === "unpublished work\n";
		},
		{ timeoutMs: 30_000, what: "unpublished task file" },
	);
	const running = stack.runs<RunRow & { pid: number | null; container: string | null }>().at(-1);
	assert.ok(running?.pid !== null && running?.pid !== undefined, "real Pi runner started");
	disk.task = GiB / 2;
	stack.coordinator.engine.kick();
	const notice = await stack.waitForBotMessage(/^Execution paused: the task disk has/);
	await stack.waitForBotMessage(/^Task 1 failed: the task disk has/);
	await settle(stack);
	assert.equal(stack.coordinator.engine.activeRuns().length, 0);
	assert.throws(() => process.kill(running.pid as number, 0), { code: "ESRCH" }, "runner is gone");
	assert.equal((await sandbox?.live({ taskId: 1 }))?.length, 0, "sandbox verified gone");
	assert.equal(slots(stack), 0);
	assert.equal(task(stack, 1).state, "failed");
	assert.ok(await stack.branchSha("task/1"), "checkpoint branch retained");
	assert.equal((await originGit(stack.origin.bare, ["show", "task/1:kept.txt"])).stdout, "unpublished work\n");
	assert.match(await command(stack, USER2, "/task beta job-2 queued while low"), /^Task 2 accepted/);
	await settle(stack);
	assert.equal(firstRun(stack, 2).dispatched_at, null);
	assert.match(await command(stack, USER2, "/status"), /Execution paused: the task disk/);
	assert.equal(
		stack.lastBotMessages(1000).filter((m) => m.text.startsWith("Execution paused:")).length,
		1,
		"no alert flood",
	);
	disk.task = 100 * GiB;
	stack.coordinator.engine.kick();
	await stack.waitForBotMessage(/^Task 2 is ready for review/, { since: notice.id });
	assert.equal(stack.runs<RunRow>().filter((run) => run.task_id === 1).length, 1, "stopped run was never resubmitted");
});
