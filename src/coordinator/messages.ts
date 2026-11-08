/**
 * Every user-facing text of the command front, plus a few the engine shares (taskRef, sha7, frozenNotice,
 * helpText, followupExpired). Plain text: the outbox sends without a parse mode, so nothing here is escaped.
 * Each builder returns at most TELEGRAM_TEXT_LIMIT characters.
 *
 * Interfaces and Storage § Telegram: "Each acknowledgement carries the task ID and queue position. Each rejection
 * gives its reason."
 */
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

/** Clamp to Telegram's message limit, marking the cut. */
export function fitText(text: string, limit: number = TELEGRAM_TEXT_LIMIT): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** One line, at most `max` characters: for echoing user-supplied fragments (agent names, task text previews). */
export function clip(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
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

export function diskLow(which: "data" | "task", freeBytes: number, minBytes: number): string {
	return (
		`disk low: free space on the ${which} disk is ${formatBytes(freeBytes)}, ` +
		`below the ${formatBytes(minBytes)} needed for new tasks`
	);
}

/** Fail closed: free space that cannot be measured counts as low. */
export function diskUnknown(which: "data" | "task"): string {
	return `disk low: free space on the ${which} disk cannot be read, so new tasks are refused`;
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

export function runAdmitted(id: number): string {
	return `a new run of ${taskRef(id)} has been admitted since the bot posted it; review its result first`;
}

export function noPullRequest(id: number): string {
	return `${taskRef(id)} has no pull request, so there is nothing to merge`;
}

export function staleHead(): string {
	return "the branch changed since the bot posted it; wait for the new head";
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
};

export function describeState(state: TaskState): string {
	return state === "review" ? "in review" : state;
}

function statusLine(t: StatusTaskLine): string {
	const parts = [`${taskRef(t.id)} · ${t.agent} · ${describeState(t.state)}`];
	if (t.position !== undefined && t.position > 0) parts.push(`queue position ${t.position}`);
	if (t.note !== undefined) parts.push(lowerFirst(t.note));
	if (t.cancelling) parts.push("cancelling");
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
	if (p.state === "review") lines.push(`Reply to a message of this task for a follow-up, or send /approve ${p.id}.`);
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

function formatBytes(bytes: number): string {
	const gib = bytes / 1024 ** 3;
	if (gib >= 1) return `${gib.toFixed(1)} GiB`;
	return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MiB`;
}
