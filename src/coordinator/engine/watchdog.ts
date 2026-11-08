/**
 * The engine's gate on the watchdog (Deployment § Processes: on any Coordinator restart the watchdog kills everything
 * in the slice and every labelled container, verifies both are empty, and "only then lets admission reopen";
 * Architecture § Fails closed: "If enforcement is unavailable, no new execution starts").
 *
 *   Recovery step 2 (and the recheck after an owner unfreeze) asks the watchdog for a sweep and waits for its answer:
 *     verified     this Coordinator may dispatch (while the watchdog's heartbeat stays fresh);
 *     unverified   the watchdog froze the group in the same transaction (the Coordinator freezes it too, idempotent);
 *     no answer    the watchdog is unavailable: fail closed. Polling and commands go on and are queued, but nothing
 *                  that starts a Pi process or a container runs (dispatch, merges, recovery jobs); the group is told
 *                  once. When the watchdog answers that same request later, admission reopens by itself (nothing of
 *                  this Coordinator was running meanwhile, so the late sweep killed nothing of its own).
 *   Dispatch, merges and recovery jobs also need a heartbeat younger than WATCHDOG_HEARTBEAT_MAX_AGE_MS: if the
 *   watchdog dies, no new run or check starts (live ones go on); the group is told once per outage.
 */
import { type RequestedSweepReason, UNVERIFIED_SWEEP } from "../../watchdog/protocol.ts";
import { type Ctx, freezeGroup, sleep, tx } from "./context.ts";

export type SweepOutcome = "verified" | "unverified" | "unavailable";

/** meta: the "paused" notice was posted for the current outage (deleted once the watchdog is healthy again). */
export const WATCHDOG_NOTICE_KEY = "watchdog_unavailable_noticed";
const WATCHDOG_NOTICE =
	"Task execution is paused: the watchdog (the independent stop path) is not answering, so no run starts. " +
	"Commands are still saved and queued.";
const ANSWER_POLL_MS = 100;

/** Read the request's answer; once there is one, the gate takes it. */
function settle(ctx: Ctx, id: number): Exclude<SweepOutcome, "unavailable"> | undefined {
	const answer = ctx.watchdog.link.answer(id);
	if (answer.kind === "pending") return undefined;
	const gate = ctx.watchdogGate;
	gate.pending = undefined;
	gate.gaveUp = false;
	gate.verified = answer.kind === "verified";
	ctx.log.info("watchdog_sweep_answered", { request: id, verified: gate.verified });
	return answer.kind;
}

/**
 * Ask the watchdog to kill and verify every leftover Pi process and labelled container, and wait (bounded) for its
 * answer. Only while this Coordinator runs nothing (recovery at startup, the recheck).
 */
export async function watchdogSweep(ctx: Ctx, reason: RequestedSweepReason): Promise<SweepOutcome> {
	const gate = ctx.watchdogGate;
	gate.verified = false;
	gate.gaveUp = false;
	const id = ctx.watchdog.link.request(reason);
	gate.pending = id;
	ctx.log.info("watchdog_sweep_requested", { request: id, reason });
	const started = Date.now();
	for (;;) {
		const outcome = settle(ctx, id);
		if (outcome !== undefined) return outcome;
		if (ctx.stopped || Date.now() - started >= ctx.watchdog.answerTimeoutMs) break;
		await sleep(ANSWER_POLL_MS);
	}
	gate.gaveUp = true;
	ctx.log.error("watchdog_unavailable", { request: id, reason, waited_ms: Date.now() - started });
	watchdogNotice(ctx);
	return "unavailable";
}

/** A request recovery stopped waiting for: take its answer once the watchdog gives one (each tick). */
export function pollWatchdog(ctx: Ctx): boolean {
	const gate = ctx.watchdogGate;
	if (gate.verified || !gate.gaveUp || gate.pending === undefined) return false;
	const request = gate.pending;
	const outcome = settle(ctx, request);
	if (outcome === "unverified") freezeGroup(ctx, UNVERIFIED_SWEEP);
	if (outcome === "verified") ctx.log.info("watchdog_available", { request });
	return outcome !== undefined;
}

/**
 * Dispatch, merges and recovery jobs (anything that starts a Pi process or a container): a verified sweep of this
 * Coordinator and a fresh heartbeat; otherwise the notice, once per outage.
 */
export function watchdogReady(ctx: Ctx): boolean {
	const gate = ctx.watchdogGate;
	if (!gate.verified) {
		if (gate.gaveUp) watchdogNotice(ctx);
		return false;
	}
	const age = ctx.watchdog.link.heartbeatAgeMs();
	const fresh = age !== undefined && age <= ctx.watchdog.heartbeatMaxAgeMs;
	if (gate.stale === fresh) {
		gate.stale = !fresh;
		if (gate.stale) ctx.log.error("watchdog_heartbeat_stale", { age_ms: age });
		else ctx.log.info("watchdog_heartbeat_fresh", { age_ms: age });
	}
	if (!fresh) {
		watchdogNotice(ctx);
		return false;
	}
	if (ctx.store.getMeta(WATCHDOG_NOTICE_KEY) !== undefined)
		tx(ctx, () => ctx.store.run("DELETE FROM meta WHERE key = ?", WATCHDOG_NOTICE_KEY));
	return true;
}

/** Tell the group once per outage that execution is paused (the same path as unavailable enforcement). */
function watchdogNotice(ctx: Ctx): void {
	if (ctx.stopped || ctx.store.getMeta(WATCHDOG_NOTICE_KEY) !== undefined) return;
	tx(ctx, () => {
		if (ctx.store.getMeta(WATCHDOG_NOTICE_KEY) !== undefined) return;
		ctx.store.setMeta(WATCHDOG_NOTICE_KEY, String(ctx.now()));
		ctx.store.enqueue({
			chatId: ctx.chatId,
			priority: "required",
			kind: "watchdog_unavailable",
			text: WATCHDOG_NOTICE,
		});
	});
}

/** The gate of a new engine: closed until recovery's sweep is verified. */
export function newWatchdogGate(): Ctx["watchdogGate"] {
	return { verified: false, pending: undefined, gaveUp: false, stale: false };
}
