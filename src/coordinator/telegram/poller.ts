import type { Update } from "grammy/types";
import { errorSummary, type Logger } from "../../runtime/log.ts";
import { type TelegramApi, TelegramError } from "../ports.ts";
import type { Store } from "../store.ts";

/**
 * Telegram long polling (Interfaces and Storage § Telegram: "Long polling with a 30 s timeout. The offset is saved
 * only after the batch is saved."). Every update of a batch goes to `onUpdate` in order; `onUpdate` saves it in its
 * own transaction (the command handler, deduplicated by the update id primary key). Only when the whole batch went
 * through is the next offset written to meta `telegram_offset`. If `onUpdate` throws, the rest of the batch is not
 * processed and the offset is not saved: after a backoff the same batch is fetched again and the updates already saved
 * are dropped as duplicates by the handler. A crash anywhere loses nothing (the offset never runs ahead of the saves).
 *
 * 401 / 404 (bad or revoked token) → `onFatal`, and the poller stops. Other errors back off (1 s → 30 s by default;
 * 429 waits at least Telegram's retry_after) and retry.
 */
export type PollerOptions = {
	readonly store: Store;
	readonly api: TelegramApi;
	readonly onUpdate: (update: Update) => void;
	readonly log: Logger;
	/** getUpdates long-poll timeout in seconds (30 in production). */
	readonly timeoutSeconds?: number;
	/** Wait after the 1st, 2nd, ... consecutive failure; the last entry repeats. */
	readonly backoffMs?: readonly number[];
	readonly onFatal?: (error: unknown) => void;
};

export type Poller = {
	/** Abort the long poll, finish the update in hand (never mid-transaction), and stop. */
	stop(): Promise<void>;
	/** Resolves when no batch is being processed (the current one, if any, has been saved or abandoned). */
	idle(): Promise<void>;
};

export const OFFSET_KEY = "telegram_offset";
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000, 30_000];

export function startPoller(options: PollerOptions): Poller {
	const { store, api, log } = options;
	const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
	const backoff =
		options.backoffMs !== undefined && options.backoffMs.length > 0 ? options.backoffMs : DEFAULT_BACKOFF_MS;
	const controller = new AbortController();
	let stopped = false;
	let failures = 0;
	let batch: Promise<void> | undefined;
	let wake: (() => void) | undefined;

	const pause = (ms: number): Promise<void> =>
		new Promise((resolve) => {
			if (stopped) return resolve();
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				wake = undefined;
				resolve();
			}
			wake = done;
		});

	const backoffFor = (error: unknown): number => {
		const base = backoff[Math.min(failures, backoff.length) - 1] ?? backoff[backoff.length - 1] ?? 1000;
		const retryAfter = error instanceof TelegramError ? error.retryAfterSeconds : undefined;
		return retryAfter === undefined ? base : Math.max(base, retryAfter * 1000);
	};

	/** One update to the handler; false if it threw (logged as metadata: ids and the error's first line only). */
	const deliverOne = async (update: Update, batchSize: number): Promise<boolean> => {
		try {
			const result: unknown = options.onUpdate(update);
			// The handler is synchronous by contract; tolerate a promise so a rejection is still a failure.
			if (isPromiseLike(result)) await result;
			return true;
		} catch (error) {
			log.error("telegram_update_failed", {
				update_id: update.update_id,
				batch: batchSize,
				error: errorSummary(error),
			});
			return false;
		}
	};

	/** Hand every update to `onUpdate` in order; true only if all of them went through. */
	const deliver = async (updates: readonly Update[]): Promise<boolean> => {
		for (const update of updates) {
			// Stopping between updates leaves the offset where it was; the rest comes again on the next start.
			if (stopped || !(await deliverOne(update, updates.length))) return false;
		}
		return true;
	};

	/** Deliver the batch, then save the offset after it: the new offset, or undefined if the batch must come again. */
	const saveBatch = async (offset: number, updates: readonly Update[]): Promise<number | undefined> => {
		if (!(await deliver(updates))) return undefined;
		const next = Math.max(offset, ...updates.map((u) => u.update_id + 1));
		try {
			store.tx(() => store.setMeta(OFFSET_KEY, String(next)));
			return next;
		} catch (error) {
			log.error("telegram_offset_save_failed", { offset: next, error: errorSummary(error) });
			return undefined;
		}
	};

	/** Process one batch; returns the offset to poll next (unchanged, after a backoff, if the batch failed). */
	const handleBatch = async (offset: number, updates: readonly Update[]): Promise<number> => {
		const work = saveBatch(offset, updates);
		batch = work.then(() => undefined);
		let next: number | undefined;
		try {
			next = await work;
		} finally {
			batch = undefined;
		}
		const fields = { count: updates.length, first: updates[0]?.update_id, last: updates.at(-1)?.update_id };
		if (next !== undefined) {
			failures = 0;
			log.debug("telegram_batch_saved", { ...fields, offset: next });
			return next;
		}
		if (stopped) return offset;
		failures++;
		const waitMs = backoffFor(undefined);
		log.warn("telegram_batch_retry", { ...fields, attempt: failures, wait_ms: waitMs });
		await pause(waitMs);
		return offset;
	};

	/** A failed long poll: unauthorized is fatal (stop + onFatal); anything else waits out a backoff. */
	const onPollError = async (error: unknown): Promise<void> => {
		if (stopped) return;
		failures++;
		const telegram = error instanceof TelegramError ? error : undefined;
		if (telegram?.kind === "unauthorized") {
			log.error("telegram_unauthorized", { method: "getUpdates", status: telegram.status });
			stopped = true;
			options.onFatal?.(error);
			return;
		}
		const waitMs = backoffFor(error);
		log.warn("telegram_poll_failed", {
			kind: telegram?.kind ?? "unexpected",
			status: telegram?.status,
			attempt: failures,
			wait_ms: waitMs,
		});
		await pause(waitMs);
	};

	const loop = async (): Promise<void> => {
		let offset = readOffset(store);
		log.info("telegram_poll_started", { offset, timeout_s: timeoutSeconds });
		while (!stopped) {
			let updates: Update[];
			try {
				updates = await api.getUpdates(offset, timeoutSeconds, controller.signal);
			} catch (error) {
				await onPollError(error);
				continue;
			}
			if (updates.length === 0) failures = 0;
			else offset = await handleBatch(offset, updates);
		}
		log.info("telegram_poll_stopped", { offset });
	};

	const running = loop().catch((error: unknown) => {
		log.error("telegram_poller_crashed", { error: errorSummary(error) });
		options.onFatal?.(error);
	});

	return {
		async stop(): Promise<void> {
			stopped = true;
			controller.abort();
			wake?.();
			await running;
		},
		async idle(): Promise<void> {
			while (batch !== undefined) await batch.catch(() => {});
		},
	};
}

/** The saved offset, or 0 on first start (Telegram then serves every update it still holds). */
function readOffset(store: Store): number {
	const value = Number(store.getMeta(OFFSET_KEY) ?? 0);
	return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}
