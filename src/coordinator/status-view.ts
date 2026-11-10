/** Shared SELECT-only status presentation. No network, migrations, writes, task actions or transcript reads. */
import { redact } from "../runtime/redact.ts";
import { readBranchHold } from "./branch-hold.ts";
import { DEMO_LIMITS, type Limits } from "./limits.ts";
import { queueInfo } from "./status-queue.ts";
import {
	readScopeIndex,
	type ScopeIndex,
	type StatusIdentity,
	scopeMatches,
	type TaskScope,
	taskScope,
} from "./status-scope.ts";
import type { Store } from "./store.ts";

export type StatusOptions = { readonly all?: boolean; readonly verbose?: boolean };
export type StatusContext = { readonly telegram?: boolean; readonly limits?: Limits; readonly scopeIndex?: ScopeIndex };
export type StatusTask = {
	id: number;
	chat_id: number;
	agent_id: string;
	text: string;
	state: string;
	pr_number: number | null;
	pr_url: string | null;
	head_commit: string | null;
	posted_head: string | null;
	tests_passed_head: string | null;
	cancel_requested: number;
	updated_at: number;
};
export type StatusSelection = {
	readonly tasks: readonly StatusTask[];
	readonly scopes: ReadonlyMap<number, TaskScope | undefined>;
	readonly hidden: number;
	readonly hiddenFailures: number;
	readonly unattributed: number;
	readonly problem: string | undefined;
};
const terminal = (task: StatusTask): boolean => ["merged", "failed", "cancelled"].includes(task.state);
const checked = (task: StatusTask): boolean => task.head_commit !== null && task.tests_passed_head === task.head_commit;
const completed = (task: StatusTask): boolean =>
	task.state === "merged" ||
	(task.state === "review" && checked(task) && task.posted_head === task.head_commit && task.cancel_requested !== 1);

export function selectStatusTasks(
	store: Store,
	group: number,
	identity: StatusIdentity | undefined,
	options: StatusOptions = {},
	context: StatusContext = {},
): StatusSelection {
	const index = context.scopeIndex ?? readScopeIndex(identity);
	const rows = store
		.all<StatusTask>(
			`SELECT id, chat_id, agent_id, text, state, pr_number, pr_url, head_commit, posted_head, tests_passed_head, cancel_requested, updated_at
		 FROM tasks ORDER BY updated_at DESC, id DESC`,
		)
		.filter((task) => !context.telegram || task.chat_id === group);
	const scopes = new Map(rows.map((task) => [task.id, taskScope(index, task)]));
	const tasks = rows.filter((task) => options.all || scopeMatches(scopes.get(task.id), group, identity));
	return {
		tasks,
		scopes,
		hidden: rows.length - tasks.length,
		hiddenFailures: rows.filter((task) => task.state === "failed" && !tasks.includes(task)).length,
		unattributed: rows.filter((task) => scopes.get(task.id) === undefined).length,
		problem: index.problem,
	};
}

function stripControls(text: string): string {
	return [...text]
		.map((c) => {
			const n = c.codePointAt(0) ?? 0;
			return n < 32 || (n >= 127 && n <= 159) ? " " : c;
		})
		.join("");
}

/** Redact before shortening: never expose a truncated credential, terminal escape or multiline request. */
export function taskSummary(text: string): string {
	const safe = stripControls(
		redact(text).replace(
			/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|cr_[A-Za-z0-9_-]{12,}|tskey-(?:auth|client)-[A-Za-z0-9_-]+)\b/g,
			"<redacted>",
		),
	)
		.replace(/\s+/g, " ")
		.trim();
	return safe.length > 108 ? `${safe.slice(0, 107)}…` : safe || "(no summary)";
}

function prLabel(store: Store, task: StatusTask): string {
	if (!task.pr_url) return "no PR";
	let state = "open (recorded)";
	if (task.state === "merged") state = "merged";
	else if (task.state === "cancelled" || readBranchHold(store, task.id)?.cause === "pr_closed")
		state = "closed (recorded)";
	const number = task.pr_number ?? task.pr_url.match(/\/pull\/(\d+)/)?.[1] ?? "?";
	return `PR #${number} ${state}`;
}

function stateParts(store: Store, task: StatusTask, limits: Limits): string[] {
	const parts = [task.state === "review" ? "in review" : task.state];
	const queue = terminal(task) ? {} : queueInfo(store, limits, task);
	if (queue.position) parts.push(`queue position ${queue.position}`);
	if (queue.note) parts.push(queue.note.charAt(0).toLowerCase() + queue.note.slice(1));
	if (task.cancel_requested === 1 && !terminal(task)) parts.push("cancelling");
	if (readBranchHold(store, task.id)) parts.push("waiting for its branch on GitHub to be restored");
	return parts;
}

function routingLabel(task: StatusTask, selected: StatusSelection, options: StatusOptions): string {
	if (!options.all) return "";
	const scope = selected.scopes.get(task.id);
	return scope ? ` [${scope.repository}, group ${scope.group}, topic ${scope.topic}]` : " [scope unconfirmed]";
}

function taskLine(
	store: Store,
	task: StatusTask,
	selected: StatusSelection,
	options: StatusOptions,
	limits: Limits,
): string {
	const parts = [`Task ${task.id}`, task.agent_id, ...stateParts(store, task, limits)];
	if (task.pr_url)
		parts.push(
			task.pr_url.match(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*/)?.[0] ??
				"invalid recorded PR URL",
		);
	parts.push(taskSummary(task.text), prLabel(store, task));
	if (task.state === "review" && task.cancel_requested !== 1 && !readBranchHold(store, task.id))
		parts.push(reviewLabel(task));
	if (options.verbose && task.head_commit) parts.push(`head ${task.head_commit}`);
	return parts.join(" · ") + routingLabel(task, selected, options);
}

function reviewLabel(task: StatusTask): string {
	if (!checked(task)) return "tests not passed at current head";
	return task.posted_head === task.head_commit ? "awaiting approval" : "awaiting a fresh review message";
}

function header(
	store: Store,
	group: number,
	identity: StatusIdentity | undefined,
	tasks: readonly StatusTask[],
	limits: Limits,
): string {
	const count = (state: string) => tasks.filter((task) => task.state === state).length;
	const slots = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM slots")?.n ?? 0;
	const runtime = { running: "live", starting: "starting", offline: "not running (read-only snapshot)" };
	const live = runtime[identity?.runtime ?? "running"];
	return (
		`Coordinator: ${live} · ${identity?.repository ?? "repo unconfigured"} · group ${group}, topic ${identity?.topicId ?? "?"}` +
		` · slots ${slots}/${limits.maxConcurrentRuns} · succeeded ${count("merged")} / failed ${count("failed")} / open ${tasks.filter((task) => !terminal(task)).length}`
	);
}

function scopeNotes(selected: StatusSelection, options: StatusOptions): string[] {
	const lines: string[] = [];
	if (!options.all && selected.hidden)
		lines.push(`Hidden outside this scope or unconfirmed: ${selected.hidden}; use --all.`);
	if (selected.problem) lines.push(`Scope: ${selected.problem}.`);
	if (options.all && selected.unattributed)
		lines.push(`Unconfirmed routing: ${selected.unattributed} tasks; no historical topic was inferred.`);
	return lines;
}

/** Counts use the complete selected set; failures remain a count even under --all/--verbose. */
export function statusView(
	store: Store,
	group: number,
	identity: StatusIdentity | undefined,
	options: StatusOptions = {},
	context: StatusContext = {},
): string[] {
	const selected = selectStatusTasks(store, group, identity, options, context);
	const limits = context.limits ?? DEMO_LIMITS;
	const render = (task: StatusTask) => taskLine(store, task, selected, options, limits);
	const lines = [header(store, group, identity, selected.tasks, limits)];
	if (options.all) lines.push(`View: all recorded tasks in this ${context.telegram ? "group" : "database"}.`);
	const done = selected.tasks.filter(completed);
	lines.push("Completed:", ...(done.length ? done.map(render) : ["  None."]));
	const pending = selected.tasks.filter((task) => !terminal(task) && !completed(task));
	if (pending.length) lines.push("Open:", ...pending.map(render));
	const cancelled = selected.tasks.filter((task) => task.state === "cancelled");
	if (cancelled.length) lines.push(`Cancelled (${cancelled.length}):`, ...cancelled.map(render));
	const outside = selected.hiddenFailures ? `; ${selected.hiddenFailures} outside this scope/unconfirmed` : "";
	lines.push(
		`Older failures: ${selected.tasks.filter((task) => task.state === "failed").length}${outside} (aggregated; records retained).`,
	);
	lines.push(...scopeNotes(selected, options));
	return lines;
}

type ParsedStatus = { all?: boolean; verbose?: boolean; task?: number };
function statusArgument(result: ParsedStatus, arg: string): boolean {
	if (arg === "--all" && result.all === undefined) {
		result.all = true;
		return true;
	}
	if (arg === "--verbose" && result.verbose === undefined) {
		result.verbose = true;
		return true;
	}
	if (/^#?[1-9]\d{0,15}$/.test(arg) && result.task === undefined) {
		result.task = Number(arg.replace(/^#/, ""));
		return Number.isSafeInteger(result.task);
	}
	return false;
}

/** Display switches only; an optional numeric task id keeps /status <id> working. */
export function parseStatusOptions(args: string): ParsedStatus | undefined {
	const result: ParsedStatus = {};
	return args
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.every((arg) => statusArgument(result, arg))
		? result
		: undefined;
}
