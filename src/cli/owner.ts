import { existsSync } from "node:fs";
import { join } from "node:path";
import { readBranchHold } from "../coordinator/branch-hold.ts";
import type { CoordinatorConfig } from "../coordinator/config.ts";
import { DEMO_LIMITS } from "../coordinator/limits.ts";
import { Store } from "../coordinator/store.ts";
import { createStoreWatchdogLink, WATCHDOG_HEARTBEAT_MAX_AGE_MS } from "../coordinator/watchdog-link.ts";
import { errorSummary } from "../runtime/log.ts";
import { redact } from "../runtime/redact.ts";
import { type SweepRow, WATCHDOG_PID_KEY } from "../watchdog/protocol.ts";
import type { OwnerAction } from "./args.ts";
import { diskReport } from "./disk-report.ts";
import { readConfig } from "./run.ts";

// STUB(spec: interfaces-and-storage § Owner CLI): local socket; inspection of quarantined conversations.
// The owner CLI opens the Coordinator's SQLite file directly (WAL lets it run next to a live Coordinator, every write
// is one BEGIN IMMEDIATE transaction) instead of talking to the Coordinator over a local socket. Quarantined
// conversations are only counted, not opened.

export const COORDINATOR_DB = "coordinator.sqlite";

export type OwnerOptions = {
	readonly envFile?: string | undefined;
	readonly env?: NodeJS.ProcessEnv;
	readonly stdout?: (text: string) => void;
	readonly stderr?: (text: string) => void;
};

/** `owner status|unfreeze|failed-events`: exit 0 done, 1 failed or refused, 2 configuration error. */
export function runOwnerCommand(action: OwnerAction, options: OwnerOptions = {}): number {
	const stdout = options.stdout ?? ((text: string) => void process.stdout.write(text));
	const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text));
	const config = readConfig(options.envFile, options.env, stderr);
	if (config === undefined) return 2;
	const path = join(config.paths.dataDir, COORDINATOR_DB);
	if (!existsSync(path)) {
		stderr(`No Coordinator database at ${path}. Start the Coordinator once (pi-durable-telegram run) first.\n`);
		return 1;
	}
	let store: Store | undefined;
	try {
		store = new Store(path);
		const result = OWNER_COMMANDS[action](store, config);
		stdout(`${result.text}\n`);
		return result.ok ? 0 : 1;
	} catch (error) {
		stderr(`owner ${action} failed: ${errorSummary(error)}\n`);
		return 1;
	} finally {
		store?.close();
	}
}

export type OwnerResult = { readonly ok: boolean; readonly text: string };

const OWNER_COMMANDS: Record<OwnerAction, (store: Store, config: CoordinatorConfig) => OwnerResult> = {
	status: (store, config) => ({
		ok: true,
		text: ownerStatus(store, config.telegram.groupChatId, diskReport(store, config)),
	}),
	unfreeze: (store, config) => ownerUnfreeze(store, config.telegram.groupChatId),
	"failed-events": (store) => ({ ok: true, text: ownerFailedEvents(store) }),
};

type TaskRow = {
	id: number;
	agent_id: string;
	state: string;
	reason: string | null;
	pr_number: number | null;
	pr_url: string | null;
	cancel_requested: number;
};
type SlotRow = { kind: string; task_id: number; run_id: number | null; agent_id: string | null; acquired_at: number };
type Count = { n: number };

const TERMINAL = "('merged','failed','cancelled')";
const RECENT_TERMINAL = 10;

/**
 * Group state, execution slots, open tasks and the most recent finished ones, then `disk` (the CLI passes
 * diskReport(): free space and usage of both disks). Metadata only: no task text.
 */
export function ownerStatus(store: Store, chatId: number, disk: readonly string[] = []): string {
	const lines = [groupLine(store, chatId), ...slotLines(store), ...watchdogLines(store)];
	const queued = store.get<Count>("SELECT COUNT(*) AS n FROM runs WHERE state = 'queued'")?.n ?? 0;
	lines.push(`Queued runs: ${queued}`);
	const open = store.all<TaskRow>(
		`SELECT id, agent_id, state, reason, pr_number, pr_url, cancel_requested FROM tasks
		 WHERE chat_id = ? AND state NOT IN ${TERMINAL} ORDER BY id`,
		chatId,
	);
	lines.push(`Open tasks: ${open.length === 0 ? "none" : ""}`.trimEnd(), ...open.map(taskLine));
	const recent = store.all<TaskRow>(
		`SELECT id, agent_id, state, reason, pr_number, pr_url, cancel_requested FROM tasks
		 WHERE chat_id = ? AND state IN ${TERMINAL} ORDER BY id DESC LIMIT ?`,
		chatId,
		RECENT_TERMINAL,
	);
	if (recent.length > 0) lines.push(`Recent finished tasks (last ${RECENT_TERMINAL}):`, ...recent.map(taskLine));
	lines.push(...heldLines(store, chatId), ...effectLines(store, chatId), ...housekeepingLines(store), ...disk);
	return lines.join("\n");
}

type OpenIntentRow = {
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
function openIntents(store: Store, chatId: number, states: readonly string[]): OpenIntentRow[] {
	return store.all<OpenIntentRow>(
		`SELECT i.id, i.task_id, i.run_id, i.tool, i.path, i.operation, i.state, t.worktree_path
		 FROM effect_intents i JOIN tasks t ON t.id = i.task_id
		 WHERE t.chat_id = ? AND i.state IN (${states.map(() => "?").join(", ")}) ORDER BY i.id`,
		chatId,
		...states,
	);
}

function intentLine(row: OpenIntentRow): string {
	const target = row.tool === "run_check" ? `run_check ${row.operation ?? "?"}` : `${row.tool} ${row.path ?? "?"}`;
	const where = row.worktree_path === null ? "" : ` in ${row.worktree_path}`;
	return `  #${row.task_id} run ${row.run_id}: ${target}${where} (${row.state})`;
}

/**
 * File changes whose outcome could not be reconciled (Agent Execution § Uncertain Effects: the group froze) and ones
 * still waiting for reconciliation (it runs at the next start or recheck). Shown only if any. Names files, never content.
 */
function effectLines(store: Store, chatId: number): string[] {
	const rows = openIntents(store, chatId, ["unresolved", "pending"]);
	if (rows.length === 0) return [];
	return [
		"Uncertain file changes (unresolved: review the file, then unfreeze; pending: reconciled at the next start or recheck):",
		...rows.map(intentLine),
	];
}

/**
 * Tasks held because their branch changed on GitHub outside the Coordinator (src/coordinator/branch-hold.ts): which
 * commit waits in the worktree and where GitHub's branch must be for the Coordinator to push it. Shown only if any.
 */
function heldLines(store: Store, chatId: number): string[] {
	const ids = store.all<{ id: number }>(
		`SELECT id FROM tasks WHERE chat_id = ? AND EXISTS (SELECT 1 FROM meta WHERE key = 'branch_hold:' || tasks.id)
		 ORDER BY id`,
		chatId,
	);
	const lines: string[] = [];
	for (const { id } of ids) {
		const hold = readBranchHold(store, id);
		if (hold === undefined) continue;
		const target = hold.pushed === null ? "deleted" : `back at ${hold.pushed.slice(0, 7)}`;
		lines.push(
			`  #${id} ${hold.kind}: ${hold.branch} on GitHub at ${hold.github.slice(0, 7)}; ${hold.local.slice(0, 7)} waits ` +
				`in the worktree until the branch is ${target}`,
		);
	}
	if (lines.length === 0) return [];
	return ["Held tasks (their branch changed on GitHub outside the Coordinator):", ...lines];
}

function groupLine(store: Store, chatId: number): string {
	const group = store.groupState(chatId);
	const reason = group.reason === null ? "" : ` (reason: ${clean(group.reason)})`;
	const recheck = group.recheck ? "; recovery recheck pending before dispatch" : "";
	return `Group ${chatId}: ${group.state}${reason}${recheck}`;
}

function slotLines(store: Store): string[] {
	const slots = store.all<SlotRow>("SELECT kind, task_id, run_id, agent_id, acquired_at FROM slots ORDER BY id");
	return [
		`Execution slots: ${slots.length}/${DEMO_LIMITS.maxConcurrentRuns} in use`,
		...slots.map((slot) => {
			const run = slot.run_id === null ? "" : ` run ${slot.run_id}`;
			const agent = slot.agent_id === null ? "" : ` agent ${slot.agent_id}`;
			return `  ${slot.kind} task ${slot.task_id}${run}${agent} since ${new Date(slot.acquired_at).toISOString()}`;
		}),
	];
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

function taskLine(task: TaskRow): string {
	const pr =
		task.pr_number === null ? "no PR" : `PR #${task.pr_number}${task.pr_url === null ? "" : ` ${task.pr_url}`}`;
	const cancel = task.cancel_requested === 1 ? " (cancel requested)" : "";
	const reason = task.reason === null ? "" : ` (${clean(task.reason)})`;
	return `  #${task.id} ${task.agent_id} ${task.state}${cancel}${reason} ${pr}`;
}

function housekeepingLines(store: Store): string[] {
	const count = (sql: string) => store.get<Count>(sql)?.n ?? 0;
	const pending = count("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'");
	const failed = count("SELECT COUNT(*) AS n FROM failed_events");
	const merges = count("SELECT COUNT(*) AS n FROM merge_intents WHERE state = 'pending'");
	const quarantined = count("SELECT COUNT(*) AS n FROM conversations WHERE quarantined = 1");
	return [
		`Outbox: ${pending} pending; failed events: ${failed}${failed > 0 ? " (owner failed-events)" : ""}`,
		`Pending merge intents: ${merges}`,
		`Quarantined conversations: ${quarantined} (read-only; inspection is not implemented yet)`,
	];
}

/**
 * Unfreeze the configured group (Architecture § Frozen group): state normal, reason cleared, recheck_required=1 so the
 * Coordinator repeats recovery steps 1-4 before it dispatches again. Only a frozen group changes; sealing is not
 * resolved here.
 */
export function ownerUnfreeze(store: Store, chatId: number): OwnerResult {
	return store.tx(() => {
		const group = store.groupState(chatId);
		if (group.state === "normal") return { ok: true, text: `Group ${chatId} is not frozen; nothing changed.` };
		if (group.state !== "frozen")
			return { ok: false, text: `Group ${chatId} is ${group.state}, not frozen; unfreeze does not change it.` };
		store.run(
			`UPDATE groups SET state = 'normal', reason = NULL, recheck_required = 1, updated_at = ?
			 WHERE chat_id = ? AND state = 'frozen'`,
			store.now(),
			chatId,
		);
		const resolved = resolveIntents(store, chatId);
		const reason = group.reason === null ? "" : ` (it was frozen: ${clean(group.reason)})`;
		return {
			ok: true,
			text: [
				`Group ${chatId} unfrozen${reason}.`,
				"Set state=normal and recheck_required=1: the Coordinator repeats recovery steps 1-4 (close run keys,",
				"the watchdog's sweep of leftover Pi processes and containers, reconcile GitHub and file effects, restore",
				"the relay) before it dispatches queued work again (not before the watchdog answers). Tasks cancelled by the",
				"freeze stay cancelled; nothing resumes on its own.",
				...resolved,
			].join("\n"),
		};
	});
}

/** What the owner's unfreeze records for an unresolved file change (effect_intents.resolution). */
export const OWNER_RESOLUTION = "owner unfreeze: accepted as found in the worktree";

/**
 * Owner review resolves the group's unresolved file changes (Interfaces and Storage § Recovery: "Owner review
 * resolves and unfreezes the group"): each is recorded as resolved, the file accepted as it is in the worktree, so the
 * recheck lets its task's worktree be used again (a reply's fresh run, /cancel's final checkpoint). Inside the tx.
 */
function resolveIntents(store: Store, chatId: number): string[] {
	const rows = openIntents(store, chatId, ["unresolved"]);
	if (rows.length === 0) return [];
	const now = store.now();
	for (const row of rows) {
		store.run(
			"UPDATE effect_intents SET state = 'resolved', resolution = ?, settled_at = ? WHERE id = ? AND state = 'unresolved'",
			OWNER_RESOLUTION,
			now,
			row.id,
		);
	}
	return [
		`Recorded your resolution of ${rows.length} uncertain file change${rows.length === 1 ? "" : "s"} (accepted as found`,
		"in the worktree; a reply's fresh run or /cancel's final checkpoint uses the file as it is now):",
		...rows.map(intentLine),
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

/** Free text from the database, shown on one line, redacted, bounded. */
function clean(text: string): string {
	return redact(text.replace(/\s+/g, " ").trim()).slice(0, 200);
}
