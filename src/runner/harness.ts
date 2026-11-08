/**
 * One run of one conversation inside the Pi process (Architecture § Pi Durable 1.5.0, § Request Flow; Agent
 * Execution § Finalize and Pending Inputs). Opens the conversation's own SQLite file, submits the run's input with its
 * `requestId`, steers follow-ups into the running work (`whenBusy: "steer"`, `whenIdle: "reject"`, falling back to one
 * successor input when Pi is already idle), and reports `finished` only once Pi is idle and every submission settled.
 * A steer counts as delivered only once the model answered a request that carried it. When the relay admitted the run's
 * last allowed request (`cap_reached`), queued steers are withdrawn and new ones refused, so no successor run starts.
 *
 * Pi Durable is used unmodified: `harness.resume()` is never called (an interrupted run is never resumed; a reused
 * conversation with unfinished work is refused), compaction is off, Pi's durable retry is the only retry owner
 * (provider retries forced to 0), and a failed run withdraws what was queued behind it.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AuthContext, createModels, type ModelThinkingLevel, type Provider } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	ConversationIdle,
	type Cursor,
	createRegistry,
	type EntryId,
	type EntryRecord,
	Harness,
	type HarnessSettings,
	LiveDoc,
	type Report,
	type SettledSubmissionRecord,
	type Submission,
	type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadProvider } from "../agent/providers.ts";
import { makePrivate } from "../runtime/private-dir.ts";
import { type AllowedCall, describeCall } from "./policy.ts";
import type { FromRunner, RunnerOutcome, RunnerStart, SteerStatus, ToolResult } from "./protocol.ts";
import { createRunnerExtension } from "./tools.ts";

const BG = BACKGROUND_CONTEXT;

/** Tool rounds per run (Pi `maxTurns`); the 30-request cap itself is enforced at the relay. */
export const MAX_TURNS = 30;
/**
 * After Pi goes idle, wait this long before reporting `finished`, so a follow-up already in transit over IPC still
 * becomes a successor run instead of being refused. Every check after it is synchronous with setting `closing`.
 */
export const QUIESCE_MS = 250;
/** How long an aborted tool call still waits for the Coordinator's result (the in-flight round may settle). */
export const TOOL_ABORT_GRACE_MS = 5_000;
/** Delivery polling for steers (Pi has no push for one submission's status). */
const PLACEMENT_POLL_MS = 100;
/** Entries scanned per page, and pages at most, when looking for the model's response after a placed steer. */
const SCAN_PAGE = 64;
const SCAN_PAGES = 32;
/** Stop reasons of a complete model response (not an error, nor a partial cut by an abort). */
const RESPONSE_STOPS: ReadonlySet<unknown> = new Set(["stop", "length", "toolUse"]);
const CAP_REACHED = "the run's request limit is reached";
/** Bounds on the stop path, so a stuck step can never keep the process from reporting and exiting. */
const STOP_STEP_MS = 10_000;
/** Final answer text sent to the Coordinator (it shortens further for Telegram). */
const ANSWER_CHARS = 4000;
const REASON_CHARS = 500;
/** Per-request HTTP timeout; a timed-out request is a retryable failure under Pi's retry policy. */
const REQUEST_TIMEOUT_MS = 300_000;

export type RunnerIo = {
	/** Send one message to the Coordinator; resolves once it is written to the channel. Never rejects. */
	send(message: FromRunner): Promise<void>;
	/** Metadata-only diagnostic line: an event name and primitive fields, never content. */
	note(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
};

export type RunnerEnvironment = {
	/** The run key (from OPENAI_API_KEY); used only for requests to the relay. */
	readonly apiKey: string | undefined;
	/** PI_RUNNER_TEST_FAST_RETRY=1: tests shrink Pi's retry backoff (20 ms base) to keep 5xx tests quick. */
	readonly fastRetry: boolean;
};

type Track = {
	readonly kind: "input" | "steer";
	readonly requestId: string;
	readonly submission: Submission;
	readonly settled: Promise<SettledSubmissionRecord>;
	/** steer_status delivered sent. */
	delivered: boolean;
	/** Withdrawn from Pi's inbox after `cap_reached` (settled unanswered, never placed): not a failure of the run. */
	withdrawn: boolean;
};

type Phase = "starting" | "running" | "closing" | "done";

type Admission =
	| { readonly track: Track; readonly status: SteerStatus }
	| { readonly refusal: string; readonly status: "rejected" | "withdrawn" };

/** How far one steer got: still on its way, received by the model, or never going to be. */
type Delivery = "pending" | "seen" | "never";

type Outcomes = { delivered: string[]; unconsumed: string[]; answered: string[] };

/** Harness settings for a run; exported for tests. */
export function runnerSettings(maxRetries: number, fastRetry: boolean): HarnessSettings {
	return {
		stream: { maxRetries: 0, timeoutMs: REQUEST_TIMEOUT_MS },
		retry: {
			enabled: true,
			maxRetries,
			baseDelayMs: fastRetry ? 20 : 2000,
			maxAgentDelayMs: fastRetry ? 100 : 30_000,
		},
		compaction: { enabled: false, backgroundTokens: 0 },
		afterFailedRun: "withdraw",
		toolExecution: "sequential",
		// Every pending follow-up is placed at the next boundary, not one per round.
		steeringMode: "all",
	};
}

/** The pi-ai provider with SDK/provider retries forced off: Pi's durable retry is the only owner. */
export function withoutProviderRetries(provider: Provider): Provider {
	return {
		...provider,
		stream: (model, context, options) =>
			provider.stream(model, context, { ...options, maxRetries: 0 } as typeof options),
		streamSimple: (model, context, options) => provider.streamSimple(model, context, { ...options, maxRetries: 0 }),
	};
}

export class RunController {
	readonly done: Promise<number>;
	readonly #start: RunnerStart;
	readonly #io: RunnerIo;
	readonly #env: RunnerEnvironment;
	#resolveDone!: (code: number) => void;
	#phase: Phase = "starting";
	#aborting = false;
	#finished = false;
	/** `cap_reached` arrived: no steer can reach the model any more. */
	#capReached = false;
	#harness: Harness | undefined;
	#root: Conversation | undefined;
	/** Resolves when start-up (open and the input's submission) ended, either way. */
	readonly #startup: Promise<void>;
	#resolveStartup!: () => void;
	readonly #tracked: Track[] = [];
	readonly #steerIds = new Set<string>();
	readonly #queuedSteers: { requestId: string; content: string }[] = [];
	#inFlight = 0;
	#inFlightWaiters: (() => void)[] = [];
	readonly #pendingTools = new Map<number, (result: ToolResult) => void>();
	#nextToolId = 0;

	constructor(start: RunnerStart, io: RunnerIo, env: RunnerEnvironment) {
		this.#start = start;
		this.#io = io;
		this.#env = env;
		this.done = new Promise((resolve) => {
			this.#resolveDone = resolve;
		});
		this.#startup = new Promise((resolve) => {
			this.#resolveStartup = resolve;
		});
	}

	/** Run to the end: answered, failed, or aborted. Resolves `done` with the exit code. */
	async run(): Promise<number> {
		try {
			await this.#open();
		} catch (error) {
			this.#io.note("runner_start_failed", { error: errorName(error) });
			await this.#closeHarness();
			await this.#finish({ outcome: "failed", reason: `start failed: ${errorText(error)}` }, 1);
			return this.done;
		} finally {
			this.#resolveStartup();
		}
		if (this.#aborting) return this.done;
		this.#phase = "running";
		for (const steer of this.#start.steers) this.steer(steer.requestId, steer.content);
		for (const steer of this.#queuedSteers.splice(0)) void this.#submitSteer(steer.requestId, steer.content);
		try {
			const quiescent = await this.#drain();
			if (!quiescent) return this.done;
			await this.#finishNormally();
		} catch (error) {
			if (this.#aborting) return this.done;
			this.#io.note("runner_failed", { error: errorName(error) });
			this.#phase = "closing";
			await this.#closeHarness();
			await this.#finish({ outcome: "failed", reason: `runner error: ${errorText(error)}` }, 1);
		}
		return this.done;
	}

	/** A follow-up from the Coordinator: steer it into the running work, or start one successor run when Pi is idle. */
	steer(requestId: unknown, content: unknown): void {
		if (typeof requestId !== "string" || requestId === "" || typeof content !== "string" || content === "") {
			if (typeof requestId === "string") void this.#steerStatus(requestId, "rejected", "invalid follow-up");
			return;
		}
		const refusal = this.#steerRefusal();
		if (refusal !== undefined) {
			void this.#steerStatus(requestId, "rejected", refusal);
			return;
		}
		if (this.#steerIds.has(requestId)) {
			this.#io.note("runner_steer_duplicate");
			return;
		}
		this.#steerIds.add(requestId);
		if (this.#capReached) {
			void this.#steerStatus(requestId, "withdrawn", CAP_REACHED);
			return;
		}
		if (this.#phase === "starting") {
			this.#queuedSteers.push({ requestId, content });
			return;
		}
		void this.#submitSteer(requestId, content);
	}

	/**
	 * The relay admitted the run's last allowed model request: a steer could only reach the model in a request the cap
	 * refuses. Withdraw every steer still queued in Pi's inbox and refuse new ones, so Pi starts no successor run
	 * (Agent Execution § Finalize and Pending Inputs: "if the cap is already reached, it expires").
	 */
	capReached(): void {
		if (this.#capReached) return;
		this.#capReached = true;
		this.#io.note("runner_cap_reached");
		for (const track of this.#tracked) if (track.kind === "steer") void this.#withdraw(track);
	}

	/** The Coordinator's answer to one `tool` request. */
	toolResult(id: unknown, result: unknown): void {
		const resolve = typeof id === "number" ? this.#pendingTools.get(id) : undefined;
		if (resolve === undefined) {
			this.#io.note("runner_tool_result_unknown");
			return;
		}
		this.#pendingTools.delete(id as number);
		resolve(normalizeToolResult(result));
	}

	/**
	 * Cancel or a limit: refuse new steers and tool calls, abort Pi (queued inputs withdrawn, the in-flight tool round
	 * gets a bounded chance to settle), close the store, report `finished` aborted. Ignored once finishing normally.
	 */
	async abort(reason: string): Promise<void> {
		if (this.#finished || this.#phase === "closing" || this.#phase === "done" || this.#aborting) return;
		this.#aborting = true;
		await this.#startup;
		if (this.#finished) return;
		this.#phase = "closing";
		await bounded(this.#submitsIdle(), STOP_STEP_MS);
		const root = this.#root;
		if (root !== undefined) {
			const aborted = await bounded(root.abort(BG), STOP_STEP_MS);
			if (!aborted.ok) this.#io.note("runner_abort_timeout");
		}
		const records = await this.#currentRecords();
		const outcomes = await this.#outcomes(records);
		const answer = root === undefined ? undefined : await this.#answerText(root, records);
		await this.#reportDelivered(outcomes.delivered);
		await this.#closeHarness();
		const optional = answer === undefined ? {} : { answer };
		await this.#finish({ outcome: "aborted", reason: shorten(reason, REASON_CHARS), ...optional, ...outcomes }, 0);
	}

	#steerRefusal(): string | undefined {
		if (this.#aborting) return "run stopping";
		if (this.#finished || this.#phase === "closing" || this.#phase === "done") return "run finished";
		return undefined;
	}

	// ------------------------------------------------------------------------------------------------------------

	async #open(): Promise<void> {
		const start = this.#start;
		const path = start.conversationPath;
		const exists = existsSync(path);
		if (start.fresh && exists) throw new Error("a fresh conversation's file already exists");
		if (!start.fresh && !exists) throw new Error("the conversation to reuse does not exist");
		if (start.fresh) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const models = createModels({ authContext: runKeyAuth(this.#env.apiKey) });
		const provider = await loadProvider("openai", {
			env: async (name) =>
				({
					OPENAI_BASE_URL: start.model.relayBaseUrl,
					OPENAI_API_KEY: this.#env.apiKey,
					OPENAI_CODEX_GATEWAY: start.model.codexGateway ? "1" : undefined,
				})[name],
		});
		if (provider === undefined) throw new Error("the openai provider is not available");
		models.setProvider(withoutProviderRetries(provider));
		if (models.getModel("openai", start.model.modelId) === undefined) {
			throw new Error(`unknown model openai/${start.model.modelId}`);
		}
		const registry = createRegistry();
		registry.install(
			createRunnerExtension({
				checkOps: start.checkOps,
				toolResultBytes: start.limits.toolResultBytes,
				instructions: start.instructions,
				invoke: (call, signal) => this.#invokeTool(call, signal),
			}),
		);
		const storage = await openNodeSqliteStorage(path);
		await makePrivate([path, `${path}-wal`, `${path}-shm`]);
		this.#harness = await Harness.open(
			storage,
			{
				models,
				registry,
				identity: { attribution: null },
				settings: runnerSettings(start.limits.maxRetries, this.#env.fastRetry),
				onReport: (report) => this.#report(report),
			},
			BG,
		);
		// Interrupted runs are never resumed: a conversation with live work or unsettled submissions is refused before
		// anything enables scheduling (only the Coordinator decides what a conversation is reused for).
		const inspection = await this.#harness.inspect(BG);
		if (inspection.tasks.length > 0 || inspection.submissions.length > 0) {
			throw new Error("the conversation has unfinished work and is not resumed");
		}
		const agent = {
			model: { provider: "openai", modelId: start.model.modelId },
			thinkingLevel: start.model.thinkingLevel as ModelThinkingLevel,
			maxTurns: MAX_TURNS,
		};
		const root = await this.#harness.root(BG, { agent });
		await root.configure(agent, BG);
		this.#root = root;
		if (this.#aborting) return;
		const submission = await root.submit(
			{ type: "input", content: start.input.content, requestId: start.input.requestId },
			BG,
		);
		this.#track("input", start.input.requestId, submission);
		await this.#io.send({ type: "ready" });
	}

	async #submitSteer(requestId: string, content: string): Promise<void> {
		const root = this.#root;
		if (root === undefined) return;
		this.#inFlight++;
		let admission: Admission;
		try {
			admission = await this.#admitSteer(root, requestId, content);
		} catch (error) {
			this.#io.note("runner_steer_failed", { error: errorName(error) });
			admission = { refusal: errorText(error), status: "rejected" };
		} finally {
			this.#inFlight--;
			if (this.#inFlight === 0) for (const wake of this.#inFlightWaiters.splice(0)) wake();
		}
		if ("refusal" in admission) {
			await this.#steerStatus(requestId, admission.status, admission.refusal);
			return;
		}
		await this.#steerStatus(requestId, admission.status);
		// `cap_reached` arrived while Pi admitted it: it can no longer reach the model.
		if (this.#capReached) await this.#withdraw(admission.track);
		void this.#watchDelivery(admission.track);
	}

	/** Steer into the running work; when Pi is idle, fall back to one successor run. */
	async #admitSteer(root: Conversation, requestId: string, content: string): Promise<Admission> {
		if (this.#aborting) return { refusal: "run stopping", status: "rejected" };
		if (this.#capReached) return { refusal: CAP_REACHED, status: "withdrawn" };
		try {
			const draft = { type: "input", content, requestId, whenBusy: "steer", whenIdle: "reject" } as const;
			const submission = await root.submit(draft, BG);
			return { track: this.#track("steer", requestId, submission), status: "submitted" };
		} catch (error) {
			if (!isConversationIdle(error)) throw error;
		}
		return this.#admitSuccessor(root, requestId, content);
	}

	/**
	 * Pi is idle. After a normal completion the follow-up becomes one successor run with the same requestId; after a
	 * failed run it is refused (that run is being finalized as failed).
	 */
	async #admitSuccessor(root: Conversation, requestId: string, content: string): Promise<Admission> {
		const records = await bounded(Promise.all(this.#tracked.map((each) => each.settled)), 2000);
		if (this.#aborting) return { refusal: "run stopping", status: "rejected" };
		if (this.#capReached) return { refusal: CAP_REACHED, status: "withdrawn" };
		if (records.value === undefined || records.value.some((record) => record.status !== "done")) {
			return { refusal: "run failed", status: "rejected" };
		}
		const submission = await root.submit({ type: "input", content, requestId }, BG);
		return { track: this.#track("steer", requestId, submission), status: "successor" };
	}

	#track(kind: Track["kind"], requestId: string, submission: Submission): Track {
		const settled = submission.wait(BG);
		// Observed here so an early rejection (a failed Harness) is never unhandled; drain sees it too.
		settled.catch(() => {});
		const track: Track = { kind, requestId, submission, settled, delivered: false, withdrawn: false };
		this.#tracked.push(track);
		return track;
	}

	/** Withdraw a steer still queued in Pi's inbox; one Pi already placed stays and is reported as usual. */
	async #withdraw(track: Track): Promise<void> {
		if (track.withdrawn || this.#finished) return;
		const result = await bounded(track.submission.abort(BG), STOP_STEP_MS);
		if (result.value !== "aborted") return;
		track.withdrawn = true;
		this.#io.note("runner_steer_withdrawn");
		await this.#steerStatus(track.requestId, "withdrawn", CAP_REACHED);
	}

	/**
	 * Report `delivered` once the model received the steer: Pi placed it (into the running run or a successor) and a
	 * model response to a request that carried it was committed. Placement alone is not delivery.
	 */
	async #watchDelivery(track: Track): Promise<void> {
		while (!this.#finished && this.#phase !== "done" && !this.#aborting) {
			const record = await track.submission.status(BG).catch(() => undefined);
			const delivery = record === undefined ? "never" : await this.#delivery(record);
			if (delivery === "seen") await this.#markDelivered(track);
			if (delivery !== "pending") return;
			await sleep(PLACEMENT_POLL_MS);
		}
	}

	async #delivery(record: SubmissionRecord): Promise<Delivery> {
		if (record.type !== "input") return "never";
		if (record.status === "queued") return "pending";
		if (record.status === "done") return "seen";
		if (record.entry === undefined) return "never";
		if (await this.#modelResponded(record.entry)) return "seen";
		return record.status === "unanswered" ? "never" : "pending";
	}

	/**
	 * True once a complete model response was committed after `entry`. Steers are placed at a boundary, before the
	 * next request is assembled, so every response after the entry answers a request that carried it.
	 */
	async #modelResponded(entry: EntryId): Promise<boolean> {
		const root = this.#root;
		if (root === undefined) return false;
		const query = { minEntryId: (entry + 1) as EntryId, order: "ascending" } as const;
		let cursor: Cursor | undefined;
		for (let page = 0; page < SCAN_PAGES; page++) {
			const found = await root.entries(query, SCAN_PAGE, cursor, BG).catch(() => undefined);
			if (found === undefined) return false;
			if (found.items.some(isModelResponse)) return true;
			if (found.next === undefined) return false;
			cursor = found.next;
		}
		return false;
	}

	async #markDelivered(track: Track): Promise<void> {
		if (track.delivered || this.#finished) return;
		track.delivered = true;
		await this.#steerStatus(track.requestId, "delivered");
	}

	/** steer_status delivered for every steer the model received and not reported yet, before `finished`. */
	async #reportDelivered(delivered: readonly string[]): Promise<void> {
		for (const track of this.#tracked) {
			if (track.kind === "steer" && delivered.includes(track.requestId)) await this.#markDelivered(track);
		}
	}

	/**
	 * Wait until every submission settled and Pi is idle, then a quiet period with no new follow-up. Returns false
	 * when an abort took over. On true, `closing` is set in the same synchronous step as the last check.
	 */
	async #drain(): Promise<boolean> {
		for (;;) {
			const step = await this.#drainStep();
			if (step !== "again") return step === "quiet";
		}
	}

	async #drainStep(): Promise<"quiet" | "again" | "aborted"> {
		const root = this.#root;
		if (root === undefined) throw new Error("conversation not open");
		const count = this.#tracked.length;
		await Promise.all(this.#tracked.map((track) => track.settled));
		await root.waitForIdle(BG);
		await this.#submitsIdle();
		if (this.#aborting) return "aborted";
		if (this.#tracked.length !== count) return "again";
		await this.#io.send({ type: "progress", text: "run idle; finishing" });
		await sleep(QUIESCE_MS);
		if (this.#aborting) return "aborted";
		if (this.#inFlight > 0 || this.#tracked.length !== count) return "again";
		this.#phase = "closing";
		return "quiet";
	}

	async #finishNormally(): Promise<void> {
		const root = this.#root;
		if (root === undefined) throw new Error("conversation not open");
		const records = await Promise.all(this.#tracked.map((track) => track.settled));
		let { outcome, reason } = await this.#outcome(root, records);
		const answer = await this.#answerText(root, records);
		const outcomes = await this.#outcomes(records);
		await this.#reportDelivered(outcomes.delivered);
		if (!(await this.#closeHarness()) && outcome === "answered") {
			outcome = "failed";
			reason = "the conversation store did not close cleanly";
		}
		const optional = {
			...(reason === undefined ? {} : { reason: shorten(reason, REASON_CHARS) }),
			...(answer === undefined ? {} : { answer }),
		};
		await this.#finish({ outcome, ...optional, ...outcomes }, 0);
	}

	/**
	 * Answered when every input settled done (a steer withdrawn at the cap does not count); otherwise failed with Pi's
	 * run failure (reason and detail).
	 */
	async #outcome(
		root: Conversation,
		records: readonly SettledSubmissionRecord[],
	): Promise<{ outcome: RunnerOutcome; reason?: string }> {
		const unanswered = records.find((record, index) => record.status !== "done" && !this.#tracked[index]?.withdrawn);
		if (unanswered === undefined) return { outcome: "answered" };
		const live = await this.#harness?.snapshot(LiveDoc, root.id, BG).catch(() => undefined);
		const failure = live?.runFailure;
		const reason =
			failure !== undefined
				? failureText(failure.reason, failure.detail)
				: failureText(unanswered.reason ?? "unanswered", unanswered.detail);
		return { outcome: "failed", reason };
	}

	/** The newest answer of the runs this process drove. */
	async #answerText(
		root: Conversation,
		records: readonly (SubmissionRecord | undefined)[],
	): Promise<string | undefined> {
		let id: EntryId | undefined;
		for (const record of records) {
			if (record?.type === "input" && record.status === "done" && (id === undefined || record.answer > id)) {
				id = record.answer;
			}
		}
		if (id === undefined) return undefined;
		const page = await root.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BG).catch(() => undefined);
		const message = page?.items[0]?.model?.[0];
		if (message?.role !== "assistant") return undefined;
		const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		return shorten(text, ANSWER_CHARS);
	}

	/** Each submission's current record (bounded reads; undefined when it could not be read). */
	async #currentRecords(): Promise<(SubmissionRecord | undefined)[]> {
		const records: (SubmissionRecord | undefined)[] = [];
		for (const track of this.#tracked) records.push((await bounded(track.submission.status(BG), 2000)).value);
		return records;
	}

	/** Which steers the model received and which it never did, and which submissions Pi settled answered. */
	async #outcomes(records: readonly (SubmissionRecord | undefined)[]): Promise<Outcomes> {
		const outcomes: Outcomes = { delivered: [], unconsumed: [], answered: [] };
		for (const [index, track] of this.#tracked.entries()) {
			const record = records[index];
			if (record?.status === "done") outcomes.answered.push(track.requestId);
			if (track.kind !== "steer") continue;
			const seen = record !== undefined && (await this.#delivery(record)) === "seen";
			(seen ? outcomes.delivered : outcomes.unconsumed).push(track.requestId);
		}
		// Follow-ups queued before the conversation opened never reached Pi.
		for (const steer of this.#queuedSteers) outcomes.unconsumed.push(steer.requestId);
		return outcomes;
	}

	async #invokeTool(call: AllowedCall, signal: AbortSignal | undefined): Promise<ToolResult> {
		if (this.#aborting || this.#phase === "closing" || this.#phase === "done") {
			return { ok: false, text: "run stopped" };
		}
		const id = ++this.#nextToolId;
		const result = new Promise<ToolResult>((resolve) => {
			this.#pendingTools.set(id, resolve);
			if (signal === undefined) return;
			const onAbort = () => {
				// The in-flight call may still settle in the Coordinator; give it a bounded chance, then give up.
				const timer = setTimeout(() => {
					if (this.#pendingTools.delete(id)) resolve({ ok: false, text: "tool call aborted" });
				}, TOOL_ABORT_GRACE_MS);
				timer.unref();
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		await this.#io.send({ type: "progress", text: describeCall(call) });
		await this.#io.send({ type: "tool", id, name: call.tool, args: { ...call.args } });
		return result;
	}

	async #steerStatus(requestId: string, status: SteerStatus, detail?: string): Promise<void> {
		await this.#io.send({
			type: "steer_status",
			requestId,
			status,
			...(detail === undefined ? {} : { detail: shorten(detail, REASON_CHARS) }),
		});
	}

	#submitsIdle(): Promise<void> {
		if (this.#inFlight === 0) return Promise.resolve();
		return new Promise((resolve) => this.#inFlightWaiters.push(resolve));
	}

	/** Close the Harness (and its SQLite file); true when it closed cleanly within the bound. */
	async #closeHarness(): Promise<boolean> {
		const harness = this.#harness;
		this.#harness = undefined;
		if (harness === undefined) return true;
		const closed = await bounded(harness.close(BG), STOP_STEP_MS);
		if (!closed.ok) this.#io.note("runner_close_failed");
		return closed.ok;
	}

	async #finish(
		result: { outcome: RunnerOutcome; reason?: string; answer?: string } & Partial<Outcomes>,
		code: number,
	): Promise<void> {
		if (this.#finished) return;
		this.#finished = true;
		this.#phase = "done";
		for (const [id, resolve] of this.#pendingTools) {
			this.#pendingTools.delete(id);
			resolve({ ok: false, text: "run stopped" });
		}
		const unconsumed = [...(result.unconsumed ?? [])];
		for (const steer of this.#queuedSteers) if (!unconsumed.includes(steer.requestId)) unconsumed.push(steer.requestId);
		await this.#io.send({
			type: "finished",
			outcome: result.outcome,
			...(result.reason === undefined ? {} : { reason: result.reason }),
			...(result.answer === undefined ? {} : { answer: result.answer }),
			delivered: result.delivered ?? [],
			unconsumed,
			answered: result.answered ?? [],
		});
		this.#io.note("runner_finished", { outcome: result.outcome });
		this.#resolveDone(code);
	}

	#report(report: Report): void {
		this.#io.note("runner_report", {
			kind: report.kind,
			...("reason" in report && typeof report.reason === "string" ? { reason: report.reason } : {}),
		});
	}
}

/** Auth for pi-ai: only the run key, from the captured environment; no ambient credential files. */
function runKeyAuth(apiKey: string | undefined): AuthContext {
	return {
		env: async (name) => (name === "OPENAI_API_KEY" ? apiKey : undefined),
		fileExists: async () => false,
	};
}

function normalizeToolResult(value: unknown): ToolResult {
	if (typeof value !== "object" || value === null) return { ok: false, text: "invalid tool result" };
	const { ok, text } = value as { ok?: unknown; text?: unknown };
	return { ok: ok === true, text: typeof text === "string" ? text : "" };
}

/** A committed, complete model response (an assistant entry that is not an error or a partial cut by an abort). */
function isModelResponse(entry: EntryRecord): boolean {
	if (!AssistantEntry.is(entry)) return false;
	const message = entry.model?.[0] as { readonly role?: unknown; readonly stopReason?: unknown } | undefined;
	return message?.role === "assistant" && RESPONSE_STOPS.has(message.stopReason);
}

function isConversationIdle(error: unknown): boolean {
	return error instanceof ConversationIdle || (error instanceof Error && error.name === "ConversationIdle");
}

function failureText(reason: string, detail: unknown): string {
	const text = typeof detail === "string" ? detail : detail === undefined ? "" : JSON.stringify(detail);
	return text === "" ? reason : `${reason}: ${text}`;
}

function shorten(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return shorten(message.split("\n")[0] ?? "", REASON_CHARS);
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bounded<T>(promise: Promise<T>, ms: number): Promise<{ ok: boolean; value?: T }> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<{ ok: boolean; value?: T }>((resolve) => {
		timer = setTimeout(() => resolve({ ok: false }), ms);
	});
	try {
		return await Promise.race([
			promise.then(
				(value) => ({ ok: true, value }),
				() => ({ ok: false }),
			),
			timeout,
		]);
	} finally {
		clearTimeout(timer);
	}
}
