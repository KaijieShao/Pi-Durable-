import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { splitTelegramText } from "./telegram/split.ts";

/**
 * The Coordinator's one SQLite file (Interfaces and Storage § Where Each Record Lives, § Storage Choices):
 * WAL, synchronous=FULL, every write in `BEGIN IMMEDIATE`. A transaction is synchronous by construction
 * (`tx(fn)` takes a synchronous callback), so it can never be held open across a network wait.
 *
 * Raw task and follow-up text is stored here because the Coordinator must replay it into fresh conversations;
 * it is never written to logs (Deployment § Logs: metadata only).
 */

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Group-level holds (Architecture § States). Only the owner CLI moves a frozen group back to normal.
CREATE TABLE IF NOT EXISTS groups (
  chat_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'normal' CHECK (state IN ('normal','sealing','frozen')),
  reason TEXT,
  recheck_required INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Every Telegram update the poller saved, keyed by its unique update id (dedup across redelivery).
CREATE TABLE IF NOT EXISTS commands (
  update_id INTEGER PRIMARY KEY,
  chat_id INTEGER,
  user_id INTEGER,
  message_id INTEGER,
  kind TEXT NOT NULL,          -- task | followup | status | cancel | approve | help | ignored
  task_id INTEGER,
  outcome TEXT NOT NULL,       -- accepted | rejected | answered | ignored
  reason TEXT,
  received_at INTEGER NOT NULL
);

-- One row per /task request: exactly one branch, one worktree and one pull request over its life.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  text TEXT NOT NULL,
  update_id INTEGER NOT NULL UNIQUE,          -- the /task update; the first run's Pi requestId
  state TEXT NOT NULL CHECK (state IN ('queued','running','review','merging','merged','failed','cancelled')),
  reason TEXT,                                 -- why the task is failed/cancelled, or what review waits for
  generation INTEGER NOT NULL DEFAULT 0,       -- bumped at every run dispatch; labels containers and run keys
  branch TEXT,
  worktree_path TEXT,                          -- NULL until created; NULL again once archived
  archived INTEGER NOT NULL DEFAULT 0,
  base_commit TEXT,                            -- main commit the worktree was created from
  head_commit TEXT,                            -- latest checkpoint commit pushed to GitHub
  posted_head TEXT,                            -- head commit last posted in Telegram (/approve binds to it)
  tests_passed_head TEXT,                      -- head commit whose approved tests passed
  pr_number INTEGER,
  pr_url TEXT,
  followup_count INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  cancel_requested_by INTEGER,
  review_since INTEGER,
  review_reminded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Pi conversations: one Pi SQLite file per conversation. A run's conversation never changes; a fresh
-- conversation after an interrupted run records the earlier one as its parent. Quarantined ones are read-only.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  parent_id TEXT,
  path TEXT NOT NULL,
  quarantined INTEGER NOT NULL DEFAULT 0,
  reusable INTEGER NOT NULL DEFAULT 0,          -- 1 once a run on it finished cleanly and quiescence was confirmed
  created_at INTEGER NOT NULL
);

-- Each run of a task. The queue is the set of runs in state 'queued', FIFO by id.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('initial','followup','conflict')),
  state TEXT NOT NULL CHECK (state IN ('queued','starting','running','finalizing','finished','failed','cancelled')),
  reason TEXT,                                  -- failure / cancel reason shown to the user
  requested_by INTEGER NOT NULL,                -- user the run counts against for the per-user waiting cap
  request_id TEXT NOT NULL,                     -- Pi requestId of the run's input (Telegram update id)
  input_text TEXT NOT NULL,                     -- the run's input as submitted to Pi
  followup_id INTEGER,                          -- follow-up that started this run, if any
  conversation_id TEXT,                         -- set at dispatch; never changes
  generation INTEGER,
  model_requests INTEGER NOT NULL DEFAULT 0,    -- counted by the relay, retries included, shared with the successor
  pid INTEGER,                                  -- Pi process
  container TEXT,                               -- agent container name
  answer TEXT,                                  -- the agent's final answer (truncated), the agent's claim only
  checkpoint_commit TEXT,
  review_done INTEGER NOT NULL DEFAULT 0,       -- post-run tests, checkpoint, push and PR completed
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_state ON runs(state);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);

-- Execution slots (Capacity § Concurrent execution: 2 deployment-wide, 1 per agent). Reserved atomically before
-- every dispatch, follow-up run, post-run check and merge test; released only after verified cleanup.
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('run','check')),
  task_id INTEGER NOT NULL,
  run_id INTEGER,
  agent_id TEXT,                                -- set for kind 'run': the agent is busy while it is held
  acquired_at INTEGER NOT NULL
);

-- Follow-ups: replies to a task's bot message. Each ends with exactly one user-visible outcome.
CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  update_id INTEGER NOT NULL UNIQUE,            -- Pi requestId
  user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('steer','run')),
  run_id INTEGER,                               -- run it steers into, or the run it started
  state TEXT NOT NULL CHECK (state IN ('pending','submitted','delivered','started','expired')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);

-- Run keys: only an open key may call the model through the relay. The key itself is never stored.
CREATE TABLE IF NOT EXISTS run_keys (
  key_hash TEXT PRIMARY KEY,
  run_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','closed')),
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);

-- Budget ledger: input allowance + max output reserved before each request; reconciled from reported usage;
-- unknown usage keeps its reservation.
CREATE TABLE IF NOT EXISTS budget (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  reserved INTEGER NOT NULL,
  actual INTEGER,
  state TEXT NOT NULL CHECK (state IN ('reserved','reconciled','unknown')),
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);

-- /approve, bound to the head commit the bot last posted.
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  user_id INTEGER NOT NULL,
  update_id INTEGER NOT NULL UNIQUE,
  head_commit TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('valid','consumed','invalidated')),
  reason TEXT,
  created_at INTEGER NOT NULL
);

-- Merge intents, saved before any merge step, so recovery can check GitHub before trying again.
CREATE TABLE IF NOT EXISTS merge_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  approval_id INTEGER NOT NULL,
  head_commit TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','merged','returned','failed')),
  merge_commit TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);

-- Durable outbox (Interfaces § Outbox to Telegram). priority 0 = required, 1 = progress (latest per task only).
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  task_id INTEGER,
  priority INTEGER NOT NULL CHECK (priority IN (0,1)),
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_to INTEGER,
  state TEXT NOT NULL CHECK (state IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  telegram_message_id INTEGER,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state, priority, id);

CREATE TABLE IF NOT EXISTS failed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Bot messages that belong to a task: a reply to any of them is a follow-up to that task.
CREATE TABLE IF NOT EXISTS task_messages (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
`;

export type Row = Record<string, SQLInputValue>;

/** Outbox kinds that are required (sent before progress). Everything else passed with priority 1 is progress. */
export type OutboxMessage = {
	readonly chatId: number;
	readonly taskId?: number | undefined;
	/** "required": acknowledgements, rejections, cancellations, run outcomes, follow-up outcomes, status replies. */
	readonly priority: "required" | "progress";
	readonly kind: string;
	readonly text: string;
	/** Telegram message id this message replies to. */
	readonly replyTo?: number | undefined;
};

export class Store {
	readonly db: DatabaseSync;
	readonly now: () => number;
	#depth = 0;

	constructor(path: string, now: () => number = Date.now) {
		this.db = new DatabaseSync(path);
		this.now = now;
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = FULL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec(SCHEMA);
		const version = this.getMeta("schema_version");
		if (version === undefined) this.setMeta("schema_version", String(SCHEMA_VERSION));
		else if (Number(version) !== SCHEMA_VERSION) throw new Error(`unsupported coordinator schema ${version}`);
	}

	/**
	 * Run `fn` in one `BEGIN IMMEDIATE` transaction; commit on return, roll back on throw. Synchronous on purpose:
	 * no await, no network wait inside. Nested calls join the outer transaction.
	 */
	tx<T>(fn: () => T): T {
		if (this.#depth > 0) return fn();
		this.db.exec("BEGIN IMMEDIATE");
		this.#depth++;
		try {
			const result = fn();
			if (result instanceof Promise) throw new Error("Store.tx callback must be synchronous");
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		} finally {
			this.#depth--;
		}
	}

	get inTransaction(): boolean {
		return this.#depth > 0;
	}

	all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
		return this.db.prepare(sql).all(...params) as T[];
	}

	get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
		return this.db.prepare(sql).get(...params) as T | undefined;
	}

	run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
		const result = this.db.prepare(sql).run(...params);
		return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
	}

	getMeta(key: string): string | undefined {
		return this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
	}

	setMeta(key: string, value: string): void {
		this.run(
			"INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			key,
			value,
		);
	}

	/**
	 * Queue a Telegram message. Must be called inside the same `tx()` as the state change it reports, so an accepted
	 * command, its change and its acknowledgement are stored together or not at all. A progress message replaces any
	 * pending progress message of the same task (only the latest progress update is kept).
	 *
	 * A text over Telegram's 4096-character limit is split into ordered parts ("[1/3] ..."), queued as consecutive
	 * rows in this transaction; the outbox's strict (priority, id) order sends them in order. Only the first part
	 * replies to `replyTo`; every part belongs to the task, so a reply to any of them is a follow-up. Returns the id
	 * of the first part.
	 */
	enqueue(message: OutboxMessage): number {
		const now = this.now();
		const priority = message.priority === "required" ? 0 : 1;
		if (priority === 1 && message.taskId !== undefined) {
			this.run("DELETE FROM outbox WHERE state = 'pending' AND priority = 1 AND task_id = ?", message.taskId);
		}
		const ids = splitTelegramText(message.text).map(
			(part, index) =>
				this.run(
					`INSERT INTO outbox(chat_id, task_id, priority, kind, text, reply_to, state, next_attempt_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
					message.chatId,
					message.taskId ?? null,
					priority,
					message.kind,
					part,
					index === 0 ? (message.replyTo ?? null) : null,
					now,
					now,
				).lastInsertRowid,
		);
		return ids[0] ?? 0;
	}

	groupState(chatId: number): { state: "normal" | "sealing" | "frozen"; reason: string | null; recheck: boolean } {
		const row = this.get<{ state: "normal" | "sealing" | "frozen"; reason: string | null; recheck_required: number }>(
			"SELECT state, reason, recheck_required FROM groups WHERE chat_id = ?",
			chatId,
		);
		return row === undefined
			? { state: "normal", reason: null, recheck: false }
			: { state: row.state, reason: row.reason, recheck: row.recheck_required === 1 };
	}

	/** The task's latest approval (any state), or undefined if it was never approved. */
	latestApproval(taskId: number): { head_commit: string; state: string; reason: string | null } | undefined {
		return this.get<{ head_commit: string; state: string; reason: string | null }>(
			"SELECT head_commit, state, reason FROM approvals WHERE task_id = ? ORDER BY id DESC LIMIT 1",
			taskId,
		);
	}

	/** Freeze the group (Architecture § Frozen group). Idempotent; keeps the first reason. */
	freeze(chatId: number, reason: string): boolean {
		const now = this.now();
		const current = this.groupState(chatId);
		if (current.state === "frozen") return false;
		this.run(
			`INSERT INTO groups(chat_id, state, reason, recheck_required, updated_at) VALUES (?, 'frozen', ?, 0, ?)
			 ON CONFLICT(chat_id) DO UPDATE SET state = 'frozen', reason = excluded.reason, updated_at = excluded.updated_at`,
			chatId,
			reason,
			now,
		);
		return true;
	}

	close(): void {
		this.db.close();
	}
}
