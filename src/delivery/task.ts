import { defineTask } from "@earendil-works/pi-durable";
import { guardPhase } from "./phase-guard.ts";
import { sendPhase } from "./send-phase.ts";
import type { DeliverInput, DeliverState, DeliveryDeps } from "./types.ts";
import { waitPhase } from "./wait-phase.ts";

export const DELIVER_TASK = "tg.deliver";

/**
 * One background, conversation-owned task per admitted Telegram message: it submits the message, streams the
 * preview and delivers the answer. Durable checkpoints make delivery survive restarts.
 */
export function createDeliverTask(deps: DeliveryDeps) {
	return defineTask<DeliverInput, DeliverState, null>({
		name: DELIVER_TASK,
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: (task, runtime, context) =>
				guardPhase("wait", runtime.signal, deps, () => waitPhase(task, runtime, context, deps)),
			send: (task, runtime, context) =>
				guardPhase("send", runtime.signal, deps, () => sendPhase(task, runtime, context, deps)),
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

export type DeliverTask = ReturnType<typeof createDeliverTask>;
