/**
 * A task held because its branch changed on GitHub outside the Coordinator (Interfaces and Storage § Coordinator to
 * GitHub; Requirements § Safe recovery; Architecture § Review and merge, § Fails closed).
 *
 * GitHub refusing a push because the task branch moved is a definite outcome, not an uncertain one: nothing was
 * pushed, and the Coordinator never overwrites or force-pushes a commit on GitHub. So the group does not freeze; only
 * that task waits, its work kept committed in its worktree, until someone restores the branch on GitHub:
 *
 *   "review":  the post-run review step could not push the run's checkpoint (or the branch moved right after the
 *              push). The task is in review, /approve is rejected, and once the branch is restored the review step is
 *              redone (push, pull request, review message), so the new head can be approved.
 *   "archive": the final push of a cancelled or failed task was refused. Its worktree is kept ("The folder is deleted
 *              only after GitHub confirms the push") and the archive is redone once the branch is restored.
 *
 * One meta key per task (`branch_hold:<task id>`), so a hold survives a restart. Written by the engine
 * (engine/effects.ts, engine/review.ts), read by the engine's retry (engine/held.ts) and by the command front.
 */
import type { Store } from "./store.ts";

export type BranchHoldKind = "review" | "archive";
export type BranchHoldCause = "branch_moved" | "branch_deleted" | "pr_closed";

export type BranchHold = {
	readonly kind: BranchHoldKind;
	/** Older persisted holds have no cause and mean branch_moved. */
	readonly cause?: BranchHoldCause;
	/** "review": the run whose review step waits for the push. */
	readonly runId: number | null;
	/** "review": that run was interrupted by a restart (its review message says so). */
	readonly interrupted: boolean;
	readonly branch: string;
	/** The commit in the task's worktree that waits to be on GitHub (full sha). */
	readonly local: string;
	/** The commit the Coordinator last pushed to the branch: GitHub must be back there. null: it never pushed it. */
	readonly pushed: string | null;
	/** GitHub's branch head when the Coordinator last looked (full sha). */
	readonly github: string | null;
	/** The original PR, including one recovered after a lost creation response. Never replaced. */
	readonly prNumber?: number;
	readonly since: number;
};

export const BRANCH_HOLD_PREFIX = "branch_hold:";

export function branchHoldKey(taskId: number): string {
	return `${BRANCH_HOLD_PREFIX}${taskId}`;
}

const SHA = /^[0-9a-f]{40,64}$/;

function isSha(value: unknown): value is string {
	return typeof value === "string" && SHA.test(value);
}

function parseJson(value: string): Record<string, unknown> | undefined {
	try {
		const raw: unknown = JSON.parse(value);
		return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** The commits of a hold are full shas; `pushed` may be null (never pushed). */
function validCommits(raw: Record<string, unknown>): boolean {
	return isSha(raw.local) && (raw.github === null || isSha(raw.github)) && (raw.pushed === null || isSha(raw.pushed));
}

function validCause(raw: Record<string, unknown>): boolean {
	return raw.cause === undefined || ["branch_moved", "branch_deleted", "pr_closed"].includes(String(raw.cause));
}

function validRow(raw: Record<string, unknown>): boolean {
	return typeof raw.branch === "string" && validCommits(raw);
}

function optionalFields(raw: Record<string, unknown>): Pick<BranchHold, "cause" | "prNumber"> {
	return {
		...(raw.cause === undefined ? {} : { cause: raw.cause as BranchHoldCause }),
		...(Number.isSafeInteger(raw.prNumber) && Number(raw.prNumber) > 0 ? { prNumber: Number(raw.prNumber) } : {}),
	};
}

function holdKind(value: unknown): BranchHoldKind | undefined {
	return value === "review" || value === "archive" ? value : undefined;
}

/** The parsed hold, or undefined for a value that is not one (never throws). */
export function parseBranchHold(value: string | undefined): BranchHold | undefined {
	const raw = value === undefined ? undefined : parseJson(value);
	if (raw === undefined || !validRow(raw)) return undefined;
	const kind = holdKind(raw.kind);
	const runId = typeof raw.runId === "number" ? raw.runId : null;
	if (kind === undefined || (kind === "review" && runId === null)) return undefined;
	if (!validCause(raw)) return undefined;
	return {
		kind,
		...optionalFields(raw),
		runId,
		interrupted: raw.interrupted === true,
		branch: raw.branch as string,
		local: raw.local as string,
		pushed: raw.pushed as string | null,
		github: raw.github as string | null,
		since: typeof raw.since === "number" ? raw.since : 0,
	};
}

/** Definite deletion/closed PR: new runs wait too; a moved-but-existing branch keeps the Phase 2b behavior. */
export function blocksTaskRuns(hold: BranchHold | undefined): boolean {
	return hold?.kind === "review" && (hold.cause === "branch_deleted" || hold.cause === "pr_closed");
}

export function readBranchHold(store: Store, taskId: number): BranchHold | undefined {
	return parseBranchHold(store.getMeta(branchHoldKey(taskId)));
}
