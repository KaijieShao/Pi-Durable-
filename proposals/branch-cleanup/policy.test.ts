import assert from "node:assert/strict";
import test from "node:test";
import {
	CleanupFailure,
	type Config,
	DEFAULT_CONFIG,
	type Evidence,
	evaluate,
	type Job,
	type Ports,
	type Result,
	runOne,
} from "./policy.ts";

const head = "a".repeat(40),
	merge = "b".repeat(40);
const config: Config = {
	...DEFAULT_CONFIG,
	mode: "enabled",
	acceptanceComplete: true,
	activationApproved: true,
	notBeforeMs: 1000,
	repository: "example/disposable",
};
const job: Job = {
	key: `example/disposable:42:7:${head}`,
	repository: config.repository,
	taskId: 42,
	branch: "task/42",
	prNumber: 7,
	reviewedHead: head,
	mergeCommit: merge,
	attempts: 0,
};
type MutableEvidence = { -readonly [K in keyof Evidence]: Evidence[K] };
function facts(): MutableEvidence {
	return {
		task: {
			id: 42,
			state: "merged",
			archived: true,
			worktreePath: null,
			worktreeAbsent: true,
			head,
			activeRuns: 0,
			heldSlots: 0,
			unsettledEffects: 0,
			pendingMergeIntents: 0,
		},
		intent: { state: "merged", approvedHead: head, mergeCommit: merge },
		pr: {
			repository: config.repository,
			number: 7,
			merged: true,
			mergedAtMs: 2000,
			headRef: "task/42",
			headSha: head,
			baseRef: "main",
			mergeSha: merge,
		},
		defaultBranch: "main",
		mergeReachableFromBase: true,
		openPrsUsingHead: 0,
		remote: { state: "present", sha: head, protected: false },
	};
}
function harness(current = facts()) {
	let state = structuredClone(current),
		reads = 0,
		deletes = 0;
	const journal: Result[] = [];
	let error: unknown;
	let missingAfterError = false;
	const ports: Ports = {
		async readEvidence() {
			reads++;
			return structuredClone(state);
		},
		async deleteRemoteRefWithLease(repo, ref, expected) {
			assert.equal(repo, config.repository);
			assert.equal(ref, "refs/heads/task/42");
			assert.equal(expected, head);
			assert.equal(journal.at(-1)?.state, "pending");
			deletes++;
			if (missingAfterError) state.remote = { state: "absent", sha: null, protected: null };
			if (error) throw error;
			state.remote = { state: "absent", sha: null, protected: null };
		},
		async record(_job, result) {
			journal.push(result);
		},
		now: () => 5000,
	};
	return {
		ports,
		journal,
		get reads() {
			return reads;
		},
		get deletes() {
			return deletes;
		},
		get task() {
			return state.task;
		},
		fail(e: unknown, missing = false) {
			error = e;
			missingAfterError = missing;
		},
	};
}

test("default disabled mode does not even read or delete a branch", async () => {
	const h = harness();
	assert.equal((await runOne(job, h.ports)).state, "disabled");
	assert.equal(h.reads, 0);
	assert.equal(h.deletes, 0);
});
test("enabling requires acceptance completion, explicit approval and a no-backfill cutoff", async () => {
	for (const override of [
		{ acceptanceComplete: false },
		{ activationApproved: false },
		{ notBeforeMs: null },
		{ notBeforeMs: NaN },
		{ notBeforeMs: -1 },
	]) {
		const h = harness();
		assert.equal((await runOne(job, h.ports, { ...config, ...override })).state, "disabled");
		assert.equal(h.deletes, 0);
	}
});
test("dry run reports a candidate without deleting", async () => {
	const h = harness();
	assert.equal((await runOne(job, h.ports, { ...config, mode: "dry-run" })).state, "would-delete");
	assert.equal(h.deletes, 0);
});
test("all open, cancelled, failed and unmerged tasks keep their branches", () => {
	for (const state of ["queued", "running", "review", "merging", "cancelled", "failed"]) {
		const e = facts();
		e.task.state = state;
		assert.equal(evaluate(job, e, config).kind, "keep");
	}
	const e = facts();
	e.pr.merged = false;
	assert.equal(evaluate(job, e, config).kind, "keep");
});
test("archive, slots, effects and pending merge reconciliation gate deletion", () => {
	for (const override of [
		{ archived: false },
		{ worktreePath: "/work/task42" },
		{ worktreeAbsent: false },
		{ activeRuns: 1 },
		{ heldSlots: 1 },
		{ unsettledEffects: 1 },
		{ pendingMergeIntents: 1 },
	]) {
		const e = facts();
		Object.assign(e.task, override);
		assert.equal(evaluate(job, e, config).kind, "keep");
	}
});
test("main, configured long-lived refs, protected refs and unknown protection are kept", () => {
	assert.equal(evaluate({ ...job, branch: "main" }, facts(), config).kind, "keep");
	assert.equal(evaluate(job, facts(), { ...config, keepBranches: ["task/42"] }).kind, "keep");
	for (const protectedValue of [true, null]) {
		const e = facts();
		e.remote.protected = protectedValue;
		assert.equal(evaluate(job, e, config).kind, "keep");
	}
});
test("repository, immutable PR/head/merge evidence and reachable main must agree", () => {
	for (const mutate of [
		(e: MutableEvidence) => {
			e.pr.repository = "other/repo";
		},
		(e: MutableEvidence) => {
			e.pr.headSha = "c".repeat(40);
		},
		(e: MutableEvidence) => {
			e.intent.mergeCommit = "c".repeat(40);
		},
		(e: MutableEvidence) => {
			e.remote.sha = "c".repeat(40);
		},
		(e: MutableEvidence) => {
			e.openPrsUsingHead = 1;
		},
		(e: MutableEvidence) => {
			e.mergeReachableFromBase = false;
		},
		(e: MutableEvidence) => {
			e.remote.state = "unknown";
		},
	]) {
		const e = facts();
		mutate(e);
		assert.equal(evaluate(job, e, config).kind, "keep");
	}
});
test("existing pre-activation branches are never backfilled", () => {
	const e = facts();
	e.pr.mergedAtMs = 500;
	assert.equal(evaluate(job, e, config).kind, "keep");
});
test("successful leased deletion preserves successful task records", async () => {
	const h = harness();
	const before = structuredClone(h.task);
	assert.equal((await runOne(job, h.ports, config)).state, "deleted");
	assert.equal(h.deletes, 1);
	assert.deepEqual(h.task, before);
});
test("recovery of an already-absent remote never sends another deletion", async () => {
	const e = facts();
	e.remote = { state: "absent", sha: null, protected: null };
	const h = harness(e);
	assert.equal((await runOne(job, h.ports, config)).state, "already-absent");
	assert.equal(h.deletes, 0);
	assert.equal(h.task.state, "merged");
});
test("lost deletion response is reconciled by reading remote absence", async () => {
	const h = harness();
	h.fail(new CleanupFailure("unknown"), true);
	assert.equal((await runOne(job, h.ports, config)).state, "already-absent");
	assert.equal(h.deletes, 1);
	assert.equal(h.task.state, "merged");
});
test("transient deletion failure retries independently without failing a merged task", async () => {
	const h = harness();
	h.fail(new CleanupFailure("transient"));
	const r = await runOne(job, h.ports, config);
	assert.equal(r.state, "retry");
	assert.equal(r.nextAttemptAtMs, 65000);
	assert.equal(h.task.state, "merged");
});
test("lease/protection denial needs attention, never a forced delete or failed merge", async () => {
	for (const category of ["denied", "changed"] as const) {
		const h = harness();
		h.fail(new CleanupFailure(category));
		assert.equal((await runOne(job, h.ports, config)).state, "needs-attention");
		assert.equal(h.deletes, 1);
		assert.equal(h.task.state, "merged");
	}
});
test("bounded retries stop in cleanup attention state only", async () => {
	const h = harness();
	h.fail(new CleanupFailure("transient"));
	assert.equal((await runOne({ ...job, attempts: 7 }, h.ports, config)).state, "needs-attention");
	assert.equal(h.task.state, "merged");
});
