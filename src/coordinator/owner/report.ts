/**
 * What the owner CLI shows (Interfaces and Storage § Interfaces, Owner CLI: status, failed events, quarantined
 * conversations; Deployment § Measurements: freezes, watchdog health). Built from the Coordinator's SQLite store by the
 * running Coordinator (owner socket), or, labelled as such, by the CLI from a read-only connection while the
 * Coordinator is not running. Status includes redacted one-line task summaries; never follow-ups or conversations.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { redact } from "../../runtime/redact.ts";
import { type SweepRow, WATCHDOG_PID_KEY } from "../../watchdog/protocol.ts";
import { type BranchHold, readBranchHold } from "../branch-hold.ts";
import { activeEvaluation, type EvaluationRow, evaluationLines, lastEvaluation, trialTasks } from "../evaluation.ts";
import { DEMO_LIMITS } from "../limits.ts";
import { formatBytes } from "../messages.ts";
import { readScopeIndex, type StatusIdentity } from "../status-scope.ts";
import { type StatusContext, type StatusOptions, selectStatusTasks, statusView } from "../status-view.ts";
import type { Store } from "../store.ts";
import { createStoreWatchdogLink, WATCHDOG_HEARTBEAT_MAX_AGE_MS } from "../watchdog-link.ts";

type SlotRow = { kind: string; task_id: number; run_id: number | null; agent_id: string | null; acquired_at: number };
type Count = { n: number };

/**
 * Same scoped task view as Telegram. Operational alerts remain visible; --verbose adds full diagnostics/storage.
 */
export type { StatusIdentity } from "../status-scope.ts";

export function ownerStatus(
	store: Store,
	chatId: number,
	disk: readonly string[] = [],
	identity?: StatusIdentity,
	options: StatusOptions = {},
	context: StatusContext = {},
): string {
	const view = { ...context, scopeIndex: context.scopeIndex ?? readScopeIndex(identity) };
	const selected = selectStatusTasks(store, chatId, identity, options, view);
	const ids = new Set(selected.tasks.map((task) => task.id));
	const lines = statusView(store, chatId, identity, options, view);
	if (identity && !context.telegram) lines.push(`Database: ${resolve(identity.databasePath)}`);
	lines.push(groupLine(store, chatId));
	lines.push(
		...(options.verbose ? [...slotLines(store, ids), ...watchdogLines(store)] : watchdogLines(store).slice(0, 1)),
	);
	const queued = store.get<Count>("SELECT COUNT(*) AS n FROM runs WHERE state = 'queued'")?.n ?? 0;
	if (options.verbose) lines.push(`Queued runs: ${queued}`);
	lines.push(...heldLines(store, chatId, ids), ...effectLines(store, chatId, ids), ...housekeepingLines(store));
	if (options.verbose)
		lines.push(...scopedEvaluationLines(store, chatId, ids, options.all === true && !context.telegram));
	lines.push(...disk);
	return lines.join("\n");
}

export type OpenIntentRow = {
	id: number;
	task_id: number;
	run_id: number;
	tool: string;
	path: string | null;
	operation: string | null;
	state: string;
	worktree_path: string | null;
};

/** The group's intents (pending or unresolved) of the effect ledger, by task and run. */
export function openIntents(store: Store, chatId: number, states: readonly string[]): OpenIntentRow[] {
	return store.all<OpenIntentRow>(
		`SELECT i.id, i.task_id, i.run_id, i.tool, i.path, i.operation, i.state, t.worktree_path
		 FROM effect_intents i JOIN tasks t ON t.id = i.task_id
		 WHERE t.chat_id = ? AND i.state IN (${states.map(() => "?").join(", ")}) ORDER BY i.id`,
		chatId,
		...states,
	);
}

/** One file change of the effect ledger: its task and run, the file (never its content), its number for resolve. */
export function intentLine(row: OpenIntentRow): string {
	const target = row.tool === "run_check" ? `run_check ${row.operation ?? "?"}` : `${row.tool} ${row.path ?? "?"}`;
	const where = row.worktree_path === null ? "" : ` in ${row.worktree_path}`;
	return `  #${row.task_id} run ${row.run_id}: ${target}${where} (${row.state}; change ${row.id})`;
}

/**
 * File changes whose outcome could not be reconciled (Agent Execution § Uncertain Effects: the group froze) and ones
 * still waiting for reconciliation (at the next start or unfreeze). Shown only if any. Names files, never content.
 */
function effectLines(store: Store, chatId: number, ids: ReadonlySet<number>): string[] {
	const rows = openIntents(store, chatId, ["unresolved", "pending"]).filter((row) => ids.has(row.task_id));
	if (rows.length === 0) return [];
	return [
		"Uncertain file changes (unresolved: review the file, then owner resolve <change> and owner unfreeze; pending: " +
			"reconciled at the next start or unfreeze):",
		...rows.map(intentLine),
	];
}

/**
 * Tasks held because their branch changed on GitHub outside the Coordinator (src/coordinator/branch-hold.ts): which
 * commit waits in the worktree and where GitHub's branch must be for the Coordinator to push it. Shown only if any.
 */
function heldLines(store: Store, chatId: number, selected: ReadonlySet<number>): string[] {
	const ids = store.all<{ id: number }>(
		`SELECT id FROM tasks WHERE chat_id = ? AND EXISTS (SELECT 1 FROM meta WHERE key = 'branch_hold:' || tasks.id)
		 ORDER BY id`,
		chatId,
	);
	const lines: string[] = [];
	for (const { id } of ids) {
		if (!selected.has(id)) continue;
		const hold = readBranchHold(store, id);
		if (hold === undefined) continue;
		lines.push(heldLine(id, hold));
	}
	if (lines.length === 0) return [];
	return ["Held tasks (their branch changed on GitHub outside the Coordinator):", ...lines];
}

function heldLine(id: number, hold: BranchHold): string {
	if (hold.cause === "branch_deleted" || hold.cause === "pr_closed")
		return (
			`  #${id} review: ${hold.branch} ${hold.github === null ? "deleted" : `at ${hold.github.slice(0, 7)}`}; ` +
			`${hold.local.slice(0, 7)} retained; restore branch and reopen original PR${hold.prNumber === undefined ? "" : ` #${hold.prNumber}`}; no replacement PR`
		);
	const target = hold.pushed === null ? "deleted" : `back at ${hold.pushed.slice(0, 7)}`;
	return (
		`  #${id} ${hold.kind}: ${hold.branch} on GitHub at ${hold.github?.slice(0, 7) ?? "missing"}; ${hold.local.slice(0, 7)} waits ` +
		`in the worktree until the branch is ${target}`
	);
}

function groupLine(store: Store, chatId: number): string {
	const group = store.groupState(chatId);
	const reason = group.reason === null ? "" : ` (reason: ${clean(group.reason)})`;
	const recheck = group.recheck ? "; recovery recheck pending before dispatch" : "";
	const resolve = group.state === "frozen" ? "; owner unfreeze repeats the recovery checks, then reopens dispatch" : "";
	return `Group ${chatId}: ${group.state}${reason}${recheck}${resolve}`;
}

function slotLines(store: Store, selected: ReadonlySet<number>): string[] {
	const slots = store.all<SlotRow>("SELECT kind, task_id, run_id, agent_id, acquired_at FROM slots ORDER BY id");
	return [
		`Execution slots: ${slots.length}/${DEMO_LIMITS.maxConcurrentRuns} in use`,
		...slots
			.filter((slot) => selected.has(slot.task_id))
			.map((slot) => {
				const run = slot.run_id === null ? "" : ` run ${slot.run_id}`;
				const agent = slot.agent_id === null ? "" : ` agent ${slot.agent_id}`;
				return `  ${slot.kind} task ${slot.task_id}${run}${agent} since ${new Date(slot.acquired_at).toISOString()}`;
			}),
	];
}

/** A cross-scope evaluation can hold dispatch, but its task identities require --all (Telegram never crosses chats). */
function scopedEvaluationLines(store: Store, chatId: number, ids: ReadonlySet<number>, all: boolean): string[] {
	const lines = evaluationLines(store, chatId);
	if (all) return lines;
	const visible = (row: EvaluationRow) => row.chat_id === chatId && trialTasks(row).every((id) => ids.has(id));
	const active = activeEvaluation(store);
	const last = lastEvaluation(store, chatId);
	if (active && !visible(active))
		lines[0] = "Evaluation outside this status scope is holding dispatch; use --all for permitted details.";
	if (last && !visible(last))
		lines[lines.length - 1] = "Last evaluation is outside this status scope; use --all for permitted details.";
	return lines;
}

/** The watchdog's heartbeat age and pid, its last sweep, and how many requests wait for it. */
export function watchdogLines(store: Store): string[] {
	const age = createStoreWatchdogLink(store).heartbeatAgeMs();
	const pid = store.getMeta(WATCHDOG_PID_KEY);
	const heartbeat =
		age === undefined
			? "Watchdog: no heartbeat yet (is it running? no run is dispatched without it)"
			: `Watchdog: last heartbeat ${Math.round(age / 1000)} s ago${pid === undefined ? "" : ` (pid ${pid})`}${
					age > WATCHDOG_HEARTBEAT_MAX_AGE_MS ? "; stale: no new run starts until it is back" : ""
				}`;
	const last = store.get<SweepRow>("SELECT * FROM watchdog_sweeps WHERE state = 'done' ORDER BY id DESC LIMIT 1");
	const pending = store.get<Count>("SELECT COUNT(*) AS n FROM watchdog_sweeps WHERE state = 'pending'")?.n ?? 0;
	return [
		heartbeat,
		last === undefined ? "Last watchdog sweep: none" : sweepLine(last),
		`Pending sweep requests: ${pending}`,
	];
}

function sweepLine(row: SweepRow): string {
	const scope = row.run_id === null ? "" : ` run ${row.run_id} (task ${row.task_id}, generation ${row.generation})`;
	const outcome = row.verified === 1 ? "verified" : `NOT verified (${row.detail ?? "unknown"})`;
	const at = row.finished_at === null ? "" : ` at ${new Date(row.finished_at).toISOString()}`;
	return (
		`Last watchdog sweep: #${row.id} ${row.reason}${scope}: ${outcome}; killed ${row.processes_killed ?? 0} ` +
		`Pi processes and ${row.containers_killed ?? 0} containers${at}`
	);
}

function housekeepingLines(store: Store): string[] {
	const count = (sql: string) => store.get<Count>(sql)?.n ?? 0;
	const pending = count("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'");
	const failed = count("SELECT COUNT(*) AS n FROM failed_events");
	const merges = count("SELECT COUNT(*) AS n FROM merge_intents WHERE state = 'pending'");
	const quarantined = count("SELECT COUNT(*) AS n FROM conversations WHERE quarantined = 1");
	const uncertain = count("SELECT COUNT(*) AS n FROM outbox_delivery_attempts WHERE state = 'uncertain'");
	return [
		`Outbox: ${pending} pending; failed events: ${failed}${failed > 0 ? " (owner failed-events)" : ""}`,
		`Unconfirmed delivery attempts: ${uncertain}${uncertain > 0 ? " (a retry can duplicate; compare Telegram receipts)" : ""}`,
		`Pending merge intents: ${merges}`,
		`Quarantined conversations: ${quarantined}${quarantined > 0 ? " (read-only: owner conversations, owner inspect <id>)" : ""}`,
	];
}

type FailedEventRow = {
	id: number;
	outbox_id: number | null;
	kind: string;
	reason: string;
	created_at: number;
	task_id: number | null;
	outbox_kind: string | null;
};

const FAILED_EVENTS_SHOWN = 50;

/** Permanently failed outbox deliveries (Interfaces § Outbox to Telegram), newest first; never the message text. */
export function ownerFailedEvents(store: Store): string {
	const rows = store.all<FailedEventRow>(
		`SELECT f.id, f.outbox_id, f.kind, f.reason, f.created_at, o.task_id, o.kind AS outbox_kind
		 FROM failed_events f LEFT JOIN outbox o ON o.id = f.outbox_id ORDER BY f.id DESC LIMIT ?`,
		FAILED_EVENTS_SHOWN,
	);
	if (rows.length === 0) return "No failed events.";
	const total = store.get<Count>("SELECT COUNT(*) AS n FROM failed_events")?.n ?? rows.length;
	const header = `Failed events: ${total}${total > rows.length ? ` (newest ${rows.length} shown)` : ""}`;
	return [
		header,
		...rows.map((row) => {
			const parts = [`#${row.id}`, new Date(row.created_at).toISOString(), `kind=${row.kind}`];
			if (row.outbox_id !== null) parts.push(`outbox=${row.outbox_id}`);
			if (row.outbox_kind !== null) parts.push(`message=${row.outbox_kind}`);
			if (row.task_id !== null) parts.push(`task=${row.task_id}`);
			parts.push(`reason=${JSON.stringify(clean(row.reason))}`);
			return `  ${parts.join(" ")}`;
		}),
	].join("\n");
}

export type ConversationRow = {
	id: string;
	task_id: number;
	parent_id: string | null;
	path: string;
	quarantined: number;
	created_at: number;
	chat_id: number;
};

/** A conversation of the group, or undefined. */
export function groupConversation(store: Store, chatId: number, id: string): ConversationRow | undefined {
	return store.get<ConversationRow>(
		`SELECT c.id, c.task_id, c.parent_id, c.path, c.quarantined, c.created_at, t.chat_id
		 FROM conversations c JOIN tasks t ON t.id = c.task_id WHERE c.id = ? AND t.chat_id = ?`,
		id,
		chatId,
	);
}

function fileSize(path: string): string {
	try {
		return formatBytes(statSync(path).size);
	} catch {
		return "file missing";
	}
}

/** The runs that used a conversation (a run's conversation never changes). */
function runsOf(store: Store, conversationId: string): string {
	const runs = store.all<{ id: number; state: string; reason: string | null }>(
		"SELECT id, state, reason FROM runs WHERE conversation_id = ? ORDER BY id",
		conversationId,
	);
	if (runs.length === 0) return "no run";
	return runs
		.map((run) => `run ${run.id} ${run.state}${run.reason === null ? "" : ` (${clean(run.reason)})`}`)
		.join(", ");
}

/** Quarantined conversations of the group (of one task if given): ids for `owner inspect`, metadata only. */
export function ownerConversations(store: Store, chatId: number, taskId?: number): string {
	const rows = store.all<ConversationRow>(
		`SELECT c.id, c.task_id, c.parent_id, c.path, c.quarantined, c.created_at, t.chat_id
		 FROM conversations c JOIN tasks t ON t.id = c.task_id
		 WHERE t.chat_id = ? AND c.quarantined = 1 AND (? IS NULL OR c.task_id = ?) ORDER BY c.created_at, c.id`,
		chatId,
		taskId ?? null,
		taskId ?? null,
	);
	const scope = taskId === undefined ? "" : ` of Task ${taskId}`;
	if (rows.length === 0) return `No quarantined conversations${scope}.`;
	return [
		`Quarantined conversations${scope}: ${rows.length} (never written again; owner inspect <id> opens one read-only)`,
		...rows.map(
			(row) =>
				`  ${row.id} Task ${row.task_id}: ${runsOf(store, row.id)}; created ${new Date(row.created_at).toISOString()}; ` +
				`${fileSize(row.path)}${row.parent_id === null ? "" : `; parent ${row.parent_id}`}`,
		),
	].join("\n");
}

/** Free text from the database, shown on one line, redacted, bounded. */
export function clean(text: string): string {
	return redact(text.replace(/\s+/g, " ").trim()).slice(0, 200);
}
