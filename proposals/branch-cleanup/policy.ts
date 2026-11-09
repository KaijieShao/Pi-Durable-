/** Fail-closed policy for the independent post-acceptance housekeeping worker. */
export type Config = {
	mode: "disabled" | "dry-run" | "enabled";
	acceptanceComplete: boolean;
	activationApproved: boolean;
	notBeforeMs: number | null;
	repository: string;
	baseBranch: string;
	taskPrefix: string;
	keepBranches: readonly string[];
	keepPrefixes: readonly string[];
};

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
	mode: "disabled",
	acceptanceComplete: false,
	activationApproved: false,
	notBeforeMs: null,
	repository: "",
	baseBranch: "main",
	taskPrefix: "task/",
	keepBranches: Object.freeze([
		"main",
		"master",
		"develop",
		"development",
		"staging",
		"production",
		"stable",
		"gh-pages",
	]),
	keepPrefixes: Object.freeze(["release/", "hotfix/", "support/"]),
});

export type Job = Readonly<{
	key: string;
	repository: string;
	taskId: number;
	branch: string;
	prNumber: number;
	reviewedHead: string;
	mergeCommit: string;
	attempts: number;
}>;

export type Evidence = Readonly<{
	task: {
		id: number;
		state: string;
		archived: boolean;
		worktreePath: string | null;
		worktreeAbsent: boolean;
		head: string;
		activeRuns: number;
		heldSlots: number;
		unsettledEffects: number;
		pendingMergeIntents: number;
	};
	intent: { state: string; approvedHead: string; mergeCommit: string };
	pr: {
		repository: string;
		number: number;
		merged: boolean;
		mergedAtMs: number;
		headRef: string;
		headSha: string;
		baseRef: string;
		mergeSha: string;
	};
	defaultBranch: string;
	mergeReachableFromBase: boolean;
	openPrsUsingHead: number;
	remote: { state: "present" | "absent" | "unknown"; sha: string | null; protected: boolean | null };
}>;

export type Verdict = { kind: "keep"; reason: string } | { kind: "candidate" } | { kind: "already-absent" };

/** Pure policy: only a positive, fully corroborated task-branch tuple can become a candidate. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keep ordered safety gates and uncertain-effect recovery visible in one audit path.
export function evaluate(job: Job, e: Evidence, c: Readonly<Config>): Verdict {
	const keep = (reason: string): Verdict => ({ kind: "keep", reason });
	if (!c.repository || job.repository !== c.repository || e.pr.repository !== job.repository)
		return keep("repository-mismatch");
	if (
		!Number.isSafeInteger(job.taskId) ||
		job.taskId < 1 ||
		!/^[A-Za-z0-9._-]+\/$/.test(c.taskPrefix) ||
		job.branch !== c.taskPrefix + job.taskId
	)
		return keep("not-an-exact-task-branch");
	const kept = new Set([...DEFAULT_CONFIG.keepBranches, ...c.keepBranches, c.baseBranch, e.defaultBranch]);
	if (kept.has(job.branch) || [...DEFAULT_CONFIG.keepPrefixes, ...c.keepPrefixes].some((p) => job.branch.startsWith(p)))
		return keep("long-lived-or-base-branch");
	if (e.task.id !== job.taskId || e.task.state !== "merged") return keep("task-not-completed-merged");
	if (!e.task.archived || e.task.worktreePath !== null || !e.task.worktreeAbsent)
		return keep("worktree-not-confirmed-archived");
	if (e.task.activeRuns || e.task.heldSlots || e.task.unsettledEffects || e.task.pendingMergeIntents)
		return keep("task-still-has-pending-work");
	if (!e.pr.merged || e.pr.number !== job.prNumber || e.pr.headRef !== job.branch || e.pr.baseRef !== c.baseBranch)
		return keep("pr-not-the-confirmed-merged-task-pr");
	if (
		c.notBeforeMs === null ||
		!Number.isFinite(c.notBeforeMs) ||
		c.notBeforeMs <= 0 ||
		!Number.isFinite(e.pr.mergedAtMs) ||
		e.pr.mergedAtMs < c.notBeforeMs
	)
		return keep("pre-activation-branch-no-backfill");
	if (!/^[0-9a-f]{40}$/.test(job.reviewedHead) || !/^[0-9a-f]{40}$/.test(job.mergeCommit))
		return keep("missing-immutable-commit-evidence");
	if (
		e.intent.state !== "merged" ||
		e.intent.approvedHead !== job.reviewedHead ||
		e.intent.mergeCommit !== job.mergeCommit ||
		e.pr.mergeSha !== job.mergeCommit ||
		e.pr.headSha !== job.reviewedHead ||
		e.task.head !== job.reviewedHead
	)
		return keep("merge-evidence-mismatch");
	if (!e.mergeReachableFromBase) return keep("recorded-merge-not-reachable-from-base");
	if (e.openPrsUsingHead !== 0) return keep("branch-used-by-an-open-pr");
	if (e.remote.state === "unknown") return keep("remote-ref-unknown");
	if (e.remote.state === "absent") return { kind: "already-absent" };
	if (e.remote.protected !== false) return keep("protected-or-protection-unknown");
	if (e.remote.sha !== job.reviewedHead) return keep("remote-head-changed");
	return { kind: "candidate" };
}

export type Result = Readonly<{
	state: "disabled" | "kept" | "would-delete" | "pending" | "deleted" | "already-absent" | "retry" | "needs-attention";
	reason: string;
	attempts: number;
	nextAttemptAtMs: number | null;
}>;

export interface Ports {
	readEvidence(job: Job): Promise<Evidence>;
	/** MUST implement an atomic expected-old-SHA lease, never an unconditional GitHub DELETE-ref call. */
	deleteRemoteRefWithLease(repository: string, fullRef: string, expectedOldSha: string): Promise<void>;
	/** Persistent cleanup-only journal, unique by job.key. No task/approval/merge-intent mutation capability. */
	record(job: Job, result: Result): Promise<void>;
	now(): number;
}

export class CleanupFailure extends Error {
	readonly category: "transient" | "denied" | "changed" | "unknown";
	constructor(category: "transient" | "denied" | "changed" | "unknown") {
		super(`branch-cleanup-${category}`);
		this.category = category;
	}
}

/** Separate housekeeping effect. Failure never changes the already-successful task/merge state. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keep ordered safety gates and uncertain-effect recovery visible in one audit path.
export async function runOne(job: Job, ports: Ports, config: Readonly<Config> = DEFAULT_CONFIG): Promise<Result> {
	const result = (
		state: Result["state"],
		reason: string,
		attempts = job.attempts,
		nextAttemptAtMs: number | null = null,
	): Result => ({ state, reason, attempts, nextAttemptAtMs });
	if (config.mode === "disabled") return result("disabled", "disabled-during-current-acceptance-and-rehearsal");
	if (
		config.mode === "enabled" &&
		(!config.acceptanceComplete ||
			!config.activationApproved ||
			config.notBeforeMs === null ||
			!Number.isFinite(config.notBeforeMs) ||
			config.notBeforeMs <= 0)
	)
		return result("disabled", "post-acceptance-activation-not-approved");
	const save = async (r: Result): Promise<Result> => {
		await ports.record(job, r);
		return r;
	};
	const retry = async (reason: string, attempts: number): Promise<Result> => {
		if (attempts >= 8) return save(result("needs-attention", reason, attempts));
		const backoffMs = Math.min(3_600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
		return save(result("retry", reason, attempts, ports.now() + backoffMs));
	};
	let facts: Evidence;
	try {
		facts = await ports.readEvidence(job);
	} catch {
		return retry("preflight-read-unavailable", job.attempts + 1);
	}
	const verdict = evaluate(job, facts, config);
	if (verdict.kind === "keep") return save(result("kept", verdict.reason));
	if (verdict.kind === "already-absent") return save(result("already-absent", "remote-absence-confirmed"));
	if (config.mode === "dry-run") return save(result("would-delete", "eligible-but-no-delete-in-dry-run"));
	const attempts = job.attempts + 1;
	// Persist the cleanup intent before the effect. A crash leaves a job to read back, never a failed merge.
	await save(result("pending", "deletion-intent-persisted", attempts));
	try {
		await ports.deleteRemoteRefWithLease(job.repository, `refs/heads/${job.branch}`, job.reviewedHead);
	} catch (error) {
		if (error instanceof CleanupFailure && (error.category === "denied" || error.category === "changed"))
			return save(result("needs-attention", `delete-${error.category}`, attempts));
		if (!(error instanceof CleanupFailure) || error.category === "unknown") {
			try {
				const after = evaluate(job, await ports.readEvidence(job), config);
				if (after.kind === "already-absent")
					return save(result("already-absent", "unknown-delete-confirmed-absent", attempts));
				if (after.kind === "keep") return save(result("kept", after.reason, attempts));
			} catch {
				return retry("delete-outcome-and-readback-unavailable", attempts);
			}
		}
		return retry("delete-not-confirmed", attempts);
	}
	// A successful transport response is not proof: confirm remote absence and immutable task/PR evidence again.
	try {
		const after = evaluate(job, await ports.readEvidence(job), config);
		if (after.kind === "already-absent") return save(result("deleted", "remote-absence-confirmed", attempts));
		if (after.kind === "keep") return save(result("kept", after.reason, attempts));
	} catch {
		return retry("delete-readback-unavailable", attempts);
	}
	return retry("ref-still-present-after-delete", attempts);
}
