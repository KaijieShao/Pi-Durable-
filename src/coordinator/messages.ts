/**
 * Every user-facing text of the command front, plus a few the engine shares (taskRef, sha7, frozenNotice,
 * helpText, followupExpired). Plain text: the outbox sends without a parse mode, so nothing here is escaped.
 * Builders do not cut whole messages: a text over Telegram's limit is split into ordered parts when it is queued
 * (Store.enqueue → src/coordinator/telegram/split.ts). Only echoed fragments are clipped (`clip`).
 *
 * Interfaces and Storage § Telegram: "Each acknowledgement carries the task ID and queue position. Each rejection
 * gives its reason."
 */
import type { WorktreeChange } from "./git.ts";
import { DEMO_LIMITS, type Limits } from "./limits.ts";

export const TELEGRAM_TEXT_LIMIT = 4096;

export type TaskState = "queued" | "running" | "review" | "merging" | "merged" | "failed" | "cancelled";

/** "Task 12": the one way every message names a task. */
export function taskRef(id: number): string {
	return `Task ${id}`;
}

/** Short commit id as shown in Telegram. */
export function sha7(sha: string): string {
	return sha.slice(0, 7);
}

/**
 * A whole message as queued. Kept as the single place builders pass their result through; it no longer cuts at
 * Telegram's limit, because Store.enqueue splits long texts into ordered parts. An explicit `limit` still clamps.
 */
export function fitText(text: string, limit?: number): string {
	return limit === undefined || text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** One line, at most `max` characters: for echoing user-supplied fragments (agent names, task text previews). */
export function clip(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/**
 * A file list as shown in Telegram: every name (long messages are split into parts, not cut), bounded at `max`
 * names with "and N more" so a huge conflict cannot flood the group.
 */
export function listFiles(files: readonly string[], max = 200): string {
	if (files.length <= max) return files.join(", ");
	return `${files.slice(0, max).join(", ")} and ${files.length - max} more`;
}

function plural(n: number, one: string, many: string = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

function lowerFirst(text: string): string {
	return text.charAt(0).toLowerCase() + text.slice(1);
}

function sentence(text: string): string {
	const trimmed = text.trim().replace(/[.\s]+$/, "");
	return trimmed === "" ? "" : `${trimmed}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Rejections. Every rejection names what was rejected and why.

export type RejectSubject = "Task request" | "Follow-up" | "/approve" | "/cancel" | "/status";

export function rejected(subject: RejectSubject, reason: string): string {
	return fitText(`${subject} rejected: ${sentence(reason)}`);
}

/**
 * Architecture § Frozen group: "/task, follow-ups and approvals are rejected with a frozen notice". A complete
 * sentence: usable on its own or as the reason of `rejected()`.
 */
export function frozenNotice(reason: string | null): string {
	const why = reason === null || reason.trim() === "" ? "" : ` (${clip(reason, 300)})`;
	return (
		`The group is frozen${why}. New tasks, follow-ups and approvals are rejected until the owner resolves it ` +
		"and unfreezes the group with the owner CLI; /status and /cancel still work."
	);
}

export function usageTask(agents: readonly string[]): string {
	return `usage: /task <agent> <text>; agents: ${agents.join(", ")}`;
}

export function usageTaskId(command: "/cancel" | "/approve" | "/status"): string {
	return command === "/status" ? "usage: /status or /status <task id>" : `usage: ${command} <task id>`;
}

export function unknownAgent(given: string, agents: readonly string[]): string {
	return `unknown agent ${JSON.stringify(clip(given, 32))}; configured agents: ${agents.join(", ")}`;
}

export function notAMember(): string {
	return "only the group's listed members and the owner can submit tasks";
}

export function emptyText(what: "task" | "follow-up"): string {
	return what === "task" ? "the task text is empty" : "a follow-up must be a text reply";
}

export function tooLong(what: "task" | "follow-up", length: number, limit: number): string {
	return `the ${what} text is too long (${length} characters; the limit is ${limit})`;
}

const BOOT_DISK_STILL_WORKS = "follow-ups, /status, /cancel and /approve still work";

/**
 * Capacity § Disk: "When its free space runs low, new tasks are rejected with a reason." The boot disk holds the
 * Coordinator database, the outbox, Pi's stores and the logs (PI_DATA_DIR).
 */
export function bootDiskLow(freeBytes: number, minBytes: number): string {
	return (
		`the boot disk is low on free space: ${formatBytes(freeBytes)} free, at least ${formatBytes(minBytes)} needed ` +
		`for new tasks; ${BOOT_DISK_STILL_WORKS}`
	);
}

/** Fail closed: free space that cannot be measured counts as low. */
export function bootDiskUnknown(): string {
	return `the free space of the boot disk cannot be read, so new tasks are refused; ${BOOT_DISK_STILL_WORKS}`;
}

/** Why a new worktree does not fit on the task disk now (src/coordinator/disk.ts). */
export type TaskDiskShortfall =
	| { readonly kind: "floor"; readonly needed: number; readonly free: number; readonly floor: number }
	| { readonly kind: "budget"; readonly needed: number; readonly used: number; readonly budget: number }
	| { readonly kind: "unknown" };

/** The shortfall in one clause (numbers only, no task text). */
export function taskDiskDetail(shortfall: TaskDiskShortfall): string {
	switch (shortfall.kind) {
		case "floor":
			return (
				`its new worktree needs about ${formatBytes(shortfall.needed)} on the task disk, but only ` +
				`${formatBytes(shortfall.free)} is free and ${formatBytes(shortfall.floor)} must stay free`
			);
		case "budget":
			return (
				`its new worktree needs about ${formatBytes(shortfall.needed)}, but the task disk budget of ` +
				`${formatBytes(shortfall.budget)} has only ${formatBytes(shortfall.budget - shortfall.used)} left ` +
				`(${formatBytes(shortfall.used)} in use)`
			);
		case "unknown":
			return "the free space of the task disk or the size of its new worktree cannot be measured";
	}
}

/**
 * Capacity § Disk: "If a new worktree would exceed it, the task stays queued and the bot says why." Told once per
 * task; `taskRef(id) stays queued: <this>.`
 */
export function taskDiskWait(shortfall: TaskDiskShortfall): string {
	return (
		`${taskDiskDetail(shortfall)}. It starts by itself once there is room, for example when another task is merged ` +
		"or cancelled and its worktree is archived"
	);
}

/** The /status and acknowledgement note of a first run held by the task disk (`detail`: taskDiskDetail()). */
export function waitingForTaskDisk(detail: string): string {
	return `Waiting for room on the task disk: ${detail}`;
}

export function noSuchTask(id: number): string {
	return `there is no ${taskRef(id)} in this group`;
}

export function notPermitted(action: "cancel" | "follow up on" | "approve", taskId: number): string {
	return `only the creator of ${taskRef(taskId)} or the group owner can ${action} it`;
}

export function terminalTask(id: number, state: "merged" | "failed" | "cancelled", reason: string | null): string {
	const why = state === "failed" && reason !== null && reason.trim() !== "" ? ` (${clip(reason, 200)})` : "";
	const verb = state === "merged" ? "is already merged" : state === "failed" ? `failed${why}` : "was cancelled";
	return `${taskRef(id)} ${verb}; send a new /task for further work`;
}

export function terminalForCommand(id: number, state: "merged" | "failed" | "cancelled"): string {
	return `${taskRef(id)} is already ${state}`;
}

export function mergeInProgress(id: number): string {
	return `merge in progress for ${taskRef(id)}`;
}

export function beingCancelled(id: number): string {
	return `${taskRef(id)} is being cancelled`;
}

export function runStopping(id: number): string {
	return `the run of ${taskRef(id)} is stopping; reply again once the task is ready for review`;
}

export function followupLimit(id: number, limit: number): string {
	return `${taskRef(id)} already has ${plural(limit, "follow-up")}, the limit; send a new /task for further work`;
}

export function notInReview(id: number, state: TaskState): string {
	return `${taskRef(id)} is ${describeState(state)}, not in review; approve it after the bot posts its pull request`;
}

/**
 * /approve while a run of the task is queued or in progress (Interfaces and Storage § Telegram: rejected "if a new
 * run has been admitted since"). `kind` is the busy run's kind; `postedHead` the head the bot last posted, if any.
 */
export function runAdmitted(p: { taskId: number; postedHead: string | null; kind: string }): string {
	const task = taskRef(p.taskId);
	const approve = `/approve ${p.taskId}`;
	if (p.kind === "initial") {
		return (
			`${task} is still on its first run, so the bot has not posted a head to approve yet; ` +
			`wait for its review message, then send ${approve}`
		);
	}
	if (p.kind === "conflict") {
		return (
			`a conflict-fix run of ${task} is queued or running, so there is no head to approve yet; ` +
			`wait for the bot to post its result, then approve the new head with ${approve}`
		);
	}
	if (p.postedHead === null) {
		return (
			`a new run of ${task} is queued or running and the bot has not posted a head to approve yet; ` +
			`wait for the bot to post its result, then send ${approve}`
		);
	}
	return (
		`a new run of ${task} was admitted, so ${sha7(p.postedHead)}, the head the bot last posted, is no longer what ` +
		`would merge; wait for the bot to post that run's result, then approve its new head with ${approve}`
	);
}

export function noPullRequest(id: number): string {
	return `${taskRef(id)} has no pull request, so there is nothing to merge`;
}

/** tasks.reason while a merge conflict waits for its fix run because the run could not be queued (engine/merge.ts). */
export const MERGE_CONFLICT_REASON = "merge conflict";

/**
 * /approve when there is no posted head to approve, or the task's branch is no longer at the head the bot last posted
 * (Interfaces and Storage § Telegram: rejected "if the branch has changed"). `conflict`: a merge with main stopped
 * with a conflict and its fix run could not be queued (the worktree holds the unfinished merge).
 */
export function staleHead(p: {
	taskId: number;
	head: string | null;
	postedHead: string | null;
	conflict: boolean;
}): string {
	const task = taskRef(p.taskId);
	const followup = `reply to a message of ${task} for a follow-up run, then approve the head the bot posts after it`;
	if (p.postedHead === null && p.conflict) {
		return (
			`the merge of ${task} with the latest main stopped with a conflict, so there is no head to approve yet; ` +
			`reply to a message of ${task} to start the conflict fix, then approve the head the bot posts after it`
		);
	}
	if (p.postedHead === null || p.head === null)
		return `the bot has not posted a head of ${task} to approve; ${followup}`;
	return `the branch of ${task} is at ${sha7(p.head)}, but the bot last posted ${sha7(p.postedHead)}; ${followup}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The merge step (engine/merge.ts): approvals rejected or set aside, each with why and what to do.
// Architecture § Review and merge; Interfaces and Storage § Coordinator to GitHub.

/** approvals.reason when the merge step rejects an approval because GitHub's branch no longer matches it. */
export const BRANCH_CHANGED_REASON = "branch changed after approval";
/** approvals.reason when the merge step rejects an approval because the pull request was closed on GitHub. */
export const PR_CLOSED_REASON = "pull request closed";

/**
 * For a task in review (its review reminder, /status <task>) whose latest approval the merge step rejected because
 * GitHub's branch or pull request no longer matched, with no new head posted since: point back to that rejection
 * instead of the usual "reply for a follow-up, or /approve", since approving again works only after the branch or
 * pull request is restored. Else undefined.
 */
export function rejectedApprovalNote(
	approval: { readonly head_commit: string; readonly state: string; readonly reason: string | null } | undefined,
	postedHead: string | null,
): string | undefined {
	if (approval?.state !== "invalidated" || approval.head_commit !== postedHead) return undefined;
	const see = "see that message for what to do next";
	if (approval.reason === BRANCH_CHANGED_REASON) {
		return `Its last approval was rejected because the branch changed after approval; ${see}.`;
	}
	if (approval.reason === PR_CLOSED_REASON) {
		return `Its last approval was rejected because the pull request was closed on GitHub; ${see}.`;
	}
	return undefined;
}

/** What the merge step knows when GitHub's view of the pull request does not match the approval. */
export type ApprovalFacts = {
	readonly taskId: number;
	readonly branch: string;
	/** The approved head: the head the bot posted when /approve was sent (full sha). */
	readonly approvedHead: string;
	/** The pull request's head on GitHub now (full sha). */
	readonly githubHead: string;
};

function rejectedHeadline(taskId: number): string {
	return `Approval of ${taskRef(taskId)} rejected; nothing was merged.`;
}

function headsDiffer(p: ApprovalFacts): string {
	return (
		`Why: branch ${p.branch} on GitHub is at ${sha7(p.githubHead)}, but the approval was for ` +
		`${sha7(p.approvedHead)}, the head the bot posted.`
	);
}

/**
 * GitHub's pull request head is not the approved head and the Coordinator did not push it: someone pushed to the task
 * branch on GitHub. The way on: restore the branch to the approved head, then /approve again or /cancel. A follow-up
 * run or /cancel before that is safe (a definite refusal of their push holds only this task: engine/effects.ts
 * pushBranch, branch-hold.ts), but their work then waits in the worktree until the branch is restored. `combined`:
 * the merge step had combined the task with a newer main when its push was refused (that commit stays local).
 */
export function approvalBranchChanged(p: ApprovalFacts & { combined?: string | undefined }): string {
	const combined =
		p.combined === undefined
			? []
			: [
					`The combination with the latest main, ${sha7(p.combined)}, was not pushed; it stays in the task's ` +
						"worktree, and the next approval, follow-up or /cancel builds on it.",
				];
	return [
		rejectedHeadline(p.taskId),
		`${headsDiffer(p)} The branch changed outside the Coordinator.`,
		...combined,
		`What to do: restore ${p.branch} on GitHub to ${sha7(p.approvedHead)}, for example from a clone after ` +
			"git fetch origin:",
		`git push --force origin ${p.approvedHead}:refs/heads/${p.branch}`,
		"(this drops the commits pushed since; save them on another branch first if you need them). " +
			`Then send /approve ${p.taskId} again to approve that head, or /cancel ${p.taskId} to drop the task.`,
		"The Coordinator never overwrites commits on GitHub: a follow-up run or a /cancel before the branch is " +
			"restored keeps its work in the task's worktree until then. The other tasks and the group carry on.",
	].join("\n");
}

/**
 * GitHub's head is the task worktree's own HEAD: the Coordinator pushed it, from an earlier merge attempt that
 * combined the task with main and was interrupted before it saved and posted the result. The worktree and GitHub
 * agree, so a follow-up run (whose review posts a new head) or /cancel push nothing foreign.
 */
export function approvalUnfinishedCombine(p: ApprovalFacts): string {
	return [
		rejectedHeadline(p.taskId),
		`${headsDiffer(p)} ${sha7(p.githubHead)} was pushed by the Coordinator itself: an earlier merge attempt ` +
			"combined the task with the latest main and was interrupted before it posted the result.",
		`What to do: reply to a message of ${taskRef(p.taskId)} for a follow-up run, then approve the head the bot ` +
			`posts after it; or send /cancel ${p.taskId}.`,
	].join("\n");
}

/** The pull request was merged on GitHub at another head than the approved one: not by the Coordinator. */
export function approvalMergedElsewhere(p: ApprovalFacts): string {
	return [
		`Approval of ${taskRef(p.taskId)} rejected; the Coordinator merged nothing.`,
		`Why: the pull request of ${taskRef(p.taskId)} was merged on GitHub outside the Coordinator, at ` +
			`${sha7(p.githubHead)} instead of the approved head ${sha7(p.approvedHead)}. Main on GitHub now contains ` +
			"that merge; the group owner should check it.",
		`What to do: this pull request cannot be merged again. To close the task, make sure branch ${p.branch} on ` +
			`GitHub is at ${sha7(p.approvedHead)} or deleted (restore it if it changed), then send /cancel ${p.taskId}.`,
	].join("\n");
}

/** The pull request was closed on GitHub (the Coordinator closes one only on cancel or a limit). */
export function approvalPrClosed(p: Omit<ApprovalFacts, "githubHead">): string {
	return [
		rejectedHeadline(p.taskId),
		`Why: the pull request of ${taskRef(p.taskId)} was closed on GitHub outside the Coordinator.`,
		`What to do: make sure branch ${p.branch} on GitHub is at ${sha7(p.approvedHead)}, the approved head (restore ` +
			`it if it was changed or deleted). Then reopen the pull request on GitHub and send /approve ${p.taskId} ` +
			`again, or send /cancel ${p.taskId} to drop the task.`,
	].join("\n");
}

/** GitHub still has the approved head, but the Coordinator's record of the branch moved (not expected to happen). */
export function approvalLocalMoved(p: Omit<ApprovalFacts, "githubHead"> & { localHead: string | null }): string {
	const local = p.localHead === null ? "no commit" : sha7(p.localHead);
	return [
		rejectedHeadline(p.taskId),
		`Why: the Coordinator's record of branch ${p.branch} is at ${local}, not at the approved head ` +
			`${sha7(p.approvedHead)} (GitHub still has ${sha7(p.approvedHead)}).`,
		`What to do: this is not expected; the group owner should check /status ${p.taskId} and the Coordinator's ` +
			"log before anyone approves it again.",
	].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// A task held because its branch changed on GitHub outside the Coordinator (branch-hold.ts, engine/held.ts): GitHub
// refused a push of the task branch, a definite outcome. Only that task waits; the group carries on.

/** What the Coordinator knows about a held task's branch. */
export type HoldFacts = {
	readonly taskId: number;
	readonly branch: string;
	/** GitHub's branch head when the Coordinator last looked (full sha). */
	readonly github: string;
	/** The commit in the task's worktree that waits to be on GitHub (full sha). */
	readonly local: string;
	/** The commit the Coordinator last pushed to the branch (full sha); null: it never pushed the branch. */
	readonly pushed: string | null;
};

function holdWhy(p: HoldFacts): string {
	if (p.pushed === null) {
		return (
			`Why: branch ${p.branch} exists on GitHub (at ${sha7(p.github)}), but the Coordinator has not pushed it yet: ` +
			"it was created outside the Coordinator. The Coordinator never overwrites commits on GitHub."
		);
	}
	return (
		`Why: branch ${p.branch} on GitHub is at ${sha7(p.github)}, but the Coordinator last pushed ` +
		`${sha7(p.pushed)} there: the branch changed outside the Coordinator. The Coordinator never overwrites commits ` +
		"on GitHub."
	);
}

/** How to put the branch back where the Coordinator can push again without force. */
function holdRestore(p: HoldFacts): string[] {
	if (p.pushed === null) {
		return [
			`What to do: delete ${p.branch} on GitHub, for example from a clone:`,
			`git push origin --delete ${p.branch}`,
			"(save its commits on another branch first if you need them).",
		];
	}
	return [
		`What to do: restore ${p.branch} on GitHub to ${sha7(p.pushed)}, for example from a clone after git fetch origin:`,
		`git push --force origin ${p.pushed}:refs/heads/${p.branch}`,
		"(this drops the commits pushed since; save them on another branch first if you need them).",
	];
}

function heldReviewLead(p: HoldFacts & { runNo: number; interrupted: boolean }): string {
	const task = taskRef(p.taskId);
	if (p.local === p.pushed) {
		return p.interrupted
			? `${task} was interrupted by restart (run ${p.runNo}); its work so far was pushed, but then its branch changed ` +
					"on GitHub. Nothing was merged."
			: `${task} finished run ${p.runNo} and its checkpoint was pushed, but then its branch changed on GitHub. ` +
					"Nothing was merged.";
	}
	return p.interrupted
		? `${task} was interrupted by restart (run ${p.runNo}), and GitHub refused the push of its work so far. Nothing ` +
				"was merged."
		: `${task} finished run ${p.runNo}, but GitHub refused the push of its checkpoint. Nothing was merged.`;
}

/**
 * The review step of a run could not put its checkpoint on GitHub because the branch changed outside the Coordinator
 * (its push was refused, or the branch moved right after it). The task waits in review with its worktree; once the
 * branch is restored, the Coordinator pushes the checkpoint and posts it for review.
 */
export function reviewHeld(p: HoldFacts & { runNo: number; tests: string; interrupted: boolean }): string {
	const head = sha7(p.local);
	const pushedIt = p.local === p.pushed;
	const kept = pushedIt
		? `Kept: the task's worktree, at ${head} (tests: ${p.tests}).`
		: `Kept: the run's work is committed in the task's worktree as ${head} (tests: ${p.tests}); it is not on GitHub yet.`;
	const then = pushedIt
		? `Once that is done, the Coordinator posts ${head} for review again`
		: `Once that is done, the Coordinator pushes ${head} and posts it for review`;
	return [
		heldReviewLead(p),
		holdWhy(p),
		kept,
		...holdRestore(p),
		`${then}; approve it then with /approve ${p.taskId}. Or send /cancel ${p.taskId} to drop the task.`,
		`Until then /approve ${p.taskId} is rejected. The other tasks and the group carry on.`,
	].join("\n");
}

/**
 * The final push of a cancelled or failed task was refused because its branch changed outside the Coordinator: its
 * worktree is kept (the folder is deleted only after GitHub confirms the push) until the branch is restored.
 * `lead`: "Task 12 cancelled." / "Task 12 failed: <reason>.".
 */
export function archiveHeld(p: HoldFacts & { lead: string; prClosed: boolean }): string {
	const kept =
		p.local === p.pushed
			? `Kept: the worktree, at ${sha7(p.local)}.`
			: `Kept: the task's work is committed in its worktree as ${sha7(p.local)}; it is not on GitHub yet.`;
	return [
		`${p.lead} Its worktree is kept: GitHub refused its final push.`,
		holdWhy(p),
		`${kept} Nothing was merged.${p.prClosed ? " Its pull request is closed." : ""}`,
		...holdRestore(p),
		`Once that is done, the Coordinator pushes ${sha7(p.local)} and archives the worktree; the branch is kept.`,
	].join("\n");
}

function restoredWord(p: HoldFacts): string {
	return p.pushed === null ? "deleted" : `restored to ${sha7(p.pushed)}`;
}

/** /approve of a task held in review (the reason of the rejection). */
export function heldApproval(p: HoldFacts): string {
	const task = taskRef(p.taskId);
	const seen = `it was at ${sha7(p.github)} when the Coordinator last looked`;
	if (p.local === p.pushed) {
		return (
			`branch ${p.branch} of ${task} changed on GitHub outside the Coordinator after ${sha7(p.local)} was pushed ` +
			`(${seen}); once it is ${restoredWord(p)}, the bot posts ${sha7(p.local)} for review again; approve it then`
		);
	}
	return (
		`the latest checkpoint of ${task}, ${sha7(p.local)}, is not on GitHub yet: branch ${p.branch} changed on GitHub ` +
		`outside the Coordinator (${seen}); once it is ${restoredWord(p)}, the bot pushes ${sha7(p.local)} and posts ` +
		"it for review; approve it then"
	);
}

/** For /status <task> and the review reminder of a held task: what it waits for. */
export function holdNote(p: HoldFacts & { kind: "review" | "archive" }): string {
	if (p.kind === "archive") {
		return (
			`Its worktree is kept until branch ${p.branch} on GitHub is ${restoredWord(p)}: the branch changed outside ` +
			"the Coordinator and GitHub refused the final push. See the bot's message about it for what to do."
		);
	}
	return (
		`Its latest checkpoint ${sha7(p.local)} waits until branch ${p.branch} on GitHub is ${restoredWord(p)}: the ` +
		"branch changed outside the Coordinator. See the bot's message about it for what to do."
	);
}

/** A follow-up run admitted while its task is held in review: its result waits too. */
export function heldFollowupNote(branch: string): string {
	return (
		`Branch ${branch} on GitHub still differs from what the Coordinator pushed, so this run's result is pushed ` +
		"only once the branch is restored"
	);
}

/**
 * Main moved: the combined result is a new commit, tested and pushed, so the approval no longer covers what would
 * merge (Architecture § Review and merge). Failed tests block a merge, so then the way on is a follow-up.
 */
export function mainMoved(p: {
	taskId: number;
	approvedHead: string;
	head: string;
	tests: string;
	testsPassed: boolean;
}): string {
	const lead =
		`Main moved; ${taskRef(p.taskId)} was combined with the latest main and retested (${p.tests}). ` +
		`Head: ${sha7(p.head)}. Nothing was merged: the approval of ${sha7(p.approvedHead)} does not cover this ` +
		"combined result";
	if (p.testsPassed) return `${lead}, so approve it with /approve ${p.taskId}.`;
	return (
		`${lead}, and it cannot merge until its tests pass. Reply to this message for a follow-up to fix them, then ` +
		"approve the head the bot posts after it."
	);
}

/**
 * Merging main into the task branch stopped with a conflict: nothing merged, the approval is set aside, and a
 * conflict-fix run was admitted (`position`) or could not be queued (`refused`, the admission's reason).
 */
export function mergeConflict(p: {
	taskId: number;
	approvedHead: string;
	files: string;
	admitted: { position: number } | { refused: string };
}): string {
	const task = taskRef(p.taskId);
	const lead =
		`Merge conflict in: ${p.files}. Nothing was merged: ${task} could not be combined with the latest main, so ` +
		`the approval of ${sha7(p.approvedHead)} no longer applies.`;
	if ("position" in p.admitted) {
		return (
			`${lead} A run of ${task} was admitted to resolve it (queue position ${p.admitted.position}); when the bot ` +
			`posts its result, review it and approve the new head with /approve ${p.taskId}.`
		);
	}
	return (
		`${lead} The conflict-fix run could not be queued (${p.admitted.refused}); reply to this message to start the ` +
		"conflict fix when the queue has room, then approve the head the bot posts after it."
	);
}

export function cannotFollowUp(id: number, state: TaskState): string {
	return `${taskRef(id)} cannot take a follow-up while it is ${describeState(state)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Acknowledgements. Each carries the task id and its queue position.

export function taskAccepted(p: {
	taskId: number;
	agent: string;
	position: number;
	note?: string | undefined;
}): string {
	const note = p.note === undefined ? "" : ` ${sentence(p.note)}`;
	return fitText(`${taskRef(p.taskId)} accepted for agent ${p.agent}. Queue position ${p.position}.${note}`);
}

export function followupSteered(p: { taskId: number; running: boolean; position: number }): string {
	return p.running
		? `Follow-up saved; it will be steered into the running ${taskRef(p.taskId)} (in progress, not queued).`
		: `Follow-up saved; it will be steered into ${taskRef(p.taskId)} when its run starts. Queue position ${p.position}.`;
}

export function followupStarted(p: {
	taskId: number;
	position: number;
	hasPullRequest: boolean;
	note?: string | undefined;
}): string {
	const where = p.hasPullRequest ? "on the same branch and pull request" : "on the same branch";
	const note = p.note === undefined ? "" : ` ${sentence(p.note)}`;
	return `Follow-up started another run of ${taskRef(p.taskId)} ${where}. Queue position ${p.position}.${note}`;
}

/**
 * A follow-up's "expired" outcome (Agent Execution § Finalize and Pending Inputs). `cause` is "cancelled",
 * "limit", "interrupted" or a short free-form reason.
 */
export function followupExpired(taskId: number, cause: string): string {
	const why =
		cause === "cancelled"
			? "the task was cancelled"
			: cause === "limit"
				? "the run hit a limit"
				: cause === "interrupted"
					? "the run was interrupted by a restart"
					: clip(cause, 200);
	return `Follow-up to ${taskRef(taskId)} expired: ${why}.`;
}

/** Interfaces and Storage § Recovery: a run that had not started when the Coordinator restarted is queued again. */
export function requeuedAfterRestart(taskId: number, position: number): string {
	return `${taskRef(taskId)} is queued again after a restart: its run had not started yet. Queue position ${position}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Uncertain effects and interrupted runs (Agent Execution § Uncertain Effects; Interfaces and Storage § Recovery
// After a Restart). File names only, never content.

/**
 * tasks.reason of a task whose run was interrupted by a restart: its changes since the last checkpoint stay in the
 * worktree, uncommitted and unpushed, until a reply starts a fresh run or /cancel archives the task. /approve is
 * refused meanwhile (there is no posted head that holds them).
 */
export const INTERRUPTED_KEPT_REASON =
	"interrupted by restart; its changes since the last checkpoint are kept in the worktree, not pushed; reply to " +
	"start a fresh run, or /cancel";

/** A file change or check whose outcome was reconciled from its target (or is waiting for the owner). */
export type ReconciledEffect = {
	readonly tool: "edit" | "write" | "run_check";
	/** The file, or the run_check operation. */
	readonly target: string;
	readonly outcome: "applied" | "unchanged" | "failed" | "unresolved" | "resolved";
};

function effectOutcome(effect: ReconciledEffect): string {
	switch (effect.outcome) {
		case "applied":
			return "applied (the file has the intended result)";
		case "unchanged":
			return "currently unchanged (the file is as it was before the change)";
		case "failed":
			return "reported failed (its check container was verified gone)";
		case "unresolved":
			return "unresolved (the file matches neither; the owner reviews it)";
		case "resolved":
			return "reviewed by the owner";
	}
}

/** "src/a.js (edit): applied (…); run_check test: reported failed (…)". */
export function reconciledEffects(effects: readonly ReconciledEffect[]): string {
	return effects
		.map((effect) =>
			effect.tool === "run_check"
				? `run_check ${effect.target}: ${effectOutcome(effect)}`
				: `${effect.target} (${effect.tool}): ${effectOutcome(effect)}`,
		)
		.join("; ");
}

/** "a.js, new.txt (new), old.txt (deleted)": a worktree's uncommitted changes. */
export function changeList(changes: readonly WorktreeChange[]): string {
	return listFiles(
		changes.map((change) => (change.change === "modified" ? change.path : `${change.path} (${change.change})`)),
	);
}

export type InterruptedFacts = {
	readonly taskId: number;
	readonly runNo: number;
	readonly branch: string | null;
	/** undefined: the worktree could not be read. */
	readonly changes: readonly WorktreeChange[] | undefined;
	readonly effects: readonly ReconciledEffect[];
	/** The last checkpoint on GitHub, if the Coordinator pushed one. */
	readonly pushedHead: string | null;
	readonly prUrl: string | null;
	readonly next: "reply" | "queued" | "cancelling";
};

function keptLine(changes: readonly WorktreeChange[] | undefined): string {
	if (changes === undefined) return "Its worktree could not be read to list the changes it holds.";
	if (changes.length === 0) return "Its worktree has no changes since the last checkpoint.";
	return `Kept in its worktree, changed since the last checkpoint: ${changeList(changes)}.`;
}

function lastCheckpointLine(p: InterruptedFacts): string[] {
	if (p.pushedHead === null || p.branch === null) return [];
	const pr = p.prUrl === null ? "" : ` and pull request ${p.prUrl}`;
	const hold = p.prUrl === null ? "holds" : "hold";
	return [`Branch ${p.branch}${pr} still ${hold} the last checkpoint, ${sha7(p.pushedHead)}.`];
}

function interruptedNextLine(p: InterruptedFacts): string {
	const where = p.branch === null ? "its branch" : `branch ${p.branch}`;
	if (p.next === "cancelling")
		return `It is being cancelled: its final checkpoint, with these changes, is pushed to ${where}.`;
	if (p.next === "queued")
		return "A follow-up run is queued: it starts in a fresh conversation and continues from these changes.";
	return (
		"Reply to this message to start a fresh run that continues from these changes (a new conversation; its result " +
		`is committed, pushed and posted for review), or send /cancel ${p.taskId} to end the task (its final checkpoint, ` +
		`with these changes, is pushed to ${where}).`
	);
}

/**
 * Posted once a run interrupted by restart is reconciled: what its worktree holds now (files changed since the last
 * checkpoint, nothing committed or pushed), what reconciliation found for the changes in flight, and what comes next.
 */
export function interruptedKept(p: InterruptedFacts): string {
	const effects =
		p.effects.length === 0 ? [] : [`In flight at the restart, reconciled: ${reconciledEffects(p.effects)}.`];
	return [
		`${taskRef(p.taskId)} was interrupted by restart (run ${p.runNo}). It is not resumed, and nothing was committed or pushed.`,
		keptLine(p.changes),
		...effects,
		...lastCheckpointLine(p),
		interruptedNextLine(p),
	].join("\n");
}

/** /approve of a task whose interrupted run's changes wait in its worktree. */
export function interruptedApproval(taskId: number): string {
	const task = taskRef(taskId);
	return (
		`${task} was interrupted by a restart and the changes its run made since the last checkpoint are kept in its ` +
		"worktree, not committed or pushed, so there is no head to approve; reply to its message to start a fresh run " +
		`that continues from them (the bot then posts a new head to approve), or send /cancel ${taskId}`
	);
}

/** The next step in the review reminder of such a task. */
export function interruptedNext(taskId: number): string {
	return (
		"Its interrupted run's changes are kept in its worktree, not pushed. Reply to this message to start a fresh run " +
		`that continues from them, or send /cancel ${taskId}.`
	);
}

/** The group's freeze reason when a file change could not be reconciled. */
export function unresolvedEffectReason(taskId: number, files: readonly string[]): string {
	return `the outcome of a file change of ${taskRef(taskId)} could not be reconciled (${listFiles(files, 10)})`;
}

/** Told to the task's users when a file change of theirs could not be reconciled (the group freezes). */
export function unresolvedEffect(p: { taskId: number; files: readonly string[] }): string {
	const task = taskRef(p.taskId);
	const one = p.files.length === 1;
	return (
		`${task}: the outcome of a file change could not be confirmed, and ${listFiles(p.files)} ` +
		`${one ? "matches" : "match"} neither ${one ? "its" : "their"} content before the change nor the intended ` +
		"result. Nothing of it was committed or pushed. The group is frozen until the owner reviews it and unfreezes " +
		`the group; /status and /cancel ${p.taskId} still work (a cancel waits for that review).`
	);
}

/** runs.reason / tasks.reason of a run stopped because a file change's outcome could not be confirmed. */
export function uncertainChangeReason(path: string): string {
	return `the outcome of a file change (${clip(path, 200)}) could not be confirmed, so the run was stopped`;
}

/** The tool result the model gets for such a change (its run stops; it must never repeat the change). */
export const UNCERTAIN_TOOL_RESULT =
	"unknown: the outcome of this change could not be confirmed; the run stops so the file can be reconciled. " +
	"Do not repeat it.";

export function taskCancelled(id: number): string {
	return `${taskRef(id)} cancelled.`;
}

export function cancelling(id: number, state: TaskState): string {
	const what =
		state === "review"
			? "its pull request is closed and its worktree archived"
			: "its run is stopped and its work is saved to its branch";
	return `Cancelling ${taskRef(id)}… You will get a message once ${what}.`;
}

export function approved(p: { taskId: number; head: string; position: number; testsPassed: boolean }): string {
	const tests = p.testsPassed ? "" : " Tests have not passed at this head, so the merge stops unless they pass.";
	return (
		`Approved ${taskRef(p.taskId)} at ${sha7(p.head)}; merging when the merge queue reaches it. ` +
		`Merge queue position ${p.position}.${tests}`
	);
}

/**
 * The one reminder for a task in review past the configured time (Architecture § Review and merge). `rejectedNote`
 * (rejectedApprovalNote) replaces the usual next step after the merge step rejected its last approval.
 */
export function reviewReminder(p: { taskId: number; prUrl: string | null; rejectedNote: string | undefined }): string {
	const pr = p.prUrl === null ? "" : ` Pull request: ${p.prUrl}.`;
	const next = p.rejectedNote ?? `Reply to this message for a follow-up, or send /approve ${p.taskId}.`;
	return `Reminder: ${taskRef(p.taskId)} is waiting for review.${pr} ${next}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Waiting notes (Capacity § Waiting: "the bot tells the user when it is waiting for reviews to finish").

export function waitingForReviews(openTasks: number): string {
	return `Waiting for open reviews to finish (${plural(openTasks, "open task")})`;
}

export function waitingForSlot(inUse: number, max: number): string {
	return `Waiting for an execution slot (${inUse}/${max} in use)`;
}

export function waitingForAgent(agent: string): string {
	return `Waiting for agent ${agent} to finish its current run`;
}

// ---------------------------------------------------------------------------------------------------------------
// /status

export type StatusTaskLine = {
	readonly id: number;
	readonly agent: string;
	readonly state: TaskState;
	readonly position?: number | undefined;
	readonly note?: string | undefined;
	readonly cancelling: boolean;
	readonly prUrl: string | null;
	/** Held: its branch changed on GitHub outside the Coordinator (branch-hold.ts). */
	readonly held?: boolean | undefined;
};

export function describeState(state: TaskState): string {
	return state === "review" ? "in review" : state;
}

function statusLine(t: StatusTaskLine): string {
	const parts = [`${taskRef(t.id)} · ${t.agent} · ${describeState(t.state)}`];
	if (t.position !== undefined && t.position > 0) parts.push(`queue position ${t.position}`);
	if (t.note !== undefined) parts.push(lowerFirst(t.note));
	if (t.cancelling) parts.push("cancelling");
	if (t.held === true) parts.push("waiting for its branch on GitHub to be restored");
	if (t.prUrl !== null) parts.push(t.prUrl);
	return parts.join(" · ");
}

export function statusSummary(p: {
	group: { state: "normal" | "sealing" | "frozen"; reason: string | null };
	slotsInUse: number;
	maxSlots: number;
	active: readonly StatusTaskLine[];
	recent: readonly StatusTaskLine[];
}): string {
	const group =
		p.group.state === "normal"
			? "normal"
			: `${p.group.state}${p.group.reason === null ? "" : ` (${clip(p.group.reason, 200)})`}`;
	const lines = [`Group: ${group}. Execution slots in use: ${p.slotsInUse}/${p.maxSlots}.`];
	if (p.active.length === 0) lines.push("No open or queued tasks.");
	else lines.push("Open and queued tasks:", ...p.active.map(statusLine));
	if (p.recent.length > 0) lines.push("Recently finished:", ...p.recent.map(statusLine));
	lines.push("Send /status <task id> for details.");
	return fitText(lines.join("\n"));
}

export type StatusDetail = {
	id: number;
	agent: string;
	state: TaskState;
	reason: string | null;
	creatorId: number;
	text: string;
	branch: string | null;
	prUrl: string | null;
	head: string | null;
	postedHead: string | null;
	testsPassedHead: string | null;
	runs: number;
	latestRun: { id: number; state: string; reason: string | null } | undefined;
	followups: number;
	followupLimit: number;
	position: number | undefined;
	note: string | undefined;
	cancelling: boolean;
	archived: boolean;
	/** rejectedApprovalNote for a task in review whose last approval was rejected; replaces the usual next step. */
	rejectedNote?: string | undefined;
	/** holdNote for a task held because its branch changed on GitHub; replaces the usual next step. */
	heldNote?: string | undefined;
};

export function statusDetail(p: StatusDetail): string {
	const lines = [
		`${taskRef(p.id)} · agent ${p.agent} · ${describeState(p.state)}${p.cancelling ? " (cancelling)" : ""}`,
		`Request: ${clip(p.text, 300)}`,
		`Created by user ${p.creatorId}.`,
		...queueLines(p),
		...branchLines(p),
		...runLines(p),
	];
	if (p.heldNote !== undefined) lines.push(p.heldNote);
	else if (p.state === "review") {
		lines.push(p.rejectedNote ?? `Reply to a message of this task for a follow-up, or send /approve ${p.id}.`);
	}
	return fitText(lines.join("\n"));
}

function queueLines(p: StatusDetail): string[] {
	if (p.position === undefined || p.position <= 0) return [];
	return [`Queue position ${p.position}.${p.note === undefined ? "" : ` ${sentence(p.note)}`}`];
}

function branchLines(p: StatusDetail): string[] {
	const lines: string[] = [];
	if (p.branch !== null) lines.push(`Branch: ${p.branch}${p.archived ? " (worktree archived)" : ""}.`);
	lines.push(`Pull request: ${p.prUrl ?? "none yet"}.`);
	if (p.head === null) return lines;
	const tests = p.testsPassedHead === p.head ? "tests passed at this head" : "tests have not passed at this head";
	const posted = p.postedHead !== null && p.postedHead !== p.head ? `; last posted ${sha7(p.postedHead)}` : "";
	lines.push(`Head: ${sha7(p.head)} (${tests}${posted}).`);
	return lines;
}

function runLines(p: StatusDetail): string[] {
	const lines: string[] = [];
	if (p.latestRun !== undefined) {
		const why = p.latestRun.reason === null ? "" : `, ${clip(p.latestRun.reason, 200)}`;
		lines.push(`Runs: ${p.runs} (latest: run ${p.latestRun.id}, ${p.latestRun.state}${why}).`);
	}
	lines.push(`Follow-ups: ${p.followups} of ${p.followupLimit}.`);
	if (p.reason !== null && p.reason.trim() !== "") lines.push(`Note: ${sentence(clip(p.reason, 300))}`);
	return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// /help

export function helpText(agents: readonly string[], bot: string, limits: Limits = DEMO_LIMITS): string {
	const at = bot === "" ? "" : `@${bot}`;
	return fitText(
		[
			"Pi Durable coding agents for this group. Commands:",
			`/task <agent> <text> - give a coding task to an agent (agents: ${agents.join(", ")}). ` +
				`With privacy mode on, send /task${at} <agent> <text>.`,
			"Reply to a task's bot message - follow-up: steered into the task while it runs, or another run on the " +
				"same branch and pull request while it is in review.",
			"/status - group state, execution slots and tasks; /status <task id> - details of one task.",
			"/approve <task id> - approve the head commit the bot last posted; it merges after the tests pass on the " +
				"latest main.",
			"/cancel <task id> - cancel a task (closes its pull request and keeps its branch).",
			"/help - this text.",
			"Only a task's creator and the group owner can follow up on, approve or cancel it.",
			`Limits: ${limits.waitingPerAgent} waiting tasks per agent, ${limits.waitingPerGroup} per group, ` +
				`${limits.waitingPerUser} per user; ${limits.openTasksPerGroup} open tasks per group; ` +
				`${limits.followUpsPerTask} follow-ups per task; ${limits.taskChars} characters per request.`,
		].join("\n"),
	);
}

/** "1.5 GiB", "300 MiB", "12 KiB", "0 bytes". */
export function formatBytes(bytes: number): string {
	const value = Math.max(0, bytes);
	if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)} TiB`;
	if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
	if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
	if (value >= 1024) return `${Math.round(value / 1024)} KiB`;
	return `${Math.round(value)} bytes`;
}
