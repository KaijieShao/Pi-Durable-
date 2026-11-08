/**
 * The Coordinator's side of the watchdog protocol (src/watchdog/protocol.ts): sweep requests and their answers are rows
 * of `watchdog_sweeps` in the Coordinator's own SQLite file, the heartbeat a meta key. Every write is one transaction.
 *
 * The timings are production values; only tests pass others (CoordinatorDeps.watchdog), never the configuration.
 */
import { HEARTBEAT_KEY, type RequestedSweepReason } from "../watchdog/protocol.ts";
import type { SweepAnswer, WatchdogLink } from "./ports.ts";
import type { Store } from "./store.ts";

/** How long recovery waits for the watchdog's answer before the watchdog counts as unavailable (no dispatch). */
export const WATCHDOG_ANSWER_TIMEOUT_MS = 30_000;
/** Dispatch needs a heartbeat at most this old: if the watchdog dies, no new run starts. */
export const WATCHDOG_HEARTBEAT_MAX_AGE_MS = 15_000;

export type WatchdogTimings = {
	readonly answerTimeoutMs: number;
	readonly heartbeatMaxAgeMs: number;
};

export function createStoreWatchdogLink(store: Store, requesterPid: number = process.pid): WatchdogLink {
	return {
		request(reason: RequestedSweepReason): number {
			return store.tx(
				() =>
					store.run(
						"INSERT INTO watchdog_sweeps(reason, state, requester_pid, requested_at) VALUES (?, 'pending', ?, ?)",
						reason,
						requesterPid,
						store.now(),
					).lastInsertRowid,
			);
		},
		answer(id: number): SweepAnswer {
			const row = store.get<{ state: string; verified: number | null }>(
				"SELECT state, verified FROM watchdog_sweeps WHERE id = ?",
				id,
			);
			if (row?.state !== "done") return { kind: "pending" };
			return { kind: row.verified === 1 ? "verified" : "unverified" };
		},
		heartbeatAgeMs(): number | undefined {
			const at = Number(store.getMeta(HEARTBEAT_KEY));
			return Number.isFinite(at) && at > 0 ? Math.max(0, store.now() - at) : undefined;
		},
	};
}
