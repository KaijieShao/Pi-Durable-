import "../helpers/env.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	admitRun,
	agentQueuePosition,
	openTaskCount,
	waitingCapReason,
	waitingCounts,
} from "../../src/coordinator/admission.ts";
import { DEMO_LIMITS } from "../../src/coordinator/limits.ts";
import { Store } from "../../src/coordinator/store.ts";

const GROUP = -100111;
const OTHER = -100222;
const ANA = 1;
const BOB = 2;

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

let nextUpdate = 1;

function openStore(): Store {
	const dir = mkdtempSync(join(tmpdir(), "pd-admission-"));
	let clock = 1_000;
	const store = new Store(join(dir, "coordinator.sqlite"), () => ++clock);
	cleanups.push(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return store;
}

function addTask(
	store: Store,
	p: { chat?: number; agent?: string; creator?: number; state?: string; worktree?: string | null; archived?: number },
): number {
	return store.run(
		`INSERT INTO tasks(chat_id, creator_id, agent_id, text, update_id, state, worktree_path, archived, created_at,
		   updated_at)
		 VALUES (?, ?, ?, 'text', ?, ?, ?, ?, 0, 0)`,
		p.chat ?? GROUP,
		p.creator ?? ANA,
		p.agent ?? "alpha",
		nextUpdate++,
		p.state ?? "queued",
		p.worktree ?? null,
		p.archived ?? 0,
	).lastInsertRowid;
}

function addRun(store: Store, taskId: number, state: string, requestedBy = ANA, kind = "initial"): number {
	return store.run(
		`INSERT INTO runs(task_id, kind, state, requested_by, request_id, input_text, queued_at)
		 VALUES (?, ?, ?, ?, ?, 'in', 0)`,
		taskId,
		kind,
		state,
		requestedBy,
		String(nextUpdate++),
	).lastInsertRowid;
}

describe("waitingCounts / waitingCapReason", () => {
	test("counts only queued runs, per agent (in its group), per group, per user (runs.requested_by)", () => {
		const store = openStore();
		addRun(store, addTask(store, { agent: "alpha" }), "queued", ANA);
		addRun(store, addTask(store, { agent: "alpha" }), "queued", BOB);
		addRun(store, addTask(store, { agent: "beta" }), "queued", ANA);
		addRun(store, addTask(store, { agent: "alpha" }), "running", ANA);
		addRun(store, addTask(store, { agent: "alpha" }), "finished", ANA);
		addRun(store, addTask(store, { agent: "alpha", chat: OTHER }), "queued", ANA);
		// A follow-up run counts against its author, not the task's creator.
		addRun(store, addTask(store, { agent: "gamma", creator: ANA, state: "review" }), "queued", BOB, "followup");
		assert.deepEqual(waitingCounts(store, { agentId: "alpha", chatId: GROUP, userId: ANA }), {
			agent: 2,
			group: 4,
			user: 3,
		});
		assert.deepEqual(waitingCounts(store, { agentId: "beta", chatId: GROUP, userId: BOB }), {
			agent: 1,
			group: 4,
			user: 2,
		});
		assert.deepEqual(waitingCounts(store, { agentId: "alpha", chatId: -1, userId: 99 }), {
			agent: 0,
			group: 0,
			user: 0,
		});
	});

	test("reasons name the cap that is full, in order agent, group, user", () => {
		const limits = DEMO_LIMITS;
		assert.equal(waitingCapReason(limits, { agent: 1, group: 3, user: 3 }), undefined);
		assert.equal(
			waitingCapReason(limits, { agent: 2, group: 4, user: 4 }, "alpha"),
			"queue full: agent alpha already has 2 waiting tasks",
		);
		assert.equal(
			waitingCapReason(limits, { agent: 2, group: 0, user: 0 }),
			"queue full: this agent already has 2 waiting tasks",
		);
		assert.equal(
			waitingCapReason(limits, { agent: 0, group: 4, user: 4 }),
			"queue full: the group already has 4 waiting tasks",
		);
		assert.equal(
			waitingCapReason(limits, { agent: 0, group: 0, user: 4 }),
			"queue full: you already have 4 waiting tasks",
		);
		assert.equal(
			waitingCapReason({ ...limits, waitingPerUser: 1 }, { agent: 0, group: 0, user: 1 }),
			"queue full: you already have 1 waiting task",
		);
	});
});

describe("openTaskCount / agentQueuePosition", () => {
	test("open tasks hold a live worktree and are not terminal; queued first runs do not count", () => {
		const store = openStore();
		addTask(store, { state: "queued" });
		addTask(store, { state: "running", worktree: "/w/2" });
		addTask(store, { state: "review", worktree: "/w/3" });
		addTask(store, { state: "merging", worktree: "/w/4" });
		addTask(store, { state: "queued", worktree: "/w/5" }); // follow-up run waiting on a task in review
		addTask(store, { state: "merged", worktree: null, archived: 1 });
		addTask(store, { state: "failed", worktree: "/w/7" }); // archive pending: terminal, not open
		addTask(store, { state: "review", worktree: "/w/8", archived: 1 });
		addTask(store, { state: "review", worktree: "/w/9", chat: OTHER });
		assert.equal(openTaskCount(store, GROUP), 4);
		assert.equal(openTaskCount(store, OTHER), 1);
	});

	test("position is 1-based among the agent's queued runs, FIFO by run id; 0 when not queued", () => {
		const store = openStore();
		const a1 = addRun(store, addTask(store, { agent: "alpha" }), "queued");
		const b1 = addRun(store, addTask(store, { agent: "beta" }), "queued");
		const a2 = addRun(store, addTask(store, { agent: "alpha" }), "queued");
		const other = addRun(store, addTask(store, { agent: "alpha", chat: OTHER }), "queued");
		const running = addRun(store, addTask(store, { agent: "alpha" }), "running");
		assert.deepEqual(
			[a1, b1, a2, other, running, 999].map((id) => agentQueuePosition(store, id)),
			[1, 1, 2, 1, 0, 0],
		);
		store.run("UPDATE runs SET state = 'starting' WHERE id = ?", a1);
		assert.equal(agentQueuePosition(store, a2), 1);
	});
});

describe("admitRun", () => {
	const request = { requestedBy: ANA, requestId: "500", inputText: "do it" };

	test("must run inside store.tx()", () => {
		const store = openStore();
		const id = addTask(store, {});
		assert.throws(() => admitRun(store, DEMO_LIMITS, { taskId: id, kind: "initial", ...request }), /store\.tx/);
	});

	test("initial run: queued with request id and input; task state unchanged", () => {
		const store = openStore();
		const id = addTask(store, {});
		const result = store.tx(() => admitRun(store, DEMO_LIMITS, { taskId: id, kind: "initial", ...request }));
		assert.equal(result.ok, true);
		assert.ok(result.ok);
		assert.equal(result.position, 1);
		const run = store.get<Record<string, unknown>>("SELECT * FROM runs WHERE id = ?", result.runId);
		assert.deepEqual(
			[run?.task_id, run?.kind, run?.state, run?.requested_by, run?.request_id, run?.input_text, run?.queued_at],
			[id, "initial", "queued", ANA, "500", "do it", 1001],
		);
		assert.equal(store.get<{ state: string }>("SELECT state FROM tasks WHERE id = ?", id)?.state, "queued");
		const again = store.tx(() => admitRun(store, DEMO_LIMITS, { taskId: id, kind: "initial", ...request }));
		assert.deepEqual(again, { ok: false, reason: `Task ${id} already has a run queued or running` });
	});

	test("follow-up / conflict run: task back to queued, valid approvals invalidated, followup id recorded", () => {
		const store = openStore();
		const id = addTask(store, { state: "merging", worktree: "/w" });
		addRun(store, id, "finished");
		store.run("UPDATE tasks SET reason = 'waiting for review' WHERE id = ?", id);
		store.run(
			`INSERT INTO approvals(task_id, user_id, update_id, head_commit, state, created_at) VALUES
			 (?, 1, 1, 'h1', 'valid', 0), (?, 1, 2, 'h0', 'consumed', 0)`,
			id,
			id,
		);
		const result = store.tx(() =>
			admitRun(store, DEMO_LIMITS, { taskId: id, kind: "conflict", ...request, followupId: 42 }),
		);
		assert.ok(result.ok);
		const task = store.get<{ state: string; reason: string | null }>(
			"SELECT state, reason FROM tasks WHERE id = ?",
			id,
		);
		assert.deepEqual({ ...task }, { state: "queued", reason: null });
		assert.deepEqual(
			store.all("SELECT state, reason FROM approvals ORDER BY id").map((row) => ({ ...row })),
			[
				{ state: "invalidated", reason: "new run admitted" },
				{ state: "consumed", reason: null },
			],
		);
		const run = store.get<{ kind: string; followup_id: number }>(
			"SELECT kind, followup_id FROM runs WHERE id = ?",
			result.runId,
		);
		assert.deepEqual({ ...run }, { kind: "conflict", followup_id: 42 });
	});

	test("refuses over a waiting cap, a terminal task, a busy task, a missing task: nothing written", () => {
		const store = openStore();
		addRun(store, addTask(store, { agent: "alpha" }), "queued", BOB);
		addRun(store, addTask(store, { agent: "alpha" }), "queued", BOB);
		const capped = addTask(store, { agent: "alpha", state: "review", worktree: "/w" });
		addRun(store, capped, "finished");
		const merged = addTask(store, { agent: "beta", state: "merged" });
		const busy = addTask(store, { agent: "beta", state: "running", worktree: "/w2" });
		addRun(store, busy, "finalizing");
		const before = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs")?.n;
		const admit = (taskId: number) =>
			store.tx(() => admitRun(store, DEMO_LIMITS, { taskId, kind: "followup", ...request }));
		assert.deepEqual(admit(capped), { ok: false, reason: "queue full: agent alpha already has 2 waiting tasks" });
		assert.deepEqual(admit(merged), { ok: false, reason: `Task ${merged} is already merged` });
		assert.deepEqual(admit(busy), { ok: false, reason: `Task ${busy} already has a run queued or running` });
		assert.deepEqual(admit(9999), { ok: false, reason: "there is no Task 9999" });
		assert.equal(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs")?.n, before);
		assert.equal(store.get<{ state: string }>("SELECT state FROM tasks WHERE id = ?", capped)?.state, "review");
	});

	test("the per-user cap counts the requester, across tasks", () => {
		const store = openStore();
		const limits = { ...DEMO_LIMITS, waitingPerUser: 2 };
		addRun(store, addTask(store, { agent: "alpha" }), "queued", ANA);
		addRun(store, addTask(store, { agent: "beta", creator: BOB }), "queued", ANA, "followup");
		const target = addTask(store, { agent: "gamma", state: "review", worktree: "/w", creator: BOB });
		addRun(store, target, "finished", BOB);
		const asAna = store.tx(() => admitRun(store, limits, { taskId: target, kind: "followup", ...request }));
		assert.deepEqual(asAna, { ok: false, reason: "queue full: you already have 2 waiting tasks" });
		const asBob = store.tx(() =>
			admitRun(store, limits, { taskId: target, kind: "followup", ...request, requestedBy: BOB }),
		);
		assert.ok(asBob.ok);
		assert.equal(asBob.position, 1);
	});
});
