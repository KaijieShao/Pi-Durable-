/**
 * The effect ledger (src/coordinator/engine/intents.ts; Agent Execution § Uncertain Effects) on a real Store and a
 * real worktree directory: an intent is saved pending before execution with its pre-hash and intended hash; only a
 * pending row is settled (once); reconciliation of a pending change inspects the target (intended → applied, as
 * before → unchanged, anything else or an unreadable target → unresolved) and a pending run_check is reported failed;
 * the task's effects count as open (nothing may archive, cancel or review the worktree) while a row is pending or
 * unresolved or its interrupted run is not reconciled; an unresolved row freezes the group with a reason naming the
 * task and file, tells the task's users once (the file name, never its content) and stops recovery's job; the owner's
 * unfreeze records the resolution and `owner status` lists what waits for review. In a live run (engine/tools.ts): an
 * answered refusal is inspected at once (as before → failed, the intended result → applied), a third state freezes the
 * group and revokes the run in the same step (no later call of it runs), and an answer the file operation never gave
 * stops the run, keeps the intent pending and holds dispatch until finalize reconciles it.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ownerStatus, ownerUnfreeze } from "../../src/cli/owner.ts";
import { planFileChange } from "../../src/coordinator/effect-target.ts";
import { type ActiveRun, type Ctx, interruptedKey } from "../../src/coordinator/engine/context.ts";
import {
	effectsOpen,
	freezeOnUnresolved,
	type IntentRow,
	newlyUnresolved,
	reconciledOf,
	reconcilePending,
	recordChange,
	recordCheck,
	settleIntent,
	settleTaskEffects,
} from "../../src/coordinator/engine/intents.ts";
import { executeTool } from "../../src/coordinator/engine/tools.ts";
import { DEMO_LIMITS } from "../../src/coordinator/limits.ts";
import { UNCERTAIN_TOOL_RESULT, uncertainChangeReason } from "../../src/coordinator/messages.ts";
import type { AgentSandbox, FsRequest, FsResponse } from "../../src/coordinator/ports.ts";
import { Store } from "../../src/coordinator/store.ts";
import { silentLogger } from "../../src/runtime/log.ts";

const CHAT = -1001;
const roots: string[] = [];

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A Store with one task (its worktree a real directory) and one run, and the part of the engine context it needs. */
function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pd-intents-")));
	roots.push(root);
	const worktree = join(root, "worktree");
	mkdirSync(worktree, { recursive: true });
	const store = new Store(join(root, "coordinator.sqlite"));
	const taskId = store.tx(
		() =>
			store.run(
				`INSERT INTO tasks(chat_id, creator_id, agent_id, text, update_id, state, branch, worktree_path, created_at, updated_at)
				 VALUES (?, 7, 'alpha', 'SECRET TASK TEXT', 9000, 'running', 'task/1', ?, 1, 1)`,
				CHAT,
				worktree,
			).lastInsertRowid,
	);
	const runId = store.tx(
		() =>
			store.run(
				`INSERT INTO runs(task_id, kind, state, requested_by, request_id, input_text, generation, queued_at)
				 VALUES (?, 'initial', 'running', 7, '9000', 'SECRET TASK TEXT', 1, 1)`,
				taskId,
			).lastInsertRowid,
	);
	const ctx = {
		store,
		log: silentLogger,
		now: () => Date.now(),
		chatId: CHAT,
		stopped: false,
		onOutbox: () => {},
		kick: () => {},
	} as unknown as Ctx;
	const active = { runId, taskId } as ActiveRun;
	after(() => store.close());
	return { root, worktree, store, ctx, active, taskId, runId };
}

const rows = (store: Store): IntentRow[] => store.all<IntentRow>("SELECT * FROM effect_intents ORDER BY id");
const outbox = (store: Store) => store.all<{ kind: string; text: string }>("SELECT kind, text FROM outbox ORDER BY id");

test("an intent is saved pending before execution, with its target, pre-hash and intended hash; it settles once", async () => {
	const s = setup();
	writeFileSync(join(s.worktree, "a.txt"), "before\n");
	const plan = await planFileChange(s.worktree, { op: "write", path: "a.txt", content: "after\n" });
	const id = recordChange(s.ctx, s.active, plan);
	const [row] = rows(s.store);
	assert.deepEqual(
		[row?.state, row?.tool, row?.path, row?.pre_hash, row?.intended_hash, row?.run_id, row?.task_id],
		["pending", "write", "a.txt", plan.pre, plan.intended, s.runId, s.taskId],
	);
	assert.ok(effectsOpen(s.store, s.taskId), "a pending intent keeps the task's effects open");
	assert.equal(settleIntent(s.ctx, id, "applied"), true);
	assert.equal(settleIntent(s.ctx, id, "failed"), false, "only a pending intent is settled");
	assert.deepEqual([rows(s.store)[0]?.state, rows(s.store)[0]?.reconciled], ["applied", 0]);
	assert.equal(effectsOpen(s.store, s.taskId), false);
	const check = recordCheck(s.ctx, s.active, "test");
	assert.deepEqual(
		[rows(s.store)[1]?.tool, rows(s.store)[1]?.operation, rows(s.store)[1]?.path],
		["run_check", "test", null],
	);
	settleIntent(s.ctx, check, "done");
	assert.equal(effectsOpen(s.store, s.taskId), false);
	s.store.tx(() => s.store.setMeta(interruptedKey(s.taskId), String(s.runId)));
	assert.ok(effectsOpen(s.store, s.taskId), "an interrupted run not reconciled yet keeps them open too");
});

test("reconciliation of pending intents: intended → applied, as before → unchanged, anything else → unresolved, a check → failed", async () => {
	const s = setup();
	const files = { applied: "applied.txt", unchanged: "unchanged.txt", third: "third.txt", created: "new.txt" };
	for (const path of [files.applied, files.unchanged, files.third]) writeFileSync(join(s.worktree, path), "before\n");
	const plans = [];
	for (const path of Object.values(files)) {
		const plan = await planFileChange(s.worktree, { op: "write", path, content: "intended\n" });
		recordChange(s.ctx, s.active, plan);
		plans.push(plan);
	}
	recordCheck(s.ctx, s.active, "test");
	// The state the crash left: one applied, one never ran, one in a third state, one created as intended.
	writeFileSync(join(s.worktree, files.applied), "intended\n");
	writeFileSync(join(s.worktree, files.third), "half-writ");
	writeFileSync(join(s.worktree, files.created), "intended\n");
	const settled = await reconcilePending(s.ctx, { runId: s.runId }, s.worktree);
	assert.deepEqual(
		settled.map((row) => [row.path ?? row.operation, row.state, row.reconciled]),
		[
			[files.applied, "applied", 1],
			[files.unchanged, "unchanged", 1],
			[files.third, "unresolved", 1],
			[files.created, "applied", 1],
			["test", "failed", 1],
		],
	);
	assert.deepEqual(
		rows(s.store).map((row) => row.state),
		["applied", "unchanged", "unresolved", "applied", "failed"],
	);
	assert.equal(rows(s.store)[2]?.observed_hash?.startsWith("sha256:"), true, "what was found is recorded");
	assert.deepEqual(newlyUnresolved(settled), [files.third]);
	assert.deepEqual(
		reconciledOf(s.store, s.runId).map((effect) => [effect.target, effect.outcome]),
		[
			[files.applied, "applied"],
			[files.unchanged, "unchanged"],
			[files.third, "unresolved"],
			[files.created, "applied"],
			["test", "failed"],
		],
	);
	assert.deepEqual(await reconcilePending(s.ctx, { runId: s.runId }, s.worktree), [], "nothing pending is left");
});

test("a target that cannot be inspected (the worktree is gone) is unresolved, never guessed", async () => {
	const s = setup();
	const plan = await planFileChange(s.worktree, { op: "write", path: "a.txt", content: "x" });
	recordChange(s.ctx, s.active, plan);
	const [row] = await reconcilePending(s.ctx, { taskId: s.taskId }, join(s.root, "missing-worktree"));
	assert.deepEqual([row?.state, row?.observed_hash], ["unresolved", null]);
});

test("unresolved freezes the group naming the task and file, tells its users once (no content), stops recovery's job; the owner's unfreeze records the resolution", async () => {
	const s = setup();
	writeFileSync(join(s.worktree, "src.js"), "CONTENT BEFORE\n");
	const plan = await planFileChange(s.worktree, { op: "write", path: "src.js", content: "CONTENT INTENDED\n" });
	recordChange(s.ctx, s.active, plan);
	writeFileSync(join(s.worktree, "src.js"), "CONTENT THIRD\n");
	await assert.rejects(settleTaskEffects(s.ctx, s.taskId), (error: Error) => {
		assert.equal(error.name, "UnknownEffect");
		assert.match(error.message, /Task 1 could not be reconciled \(src\.js\)/);
		return true;
	});
	const group = s.store.groupState(CHAT);
	assert.equal(group.state, "frozen");
	assert.equal(group.reason, "the outcome of a file change of Task 1 could not be reconciled (src.js)");
	const told = outbox(s.store).filter((message) => message.kind === "effect_unresolved");
	assert.equal(told.length, 1);
	assert.match(
		told[0]?.text ?? "",
		/^Task 1: the outcome of a file change could not be confirmed, and src\.js matches/,
	);
	const everything = JSON.stringify(outbox(s.store));
	for (const secret of ["CONTENT", "SECRET TASK TEXT"]) assert.ok(!everything.includes(secret), secret);
	assert.ok(effectsOpen(s.store, s.taskId), "nothing may archive or review the worktree");
	// Asked again (another recovery attempt): still frozen, not told twice.
	await assert.rejects(settleTaskEffects(s.ctx, s.taskId), /could not be reconciled/);
	assert.equal(freezeOnUnresolved(s.ctx, s.taskId, []), group.reason ?? "");
	assert.equal(outbox(s.store).filter((message) => message.kind === "effect_unresolved").length, 1);

	const status = ownerStatus(s.store, CHAT);
	assert.match(status, /Uncertain file changes \(unresolved: review the file, then unfreeze/);
	assert.ok(status.includes(`#1 run ${s.runId}: write src.js in ${s.worktree} (unresolved)`), status);
	const unfrozen = ownerUnfreeze(s.store, CHAT);
	assert.equal(unfrozen.ok, true);
	assert.match(unfrozen.text, /Recorded your resolution of 1 uncertain file change \(accepted as found/);
	const [row] = rows(s.store);
	assert.deepEqual([row?.state, row?.resolution], ["resolved", "owner unfreeze: accepted as found in the worktree"]);
	assert.equal(s.store.groupState(CHAT).state, "normal");
	assert.equal(effectsOpen(s.store, s.taskId), false, "resolved: the worktree may be used again");
	assert.deepEqual(await settleTaskEffects(s.ctx, s.taskId), [], "the recheck's job now goes on");
	assert.deepEqual(
		reconciledOf(s.store, s.runId).map((effect) => effect.outcome),
		["resolved"],
	);
	assert.ok(!ownerStatus(s.store, CHAT).includes("Uncertain file changes"));
});

// ---------------------------------------------------------------------------------------------------------------
// A live run's file changes (src/coordinator/engine/tools.ts): the agent container's answer settles the intent; an
// answered refusal is inspected at once; an unknown answer stops the run. The engine's own pass never runs here (kick
// is a no-op), so whatever revokes the run must do it in the tool call's own step.

/** The run's agent container: `answer` decides each change's answer (after doing whatever it does to the file). */
function liveRun(s: ReturnType<typeof setup>, answer: (request: FsRequest) => FsResponse) {
	const ops: FsRequest[] = [];
	const box: AgentSandbox = {
		name: "agent-test",
		stop: async () => {},
		fileOp: async (request) => {
			ops.push(request);
			return answer(request);
		},
	};
	const ctx = {
		...(s.ctx as unknown as Record<string, unknown>),
		sandbox: { checkOps: () => [] },
		limits: DEMO_LIMITS,
		reconciling: new Set<number>(),
	} as unknown as Ctx;
	const active = {
		runId: s.runId,
		taskId: s.taskId,
		generation: 1,
		agentBox: box,
		worktree: s.worktree,
		capRefused: false,
		decision: undefined,
		effects: Promise.resolve(),
		effectsClosed: false,
		deadline: undefined,
		capTimer: undefined,
		resolveDecision: () => {},
	} as unknown as ActiveRun;
	const write = (content: string) => executeTool(ctx, active, { name: "write", args: { path: "a.txt", content } });
	return { ctx, active, ops, write };
}

test("live run: a refusal that left the file as it was is failed (the model sees the refusal); one that left the intended content is applied after all; the run goes on", async () => {
	const s = setup();
	writeFileSync(join(s.worktree, "a.txt"), "before\n");
	let effect: () => void = () => {};
	const live = liveRun(s, () => {
		effect();
		return { ok: false, code: "io", message: "a.txt: file operation failed (EIO)" };
	});
	assert.deepEqual(await live.write("first\n"), { ok: false, text: "io: a.txt: file operation failed (EIO)" });
	effect = () => writeFileSync(join(s.worktree, "a.txt"), "second\n");
	assert.deepEqual(await live.write("second\n"), {
		ok: true,
		text: "a.txt: the change is applied (the file has the intended content).",
	});
	assert.deepEqual(
		rows(s.store).map((row) => [row.state, row.reconciled, row.observed_hash === row.pre_hash]),
		[
			["failed", 0, true],
			["applied", 1, false],
		],
	);
	assert.equal(live.active.decision, undefined, "the run is not stopped");
	assert.equal(s.store.groupState(CHAT).state, "normal");
	assert.equal(live.ops.length, 2);
});

test("live run: a refusal that left a third state freezes the group and revokes the run in the same step, so no later call of the run touches the file again", async () => {
	const s = setup();
	writeFileSync(join(s.worktree, "a.txt"), "before\n");
	const live = liveRun(s, () => {
		writeFileSync(join(s.worktree, "a.txt"), "half-writ");
		return { ok: false, code: "io", message: "a.txt: no space left on the task disk" };
	});
	assert.deepEqual(await live.write("intended\n"), { ok: false, text: UNCERTAIN_TOOL_RESULT });
	assert.equal(s.store.groupState(CHAT).state, "frozen");
	assert.deepEqual(live.active.decision, { kind: "cancelled", reason: "group frozen", cause: "cancelled" });
	// The model asks for the same change again: never executed ("The model never re-runs an uncertain mutation").
	assert.deepEqual(await live.write("intended\n"), { ok: false, text: "run stopped" });
	assert.equal(live.ops.length, 1);
	assert.deepEqual(
		rows(s.store).map((row) => row.state),
		["unresolved"],
	);
	assert.equal(readFileSync(join(s.worktree, "a.txt"), "utf8"), "half-writ");
});

test("live run: an answer the file operation never gave keeps the intent pending, stops the run (failed) and holds dispatch until finalize reconciles it", async () => {
	const s = setup();
	const live = liveRun(s, () => ({ ok: false, code: "timeout", message: "file operation timed out", uncertain: true }));
	assert.deepEqual(await live.write("intended\n"), { ok: false, text: UNCERTAIN_TOOL_RESULT });
	assert.deepEqual(live.active.decision, {
		kind: "failed",
		reason: uncertainChangeReason("a.txt"),
		cause: "run failed",
	});
	assert.ok(live.ctx.reconciling.has(s.runId), "dispatch waits for this run's reconciliation");
	assert.deepEqual(
		rows(s.store).map((row) => [row.path, row.state]),
		[["a.txt", "pending"]],
	);
	assert.deepEqual(await live.write("intended\n"), { ok: false, text: "run stopped" });
	assert.equal(live.ops.length, 1, "never repeated");
});
