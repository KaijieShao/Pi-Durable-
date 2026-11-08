import type { Context } from "@earendil-works/chord";
import { isFatalHarnessError } from "../runtime/fatal.ts";
import { errorSummary } from "../runtime/log.ts";
import type { DeliveryDeps } from "./types.ts";

/**
 * Run a phase body. A throw faults the task, so expected failures are handled inside phases; here a closing or
 * aborted invocation passes through silently (the scheduler records no fault), a failed Session is fatal, and
 * anything else is logged before it faults the task.
 */
export async function guardPhase(
	name: string,
	signal: AbortSignal,
	deps: Pick<DeliveryDeps, "log" | "onFatal">,
	body: () => Promise<void>,
	_context?: Context,
): Promise<void> {
	try {
		await body();
	} catch (error) {
		if (signal.aborted) throw error;
		if (isFatalHarnessError(error)) {
			deps.onFatal("storage failure in delivery", error);
			throw error;
		}
		deps.log.error("delivery_phase_failed", { phase: name, error: errorSummary(error) });
		throw error;
	}
}
