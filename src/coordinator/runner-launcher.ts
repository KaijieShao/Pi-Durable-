/**
 * "process" isolation of Pi processes: the weaker LOCAL mode (macOS, development). Starts one Pi process per run
 * (src/runner/main.ts) as a child of the Coordinator, as the Coordinator's own user, and talks to it over Node IPC
 * (src/runner/protocol.ts). On Linux deployments the "systemd" isolation (runner-systemd.ts) is the default: its own
 * unprivileged user, a dedicated slice, a per-unit IP filter. Here there is none of that: the only separation is the
 * minimal environment, the private run home and the process group (docs/isolation.md).
 *
 * The child gets a minimal environment: PATH, HOME = `<dataDir>/run-home` (empty, mode 700), OPENAI_API_KEY = the run
 * key (its only secret), NODE_NO_WARNINGS=1; nothing else is inherited (no NODE_OPTIONS, no parent flags). Its argv
 * carries the deployment and run markers (src/runner/argv.ts; no secrets), so it can be found again by `ps` after a
 * restart: by its recorded pid, or by restart cleanup's deployment-wide listing (`leftovers()`). It runs detached in
 * its own process group so `kill()` signals the whole group. Its stdout and stderr are
 * drained here and never forwarded as text: only `@pi-runner {json}` metadata lines are logged, with allowlisted
 * primitive fields; everything else is counted.
 */
import { type ChildProcess, fork, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { deploymentId, hasRunnerMarkers, markedRunId, runnerArgv } from "../runner/argv.ts";
import { isFromRunner, type RunnerStart, type ToRunner } from "../runner/protocol.ts";
import { errorSummary, type Logger } from "../runtime/log.ts";
import type { RunLauncher, RunnerExit, RunnerHandle, RunnerRef } from "./ports.ts";
import {
	checkTestEnv,
	drainStderr,
	FALLBACK_PATH,
	logNote,
	newOutputCounts,
	type OutputCounts,
	parseNoteJson,
} from "./runner-common.ts";

export type RunLauncherOptions = {
	readonly dataDir: string;
	readonly log: Logger;
	/** The runner entry; default `../runner/main.ts` next to this file (`main.js` when running from dist). */
	readonly runnerPath?: string;
	/** Node flags for the child; default none (the parent's own flags, such as `--test`, are never inherited). */
	readonly execArgv?: readonly string[];
	/** TEST ONLY: extra variables for the child; only names starting with PI_RUNNER_TEST_ are accepted. */
	readonly testEnv?: Readonly<Record<string, string>>;
};

const NOTE_PREFIX = "@pi-runner ";
/** The runner's entry in a Pi process's command line (src or dist). */
const RUNNER_COMMAND = /runner[/\\]main\.(ts|js)\b/;

/** The default runner entry next to this module. */
export function defaultRunnerPath(): string {
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	return fileURLToPath(new URL(`../runner/main.${extension}`, import.meta.url));
}

export function createRunLauncher(options: RunLauncherOptions): RunLauncher {
	const { dataDir, log } = options;
	const runnerPath = options.runnerPath ?? defaultRunnerPath();
	const execArgv = [...(options.execArgv ?? [])];
	const testEnv = checkTestEnv(options.testEnv);
	const deployment = deploymentId(dataDir);
	const isRunner = (ref: RunnerRef): boolean => ref.pid !== null && isPiProcess(ref.pid, deployment, ref.runId);
	return {
		isolation: "process",
		// Nothing to check: this mode is a plain child process (the sandbox check still gates execution).
		available: async () => ({ ok: true }),
		launch(start: RunnerStart, runKey: string, onMessage) {
			const home = join(dataDir, "run-home");
			mkdirSync(home, { recursive: true, mode: 0o700 });
			chmodSync(home, 0o700);
			const env: Record<string, string> = {
				PATH: process.env.PATH ?? FALLBACK_PATH,
				HOME: home,
				OPENAI_API_KEY: runKey,
				NODE_NO_WARNINGS: "1",
				...testEnv,
			};
			const args = runnerArgv({ transport: "ipc", conversationAccess: "private", deployment, runId: start.runId });
			const child = fork(runnerPath, args, {
				cwd: home,
				env,
				execArgv,
				detached: true,
				serialization: "json",
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			});
			const meta = { runId: start.runId, taskId: start.taskId, pid: child.pid };
			const counts = newOutputCounts();
			drainStdout(child.stdout, log, meta, counts);
			drainStderr(child.stderr, counts);
			let exitedFlag = false;
			const exited = new Promise<RunnerExit>((resolve) => {
				child.once("exit", (code, signal) => {
					exitedFlag = true;
					log.info("runner_exit", { ...meta, code: code ?? undefined, signal: signal ?? undefined, ...counts });
					resolve({ code, signal });
				});
				child.once("error", (error) => {
					log.error("runner_process_error", { ...meta, error: errorSummary(error) });
					// A spawn failure emits no "exit"; a later error of a live child does not end it.
					if (child.pid === undefined && !exitedFlag) {
						exitedFlag = true;
						resolve({ code: null, signal: null });
					}
				});
			});
			child.on("message", (message: unknown) => {
				if (!isFromRunner(message)) {
					log.warn("runner_bad_message", meta);
					return;
				}
				try {
					onMessage(message);
				} catch (error) {
					log.error("runner_message_handler_failed", { ...meta, type: message.type, error: errorSummary(error) });
				}
			});
			log.info("runner_launched", { ...meta, fresh: start.fresh, steers: start.steers.length, isolation: "process" });
			const handle: RunnerHandle = {
				pid: child.pid,
				send: (message: ToRunner) => send(child, message, log, meta),
				kill: () => {
					if (exitedFlag) return;
					killGroup(child);
				},
				exited,
			};
			handle.send(start);
			return handle;
		},
		isRunner,
		leftovers: () => markedProcesses(deployment),
		killRunner(ref: RunnerRef): void {
			// Only a process that carries this deployment's and this run's markers (never a reused pid).
			if (ref.pid === null || !isRunner(ref)) return;
			for (const target of [-ref.pid, ref.pid]) {
				try {
					process.kill(target, "SIGKILL");
				} catch {
					// Not ours or already gone.
				}
			}
		},
	};
}

/** True if `pid` is a live Pi process of this deployment serving `runId` (by its command line). */
function isPiProcess(pid: number, deployment: string, runId: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	const result = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
		encoding: "utf8",
		timeout: 5000,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return false;
	return RUNNER_COMMAND.test(result.stdout) && hasRunnerMarkers(result.stdout, deployment, runId);
}

/**
 * Restart cleanup, deployment-wide: every live Pi process (not this one) whose command line carries this deployment's
 * markers, whatever run it served; undefined when `ps` cannot list the processes.
 */
function markedProcesses(deployment: string): RunnerRef[] | undefined {
	const result = spawnSync("ps", ["-A", "-ww", "-o", "pid=,command="], {
		encoding: "utf8",
		timeout: 5000,
		maxBuffer: 16 * 1024 * 1024,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
	});
	if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") return undefined;
	const refs: RunnerRef[] = [];
	for (const line of result.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(.*)$/.exec(line);
		const pid = Number(match?.[1]);
		const command = match?.[2] ?? "";
		const runId = RUNNER_COMMAND.test(command) ? markedRunId(command, deployment) : undefined;
		if (runId !== undefined && pid !== process.pid) refs.push({ runId, generation: 0, pid });
	}
	return refs;
}

function send(child: ChildProcess, message: ToRunner, log: Logger, meta: Record<string, unknown>): void {
	if (!child.connected) {
		log.debug("runner_send_skipped", { ...meta, type: message.type });
		return;
	}
	try {
		child.send(message, (error) => {
			if (error) log.warn("runner_send_failed", { ...meta, type: message.type });
		});
	} catch {
		log.warn("runner_send_failed", { ...meta, type: message.type });
	}
}

/** SIGKILL the child's process group (it is a group leader: detached), falling back to the child alone. */
function killGroup(child: ChildProcess): void {
	const pid = child.pid;
	if (pid !== undefined) {
		try {
			process.kill(-pid, "SIGKILL");
			return;
		} catch {
			// No such group (already gone, or not a leader): try the process itself.
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		// Already gone.
	}
}

function drainStdout(stream: Readable | null, log: Logger, meta: Record<string, unknown>, counts: OutputCounts): void {
	if (stream === null) return;
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	lines.on("line", (line) => {
		const fields = line.startsWith(NOTE_PREFIX) ? parseNoteJson(line.slice(NOTE_PREFIX.length)) : undefined;
		logNote(log, meta, fields, counts);
	});
	lines.on("error", () => {});
}
