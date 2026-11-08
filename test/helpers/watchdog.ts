/**
 * TEST ONLY: the watchdog in tests. `startTestWatchdog` runs the real watchdog core (src/watchdog/watchdog.ts) in this
 * process, on its own connection to the Coordinator's SQLite file, reaping this deployment's marked Pi processes (the
 * production marker scan) and the given containers (the local test sandbox's, or the Docker CLI's). `verifiedWatchdog`
 * is a stand-in link for unit tests of the engine that are not about the watchdog: every sweep is verified at once.
 */
import type { WatchdogOptions } from "../../src/coordinator/engine/context.ts";
import type { ContainerFilter, Sandbox } from "../../src/coordinator/ports.ts";
import { WATCHDOG_ANSWER_TIMEOUT_MS, WATCHDOG_HEARTBEAT_MAX_AGE_MS } from "../../src/coordinator/watchdog-link.ts";
import { deploymentId } from "../../src/runner/argv.ts";
import { type Logger, silentLogger } from "../../src/runtime/log.ts";
import { markerProcessReaper, type Reaper, type Scope } from "../../src/watchdog/reapers.ts";
import { startWatchdog, type Watchdog } from "../../src/watchdog/watchdog.ts";

const filterOf = (scope: Scope | undefined): ContainerFilter | undefined =>
	scope === undefined ? undefined : { taskId: scope.taskId, generation: scope.generation };

/** A sandbox's managed containers as a reaper: `live()` lists them, `killAll()` removes them. */
export function sandboxReaper(sandbox: Sandbox): Reaper {
	return {
		kind: "containers",
		async list(scope) {
			try {
				return await sandbox.live(filterOf(scope));
			} catch {
				return undefined;
			}
		},
		async kill(_items, scope) {
			await sandbox.killAll(filterOf(scope)).catch(() => undefined);
		},
	};
}

export type TestWatchdogOptions = {
	readonly dataDir: string;
	readonly chatId: number;
	readonly containers: Reaper;
	readonly log?: Logger;
	readonly runDeadlineMs?: number;
	readonly deadlineGraceMs?: number;
	/** Default 50 ms (1 s in production). */
	readonly intervalMs?: number;
};

export function startTestWatchdog(options: TestWatchdogOptions): Watchdog {
	return startWatchdog({
		dataDir: options.dataDir,
		chatId: options.chatId,
		reapers: {
			processes: [markerProcessReaper({ deployment: deploymentId(options.dataDir) })],
			containers: [options.containers],
		},
		log: options.log ?? silentLogger,
		intervalMs: options.intervalMs ?? 50,
		...(options.runDeadlineMs === undefined ? {} : { runDeadlineMs: options.runDeadlineMs }),
		...(options.deadlineGraceMs === undefined ? {} : { deadlineGraceMs: options.deadlineGraceMs }),
	});
}

/** Engine unit tests: every sweep request is answered verified at once; the heartbeat is always fresh. */
export function verifiedWatchdog(): WatchdogOptions & { readonly requests: string[] } {
	const requests: string[] = [];
	return {
		requests,
		link: {
			request(reason) {
				requests.push(reason);
				return requests.length;
			},
			answer: () => ({ kind: "verified" }),
			heartbeatAgeMs: () => 0,
		},
		answerTimeoutMs: WATCHDOG_ANSWER_TIMEOUT_MS,
		heartbeatMaxAgeMs: WATCHDOG_HEARTBEAT_MAX_AGE_MS,
	};
}
