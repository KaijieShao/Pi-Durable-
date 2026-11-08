import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { errorSummary, type Logger } from "../runtime/log.ts";
import type { Limits } from "./limits.ts";
import type { Store } from "./store.ts";

/**
 * The model relay (Architecture § Model relay; Interfaces and Storage § Pi to relay, § Relay and conversation reuse).
 * A 127.0.0.1 HTTP listener inside the Coordinator process, OpenAI-compatible (`POST /v1/responses` only). Pi reaches
 * the model only through it, with a run key; the relay holds the real model key.
 *
 * Per request: the bearer run key must be open and its run starting or running (same generation). Then, in ONE
 * `BEGIN IMMEDIATE` transaction: the request cap (30 per run, retries included, shared with the successor run), the
 * 48K-token input estimate, the budget reservation against the project ceiling, the `model_requests` increment and
 * the budget row. Only then is the request forwarded; admitting the run's last allowed request first reports the cap
 * reached (`onCapReached`), so the run's pending steers can be withdrawn. The upstream SSE body is streamed back as
 * it arrives while the terminal `response.*` event's usage reconciles the budget row; without reported usage the row
 * becomes `unknown` and keeps its reservation (Capacity § Token budget reservation).
 *
 * Error bodies are sanitized and fixed: the 400/401 texts contain none of pi-ai's retryable words, so Pi's durable
 * retry never retries them (Agent Execution § Limits); 429/5xx texts carry the status number, so Pi retries them and
 * every retry is another counted request. Logs carry metadata only: never bodies, keys or headers.
 */

export type RelayLimitReason = "request_cap" | "context_limit" | "budget" | "upstream_400" | "upstream_401";

export type RelayOptions = {
	readonly store: Store;
	readonly limits: Limits;
	/** `baseUrl` is the user's OPENAI_BASE_URL (e.g. https://api.openai.com/v1); the relay POSTs `${baseUrl}/responses`. */
	readonly upstream: { readonly baseUrl: string; readonly apiKey: string };
	/** OPENAI_CODEX_GATEWAY=1: the gateway refuses `max_output_tokens`, so the relay does not add it when absent. */
	readonly codexGateway: boolean;
	readonly projectTokenCeiling: number;
	/**
	 * A run hit a limit or a fatal upstream answer: the engine finalizes it as failed with that reason. Called after the
	 * refusal is sent, outside any transaction; may be called more than once for the same run (be idempotent).
	 */
	readonly onRunLimit: (runId: number, reason: RelayLimitReason) => void;
	/**
	 * The run's last allowed request (the cap'th) was admitted: the engine tells its Pi process that no steer can reach
	 * the model any more. Called once per run, after the admission commits and before the request is forwarded.
	 */
	readonly onCapReached: (runId: number) => void;
	readonly log: Logger;
	readonly fetch?: typeof fetch;
	/** 127.0.0.1 port; 0 or undefined = ephemeral. */
	readonly port?: number;
};

export type Relay = {
	/** `http://127.0.0.1:<port>/v1`: Pi's OPENAI_BASE_URL. */
	readonly url: string;
	/** Stop listening, abort in-flight upstream requests and wait until their budget rows are settled. */
	close(): Promise<void>;
};

/** Largest accepted request body. Anything larger is far beyond the 48K-token input limit anyway. */
export const RELAY_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Largest single SSE line/event (or non-streamed JSON body) scanned for usage; larger ones pass through unscanned. */
const MAX_SCAN_CHARS = 16 * 1024 * 1024;
const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);
const TERMINAL_HINT = /"response\.(?:completed|incomplete|failed)"/;
/** Client headers forwarded upstream (prompt-cache affinity and content negotiation); never authorization. */
const FORWARDED_HEADERS = ["accept", "user-agent", "session_id", "x-client-request-id", "x-session-id", "openai-beta"];
const NO_RETRY: OutgoingHttpHeaders = { "x-should-retry": "false" };

/** sha256 hex of a run key; `run_keys.key_hash`. The key itself is never stored. */
export function hashRunKey(key: string): string {
	return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Estimated input tokens of a Responses request: ceil(UTF-8 bytes of JSON.stringify({instructions, input, tools}) / 4).
 * `input` carries the whole history, tool calls and tool results (Pi sends `store: false`, no server-side state).
 */
export function estimateInputTokens(body: unknown): number {
	const fields = isRecord(body) ? body : {};
	const json = JSON.stringify({ instructions: fields.instructions, input: fields.input, tools: fields.tools });
	return Math.ceil(Buffer.byteLength(json, "utf8") / 4);
}

/** Project tokens spent: reconciled actual usage plus every reservation not yet reconciled (reserved or unknown). */
export function projectTokensSpent(store: Store): number {
	const row = store.get<{ spent: number | null }>(
		`SELECT SUM(CASE WHEN state = 'reconciled' THEN COALESCE(actual, 0) ELSE reserved END) AS spent FROM budget`,
	);
	return Number(row?.spent ?? 0);
}

export async function startRelay(options: RelayOptions): Promise<Relay> {
	const core = new RelayCore(options);
	const handlers = new Set<Promise<void>>();
	const server = createServer((req, res) => {
		const task = core
			.handle(req, res)
			.catch((error: unknown) => {
				options.log.error("relay.handler_failed", { error: errorSummary(error) });
				sendJson(res, new Answer(500, { error: { message: "relay error (status 500)" } }));
			})
			.finally(() => handlers.delete(task));
		handlers.add(task);
	});
	server.on("clientError", (_error, socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const port = (server.address() as AddressInfo).port;
	options.log.info("relay.started", { port });

	let closed: Promise<void> | undefined;
	return {
		url: `http://127.0.0.1:${port}/v1`,
		close(): Promise<void> {
			closed ??= (async () => {
				core.stop();
				const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
				server.closeAllConnections();
				await stopped;
				await Promise.allSettled([...handlers]);
				options.log.info("relay.stopped", { port });
			})();
			return closed;
		},
	};
}

// ---------------------------------------------------------------------------------------------------------------

type RunRef = { readonly runId: number; readonly taskId: number; readonly modelRequests: number };
type ErrorBody = { readonly error: { readonly message: string; readonly type?: string } };
type Admitted = { readonly budgetId: number; readonly requestNumber: number; readonly reserved: number };
type Streamed = { readonly outcome: string; readonly usage: number | undefined };

/** A complete error answer to the client; with `limit`, the run is reported to the engine after it is sent. */
class Answer {
	readonly status: number;
	readonly body: ErrorBody;
	readonly headers: OutgoingHttpHeaders;
	readonly limit: { readonly run: RunRef; readonly reason: RelayLimitReason } | undefined;
	constructor(
		status: number,
		body: ErrorBody,
		headers: OutgoingHttpHeaders = {},
		limit?: { readonly run: RunRef; readonly reason: RelayLimitReason },
	) {
		this.status = status;
		this.body = body;
		this.headers = headers;
		this.limit = limit;
	}
}

const NOT_OPEN = new Answer(401, { error: { message: "run key not open" } }, NO_RETRY);
const NOT_FOUND = new Answer(404, { error: { message: "not found" } });
const UPSTREAM_FAILED = new Answer(502, { error: { message: "upstream connection failed (status 502)" } });

class RelayCore {
	readonly #options: RelayOptions;
	readonly #fetch: typeof fetch;
	readonly #upstreamUrl: string;
	/** Runs refused for a limit or a fatal upstream answer: refused again without counting, until the engine revokes. */
	readonly #limited = new Map<number, RelayLimitReason>();
	readonly #inflight = new Set<AbortController>();
	#stopping = false;

	constructor(options: RelayOptions) {
		this.#options = options;
		this.#fetch = options.fetch ?? fetch;
		this.#upstreamUrl = `${options.upstream.baseUrl.replace(/\/+$/, "")}/responses`;
	}

	stop(): void {
		this.#stopping = true;
		for (const controller of this.#inflight) controller.abort();
	}

	async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const started = Date.now();
		const gate = this.#authorize(req);
		if (gate instanceof Answer) return this.#answer(res, gate);
		const body = await this.#readJson(req, gate.run);
		if (body === undefined) return;
		if (body instanceof Answer) return this.#answer(res, body);
		const admitted = this.#admit(gate.keyHash, gate.run, body);
		if (admitted instanceof Answer) return this.#answer(res, admitted);
		if (admitted.requestNumber >= this.#options.limits.modelRequestsPerRun) this.#capReached(gate.run);
		await this.#forward(req, res, gate.run, body, admitted, started);
	}

	#authorize(req: IncomingMessage): Answer | { readonly run: RunRef; readonly keyHash: string } {
		if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/v1/responses") return NOT_FOUND;
		if (this.#stopping) return new Answer(503, { error: { message: "relay stopping (status 503)" } });
		const found = findRun(this.#options.store, req.headers.authorization);
		if (typeof found === "string") {
			this.#options.log.warn("relay.unauthorized", { reason: found });
			return NOT_OPEN;
		}
		const blocked = this.#limited.get(found.run.runId);
		return blocked === undefined ? found : this.#refusal(found.run, blocked);
	}

	/** The request body as a JSON object; undefined if the client went away while sending it. */
	async #readJson(req: IncomingMessage, run: RunRef): Promise<Record<string, unknown> | Answer | undefined> {
		const raw = await readBody(req, RELAY_MAX_BODY_BYTES);
		if (raw.kind === "aborted") return undefined;
		// Over 8 MiB is necessarily over the 48K-token input limit: refused before it is sent, and the run stops.
		if (raw.kind === "too_large") return this.#refusal(run, "context_limit", 413);
		let body: unknown;
		try {
			body = JSON.parse(raw.buffer.toString("utf8"));
		} catch {
			body = undefined;
		}
		if (!isRecord(body)) return invalid(400, "request body must be a JSON object");
		// Server-side history would hide part of the assembled input from the 48K check: refuse it.
		if (body.previous_response_id != null || body.conversation != null)
			return invalid(400, "server-side conversation state is not supported");
		return body;
	}

	/** Cap, context, budget, count and reservation: one transaction, before anything is sent. */
	#admit(keyHash: string, run: RunRef, body: Record<string, unknown>): Admitted | Answer {
		const { store, limits, projectTokenCeiling } = this.#options;
		const maxOutput = clampOutput(body, limits.maxOutputTokens, this.#options.codexGateway);
		const estimate = estimateInputTokens(body);
		// Capacity § Token budget reservation: "its input allowance plus maximum output is reserved".
		const reserved = limits.maxInputTokens + maxOutput;
		let outcome: Admitted | RelayLimitReason | "closed";
		try {
			outcome = store.tx((): Admitted | RelayLimitReason | "closed" => {
				const current = lookupRun(store, keyHash);
				if (current === undefined) return "closed";
				if (current.modelRequests >= limits.modelRequestsPerRun) return "request_cap";
				if (estimate > limits.maxInputTokens) return "context_limit";
				if (projectTokensSpent(store) + reserved > projectTokenCeiling) return "budget";
				store.run("UPDATE runs SET model_requests = model_requests + 1 WHERE id = ?", current.runId);
				const budgetId = store.run(
					"INSERT INTO budget(run_id, task_id, reserved, state, created_at) VALUES (?, ?, ?, 'reserved', ?)",
					current.runId,
					current.taskId,
					reserved,
					store.now(),
				).lastInsertRowid;
				return { budgetId, requestNumber: current.modelRequests + 1, reserved };
			});
		} catch (error) {
			this.#options.log.error("relay.admission_failed", { run: run.runId, error: errorSummary(error) });
			return new Answer(500, { error: { message: "relay error (status 500)" } });
		}
		if (outcome === "closed") {
			this.#options.log.warn("relay.unauthorized", { run: run.runId, reason: "closed" });
			return NOT_OPEN;
		}
		return typeof outcome === "string" ? this.#refusal(run, outcome) : outcome;
	}

	async #forward(
		req: IncomingMessage,
		res: ServerResponse,
		run: RunRef,
		body: Record<string, unknown>,
		admitted: Admitted,
		started: number,
	): Promise<void> {
		const meta = { run: run.runId, task: run.taskId, n: admitted.requestNumber };
		const controller = new AbortController();
		this.#inflight.add(controller);
		const onClose = (): void => {
			if (!res.writableFinished) controller.abort();
		};
		res.on("close", onClose);
		let usage: number | undefined;
		try {
			const upstream = await this.#send(req, body, controller.signal, meta);
			if (upstream === undefined) {
				this.#options.log.info("relay.request", { ...meta, outcome: "client_aborted", ms: Date.now() - started });
				res.destroy();
			} else if (upstream instanceof Answer) this.#answer(res, upstream);
			else if (upstream.status < 200 || upstream.status > 299) {
				await upstream.body?.cancel().catch(() => {});
				this.#options.log.warn("relay.upstream_status", { ...meta, status: upstream.status, ms: Date.now() - started });
				this.#answer(res, this.#upstreamError(run, upstream));
			} else {
				const streamed = await pipe(res, upstream, controller.signal);
				usage = streamed.usage;
				this.#options.log.info("relay.request", {
					...meta,
					status: upstream.status,
					outcome: streamed.outcome,
					usage: usage === undefined ? "unknown" : "reconciled",
					reserved: admitted.reserved,
					actual: usage,
					ms: Date.now() - started,
				});
			}
		} finally {
			res.off("close", onClose);
			this.#inflight.delete(controller);
			this.#settle(admitted.budgetId, usage);
		}
	}

	/** POST upstream with the real key; undefined if the client (or close()) aborted it first. */
	async #send(
		req: IncomingMessage,
		body: Record<string, unknown>,
		signal: AbortSignal,
		meta: Record<string, number>,
	): Promise<Response | Answer | undefined> {
		try {
			return await this.#fetch(this.#upstreamUrl, {
				method: "POST",
				headers: upstreamHeaders(req, this.#options.upstream.apiKey),
				body: JSON.stringify(body),
				signal,
				redirect: "manual",
			});
		} catch (error) {
			if (signal.aborted) return undefined;
			this.#options.log.warn("relay.upstream_failed", { ...meta, error: errorSummary(error) });
			return UPSTREAM_FAILED;
		}
	}

	/** Sanitized answer for a non-2xx upstream status; the upstream body is never passed on. */
	#upstreamError(run: RunRef, upstream: Response): Answer {
		const status = upstream.status;
		if (status === 400) return this.#refusal(run, "upstream_400");
		if (status === 401 || status === 403) return this.#refusal(run, "upstream_401");
		const message = { error: { message: `upstream error (status ${status})` } };
		if (status === 429 || (status >= 500 && status <= 599)) return new Answer(status, message, retryHeaders(upstream));
		if (status >= 400 && status <= 499) return new Answer(status, message, NO_RETRY);
		return UPSTREAM_FAILED;
	}

	#refusal(run: RunRef, reason: RelayLimitReason, status?: number): Answer {
		const { limits } = this.#options;
		const limit = { run, reason };
		switch (reason) {
			case "request_cap":
				return invalid(status ?? 400, `request limit reached (${limits.modelRequestsPerRun} per run)`, limit);
			case "context_limit":
				return invalid(status ?? 400, `input exceeds ${tokenLabel(limits.maxInputTokens)} tokens`, limit);
			case "budget":
				return invalid(status ?? 400, "project token budget exhausted", limit);
			case "upstream_400":
				return invalid(status ?? 400, "upstream rejected the request (status 400)", limit);
			case "upstream_401": {
				const message = "upstream rejected the credentials (status 401)";
				return new Answer(status ?? 401, { error: { message, type: "authentication_error" } }, NO_RETRY, limit);
			}
		}
	}

	#answer(res: ServerResponse, answer: Answer): void {
		sendJson(res, answer);
		if (answer.limit === undefined) return;
		const { run, reason } = answer.limit;
		this.#limited.set(run.runId, reason);
		this.#options.log.warn("relay.limit", { run: run.runId, task: run.taskId, reason, status: answer.status });
		try {
			this.#options.onRunLimit(run.runId, reason);
		} catch (error) {
			this.#options.log.error("relay.on_run_limit_failed", { run: run.runId, reason, error: errorSummary(error) });
		}
	}

	#capReached(run: RunRef): void {
		this.#options.log.info("relay.cap_reached", { run: run.runId, task: run.taskId });
		try {
			this.#options.onCapReached(run.runId);
		} catch (error) {
			this.#options.log.error("relay.on_cap_reached_failed", { run: run.runId, error: errorSummary(error) });
		}
	}

	#settle(budgetId: number, actual: number | undefined): void {
		const { store } = this.#options;
		try {
			store.tx(() =>
				actual === undefined
					? store.run(
							"UPDATE budget SET state = 'unknown', settled_at = ? WHERE id = ? AND state = 'reserved'",
							store.now(),
							budgetId,
						)
					: store.run(
							"UPDATE budget SET state = 'reconciled', actual = ?, settled_at = ? WHERE id = ? AND state = 'reserved'",
							actual,
							store.now(),
							budgetId,
						),
			);
		} catch (error) {
			// The row stays 'reserved' (recovery turns it into 'unknown'): the reservation is kept either way.
			this.#options.log.error("relay.settle_failed", { budget: budgetId, error: errorSummary(error) });
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------

/** The run behind an open key: key open, run starting or running, same task and generation as the key. */
function lookupRun(store: Store, keyHash: string): RunRef | undefined {
	return store.get<RunRef>(
		`SELECT k.run_id AS runId, k.task_id AS taskId, r.model_requests AS modelRequests
		 FROM run_keys k JOIN runs r ON r.id = k.run_id JOIN tasks t ON t.id = r.task_id
		 WHERE k.key_hash = ? AND k.state = 'open' AND r.state IN ('starting', 'running')
		   AND r.task_id = k.task_id AND r.generation = k.generation AND t.generation = k.generation`,
		keyHash,
	);
}

/** The run of the bearer key in `authorization`, or why there is none. */
function findRun(
	store: Store,
	authorization: string | undefined,
): { readonly run: RunRef; readonly keyHash: string } | "no_key" | "not_open" {
	const key = /^Bearer\s+(\S{1,512})\s*$/i.exec(authorization ?? "")?.[1];
	if (key === undefined) return "no_key";
	const keyHash = hashRunKey(key);
	const run = lookupRun(store, keyHash);
	return run === undefined ? "not_open" : { run, keyHash };
}

/**
 * Clamp `max_output_tokens` to the per-request output limit; set it when absent (or not a positive number), unless
 * the Codex gateway (which refuses the field) is in use and it is absent. Returns the request's maximum output.
 */
function clampOutput(body: Record<string, unknown>, maxOutput: number, codexGateway: boolean): number {
	const requested = body.max_output_tokens;
	if (requested == null && codexGateway) {
		delete body.max_output_tokens;
		return maxOutput;
	}
	const valid = typeof requested === "number" && Number.isFinite(requested) && requested >= 1;
	const clamped = valid ? Math.min(Math.floor(requested), maxOutput) : maxOutput;
	body.max_output_tokens = clamped;
	return clamped;
}

function upstreamHeaders(req: IncomingMessage, apiKey: string): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const name of FORWARDED_HEADERS) {
		const value = req.headers[name];
		if (typeof value === "string" && value.length <= 512 && !/[\r\n]/.test(value)) headers[name] = value;
	}
	headers["content-type"] = "application/json";
	headers.authorization = `Bearer ${apiKey}`;
	return headers;
}

/** Retry-After (and retry-after-ms) passthrough for 429/5xx, validated so nothing else leaks through. */
function retryHeaders(upstream: Response): OutgoingHttpHeaders {
	const headers: OutgoingHttpHeaders = {};
	const after = upstream.headers.get("retry-after")?.trim() ?? "";
	const httpDate = /^[\w ,:]{1,64}$/.test(after) && !Number.isNaN(Date.parse(after));
	if (/^\d{1,9}$/.test(after) || httpDate) headers["retry-after"] = after;
	const afterMs = upstream.headers.get("retry-after-ms")?.trim() ?? "";
	if (/^\d{1,12}(?:\.\d{1,6})?$/.test(afterMs)) headers["retry-after-ms"] = afterMs;
	return headers;
}

type BodyResult =
	| { readonly kind: "ok"; readonly buffer: Buffer }
	| { readonly kind: "too_large" }
	| { readonly kind: "aborted" };

function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > maxBytes) return Promise.resolve({ kind: "too_large" });
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		const finish = (result: BodyResult): void => {
			req.off("data", onData);
			req.off("end", onEnd);
			req.off("error", onError);
			req.off("aborted", onError);
			resolve(result);
		};
		const onData = (chunk: Buffer): void => {
			size += chunk.length;
			if (size <= maxBytes) {
				chunks.push(chunk);
				return;
			}
			// Keep reading and discarding the rest, so the client gets the 413 instead of a reset connection.
			chunks.length = 0;
			finish({ kind: "too_large" });
			req.resume();
		};
		const onEnd = (): void => finish({ kind: "ok", buffer: Buffer.concat(chunks) });
		const onError = (): void => finish({ kind: "aborted" });
		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
		req.on("aborted", onError);
	});
}

/** Stream a 2xx upstream body to the client chunk by chunk (no buffering) while scanning it for usage. */
async function pipe(res: ServerResponse, upstream: Response, signal: AbortSignal): Promise<Streamed> {
	const contentType = upstream.headers.get("content-type") ?? "application/json";
	const scanner: UsageScanner = /text\/event-stream/i.test(contentType) ? new SseUsage() : new JsonUsage();
	res.writeHead(upstream.status, {
		"content-type": contentType,
		"cache-control": "no-cache",
		"x-accel-buffering": "no",
	});
	res.flushHeaders();
	const reader = upstream.body?.getReader();
	try {
		if (reader !== undefined) await copy(reader, res, scanner);
		scanner.end();
		res.end();
		return { outcome: "streamed", usage: scanner.usage };
	} catch {
		await reader?.cancel().catch(() => {});
		res.destroy();
		return { outcome: signal.aborted ? "client_aborted" : "upstream_broken", usage: scanner.usage };
	}
}

/** Write each upstream chunk as it arrives, honoring backpressure; throws once the client is gone. */
async function copy(reader: ReadableStreamDefaultReader<Uint8Array>, res: ServerResponse, scanner: UsageScanner) {
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		scanner.push(next.value);
		if (res.destroyed) throw new Error("client gone");
		if (!res.write(next.value)) await drained(res);
	}
}

function drained(res: ServerResponse): Promise<void> {
	return new Promise((resolve) => {
		if (res.destroyed || res.writableEnded) {
			resolve();
			return;
		}
		const done = (): void => {
			res.off("drain", done);
			res.off("close", done);
			resolve();
		};
		res.on("drain", done);
		res.on("close", done);
	});
}

function sendJson(res: ServerResponse, answer: Answer): void {
	if (res.headersSent || res.destroyed) {
		res.destroy();
		return;
	}
	const text = JSON.stringify(answer.body);
	res.writeHead(answer.status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(text),
		"cache-control": "no-store",
		...answer.headers,
	});
	res.end(text);
}

function invalid(status: number, message: string, limit?: { run: RunRef; reason: RelayLimitReason }): Answer {
	return new Answer(status, { error: { message, type: "invalid_request_error" } }, NO_RETRY, limit);
}

/** 48000 → "48K" (the docs' wording); other values verbatim. */
function tokenLabel(tokens: number): string {
	return tokens % 1000 === 0 ? `${tokens / 1000}K` : String(tokens);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** input_tokens + output_tokens of a Responses `usage` object, if both are reported. */
function usageTokens(usage: unknown): number | undefined {
	if (!isRecord(usage)) return undefined;
	const { input_tokens: input, output_tokens: output } = usage;
	return isCount(input) && isCount(output) ? input + output : undefined;
}

/** The usage of a terminal `response.*` event's JSON data, if it is one and reports usage. */
function terminalUsage(data: string): number | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || typeof parsed.type !== "string" || !TERMINAL_EVENTS.has(parsed.type)) return undefined;
	return isRecord(parsed.response) ? usageTokens(parsed.response.usage) : undefined;
}

interface UsageScanner {
	/** Reported usage (input + output tokens) of the last terminal response seen, if any. */
	readonly usage: number | undefined;
	push(chunk: Uint8Array): void;
	end(): void;
}

/**
 * Incremental SSE parser (WHATWG event-stream framing: LF, CR or CRLF line ends, also split across chunks; `data:`
 * lines joined by LF; a blank line dispatches). Only events that look terminal are JSON-parsed. A line or event larger
 * than the scan cap is skipped (its usage stays unknown); the bytes still pass through to the client unchanged.
 */
class SseUsage implements UsageScanner {
	usage: number | undefined;
	#decoder = new TextDecoder();
	/** Unterminated tail: the current partial line (plus a trailing CR that may be the first half of CRLF). */
	#tail = "";
	#data: string[] = [];
	#event = "";
	#size = 0;
	#skip = false;

	push(chunk: Uint8Array): void {
		this.#feed(this.#decoder.decode(chunk, { stream: true }));
	}

	end(): void {
		this.#feed(this.#decoder.decode());
		const last = this.#tail.replace(/\r$/, "");
		this.#tail = "";
		if (last !== "") this.#onLine(last);
		this.#dispatch();
	}

	#feed(text: string): void {
		// Fast path: no line end in this chunk (a long data line arriving in pieces) is only appended.
		if (!/[\r\n]/.test(text) && !this.#tail.endsWith("\r")) this.#tail += text;
		else for (const line of this.#lines(this.#tail + text)) this.#onLine(line);
		if (this.#tail.length > MAX_SCAN_CHARS) {
			this.#skip = true;
			this.#tail = "";
		}
	}

	/** Complete lines of `buffer`; the unterminated rest (and a trailing CR, maybe half of CRLF) becomes the tail. */
	#lines(buffer: string): string[] {
		const held = buffer.endsWith("\r") ? "\r" : "";
		const lines = (held ? buffer.slice(0, -1) : buffer).split(/\r\n|\r|\n/);
		this.#tail = (lines.pop() ?? "") + held;
		return lines;
	}

	#onLine(line: string): void {
		if (line === "") this.#dispatch();
		else if (!this.#skip && !line.startsWith(":")) {
			const colon = line.indexOf(":");
			if (colon === -1) this.#onField(line, "");
			else this.#onField(line.slice(0, colon), line.slice(line.startsWith(": ", colon) ? colon + 2 : colon + 1));
		}
	}

	#onField(field: string, value: string): void {
		if (field === "event") this.#event = value;
		if (field !== "data") return;
		this.#size += value.length + 1;
		if (this.#size <= MAX_SCAN_CHARS) this.#data.push(value);
		else {
			this.#skip = true;
			this.#data = [];
		}
	}

	#dispatch(): void {
		const data = this.#data.join("\n");
		const scan = !this.#skip && data !== "" && (TERMINAL_EVENTS.has(this.#event) || TERMINAL_HINT.test(data));
		this.#data = [];
		this.#event = "";
		this.#size = 0;
		this.#skip = false;
		const tokens = scan ? terminalUsage(data) : undefined;
		if (tokens !== undefined) this.usage = tokens;
	}
}

/** A non-streamed JSON response (`stream: false`): usage is the top-level `usage` object. */
class JsonUsage implements UsageScanner {
	usage: number | undefined;
	#chunks: Uint8Array[] = [];
	#size = 0;

	push(chunk: Uint8Array): void {
		this.#size += chunk.length;
		if (this.#size > MAX_SCAN_CHARS) this.#chunks = [];
		else this.#chunks.push(chunk);
	}

	end(): void {
		if (this.#size > MAX_SCAN_CHARS) return;
		try {
			const parsed: unknown = JSON.parse(Buffer.concat(this.#chunks).toString("utf8"));
			if (isRecord(parsed)) this.usage = usageTokens(parsed.usage);
		} catch {
			// Not JSON: usage unknown.
		}
		this.#chunks = [];
	}
}
