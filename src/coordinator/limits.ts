/**
 * Demo limits from the design docs (Capacity § Fixed limits, Agent Execution § Limits). They are fixed for the
 * demo deployment: production code always uses `DEMO_LIMITS`; only tests pass overrides (shorter deadlines, smaller
 * caps) through `CoordinatorDeps.limits`.
 *
 * "48K / 16K" tokens are read as 48,000 / 16,000 (the smaller, safer reading of "K"); tool results are capped at
 * 16 KiB = 16,384 bytes, as the docs say KiB explicitly.
 */
export type Limits = {
	/** Deployment-wide concurrent executions (runs and merge/review checks): Capacity "Concurrent execution". */
	readonly maxConcurrentRuns: number;
	/** At most one running task per agent. */
	readonly runsPerAgent: number;
	/** Waiting (queued) runs per agent / per group / per user. */
	readonly waitingPerAgent: number;
	readonly waitingPerGroup: number;
	readonly waitingPerUser: number;
	/** Open tasks per group: running, in review or merging (tasks with a live worktree); queued first runs excluded. */
	readonly openTasksPerGroup: number;
	/** Model requests per run, retries included, shared with the run's successor (enforced at the relay). */
	readonly modelRequestsPerRun: number;
	/** Pi durable retries per model call; provider (SDK) retries are 0. */
	readonly retriesPerCall: number;
	/** Run deadline, enforced by the watchdog path independently of Pi. */
	readonly runDeadlineMs: number;
	/** run_check (and setup/test) container time limit. */
	readonly checkDeadlineMs: number;
	/** Estimated tokens of the fully assembled model input; above this the request is refused before it is sent. */
	readonly maxInputTokens: number;
	/** Max output tokens per request. */
	readonly maxOutputTokens: number;
	/** Follow-ups per task and characters per follow-up. */
	readonly followUpsPerTask: number;
	readonly followUpChars: number;
	/** Characters of a /task request (same bound as a follow-up; the docs set no separate figure). */
	readonly taskChars: number;
	/** Bytes of one tool result kept for the model; truncation is marked. */
	readonly toolResultBytes: number;
	/** Provisional container limits (Capacity § Provisional container limits). */
	readonly agentCpus: number;
	readonly agentMemoryMiB: number;
	readonly agentPids: number;
	readonly checkCpus: number;
	readonly checkMemoryMiB: number;
	readonly checkPids: number;
	/**
	 * The isolated evaluator (Capacity § Provisional container limits: "Evaluator, exclusive phase 2 vCPU 2 GiB"; Agent
	 * Execution § Containers): one container after sealing, its suites one after another, stopped at this deadline (a
	 * provisional figure: the docs set none; each suite also has its own bound in the image's suite list).
	 */
	readonly evaluatorCpus: number;
	readonly evaluatorMemoryMiB: number;
	readonly evaluatorPids: number;
	readonly evaluatorDeadlineMs: number;
	/**
	 * Free-space floor of both disks (Capacity § Disk), the default of PI_BOOT_DISK_MIN_FREE and PI_TASK_DISK_MIN_FREE:
	 * new /task requests are rejected while the boot disk (PI_DATA_DIR) has less free; a new worktree is created only if
	 * at least this much stays free on the task disk (PI_TASK_DIR) after it (src/coordinator/disk.ts).
	 */
	readonly minFreeDiskBytes: number;
	/**
	 * Room a new worktree is assumed to need beyond its checked-out files (dependencies, build output), the default of
	 * PI_WORKTREE_HEADROOM. Provisional: the stress test sets the task disk's size (Capacity § Disk).
	 */
	readonly worktreeHeadroomBytes: number;
	/** A task in review past this gets one reminder. */
	readonly reviewReminderMs: number;
	/** Grace period for a stop (abort → terminate → verify) before it counts as unconfirmed. */
	readonly stopGraceMs: number;
};

export const DEMO_LIMITS: Limits = Object.freeze({
	maxConcurrentRuns: 2,
	runsPerAgent: 1,
	waitingPerAgent: 2,
	waitingPerGroup: 4,
	waitingPerUser: 4,
	openTasksPerGroup: 4,
	modelRequestsPerRun: 30,
	retriesPerCall: 2,
	runDeadlineMs: 10 * 60_000,
	checkDeadlineMs: 60_000,
	maxInputTokens: 48_000,
	maxOutputTokens: 16_000,
	followUpsPerTask: 5,
	followUpChars: 4000,
	taskChars: 4000,
	toolResultBytes: 16 * 1024,
	agentCpus: 0.5,
	agentMemoryMiB: 512,
	agentPids: 128,
	checkCpus: 1,
	checkMemoryMiB: 1024,
	checkPids: 256,
	evaluatorCpus: 2,
	evaluatorMemoryMiB: 2048,
	evaluatorPids: 512,
	evaluatorDeadlineMs: 30 * 60_000,
	minFreeDiskBytes: 1024 * 1024 * 1024,
	worktreeHeadroomBytes: 1024 * 1024 * 1024,
	reviewReminderMs: 24 * 60 * 60_000,
	stopGraceMs: 15_000,
});
