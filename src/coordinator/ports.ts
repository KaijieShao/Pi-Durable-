/**
 * Interfaces between the Coordinator core and the outside world. Production implementations:
 * Telegram → src/coordinator/telegram/api.ts, GitHub → src/coordinator/github.ts, git → src/coordinator/git.ts,
 * containers → src/coordinator/sandbox/docker.ts, Pi processes → src/coordinator/runner-systemd.ts (Linux) or
 * src/coordinator/runner-launcher.ts (local).
 * Tests swap in fakes (fake Bot API over HTTP, fake GitHub over HTTP, local test sandbox).
 */
import type { Update } from "grammy/types";
import type { FromRunner, RunnerStart, ToRunner } from "../runner/protocol.ts";

// ---------------------------------------------------------------------------------------------------------------
// Telegram Bot API (subset). Errors are TelegramError with a classified kind.

export type TelegramMe = { readonly id: number; readonly username: string; readonly canReadAllGroupMessages: boolean };

export type SendMessageParams = {
	readonly chatId: number;
	readonly text: string;
	/** Forum topic; omitted for General / non-forum groups. */
	readonly threadId?: number | undefined;
	readonly replyTo?: number | undefined;
};

export interface TelegramApi {
	getMe(signal?: AbortSignal): Promise<TelegramMe>;
	/** Long polling: `timeout` seconds (30 in production). */
	getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<Update[]>;
	sendMessage(params: SendMessageParams, signal?: AbortSignal): Promise<{ messageId: number }>;
}

export type TelegramErrorKind = "network" | "server" | "rate_limited" | "unauthorized" | "permanent";

export class TelegramError extends Error {
	readonly kind: TelegramErrorKind;
	readonly status: number | undefined;
	/** Seconds Telegram asked us to wait (429 parameters.retry_after). */
	readonly retryAfterSeconds: number | undefined;
	constructor(kind: TelegramErrorKind, message: string, status?: number, retryAfterSeconds?: number) {
		super(message);
		this.name = "TelegramError";
		this.kind = kind;
		this.status = status;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// GitHub (REST, fine-grained token for one repository). Only the Coordinator calls it.

export type PullRequest = {
	readonly number: number;
	readonly url: string;
	readonly state: "open" | "closed";
	readonly merged: boolean;
	readonly headSha: string;
	readonly headRef: string;
	readonly baseRef: string;
	readonly mergeCommitSha: string | undefined;
};

export type MergeResult =
	| { readonly merged: true; readonly sha: string }
	/** 405 not mergeable / not up to date, 409 head modified, 422 invalid: GitHub refused; nothing merged. */
	| { readonly merged: false; readonly status: number; readonly reason: string };

export interface GitHubApi {
	/** The task's pull request, matched by repository, base branch and head branch; open or closed. */
	findPullRequest(head: string, base: string): Promise<PullRequest | undefined>;
	getPullRequest(number: number): Promise<PullRequest>;
	createPullRequest(params: { head: string; base: string; title: string; body: string }): Promise<PullRequest>;
	updatePullRequest(number: number, params: { title?: string; body?: string }): Promise<PullRequest>;
	closePullRequest(number: number): Promise<PullRequest>;
	/** Merge exactly `sha` with a merge commit; GitHub refuses if the head moved or main moved (up-to-date rule). */
	mergePullRequest(number: number, sha: string, commitTitle: string): Promise<MergeResult>;
	/** Current commit of a branch, or undefined if it does not exist. */
	branchSha(branch: string): Promise<string | undefined>;
	/** True if `commit` is reachable from `branch` (e.g. main already contains a task's head). */
	branchContains(branch: string, commit: string): Promise<boolean>;
}

/** `transient` = network error, 5xx or 429: safe to retry a read; a write is retried only after reading state. */
export class GitHubError extends Error {
	readonly status: number | undefined;
	readonly transient: boolean;
	constructor(message: string, status: number | undefined, transient: boolean) {
		super(message);
		this.name = "GitHubError";
		this.status = status;
		this.transient = transient;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Containers. Every file operation runs inside the task's agent container; run_check in a separate check container.

export type FsRequest =
	| { readonly op: "read"; readonly path: string; readonly offset?: number; readonly limit?: number }
	| { readonly op: "write"; readonly path: string; readonly content: string }
	| {
			readonly op: "edit";
			readonly path: string;
			readonly oldText: string;
			readonly newText: string;
			readonly replaceAll?: boolean;
	  };

export type FsErrorCode =
	| "denied"
	| "not_found"
	| "invalid"
	| "too_large"
	| "not_unique"
	| "io"
	| "timeout"
	| "unavailable";

export type FsResponse =
	| { readonly ok: true; readonly output: string; readonly truncated: boolean }
	| { readonly ok: false; readonly code: FsErrorCode; readonly message: string };

/** Named outcomes returned to the model (Agent Execution § Agent and check enforcement). */
export type CheckOutcome =
	| "passed"
	| "failed"
	| "timeout"
	| "memory_limit"
	| "process_limit"
	| "output_limit"
	| "unknown_operation"
	| "unavailable"
	| "error";

export type CheckResult = {
	readonly op: string;
	readonly outcome: CheckOutcome;
	readonly exitCode: number | undefined;
	/** Retained tail of combined output, capped at the tool-result limit. */
	readonly output: string;
	readonly truncated: boolean;
	readonly durationMs: number;
};

export type ContainerFilter = { readonly taskId?: number; readonly generation?: number };

export interface AgentSandbox {
	/** Container name (labels carry task id and generation). */
	readonly name: string;
	fileOp(request: FsRequest, signal?: AbortSignal): Promise<FsResponse>;
	/** Stop and remove the container; resolves once Docker no longer lists it. */
	stop(): Promise<void>;
}

export interface Sandbox {
	/** Fails closed: if enforcement (Docker, images) is unavailable, no execution starts. */
	available(): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
	startAgent(spec: {
		readonly taskId: number;
		readonly generation: number;
		readonly worktree: string;
		/** The container exits by itself after this, even if the Coordinator is gone. */
		readonly lifetimeMs: number;
	}): Promise<AgentSandbox>;
	/** Run one listed operation in a fresh check container: worktree read-only (writable only for "setup"). */
	runCheck(spec: {
		readonly taskId: number;
		readonly generation: number;
		readonly worktree: string;
		readonly op: string;
		readonly writable: boolean;
		readonly timeoutMs: number;
		readonly signal?: AbortSignal;
	}): Promise<CheckResult>;
	/** The fixed operation list, from the pinned check image (not from the worktree). */
	checkOps(): readonly string[];
	/** Kill and remove every matching managed container. */
	killAll(filter?: ContainerFilter): Promise<void>;
	/** Names of managed containers that still exist (empty = verified gone). */
	live(filter?: ContainerFilter): Promise<string[]>;
}

// ---------------------------------------------------------------------------------------------------------------
// Pi processes: one per run (src/runner/main.ts). Two isolations (Deployment § Processes):
//   "systemd" (src/coordinator/runner-systemd.ts): a transient unit as the Pi user in the Pi slice, stdio frames;
//   "process" (src/coordinator/runner-launcher.ts): a child of the Coordinator as its own user, Node IPC (local mode).

export type RunnerExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

export type Availability = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface RunnerHandle {
	/** The process the Coordinator started: the Pi process itself, or the systemd-run client of its unit. */
	readonly pid: number | undefined;
	send(message: ToRunner): void;
	/** SIGKILL the Pi process (its process group, or every process of its unit). */
	kill(): void;
	/** Resolves once the Pi process is gone (for a unit: the unit is inactive, not only its client). */
	readonly exited: Promise<RunnerExit>;
}

/** One start of a run, as recorded in its row: enough to find its Pi process again after a restart. */
export type RunnerRef = {
	readonly runId: number;
	/** The start's generation (systemd units are named by it; the process mode does not use it: 0 from leftovers()). */
	readonly generation: number;
	/** The pid recorded at launch (RunnerHandle.pid), if any. */
	readonly pid: number | null;
};

export interface RunLauncher {
	readonly isolation: "systemd" | "process";
	/** Fails closed: if this launcher's isolation is unusable, no execution starts (with Sandbox.available()). */
	available(): Promise<Availability>;
	/**
	 * Start a Pi process for one start of a run (`generation` of the dispatch). `runKey` is its only secret: it reaches
	 * the process through its environment (process) or its first stdin frame (systemd), never argv.
	 */
	launch(
		start: RunnerStart,
		runKey: string,
		onMessage: (message: FromRunner) => void,
		run: { readonly generation: number },
	): RunnerHandle;
	/** Restart cleanup: true if the Pi process of this start may still be alive. */
	isRunner(ref: RunnerRef): boolean;
	/** Restart cleanup: SIGKILL the Pi process of this start, if it is still there. */
	killRunner(ref: RunnerRef): void;
	/**
	 * Restart cleanup, deployment-wide (Deployment § Processes: the watchdog "kills everything in the slice"): every Pi
	 * process of this deployment that may still be there, whatever run it served (by unit name under systemd, by the
	 * argv markers in the process mode), for isRunner/killRunner; undefined when they cannot be listed. Called only
	 * while this Coordinator has no live run (recovery at startup and its recheck after an unfreeze).
	 */
	leftovers(): readonly RunnerRef[] | undefined;
}
