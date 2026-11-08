/**
 * Run keys (Architecture § Model relay: "It accepts only an open run key"). A key is 32 random bytes, base64url;
 * only its sha256 (relay.hashRunKey) is stored. Closing a run's keys revokes its generation: the relay refuses every
 * further request, so no successor or new model call starts after revocation.
 */
import { randomBytes } from "node:crypto";
import { hashRunKey } from "../relay.ts";
import type { Store } from "../store.ts";

export function newRunKey(): string {
	return randomBytes(32).toString("base64url");
}

/** Store an open key for the run's generation. Call inside `store.tx()`. */
export function openRunKey(
	store: Store,
	run: { runId: number; taskId: number; generation: number },
	key: string,
	now: number,
): void {
	store.run(
		`INSERT INTO run_keys(key_hash, run_id, task_id, generation, state, opened_at)
		 VALUES (?, ?, ?, ?, 'open', ?)`,
		hashRunKey(key),
		run.runId,
		run.taskId,
		run.generation,
		now,
	);
}

/** Close the run's keys and revoke its generation. Returns how many keys were open. Call inside `store.tx()`. */
export function closeRunKeys(
	store: Store,
	run: { runId: number; taskId: number; generation: number },
	now: number,
): number {
	return store.run(
		`UPDATE run_keys SET state = 'closed', closed_at = ?
		 WHERE state = 'open' AND (run_id = ? OR (task_id = ? AND generation = ?))`,
		now,
		run.runId,
		run.taskId,
		run.generation,
	).changes;
}

/** Recovery step 1: close every open key. */
export function closeAllRunKeys(store: Store, now: number): number {
	return store.run("UPDATE run_keys SET state = 'closed', closed_at = ? WHERE state = 'open'", now).changes;
}
