/**
 * Starts one Pi process per run (src/runner/main.ts) and talks to it over Node IPC (src/runner/protocol.ts).
 *
 * The child gets a minimal environment: PATH, HOME = `<dataDir>/run-home` (empty, mode 700), OPENAI_API_KEY = the run
 * key (its only secret), NODE_NO_WARNINGS=1; nothing else is inherited (no NODE_OPTIONS, no parent flags). It runs
 * detached in its own process group so `kill()` signals the whole group. Its stdout and stderr are drained here and
 * never forwarded as text: only `@pi-runner {json}` metadata lines are logged, with allowlisted primitive fields;
 * everything else is counted.
 */
import { type ChildProcess, fork, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { isFromRunner, type RunnerStart, type ToRunner } from "../runner/protocol.ts";
import { errorSummary, type Logger } from "../runtime/log.ts";
import type { RunLauncher, RunnerExit, RunnerHandle } from "./ports.ts";

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
const NOTE_EVENT = /^[a-z][a-z0-9_]{0,47}$/;
const NOTE_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const NOTE_VALUE = /^[\w.:-]{0,64}$/;
/** At most this many metadata lines are logged per process; the rest are counted. */
const MAX_NOTES = 200;

/** The default runner entry next to this module. */
export function defaultRunnerPath(): string {
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	return fileURLToPath(new URL(`../runner/main.${extension}`, import.meta.url));
}

export function createRunLauncher(options: RunLauncherOptions): RunLauncher {
	const { dataDir, log } = options;
	const runnerPath = options.runnerPath ?? defaultRunnerPath();
	const execArgv = [...(options.execArgv ?? [])];
	const testEnv: Record<string, string> = {};
	for (const [name, value] of Object.entries(options.testEnv ?? {})) {
		if (!/^PI_RUNNER_TEST_[A-Z0-9_]+$/.test(name))
			throw new Error(`testEnv: ${name} is not a PI_RUNNER_TEST_ variable`);
		testEnv[name] = value;
	}
	return {
		launch(start: RunnerStart, runKey: string, onMessage) {
			const home = join(dataDir, "run-home");
			mkdirSync(home, { recursive: true, mode: 0o700 });
			chmodSync(home, 0o700);
			const env: Record<string, string> = {
				PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
				HOME: home,
				OPENAI_API_KEY: runKey,
				NODE_NO_WARNINGS: "1",
				...testEnv,
			};
			// STUB(spec: deployment.md § Pi processes, § Watchdog): Pi processes should run as their own unprivileged user
			// in a dedicated systemd slice (the watchdog kills the slice; the metadata server is firewalled for that user).
			// Here they run as the Coordinator's user in their own process group, which kill() signals as a whole.
			const child = fork(runnerPath, [], {
				cwd: home,
				env,
				execArgv,
				detached: true,
				serialization: "json",
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			});
			const meta = { runId: start.runId, taskId: start.taskId, pid: child.pid };
			const counts = { stdoutLines: 0, notes: 0, stderrBytes: 0, stderrLines: 0 };
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
			log.info("runner_launched", { ...meta, fresh: start.fresh, steers: start.steers.length });
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
		isRunner(pid: number): boolean {
			if (!Number.isInteger(pid) || pid <= 1) return false;
			const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
				encoding: "utf8",
				timeout: 5000,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			});
			if (result.status !== 0 || typeof result.stdout !== "string") return false;
			return /runner[/\\]main\.(ts|js)\b/.test(result.stdout);
		},
	};
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

function drainStdout(
	stream: Readable | null,
	log: Logger,
	meta: Record<string, unknown>,
	counts: { stdoutLines: number; notes: number },
): void {
	if (stream === null) return;
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	lines.on("line", (line) => {
		const fields = line.startsWith(NOTE_PREFIX) ? parseNote(line.slice(NOTE_PREFIX.length)) : undefined;
		if (fields === undefined || counts.notes >= MAX_NOTES) {
			counts.stdoutLines++;
			return;
		}
		counts.notes++;
		const { event, ...rest } = fields;
		log.info("runner_note", { ...meta, note: event, ...rest });
	});
	lines.on("error", () => {});
}

function drainStderr(stream: Readable | null, counts: { stderrBytes: number; stderrLines: number }): void {
	if (stream === null) return;
	stream.on("data", (chunk: Buffer) => {
		counts.stderrBytes += chunk.byteLength;
		for (const byte of chunk) if (byte === 0x0a) counts.stderrLines++;
	});
	stream.on("error", () => {});
}

type NoteFields = { event: string } & Record<string, string | number | boolean>;

/** A metadata line's fields, when it is one: an event name and allowlisted primitive values. */
function parseNote(json: string): NoteFields | undefined {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.event !== "string" || !NOTE_EVENT.test(record.event)) return undefined;
	const fields: NoteFields = { event: record.event };
	for (const [key, field] of Object.entries(record)) {
		if (allowedNoteField(key, field)) fields[key] = field;
	}
	return fields;
}

/** Only short identifiers, numbers and booleans pass; the launcher's own fields cannot be overridden. */
function allowedNoteField(key: string, field: unknown): field is string | number | boolean {
	if (!NOTE_KEY.test(key) || ["event", "runId", "taskId", "pid"].includes(key)) return false;
	if (typeof field === "number") return Number.isFinite(field);
	if (typeof field === "boolean") return true;
	return typeof field === "string" && NOTE_VALUE.test(field);
}
