/**
 * IPC between the Coordinator and one Pi process (one process per run; Architecture § Pi Durable 1.5.0).
 * Messages travel over Node's `process.send` channel as plain JSON. The run key is NOT in any message: the child
 * reads it from its environment (OPENAI_API_KEY) and uses it only for requests to the relay.
 */

export type RunnerInput = {
	/** Text submitted to Pi as a user input. */
	readonly content: string;
	/** Pi `requestId` = the Telegram update id that carried the text (dedup for live retries only). */
	readonly requestId: string;
};

export type RunnerStart = {
	readonly type: "start";
	readonly runId: number;
	readonly taskId: number;
	/** Pi SQLite file of this run's conversation (one file per conversation). */
	readonly conversationPath: string;
	/** True when the conversation is new (first run, or a fresh conversation after an interrupted run). */
	readonly fresh: boolean;
	readonly model: {
		readonly modelId: string;
		readonly thinkingLevel: string;
		/** Relay base URL, e.g. http://127.0.0.1:PORT/v1 (becomes OPENAI_BASE_URL for the pi-ai openai provider). */
		readonly relayBaseUrl: string;
		readonly codexGateway: boolean;
	};
	/** The run's input. */
	readonly input: RunnerInput;
	/** Follow-ups accepted before the Pi process started: submitted as steers right after `input`. */
	readonly steers: readonly RunnerInput[];
	/** System instructions: the Coordinator's role text plus the repository's checked-in AGENTS.md at the base. */
	readonly instructions: string;
	readonly limits: {
		/** Pi durable retries per call (2); provider retries are forced to 0. */
		readonly maxRetries: number;
		/** Tool result cap in bytes (16 KiB), truncation marked. */
		readonly toolResultBytes: number;
		/** The child exits on its own after this (independent of the Coordinator's watchdog). */
		readonly deadlineMs: number;
	};
	/** run_check operations from the pinned check image. */
	readonly checkOps: readonly string[];
};

export type ToolName = "read" | "edit" | "write" | "run_check";

/** A tool result as the model sees it. */
export type ToolResult = { readonly ok: boolean; readonly text: string };

export type ToRunner =
	| RunnerStart
	/** A follow-up while the run is busy: submitted with whenBusy "steer"; at completion it becomes a successor run. */
	| { readonly type: "steer"; readonly requestId: string; readonly content: string }
	/** Answer to a `tool` request. */
	| { readonly type: "tool_result"; readonly id: number; readonly result: ToolResult }
	/**
	 * The relay admitted the run's last allowed model request (Agent Execution § Limits; Finalize and Pending Inputs
	 * "if the cap is already reached, it expires"): a steer could only reach the model in a request the cap refuses.
	 * Withdraw every steer still queued in Pi's inbox and refuse new ones, so Pi starts no successor run.
	 */
	| { readonly type: "cap_reached" }
	/** Cancel or a limit: abort Pi, let the in-flight tool round settle, then exit. */
	| { readonly type: "abort"; readonly reason: string };

export type SteerStatus =
	/** Accepted by Pi into the running work (queued in its inbox as a steer). */
	| "submitted"
	/** Arrived when the run was answering: submitted as the input of one successor run (same requestId). */
	| "successor"
	/**
	 * The model received it: Pi placed it into the conversation (in the running run or a successor) and a model
	 * response to a request that carried it was committed. A steer placed but never answered is not delivered.
	 */
	| "delivered"
	/** Not accepted (e.g. the process is shutting down); the Coordinator expires it. */
	| "rejected"
	/** Withdrawn from Pi's inbox, or refused, after `cap_reached`; the Coordinator expires it with the limit reason. */
	| "withdrawn";

export type RunnerOutcome =
	/** Pi answered every input and is idle: normal completion (quiescence confirmed). */
	| "answered"
	/** A Pi run ended unanswered (model error, refusal from the relay, turn limit...). */
	| "failed"
	/** Aborted on request. */
	| "aborted";

export type FromRunner =
	/** Harness open and the input submitted. */
	| { readonly type: "ready" }
	| {
			readonly type: "steer_status";
			readonly requestId: string;
			readonly status: SteerStatus;
			readonly detail?: string;
	  }
	/** A tool call the policy hook allowed; the Coordinator executes it in the task's container. */
	| { readonly type: "tool"; readonly id: number; readonly name: ToolName; readonly args: Record<string, unknown> }
	/** Metadata-only progress, e.g. "read src/app.js". Never raw content. */
	| { readonly type: "progress"; readonly text: string }
	| {
			readonly type: "finished";
			readonly outcome: RunnerOutcome;
			/** Pi's failure reason (runFailure reason and detail), if any. */
			readonly reason?: string;
			/** The final answer text, truncated (the agent's claim, not "passed"). */
			readonly answer?: string;
			/** requestIds of steers the model received (see SteerStatus "delivered"). */
			readonly delivered: readonly string[];
			/** requestIds of the other steers: never placed, withdrawn, or placed but never answered by the model. */
			readonly unconsumed: readonly string[];
			/** requestIds of the submissions (the run's input, steers, successor inputs) that Pi settled answered. */
			readonly answered: readonly string[];
	  }
	| { readonly type: "error"; readonly message: string };

export function isFromRunner(value: unknown): value is FromRunner {
	return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
