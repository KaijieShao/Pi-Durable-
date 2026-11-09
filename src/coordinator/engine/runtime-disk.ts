/** Free-space safety, unlike the new-worktree budget, applies to every execution. Never deletes task data. */
import { EXECUTION_DISK_WAIT_KEY, type ExecutionDiskPressure, executionDiskPressure } from "../disk.ts";
import { type Ctx, tx } from "./context.ts";

function pressureState(pressure: ExecutionDiskPressure | undefined): string | undefined {
	if (pressure === undefined) return undefined;
	return `${pressure.disk}:${pressure.free === undefined ? "unknown" : "low"}`;
}

function persistPressure(ctx: Ctx, pressure: ExecutionDiskPressure | undefined): void {
	const state = pressureState(pressure);
	const saved = ctx.store.getMeta(EXECUTION_DISK_WAIT_KEY)?.split("|")[0];
	if (saved === state) return;
	tx(ctx, () => {
		if (pressure === undefined) ctx.store.run("DELETE FROM meta WHERE key = ?", EXECUTION_DISK_WAIT_KEY);
		else ctx.store.setMeta(EXECUTION_DISK_WAIT_KEY, `${state}|${pressure.reason}`);
		ctx.store.enqueue({
			chatId: ctx.chatId,
			priority: "required",
			kind: pressure === undefined ? "disk_recovered" : "disk_pressure",
			text:
				pressure === undefined
					? "Disk safety floor recovered. Queued executions may start again; stopped runs are not resubmitted."
					: `Execution paused: ${pressure.reason}. No new run or merge check starts. Active runs are stopped and verified; unpushed work is kept. /status and /cancel remain available.`,
		});
	});
}

export function refreshExecutionDisk(ctx: Ctx): ExecutionDiskPressure | undefined {
	const pressure = executionDiskPressure(ctx.diskProbe, ctx.config.paths, ctx.disk);
	const previous = ctx.executionDiskHold;
	ctx.executionDiskHold = pressure;
	try {
		persistPressure(ctx, pressure);
	} catch {
		// Even a completely full boot disk must not prevent in-memory revocation and workload termination.
		ctx.log.error("disk_pressure_persist_failed", { disk: pressure?.disk ?? previous?.disk });
	}
	if (pressureState(pressure) !== pressureState(previous))
		ctx.log.warn(pressure === undefined ? "execution_disk_recovered" : "execution_disk_hold", {
			disk: pressure?.disk,
			free: pressure?.free,
			floor: pressure?.floor,
		});
	return pressure;
}
