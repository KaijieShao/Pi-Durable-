import { errorSummary, type Logger } from "../runtime/log.ts";
import { type TelegramApi, TelegramError, type TelegramErrorKind } from "./ports.ts";
import type { Store } from "./store.ts";
import { TELEGRAM_TEXT_LIMIT } from "./telegram/split.ts";

/**
 * Durable outbox sender (Interfaces and Storage § Outbox to Telegram). Rows are queued by `Store.enqueue()` inside the
 * transaction of the change they report; this loop delivers them:
 *
 * - Strict order: the head of the queue is the first pending row by (priority, id), so required messages (priority 0)
 *   always go out before progress (priority 1) and FIFO within each class. A head row waiting for its retry holds the
 *   rest back (a progress row is never sent while a required one is pending).
 * - Success → in one transaction: state sent, telegram_message_id, sent_at; for a task's row also
 *   `INSERT OR IGNORE task_messages(chat_id, message_id, task_id)`, so a reply to it is a follow-up to that task.
 * - Network error, 5xx (and 401/404: token trouble, the poller reports it) → attempts + 1, retried after
 *   `backoffMs(attempts)` (1 s · 2^(n-1), at most 60 s). Events stay pending until Telegram confirms them.
 * - 429 → no send at all (to any chat: the limit is per bot) until Telegram's retry_after has passed. The hold's
 *   end is saved in the store (meta `outbox_hold_until`) and read back at start, so a restart still honours it.
 * - Any other 4xx → state failed + a failed_events row (outbox kind and a metadata-only reason) for the owner CLI.
 * - Delivery is at-least-once: a crash (or a lost response) between Telegram accepting a message and the row being
 *   marked sent makes the row go out again after restart. Permanent refusals remain explicitly failed. Telegram
 *   has no sendMessage idempotency key: an accepted-but-unconfirmed send can duplicate on retry. Confirmed receipts
 *   are kept in memory while SQLite is unavailable, so that particular persistence failure does not send twice.
 * - Every HTTP attempt has durable metadata saved BEFORE sending. An unsettled attempt found on restart is marked
 *   uncertain, never reported as a confirmed loss or exactly-once success. Message bodies/credentials are not logged.
 *
 * Texts are plain (no parse mode). `Store.enqueue` already split longer texts into ordered parts of at most 4096
 * characters (src/coordinator/telegram/split.ts); the send-time cut below is only a guard for rows written some other
 * way. The chat id comes from the row; the forum topic (`threadId`) is the deployment's, omitted for General (1) and
 * groups without topics.
 */
export type OutboxOptions = {
	readonly store: Store;
	readonly api: TelegramApi;
	/** Forum topic to post in; undefined (or 1, General) = no message_thread_id. */
	readonly threadId: number | undefined;
	readonly log: Logger;
	readonly now?: () => number;
	/** Delay before retry `attempt` (1-based count of failed attempts so far). */
	readonly backoffMs?: (attempt: number) => number;
	/** How often the sender looks for new rows without a kick. */
	readonly pollMs?: number;
};

export type OutboxSender = {
	/** Look for due rows now (call after a transaction that enqueued something). */
	kick(): void;
	/** Stop sending; an in-flight send gets a short grace, then is aborted (its row stays pending). */
	stop(): Promise<void>;
	/** Resolves when nothing is due: the queue is empty or its head is waiting for a retry. */
	idle(): Promise<void>;
};

export { TELEGRAM_TEXT_LIMIT } from "./telegram/split.ts";

const DEFAULT_POLL_MS = 1000;
const DEFAULT_RETRY_AFTER_S = 5;
/** Store meta key: epoch ms before which nothing may be sent (Telegram's last 429 retry_after). */
export const OUTBOX_HOLD_KEY = "outbox_hold_until";
const STOP_GRACE_MS = 1000;

export function defaultOutboxBackoff(attempt: number): number {
	return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

type OutboxRow = {
	id: number;
	chat_id: number;
	task_id: number | null;
	priority: number;
	kind: string;
	text: string;
	reply_to: number | null;
	attempts: number;
	next_attempt_at: number;
	created_at: number;
};

type ConfirmedReceipt = { readonly row: OutboxRow; readonly attemptId: number; readonly messageId: number };

function failureState(kind: TelegramErrorKind): string {
	return {
		rate_limited: "rate_limited",
		permanent: "failed",
		network: "uncertain",
		server: "uncertain",
		unauthorized: "retry",
	}[kind];
}

function recoverUncertainAttempts(store: Store, log: Logger): void {
	try {
		const changed = store.tx(() =>
			store.run(
				"UPDATE outbox_delivery_attempts SET state = 'uncertain', settled_at = ? WHERE state = 'started'",
				store.now(),
			),
		).changes;
		if (changed > 0) log.warn("outbox_delivery_uncertain", { count: changed });
	} catch {
		log.error("outbox_attempt_recovery_failed");
	}
}

export function startOutbox(options: OutboxOptions): OutboxSender {
	const { store, api, log } = options;
	const now = options.now ?? store.now;
	const backoffMs = options.backoffMs ?? defaultOutboxBackoff;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	// Sending to General with message_thread_id 1 is refused by Telegram; General means "no thread".
	const threadId = options.threadId === 1 ? undefined : options.threadId;
	const controller = new AbortController();
	let stopped = false;
	let kicked = false;
	/** No send of any row before this (429 retry_after, or a store that could not record an outcome). */
	let holdUntil = savedHold(store, log);
	let wake: (() => void) | undefined;
	const idleWaiters: (() => void)[] = [];
	const receipts = new Map<number, ConfirmedReceipt>();
	recoverUncertainAttempts(store, log);

	const flushIdle = () => {
		for (const resolve of idleWaiters.splice(0)) resolve();
	};

	const sleep = (ms: number): Promise<void> =>
		new Promise((resolve) => {
			if (stopped || kicked) {
				kicked = false;
				return resolve();
			}
			const timer = setTimeout(done, Math.max(1, Math.min(ms, 2 ** 31 - 1)));
			function done() {
				clearTimeout(timer);
				wake = undefined;
				resolve();
			}
			wake = done;
		});

	const head = (): OutboxRow | undefined => {
		try {
			return store.get<OutboxRow>(
				`SELECT id, chat_id, task_id, priority, kind, text, reply_to, attempts, next_attempt_at, created_at
			 FROM outbox WHERE state = 'pending' ORDER BY priority, id LIMIT 1`,
			);
		} catch (error) {
			log.error("outbox_read_failed", { error: errorSummary(error) });
			return undefined;
		}
	};

	/** Record an outcome; if the store refuses, hold all sending briefly (the row stays pending, sent again). */
	const record = (row: OutboxRow, what: string, fn: () => void): boolean => {
		try {
			store.tx(fn);
			return true;
		} catch (error) {
			holdUntil = Math.max(holdUntil, now() + backoffMs(1));
			log.error("outbox_record_failed", { outbox_id: row.id, outcome: what, error: errorSummary(error) });
			return false;
		}
	};

	const markSent = ({ row, messageId, attemptId }: ConfirmedReceipt): boolean =>
		record(row, "sent", () => {
			// A pending progress row may have been replaced (deleted) while it was in flight: it was still sent.
			store.run(
				`UPDATE outbox SET state = 'sent', attempts = attempts + 1, telegram_message_id = ?, sent_at = ?
				 WHERE id = ? AND state = 'pending'`,
				messageId,
				now(),
				row.id,
			);
			store.run(
				"UPDATE outbox_delivery_attempts SET state = 'sent', settled_at = ?, telegram_message_id = ? WHERE id = ?",
				now(),
				messageId,
				attemptId,
			);
			if (row.task_id !== null)
				store.run(
					"INSERT OR IGNORE INTO task_messages(chat_id, message_id, task_id) VALUES (?, ?, ?)",
					row.chat_id,
					messageId,
					row.task_id,
				);
		});

	/** 429: Telegram's limit is per bot, so nothing at all is sent until retry_after has passed. */
	const holdForRateLimit = (row: OutboxRow, error: TelegramError): void => {
		const seconds = error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_S;
		holdUntil = Math.max(holdUntil, now() + Math.max(1, seconds) * 1000);
		// Saved, so a Coordinator restarted during the hold does not send before Telegram allows it.
		const until = holdUntil;
		record(row, "rate_limited", () => {
			store.setMeta(OUTBOX_HOLD_KEY, String(until));
		});
		log.warn("outbox_rate_limited", { outbox_id: row.id, retry_after_s: seconds });
	};

	/** Permanent refusal: failed + a failed_events row (outbox kind, error summary: metadata, never the text). */
	const markFailed = (row: OutboxRow, error: TelegramError): void => {
		const reason = errorSummary(error);
		record(row, "failed", () => {
			const changed = store.run(
				"UPDATE outbox SET state = 'failed', attempts = attempts + 1 WHERE id = ? AND state = 'pending'",
				row.id,
			).changes;
			if (changed === 1)
				store.run(
					"INSERT INTO failed_events(outbox_id, kind, reason, created_at) VALUES (?, ?, ?, ?)",
					row.id,
					row.kind,
					reason,
					now(),
				);
		});
		log.error("outbox_failed", { outbox_id: row.id, kind: row.kind, task_id: row.task_id, status: error.status });
	};

	/** Network, 5xx, 401/404 or anything unexpected: stays pending, retried after a backoff. */
	const scheduleRetry = (row: OutboxRow, error: unknown): void => {
		const kind = error instanceof TelegramError ? error.kind : "network";
		const status = error instanceof TelegramError ? error.status : undefined;
		const attempts = row.attempts + 1;
		const delay = backoffMs(attempts);
		record(row, "retry", () => {
			store.run(
				"UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE id = ? AND state = 'pending'",
				attempts,
				now() + delay,
				row.id,
			);
		});
		const fields = { outbox_id: row.id, error_kind: kind, status, attempts, retry_ms: delay };
		if (kind === "unauthorized") log.error("outbox_unauthorized", fields);
		else log.warn("outbox_retry", fields);
	};

	const onFailure = (row: OutboxRow, error: unknown): void => {
		if (error instanceof TelegramError && error.kind === "rate_limited") holdForRateLimit(row, error);
		else if (error instanceof TelegramError && error.kind === "permanent") markFailed(row, error);
		else scheduleRetry(row, error);
	};

	const recordAttemptFailure = (row: OutboxRow, attemptId: number, error: unknown): void => {
		const kind = error instanceof TelegramError ? error.kind : "network";
		const status = error instanceof TelegramError ? error.status : undefined;
		const state = failureState(kind);
		record(row, "attempt_failed", () => {
			store.run(
				"UPDATE outbox_delivery_attempts SET state = ?, settled_at = ?, error_kind = ?, status = ? WHERE id = ?",
				state,
				now(),
				kind,
				status ?? null,
				attemptId,
			);
		});
	};

	const commitReceipt = (receipt: ConfirmedReceipt): void => {
		if (!markSent(receipt)) return;
		receipts.delete(receipt.row.id);
		log.info("outbox_sent", {
			outbox_id: receipt.row.id,
			kind: receipt.row.kind,
			task_id: receipt.row.task_id,
			message_id: receipt.messageId,
			attempt_id: receipt.attemptId,
			delivery_latency_ms: now() - receipt.row.created_at,
		});
	};

	const beginAttempt = (row: OutboxRow): number | undefined => {
		let id: number | undefined;
		const recorded = record(row, "attempt_started", () => {
			store.run(
				"UPDATE outbox_delivery_attempts SET state = 'uncertain', settled_at = ? WHERE outbox_id = ? AND state = 'started'",
				now(),
				row.id,
			);
			id = store.run(
				"INSERT INTO outbox_delivery_attempts(outbox_id, started_at, state) VALUES (?, ?, 'started')",
				row.id,
				now(),
			).lastInsertRowid;
		});
		if (!recorded) return undefined;
		if (id !== undefined) log.info("outbox_attempt", { outbox_id: row.id, attempt_id: id, kind: row.kind });
		return id;
	};

	const send = async (row: OutboxRow): Promise<void> => {
		const attemptId = beginAttempt(row);
		if (attemptId === undefined) return; // No HTTP side effect without durable intent.
		let messageId: number;
		try {
			const result = await api.sendMessage(
				{
					chatId: row.chat_id,
					text: fitTelegramText(row.text),
					threadId,
					replyTo: row.reply_to ?? undefined,
				},
				controller.signal,
			);
			messageId = result.messageId;
		} catch (error) {
			recordAttemptFailure(row, attemptId, error);
			// Aborted by stop(): the outcome is unknown; the row stays pending and goes out again after restart.
			if (stopped && controller.signal.aborted) return;
			onFailure(row, error);
			return;
		}
		const receipt = { row, messageId, attemptId };
		receipts.set(row.id, receipt);
		commitReceipt(receipt);
	};

	/** Send the head row if it is due; otherwise return how long to wait (0 = look again at once). */
	const step = async (): Promise<number> => {
		const t = now();
		if (t < holdUntil) return holdUntil - t;
		const receipt = receipts.values().next().value;
		if (receipt !== undefined) {
			commitReceipt(receipt);
			return 0;
		}
		const row = head();
		if (row === undefined || row.next_attempt_at > t) {
			flushIdle();
			return row === undefined ? pollMs : Math.min(pollMs, row.next_attempt_at - t);
		}
		await send(row);
		return 0;
	};

	const loop = async (): Promise<void> => {
		while (!stopped) {
			const wait = await step();
			if (wait > 0) await sleep(wait);
		}
	};

	const running = loop()
		.catch((error: unknown) => log.error("outbox_crashed", { error: errorSummary(error) }))
		.finally(flushIdle);

	const kick = () => {
		kicked = true;
		wake?.();
	};

	return {
		kick,
		async stop(): Promise<void> {
			if (!stopped) {
				stopped = true;
				wake?.();
				const grace = setTimeout(() => controller.abort(), STOP_GRACE_MS);
				try {
					await running;
				} finally {
					clearTimeout(grace);
				}
			}
			await running;
		},
		idle(): Promise<void> {
			if (stopped) return running;
			return new Promise((resolve) => {
				idleWaiters.push(resolve);
				kick();
			});
		},
	};
}

/** The saved 429 hold (0 if none or unreadable: a store that cannot be read sends nothing anyway). */
function savedHold(store: Store, log: Logger): number {
	try {
		const value = Number(store.getMeta(OUTBOX_HOLD_KEY) ?? 0);
		return Number.isFinite(value) && value > 0 ? value : 0;
	} catch (error) {
		log.error("outbox_hold_read_failed", { error: errorSummary(error) });
		return 0;
	}
}

/**
 * Guard at send time: Telegram's 4096-character limit in UTF-16 units, cut with "…". Rows from `Store.enqueue` are
 * already split into parts that fit, so this never cuts them.
 */
export function fitTelegramText(text: string): string {
	if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
	let cut = TELEGRAM_TEXT_LIMIT - 1;
	const last = text.charCodeAt(cut - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut--;
	return `${text.slice(0, cut)}…`;
}
