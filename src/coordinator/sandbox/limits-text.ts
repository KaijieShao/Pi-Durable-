/**
 * Helpers shared by the Docker sandbox and the local test sandbox: bounded output, named limit outcomes, the
 * file-operation client (fsop.mjs over stdin/stdout), task-disk layout (empty-git mask, scratch space) and names.
 * Nothing here logs content: callers log metadata only (Deployment § Logs).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, chown, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CheckOutcome, CheckResult, ContainerFilter, FsErrorCode, FsRequest, FsResponse } from "../ports.ts";

/** Coordinator-side limit for one file operation (design: 30 s → `timeout`). fsop.mjs gives up by itself at 25 s. */
export const FS_TIMEOUT_MS = 30_000;
/** Largest request sent to fsop.mjs (it refuses content over 1 MiB itself; this bounds JSON escaping). */
export const FS_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** fsop.mjs prints at most 64 KiB of read output; anything far larger is a malfunction. */
export const FS_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
/**
 * Total output a check may emit before it is stopped with `output_limit` (Agent Execution § Output and Context:
 * "Total emitted output is bounded separately"). Below this, only the tail is kept and `truncated` is set.
 */
export const CHECK_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
/** Room kept free in a check's output for the outcome trailer line. */
const TRAILER_ROOM = 256;

/** Container / operation names. Check ops: lower-case word, as in ops.json. */
export const OP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

const FS_ERROR_CODES: readonly FsErrorCode[] = [
	"denied",
	"not_found",
	"invalid",
	"too_large",
	"not_unique",
	"io",
	"timeout",
	"unavailable",
];

// ---------------------------------------------------------------------------------------------------------------
// Bounded output

/** Keeps the last `maxBytes` bytes of a stream; `text()` marks truncation and never splits a UTF-8 character. */
export class TailBuffer {
	readonly #max: number;
	#chunks: Buffer[] = [];
	#size = 0;
	#total = 0;

	constructor(maxBytes: number) {
		this.#max = Math.max(256, Math.floor(maxBytes));
	}

	push(chunk: Buffer | string): void {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		if (buffer.length === 0) return;
		this.#total += buffer.length;
		this.#chunks.push(buffer);
		this.#size += buffer.length;
		while (this.#chunks.length > 1 && this.#size - (this.#chunks[0]?.length ?? 0) >= this.#max) {
			this.#size -= this.#chunks.shift()?.length ?? 0;
		}
		if (this.#chunks.length > 64) {
			const all = Buffer.concat(this.#chunks);
			const kept = all.subarray(Math.max(0, all.length - this.#max));
			this.#chunks = [Buffer.from(kept)];
			this.#size = kept.length;
		}
	}

	get totalBytes(): number {
		return this.#total;
	}

	get truncated(): boolean {
		return this.#total > this.#max;
	}

	text(): string {
		const all = Buffer.concat(this.#chunks);
		if (!this.truncated) return all.toString("utf8");
		const marker = `[truncated: earlier output omitted, ${this.#total} bytes in total]\n`;
		const keep = Math.max(0, this.#max - Buffer.byteLength(marker));
		const tail = all.subarray(Math.max(0, all.length - keep));
		let start = 0;
		while (start < tail.length && ((tail[start] ?? 0) & 0xc0) === 0x80) start++;
		return marker + tail.subarray(start).toString("utf8");
	}
}

/**
 * Fork / thread creation failures under the pids limit, as shells, Node and libc report them. Untrusted output can
 * fake this, but it can only turn a failure into another failure: "passed" depends on the exit code alone.
 */
const PROCESS_LIMIT =
	/resource temporarily unavailable|fork: retry|cannot fork|spawn\s+\S*\s*EAGAIN|EAGAIN.{0,40}(?:spawn|fork|thread)|pthread_create|uv_thread_create/i;

/** Tail + total-output bound + process-limit detection for one check's combined stdout/stderr. */
export class OutputMonitor {
	readonly tail: TailBuffer;
	readonly #hardLimit: number;
	#carry = "";
	#processLimit = false;

	constructor(tailBytes: number, hardLimitBytes: number = CHECK_OUTPUT_LIMIT_BYTES) {
		this.tail = new TailBuffer(Math.max(256, tailBytes - TRAILER_ROOM));
		this.#hardLimit = hardLimitBytes;
	}

	/** Returns true once the total output passed the hard limit. */
	push(chunk: Buffer): boolean {
		this.tail.push(chunk);
		if (!this.#processLimit) {
			const text = this.#carry + chunk.toString("latin1");
			if (PROCESS_LIMIT.test(text)) this.#processLimit = true;
			this.#carry = text.slice(-128);
		}
		return this.tail.totalBytes > this.#hardLimit;
	}

	get processLimitSeen(): boolean {
		return this.#processLimit;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Check outcomes

/** What the sandbox observed about one check; `classifyCheck` turns it into the named outcome. */
export type CheckFacts = {
	/** The spawn of the container runtime itself failed (e.g. Docker missing). */
	readonly spawnFailed: boolean;
	/** The check process (container) actually started. */
	readonly started: boolean;
	readonly exitCode: number | undefined;
	/** The Coordinator's deadline stopped it. */
	readonly timedOut: boolean;
	/** The caller's signal stopped it (cancel / limit of the run). */
	readonly aborted: boolean;
	/** Total output passed CHECK_OUTPUT_LIMIT_BYTES and it was stopped. */
	readonly outputLimited: boolean;
	/** The container runtime reported an out-of-memory kill. */
	readonly oomKilled: boolean;
	/** Output shows a fork / thread creation failure. */
	readonly processLimitSeen: boolean;
};

/** Exit codes reserved by deploy/docker/run-check.mjs. */
export const EXIT_UNKNOWN_OPERATION = 64;
export const EXIT_LAUNCHER_DEADLINE = 124;

/**
 * Named outcome for every limit the container can report (Agent Execution § Agent and check enforcement). Only exit
 * code 0 with no limit hit is "passed"; a limit or an uncertain start is never "passed".
 */
export function classifyCheck(facts: CheckFacts): CheckOutcome {
	if (facts.spawnFailed) return "unavailable";
	if (facts.aborted || !facts.started) return "error";
	if (facts.timedOut) return "timeout";
	if (facts.outputLimited) return "output_limit";
	if (facts.oomKilled) return "memory_limit";
	if (facts.exitCode === EXIT_LAUNCHER_DEADLINE) return "timeout";
	if (facts.exitCode === 0) return "passed";
	if (facts.exitCode === EXIT_UNKNOWN_OPERATION) return "unknown_operation";
	if (facts.processLimitSeen) return "process_limit";
	return "failed";
}

export type LimitFigures = { readonly timeoutMs: number; readonly memoryMiB?: number; readonly pids?: number };

/** One trailer line naming the limit that ended the check (empty for passed / failed). */
export function outcomeTrailer(outcome: CheckOutcome, figures: LimitFigures): string {
	const seconds = Math.round(figures.timeoutMs / 100) / 10;
	switch (outcome) {
		case "timeout":
			return `[timeout: the check exceeded its ${seconds} s limit and was stopped]`;
		case "memory_limit":
			return `[memory_limit: the check exceeded its ${figures.memoryMiB ?? "?"} MiB memory limit and was killed]`;
		case "process_limit":
			return `[process_limit: the check could not start more processes (limit ${figures.pids ?? "?"})]`;
		case "output_limit":
			return `[output_limit: the check printed more than ${CHECK_OUTPUT_LIMIT_BYTES / (1024 * 1024)} MiB and was stopped]`;
		case "unknown_operation":
			return "[unknown_operation: not in the approved operation list]";
		case "unavailable":
			return "[unavailable: the check sandbox is not available]";
		case "error":
			return "[error: the check could not run to completion]";
		default:
			return "";
	}
}

/** Output text with the trailer appended. */
export function withTrailer(output: string, trailer: string): string {
	if (trailer === "") return output;
	return output === "" || output.endsWith("\n") ? `${output}${trailer}` : `${output}\n${trailer}`;
}

/** A result for a check that never ran (rejected before any container started). */
export function rejectedCheck(op: string, outcome: CheckOutcome, message: string, startedAt: number): CheckResult {
	return { op, outcome, exitCode: undefined, output: message, truncated: false, durationMs: Date.now() - startedAt };
}

/** Fields of `Sandbox.runCheck`'s spec checked before anything runs. */
export type CheckRequest = {
	readonly taskId: number;
	readonly generation: number;
	readonly op: string;
	readonly writable: boolean;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal | undefined;
};

/**
 * Reject a check request before any container starts: bad ids → error, an op that is not a lower-case word →
 * unknown_operation, writable for anything but "setup" → error, already aborted → error.
 */
export function precheckCheck(spec: CheckRequest, startedAt: number): CheckResult | undefined {
	const op = typeof spec.op === "string" ? spec.op : "";
	if (!validIds(spec.taskId, spec.generation) || !positiveFinite(spec.timeoutMs)) {
		return rejectedCheck(op, "error", "invalid check request", startedAt);
	}
	if (!OP_NAME.test(op)) return rejectedCheck(op, "unknown_operation", "unknown operation", startedAt);
	if (spec.writable && op !== "setup") {
		return rejectedCheck(op, "error", "only the setup operation may write to the worktree", startedAt);
	}
	if (spec.signal?.aborted === true) return rejectedCheck(op, "error", "check cancelled", startedAt);
	return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// File operations (fsop.mjs client)

/** Shape check before anything is sent (fsop.mjs repeats every rule; this only keeps junk off the wire). */
export function checkFsRequest(request: FsRequest): FsResponse | undefined {
	const value = request as unknown as Record<string, unknown> | null;
	if (typeof value !== "object" || value === null) return fsError("invalid", "request must be an object");
	if (value.op !== "read" && value.op !== "write" && value.op !== "edit") {
		return fsError("invalid", "op must be read, write or edit");
	}
	if (typeof value.path !== "string" || value.path === "") return fsError("invalid", "path must be a non-empty string");
	if (value.path.includes("\0")) return fsError("denied", "path contains a NUL byte");
	return undefined;
}

export function fsError(code: FsErrorCode, message: string): FsResponse {
	return { ok: false, code, message };
}

/** Parse fsop.mjs's response line; anything else is an `io` failure (or `unavailable` if the container is gone). */
export function parseFsResponse(stdout: string, stderr: string): FsResponse {
	const line = stdout.split("\n").find((part) => part.trim() !== "");
	if (line !== undefined) {
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (parsed.ok === true && typeof parsed.output === "string") {
				return { ok: true, output: parsed.output, truncated: parsed.truncated === true };
			}
			if (
				parsed.ok === false &&
				typeof parsed.message === "string" &&
				(FS_ERROR_CODES as readonly unknown[]).includes(parsed.code)
			) {
				return fsError(parsed.code as FsErrorCode, parsed.message.slice(0, 1000));
			}
		} catch {
			// fall through
		}
	}
	if (/no such container|is not running|cannot exec in a stopped/i.test(stderr)) {
		return fsError("unavailable", "the task container is not running");
	}
	return fsError("io", "file operation failed");
}

/**
 * Run `command args` (fsop.mjs directly, or `docker exec ... fsop.mjs`) with the request as JSON on stdin. Never a
 * shell. The deadline kills the client and answers `timeout`; the signal answers `unavailable` ("cancelled").
 */
export function runFsop(
	command: string,
	args: readonly string[],
	request: FsRequest,
	options: { timeoutMs?: number; signal?: AbortSignal | undefined; env: NodeJS.ProcessEnv },
): Promise<FsResponse> {
	const invalid = checkFsRequest(request);
	if (invalid !== undefined) return Promise.resolve(invalid);
	const input = JSON.stringify(request);
	if (Buffer.byteLength(input) > FS_MAX_REQUEST_BYTES)
		return Promise.resolve(fsError("too_large", "request too large"));
	if (options.signal?.aborted === true) return Promise.resolve(fsError("unavailable", "file operation cancelled"));
	return new Promise((resolve) => {
		const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], env: options.env, shell: false });
		const stdout: Buffer[] = [];
		let stdoutBytes = 0;
		let stderr = "";
		let settled = false;
		const finish = (response: FsResponse): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(response);
		};
		const kill = (response: FsResponse): void => {
			child.kill("SIGKILL");
			finish(response);
		};
		const onAbort = (): void => kill(fsError("unavailable", "file operation cancelled"));
		const timer = setTimeout(
			() => kill(fsError("timeout", "file operation timed out")),
			options.timeoutMs ?? FS_TIMEOUT_MS,
		);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > FS_MAX_STDOUT_BYTES) kill(fsError("io", "file operation output too large"));
			else stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096);
		});
		child.on("error", () => finish(fsError("unavailable", "file operation could not start")));
		child.on("close", () => finish(parseFsResponse(Buffer.concat(stdout).toString("utf8"), stderr)));
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

// ---------------------------------------------------------------------------------------------------------------
// Task-disk layout

export type TaskLayout = {
	/** Empty read-only file mounted over /work/.git (a worktree's .git is a file). */
	readonly emptyGit: string;
	/** Empty read-only directory, used instead when a worktree's .git is a directory. */
	readonly emptyGitDir: string;
	/** Parent of the per-check scratch directories. */
	readonly scratchRoot: string;
};

/** Ensure `<taskDir>/empty-git` (empty file, mode 0444), `<taskDir>/empty-git-dir` (0555) and `<taskDir>/scratch`. */
export async function ensureTaskLayout(taskDir: string): Promise<TaskLayout> {
	await mkdir(taskDir, { recursive: true, mode: 0o700 });
	const layout: TaskLayout = {
		emptyGit: join(taskDir, "empty-git"),
		emptyGitDir: join(taskDir, "empty-git-dir"),
		scratchRoot: join(taskDir, "scratch"),
	};
	await ensureEmptyFile(layout.emptyGit);
	await ensureEmptyDir(layout.emptyGitDir);
	await mkdir(layout.scratchRoot, { recursive: true, mode: 0o700 });
	return layout;
}

async function lstatOrUndefined(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function ensureEmptyFile(path: string): Promise<void> {
	const stat = await lstatOrUndefined(path);
	if (stat !== undefined && (!stat.isFile() || stat.size !== 0)) await rm(path, { recursive: true, force: true });
	if (stat === undefined || !stat.isFile() || stat.size !== 0) {
		const handle = await open(path, "wx", 0o444);
		await handle.close();
	}
	await chmod(path, 0o444);
}

async function ensureEmptyDir(path: string): Promise<void> {
	const stat = await lstatOrUndefined(path);
	const usable = stat?.isDirectory() === true && (await readdir(path)).length === 0;
	if (stat !== undefined && !usable) {
		await chmod(path, 0o700).catch(() => {});
		await rm(path, { recursive: true, force: true });
	}
	if (!usable) await mkdir(path, { mode: 0o555 });
	await chmod(path, 0o555);
}

/** Parse "uid:gid". */
export function parseUser(user: string): { uid: number; gid: number } | undefined {
	const match = /^(\d+):(\d+)$/.exec(user);
	if (match === null) return undefined;
	return { uid: Number(match[1]), gid: Number(match[2]) };
}

/**
 * A fresh scratch directory for one check (mode 0700). If the container runs as another uid, it is handed to that
 * uid (as root) or opened up (0777; its parent stays 0700, so other host users still cannot reach it).
 */
export async function createScratch(scratchRoot: string, user?: string): Promise<string> {
	const path = join(scratchRoot, randomBytes(8).toString("hex"));
	await mkdir(path, { mode: 0o700 });
	const owner = user === undefined ? undefined : parseUser(user);
	const self = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (owner !== undefined && self !== undefined && owner.uid !== self) {
		if (self === 0) await chown(path, owner.uid, owner.gid);
		else await chmod(path, 0o777);
	}
	return path;
}

/** Delete a scratch directory; false if it could not be removed completely. */
export async function removeScratch(path: string): Promise<boolean> {
	try {
		await rm(path, { recursive: true, force: true, maxRetries: 2 });
		return (await lstatOrUndefined(path)) === undefined;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Names and filters

/** `pd-t<task>-g<gen>-<hex>` for agent containers, `pd-c<task>-g<gen>-<hex>` for check containers. */
export function containerName(kind: "agent" | "check", taskId: number, generation: number): string {
	return `pd-${kind === "agent" ? "t" : "c"}${taskId}-g${generation}-${randomBytes(4).toString("hex")}`;
}

export function validIds(taskId: unknown, generation: unknown): boolean {
	return (
		typeof taskId === "number" &&
		Number.isSafeInteger(taskId) &&
		taskId >= 0 &&
		typeof generation === "number" &&
		Number.isSafeInteger(generation) &&
		generation >= 0
	);
}

export function positiveFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function matchesFilter(entry: { taskId: number; generation: number }, filter?: ContainerFilter): boolean {
	if (filter?.taskId !== undefined && entry.taskId !== filter.taskId) return false;
	if (filter?.generation !== undefined && entry.generation !== filter.generation) return false;
	return true;
}

/** True if `path` is a valid relative setup-script path (same rule as config and run-check.mjs). */
export function validSetupScript(path: string): boolean {
	const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
	return (
		path !== "" &&
		!path.startsWith("/") &&
		!path.includes("\0") &&
		!/[\n\r]/.test(path) &&
		segments.length > 0 &&
		segments.every((segment) => segment !== ".." && segment.toLowerCase() !== ".git")
	);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
