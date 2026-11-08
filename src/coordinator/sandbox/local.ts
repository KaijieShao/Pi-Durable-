/**
 * TEST-ONLY sandbox. It is not reachable from configuration or the environment: only tests construct it (through
 * `CoordinatorDeps.sandbox`). It gives NO isolation: file operations run `node deploy/docker/fsop.mjs <worktree>` as a
 * host subprocess (the same confinement code the agent container runs), and checks are functions the test supplies.
 * "Containers" are entries in memory, so `live()` / `killAll()` behave like the Docker sandbox's label queries.
 */
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { errorSummary, type Logger, silentLogger } from "../../runtime/log.ts";
import { DEMO_LIMITS } from "../limits.ts";
import type { AgentSandbox, CheckResult, ContainerFilter, FsRequest, FsResponse, Sandbox } from "../ports.ts";
import {
	type CheckFacts,
	classifyCheck,
	containerName,
	createScratch,
	ensureTaskLayout,
	FS_TIMEOUT_MS,
	fsError,
	matchesFilter,
	OP_NAME,
	OutputMonitor,
	outcomeTrailer,
	positiveFinite,
	precheckCheck,
	rejectedCheck,
	removeScratch,
	runFsop,
	validIds,
	withTrailer,
} from "./limits-text.ts";

/** A test check: gets the worktree path and whether it may write (only for "setup"). */
export type LocalCheck = (worktree: string, writable: boolean) => Promise<{ exitCode: number; output: string }>;

export type LocalSandboxOptions = {
	readonly taskDir: string;
	/** Operations by name. "test" (and "setup") default to passing when not given. */
	readonly checks?: Readonly<Record<string, LocalCheck>>;
	readonly log?: Logger;
	/** Override the fsop.mjs path (default: deploy/docker/fsop.mjs of this package). */
	readonly fsopPath?: string;
};

type Entry = {
	readonly taskId: number;
	readonly generation: number;
	readonly kind: "agent" | "check";
	readonly timer?: NodeJS.Timeout;
};

type CheckRun =
	| { readonly kind: "done"; readonly exitCode: number; readonly output: string }
	| { readonly kind: "timeout" | "aborted" | "error" };

const DEFAULT_FSOP = fileURLToPath(new URL("../../../deploy/docker/fsop.mjs", import.meta.url));

const passing =
	(output: string): LocalCheck =>
	async () => ({ exitCode: 0, output });

/** Await `promise` up to `timeoutMs`; the caller's signal stops waiting (the function itself cannot be killed). */
function raceCheck(
	promise: Promise<{ exitCode: number; output: string }>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<CheckRun> {
	return new Promise((resolve) => {
		const finish = (run: CheckRun): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(run);
		};
		const onAbort = (): void => finish({ kind: "aborted" });
		const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted === true) onAbort();
		promise.then(
			(result) => finish({ kind: "done", exitCode: result.exitCode, output: String(result.output ?? "") }),
			() => finish({ kind: "error" }),
		);
	});
}

export function createLocalSandbox(options: LocalSandboxOptions): Sandbox {
	const log = options.log ?? silentLogger;
	const fsopPath = options.fsopPath ?? DEFAULT_FSOP;
	const checks: Record<string, LocalCheck> = {
		setup: passing("no setup script"),
		test: passing("ok"),
		...options.checks,
	};
	const entries = new Map<string, Entry>();

	const remove = (name: string): void => {
		const entry = entries.get(name);
		if (entry?.timer !== undefined) clearTimeout(entry.timer);
		entries.delete(name);
	};

	const matching = (filter?: ContainerFilter): string[] =>
		[...entries.entries()].filter(([, entry]) => matchesFilter(entry, filter)).map(([name]) => name);

	const agentHandle = (name: string, worktree: string): AgentSandbox => ({
		name,
		fileOp(request: FsRequest, signal?: AbortSignal): Promise<FsResponse> {
			if (!entries.has(name)) return Promise.resolve(fsError("unavailable", "the task container is not running"));
			return runFsop(process.execPath, [fsopPath, worktree], request, {
				timeoutMs: FS_TIMEOUT_MS,
				signal,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			});
		},
		async stop(): Promise<void> {
			remove(name);
		},
	});

	const startAgent: Sandbox["startAgent"] = async (spec) => {
		if (!validIds(spec.taskId, spec.generation)) throw new Error("invalid task id or generation");
		if (!positiveFinite(spec.lifetimeMs)) throw new Error("invalid container lifetime");
		if (!isAbsolute(spec.worktree) || !(await stat(spec.worktree)).isDirectory()) {
			throw new Error("worktree must be an existing absolute directory");
		}
		await ensureTaskLayout(options.taskDir);
		const name = containerName("agent", spec.taskId, spec.generation);
		const timer = setTimeout(() => remove(name), Math.max(1, spec.lifetimeMs));
		timer.unref();
		entries.set(name, { taskId: spec.taskId, generation: spec.generation, kind: "agent", timer });
		log.info("agent_container_started", { task: spec.taskId, generation: spec.generation, container: name });
		return agentHandle(name, spec.worktree);
	};

	const finishCheck = (op: string, run: CheckRun, timeoutMs: number, startedAt: number): CheckResult => {
		const monitor = new OutputMonitor(DEMO_LIMITS.toolResultBytes);
		if (run.kind === "done") monitor.push(Buffer.from(run.output, "utf8"));
		const facts: CheckFacts = {
			spawnFailed: false,
			started: run.kind !== "error",
			exitCode: run.kind === "done" ? run.exitCode : undefined,
			timedOut: run.kind === "timeout",
			aborted: run.kind === "aborted",
			outputLimited: false,
			oomKilled: false,
			processLimitSeen: monitor.processLimitSeen,
		};
		const outcome = classifyCheck(facts);
		return {
			op,
			outcome,
			exitCode: facts.exitCode,
			output: withTrailer(monitor.tail.text(), outcomeTrailer(outcome, { timeoutMs })),
			truncated: monitor.tail.truncated,
			durationMs: Date.now() - startedAt,
		};
	};

	const execute = async (check: LocalCheck, spec: Parameters<Sandbox["runCheck"]>[0], startedAt: number) => {
		let promise: Promise<{ exitCode: number; output: string }>;
		try {
			promise = check(spec.worktree, spec.writable && spec.op === "setup");
		} catch (error) {
			promise = Promise.reject(error);
		}
		const run = await raceCheck(promise, spec.timeoutMs, spec.signal);
		const result = finishCheck(spec.op, run, spec.timeoutMs, startedAt);
		log.info("check_finished", {
			task: spec.taskId,
			generation: spec.generation,
			op: spec.op,
			outcome: result.outcome,
		});
		return result;
	};

	const runCheck: Sandbox["runCheck"] = async (spec) => {
		const startedAt = Date.now();
		const rejected = precheckCheck(spec, startedAt);
		if (rejected !== undefined) return rejected;
		const check = Object.hasOwn(checks, spec.op) ? checks[spec.op] : undefined;
		if (check === undefined) return rejectedCheck(spec.op, "unknown_operation", "unknown operation", startedAt);
		const layout = await ensureTaskLayout(options.taskDir);
		const scratch = await createScratch(layout.scratchRoot);
		const name = containerName("check", spec.taskId, spec.generation);
		entries.set(name, { taskId: spec.taskId, generation: spec.generation, kind: "check" });
		try {
			return await execute(check, spec, startedAt);
		} catch (error) {
			log.warn("check_failed", { task: spec.taskId, op: spec.op, reason: errorSummary(error) });
			return rejectedCheck(spec.op, "error", "the check could not run", startedAt);
		} finally {
			remove(name);
			await removeScratch(scratch);
		}
	};

	return {
		async available() {
			try {
				await ensureTaskLayout(options.taskDir);
				if (!(await stat(fsopPath)).isFile()) return { ok: false, reason: "fsop.mjs not found" };
				return { ok: true };
			} catch {
				return { ok: false, reason: "local sandbox: task directory or fsop.mjs unavailable" };
			}
		},
		startAgent,
		runCheck,
		checkOps: () => Object.keys(checks).filter((op) => op !== "setup" && OP_NAME.test(op)),
		async killAll(filter?: ContainerFilter) {
			for (const name of matching(filter)) remove(name);
		},
		async live(filter?: ContainerFilter) {
			return matching(filter);
		},
	};
}
