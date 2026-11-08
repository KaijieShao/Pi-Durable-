import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { createAgentModels, createAuthContext } from "../../src/agent/models.ts";
import { DEMO_LIMITS, type Limits } from "../../src/coordinator/limits.ts";
import {
	estimateInputTokens,
	hashRunKey,
	projectTokensSpent,
	RELAY_MAX_BODY_BYTES,
	type Relay,
	type RelayLimitReason,
	startRelay,
} from "../../src/coordinator/relay.ts";
import { Store } from "../../src/coordinator/store.ts";
import { createLogger } from "../../src/runtime/log.ts";
import { sleep, waitFor } from "../helpers/env.ts";

const UPSTREAM_KEY = "sk-upstream-relay-test-0000000000000000";
const PROMPT = "PROMPT-TEXT-never-logged";
const SECRET_DETAIL = "upstream-secret-detail timeout rate limit overloaded server_error";

// ---------------------------------------------------------------------------------------------------------------
// Fake upstream: a 127.0.0.1 OpenAI Responses endpoint whose behavior each test sets.

type UpstreamCall = {
	readonly path: string;
	readonly headers: IncomingHttpHeaders;
	readonly body: Record<string, unknown>;
};
type UpstreamHandler = (call: UpstreamCall, res: ServerResponse) => void | Promise<void>;

type Upstream = {
	readonly baseUrl: string;
	readonly calls: UpstreamCall[];
	/** Responses whose client went away before the upstream finished writing. */
	aborted: number;
	handler: UpstreamHandler;
	close(): Promise<void>;
};

async function startUpstream(): Promise<Upstream> {
	const state: Upstream = {
		baseUrl: "",
		calls: [],
		aborted: 0,
		handler: (_call, res) => sseReply(res, responseEvents("Hello from upstream", USAGE)),
		close: async () => {},
	};
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const call = {
				path: req.url ?? "",
				headers: req.headers,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			};
			state.calls.push(call);
			res.on("close", () => {
				if (!res.writableFinished) state.aborted++;
			});
			void state.handler(call, res);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return Object.assign(state, {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	});
}

const USAGE = { input_tokens: 120, output_tokens: 30, total_tokens: 150 };

function responseEvents(text: string, usage: object | undefined, terminal = "response.completed"): object[] {
	const item = {
		type: "message",
		id: "msg_1",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	const done = { id: "resp_1", object: "response", status: "completed", output: [item], ...(usage ? { usage } : {}) };
	return [
		{
			type: "response.created",
			sequence_number: 0,
			response: { id: "resp_1", object: "response", status: "in_progress", output: [] },
		},
		{
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { ...item, status: "in_progress", content: [] },
		},
		{
			type: "response.content_part.added",
			sequence_number: 2,
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		},
		{
			type: "response.output_text.delta",
			sequence_number: 3,
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			delta: text,
		},
		{
			type: "response.output_text.done",
			sequence_number: 4,
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			text,
		},
		{ type: "response.output_item.done", sequence_number: 5, output_index: 0, item },
		{ type: terminal, sequence_number: 6, response: done },
	];
}

function sseFrame(event: object): string {
	return `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseReply(res: ServerResponse, events: object[]): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.end(events.map(sseFrame).join(""));
}

function errorReply(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "application/json", ...headers });
	res.end(JSON.stringify({ error: { message: SECRET_DETAIL, type: "invalid_request_error", code: "x" } }));
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture: a temp Store with a running task/run and its open key, the fake upstream and the relay.

type RunFixture = { readonly key: string; readonly runId: number; readonly taskId: number };

type Fixture = {
	readonly store: Store;
	readonly upstream: Upstream;
	readonly relay: Relay;
	readonly run: RunFixture;
	readonly hits: { runId: number; reason: RelayLimitReason }[];
	/** onCapReached calls (run ids), in order. */
	readonly capped: number[];
	readonly logs: string[];
	addRun(options?: { runState?: string; keyState?: string; keyGeneration?: number }): RunFixture;
};

let updateIds = 1000;

function addRun(
	store: Store,
	options: { runState?: string; keyState?: string; keyGeneration?: number } = {},
): RunFixture {
	const updateId = updateIds++;
	const taskId = store.run(
		`INSERT INTO tasks(chat_id, creator_id, agent_id, text, update_id, state, generation, created_at, updated_at)
		 VALUES (-100123, 7, 'alpha', 'task text', ?, 'running', 1, 0, 0)`,
		updateId,
	).lastInsertRowid;
	const runId = store.run(
		`INSERT INTO runs(task_id, kind, state, requested_by, request_id, input_text, generation, queued_at)
		 VALUES (?, 'initial', ?, 7, ?, 'task text', 1, 0)`,
		taskId,
		options.runState ?? "running",
		String(updateId),
	).lastInsertRowid;
	const key = randomBytes(32).toString("base64url");
	store.run(
		`INSERT INTO run_keys(key_hash, run_id, task_id, generation, state, opened_at) VALUES (?, ?, ?, ?, ?, 0)`,
		hashRunKey(key),
		runId,
		taskId,
		options.keyGeneration ?? 1,
		options.keyState ?? "open",
	);
	return { key, runId, taskId };
}

async function setup(
	t: TestContext,
	options: { limits?: Partial<Limits>; ceiling?: number; codexGateway?: boolean; baseUrl?: string } = {},
): Promise<Fixture> {
	const dir = mkdtempSync(join(tmpdir(), "relay-test-"));
	const store = new Store(join(dir, "coordinator.sqlite"));
	const upstream = await startUpstream();
	const hits: { runId: number; reason: RelayLimitReason }[] = [];
	const capped: number[] = [];
	const logs: string[] = [];
	const relay = await startRelay({
		store,
		limits: { ...DEMO_LIMITS, ...options.limits },
		upstream: { baseUrl: options.baseUrl ?? upstream.baseUrl, apiKey: UPSTREAM_KEY },
		codexGateway: options.codexGateway ?? false,
		projectTokenCeiling: options.ceiling ?? 50_000_000,
		onRunLimit: (runId, reason) => hits.push({ runId, reason }),
		onCapReached: (runId) => capped.push(runId),
		log: createLogger({ level: "debug", sink: (_level, line) => logs.push(line) }),
	});
	const run = addRun(store);
	t.after(async () => {
		await relay.close();
		await upstream.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
		for (const line of logs) {
			for (const secret of [run.key, UPSTREAM_KEY, PROMPT, SECRET_DETAIL]) {
				assert.ok(!line.includes(secret), `log line leaks a secret or body: ${line.slice(0, 80)}`);
			}
		}
	});
	return { store, upstream, relay, run, hits, capped, logs, addRun: (o) => addRun(store, o) };
}

function requestBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		model: "gpt-5.4",
		instructions: "Be brief.",
		input: [{ role: "user", content: [{ type: "input_text", text: PROMPT }] }],
		stream: true,
		store: false,
		...extra,
	};
}

function post(
	relay: Relay,
	key: string | undefined,
	body: unknown = requestBody(),
	signal?: AbortSignal,
): Promise<Response> {
	return fetch(`${relay.url}/responses`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(key === undefined ? {} : { authorization: `Bearer ${key}` }) },
		body: JSON.stringify(body),
		...(signal ? { signal } : {}),
	});
}

function modelRequests(store: Store, runId: number): number {
	return store.get<{ n: number }>("SELECT model_requests AS n FROM runs WHERE id = ?", runId)?.n ?? -1;
}

type BudgetRow = { id: number; run_id: number; reserved: number; actual: number | null; state: string };

function budgetRows(store: Store, runId: number): BudgetRow[] {
	return store.all<BudgetRow>(
		"SELECT id, run_id, reserved, actual, state FROM budget WHERE run_id = ? ORDER BY id",
		runId,
	);
}

/** The real pi-ai OpenAI client (as the runner configures it) calling the relay with a run key. */
async function piCall(relay: Relay, key: string): Promise<AssistantMessage> {
	const env = { OPENAI_API_KEY: key, OPENAI_BASE_URL: relay.url };
	const models = await createAgentModels({
		provider: "openai",
		credentials: {
			read: async () => undefined,
			list: async () => [],
			modify: async () => undefined,
			delete: async () => {},
		},
		authContext: createAuthContext(env, env),
	});
	const model = models.getModel("openai", "gpt-5.4");
	assert.ok(model);
	return models.completeSimple(
		model,
		{ systemPrompt: "Be brief.", messages: [{ role: "user", content: PROMPT, timestamp: 0 }] },
		{ maxRetries: 0 },
	);
}

function asAssistantError(errorMessage: string): AssistantMessage {
	return { stopReason: "error", errorMessage } as AssistantMessage;
}

// ---------------------------------------------------------------------------------------------------------------

test("hashRunKey is sha256 hex and estimateInputTokens counts UTF-8 bytes of instructions, input and tools / 4", () => {
	assert.equal(hashRunKey("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	const body = {
		instructions: "héllo",
		input: [{ role: "user", content: "x".repeat(100) }],
		tools: [],
		model: "y".repeat(999),
	};
	const json = JSON.stringify({ instructions: body.instructions, input: body.input, tools: body.tools });
	assert.equal(estimateInputTokens(body), Math.ceil(Buffer.byteLength(json, "utf8") / 4));
	assert.equal(estimateInputTokens({}), Math.ceil(2 / 4));
	assert.equal(estimateInputTokens("not an object"), 1);
});

test("an open key forwards with the real key, streams SSE as it arrives and reconciles usage", async (t) => {
	const f = await setup(t);
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const events = responseEvents("Hello from upstream", USAGE);
	f.upstream.handler = async (_call, res) => {
		res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "upstream=1", "x-internal": "1" });
		res.write(sseFrame(events[0] as object));
		await gate; // the rest only after the client has seen the first event: proves no buffering
		for (const event of events.slice(1)) res.write(sseFrame(event));
		res.end();
	};
	const response = await post(f.relay, f.run.key);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
	assert.equal(response.headers.get("set-cookie"), null);
	assert.equal(response.headers.get("x-internal"), null);
	const reader = response.body?.getReader();
	assert.ok(reader);
	const decoder = new TextDecoder();
	const first = await Promise.race([reader.read(), sleep(5000).then(() => undefined)]);
	assert.ok(first && !first.done, "first SSE chunk arrives before the upstream finishes");
	let text = decoder.decode(first.value, { stream: true });
	assert.match(text, /response\.created/);
	assert.doesNotMatch(text, /response\.completed/);
	release();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	assert.equal(text, events.map(sseFrame).join(""), "body passed through unchanged");

	assert.equal(f.upstream.calls.length, 1);
	const call = f.upstream.calls[0];
	assert.ok(call);
	assert.equal(call.path, "/v1/responses");
	assert.equal(call.headers.authorization, `Bearer ${UPSTREAM_KEY}`);
	assert.ok(!JSON.stringify(call.headers).includes(f.run.key), "the run key never reaches upstream");
	assert.equal((call.body.input as { content: { text: string }[] }[])[0]?.content[0]?.text, PROMPT);
	assert.equal(modelRequests(f.store, f.run.runId), 1);
	const rows = await waitFor(() => {
		const all = budgetRows(f.store, f.run.runId);
		return all.length === 1 && all[0]?.state !== "reserved" ? all : undefined;
	});
	assert.deepEqual(
		rows.map((row) => ({ state: row.state, actual: row.actual, reserved: row.reserved })),
		[{ state: "reconciled", actual: 150, reserved: DEMO_LIMITS.maxInputTokens + DEMO_LIMITS.maxOutputTokens }],
	);
	assert.equal(projectTokensSpent(f.store), 150);
	assert.deepEqual(f.hits, []);
});

test("the real pi-ai OpenAI client completes through the relay", async (t) => {
	const f = await setup(t);
	const message = await piCall(f.relay, f.run.key);
	assert.equal(message.stopReason, "stop", message.errorMessage);
	assert.deepEqual(
		message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		["Hello from upstream"],
	);
	assert.equal(message.usage.output, 30);
	assert.equal(f.upstream.calls[0]?.headers.authorization, `Bearer ${UPSTREAM_KEY}`);
	await waitFor(() => budgetRows(f.store, f.run.runId)[0]?.state === "reconciled");
});

test("closed, unknown, missing and stale keys get 401 and never reach upstream", async (t) => {
	const f = await setup(t);
	const closed = f.addRun({ keyState: "closed" });
	const finished = f.addRun({ runState: "finished" });
	const finalizing = f.addRun({ runState: "finalizing" });
	const queued = f.addRun({ runState: "queued" });
	const staleGeneration = f.addRun({ keyGeneration: 0 });
	const keys = [closed.key, finished.key, finalizing.key, queued.key, staleGeneration.key, "unknown-key", undefined];
	for (const key of keys) {
		const response = await post(f.relay, key);
		assert.equal(response.status, 401);
		assert.deepEqual(await response.json(), { error: { message: "run key not open" } });
	}
	const raw = await fetch(`${f.relay.url}/responses`, {
		method: "POST",
		headers: { authorization: `Basic ${f.run.key}` },
		body: "{}",
	});
	assert.equal(raw.status, 401);
	await raw.arrayBuffer();
	// A key closed after it was used is refused from then on.
	assert.equal((await post(f.relay, f.run.key)).status, 200);
	f.store.run("UPDATE run_keys SET state = 'closed' WHERE run_id = ?", f.run.runId);
	assert.equal((await post(f.relay, f.run.key)).status, 401);
	assert.equal(f.upstream.calls.length, 1);
	for (const run of [closed, finished, finalizing, queued, staleGeneration]) {
		assert.equal(modelRequests(f.store, run.runId), 0);
		assert.deepEqual(budgetRows(f.store, run.runId), []);
	}
	assert.deepEqual(f.hits, []);
});

test("only POST /v1/responses is served", async (t) => {
	const f = await setup(t);
	const base = f.relay.url.replace(/\/v1$/, "");
	for (const [method, path] of [
		["GET", "/v1/responses"],
		["POST", "/v1/chat/completions"],
		["POST", "/v1/models"],
		["POST", "/responses"],
	] as const) {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: { authorization: `Bearer ${f.run.key}` },
			...(method === "POST" ? { body: "{}" } : {}),
		});
		assert.equal(response.status, 404, `${method} ${path}`);
		assert.deepEqual(await response.json(), { error: { message: "not found" } });
	}
	assert.ok(f.relay.url.startsWith("http://127.0.0.1:"));
	assert.equal(f.upstream.calls.length, 0);
});

test("the 31st request is refused: the 30-request cap counts retries (429/5xx answers too)", async (t) => {
	const f = await setup(t);
	/** onCapReached calls already made when each request reached upstream. */
	const cappedAtUpstream: number[] = [];
	f.upstream.handler = (_call, res) => {
		cappedAtUpstream.push(f.capped.length);
		if (f.upstream.calls.length % 3 === 0) errorReply(res, 503, { "retry-after": "1" });
		else sseReply(res, responseEvents("ok", USAGE));
	};
	const statuses: number[] = [];
	for (let i = 0; i < DEMO_LIMITS.modelRequestsPerRun; i++) {
		const response = await post(f.relay, f.run.key);
		statuses.push(response.status);
		await response.arrayBuffer();
	}
	assert.equal(statuses.filter((status) => status === 503).length, 10);
	assert.equal(statuses.filter((status) => status === 200).length, 20);
	assert.equal(modelRequests(f.store, f.run.runId), 30);
	assert.deepEqual(f.hits, []);
	// The 30th (last allowed) admission reports the cap reached once, before that request is forwarded.
	assert.deepEqual(f.capped, [f.run.runId]);
	assert.deepEqual(cappedAtUpstream, [...Array(29).fill(0), 1]);

	const refused = await post(f.relay, f.run.key);
	assert.equal(refused.status, 400);
	assert.deepEqual(await refused.json(), {
		error: { message: "request limit reached (30 per run)", type: "invalid_request_error" },
	});
	assert.deepEqual(f.hits, [{ runId: f.run.runId, reason: "request_cap" }]);
	assert.equal(f.upstream.calls.length, 30);
	assert.equal(modelRequests(f.store, f.run.runId), 30);
	const rows = await waitFor(() => {
		const all = budgetRows(f.store, f.run.runId);
		return all.every((row) => row.state !== "reserved") ? all : undefined;
	});
	assert.equal(rows.length, 30);
	assert.equal(rows.filter((row) => row.state === "unknown").length, 10, "a 5xx keeps its reservation");
	// Still refused afterwards, without reaching upstream; refusals do not report the cap reached again.
	assert.equal((await post(f.relay, f.run.key)).status, 400);
	assert.equal(f.upstream.calls.length, 30);
	assert.deepEqual(f.capped, [f.run.runId]);
	assert.ok(isRetryableAssistantError(asAssistantError("OpenAI API error (503): upstream error (status 503)")));
	assert.ok(!isRetryableAssistantError(asAssistantError("400 request limit reached (30 per run)")));
});

test("an input estimated over 48K tokens is refused before it is sent", async (t) => {
	const f = await setup(t);
	const body = requestBody({ input: [{ role: "user", content: "x".repeat(4 * DEMO_LIMITS.maxInputTokens) }] });
	assert.ok(estimateInputTokens(body) > DEMO_LIMITS.maxInputTokens);
	const response = await post(f.relay, f.run.key, body);
	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error: { message: "input exceeds 48K tokens", type: "invalid_request_error" },
	});
	assert.equal(f.upstream.calls.length, 0);
	assert.deepEqual(f.hits, [{ runId: f.run.runId, reason: "context_limit" }]);
	assert.equal(modelRequests(f.store, f.run.runId), 0);
	assert.deepEqual(budgetRows(f.store, f.run.runId), []);
	// The run stays refused, even for a small request, until the engine revokes it.
	assert.equal((await post(f.relay, f.run.key)).status, 400);
	assert.equal(f.upstream.calls.length, 0);
	assert.ok(
		!isRetryableAssistantError(asAssistantError('OpenAI API error (400): {"message":"input exceeds 48K tokens"}')),
	);

	// Just under the limit passes.
	const other = f.addRun();
	const fits = requestBody({ instructions: "", input: "" });
	const pad = 4 * DEMO_LIMITS.maxInputTokens - Buffer.byteLength(JSON.stringify({ instructions: "", input: "" }));
	fits.input = "y".repeat(pad);
	assert.equal(estimateInputTokens(fits), DEMO_LIMITS.maxInputTokens);
	const ok = await post(f.relay, other.key, fits);
	assert.equal(ok.status, 200);
	await ok.arrayBuffer();
});

test("a body over the size limit gets 413 and stops the run at the context limit", async (t) => {
	const f = await setup(t);
	const big = Buffer.alloc(RELAY_MAX_BODY_BYTES + 1024, 0x61);
	const status = await new Promise<number>((resolve, reject) => {
		let code: number | undefined;
		let closed = false;
		const settle = (): void => {
			if (code !== undefined && closed) resolve(code);
		};
		const url = new URL(`${f.relay.url}/responses`);
		const req = request(
			{
				host: url.hostname,
				port: url.port,
				path: url.pathname,
				method: "POST",
				headers: { authorization: `Bearer ${f.run.key}`, "content-type": "application/json" },
			},
			(res) => {
				res.resume();
				res.on("end", () => {
					code = res.statusCode ?? 0;
					settle();
				});
			},
		);
		// Resolve once the upload finished too: the relay drains the rest of the body after its 413.
		req.on("close", () => {
			closed = true;
			settle();
		});
		req.on("error", reject);
		req.end(big); // chunked upload: no content-length shortcut, the relay counts the bytes it reads
	});
	assert.equal(status, 413);
	assert.equal(f.upstream.calls.length, 0);
	assert.deepEqual(f.hits, [{ runId: f.run.runId, reason: "context_limit" }]);
	assert.equal(modelRequests(f.store, f.run.runId), 0);
});

test("the project token ceiling refuses a request whose reservation does not fit", async (t) => {
	const reserve = DEMO_LIMITS.maxInputTokens + DEMO_LIMITS.maxOutputTokens;
	const f = await setup(t, { ceiling: 100_000 });
	const first = await post(f.relay, f.run.key);
	assert.equal(first.status, 200);
	await first.arrayBuffer();
	await waitFor(() => budgetRows(f.store, f.run.runId)[0]?.state === "reconciled");
	// Another run's usage was never reported: its reservation is kept.
	const other = f.addRun();
	f.store.run(
		"INSERT INTO budget(run_id, task_id, reserved, state, created_at) VALUES (?, ?, 40000, 'unknown', 0)",
		other.runId,
		other.taskId,
	);
	assert.equal(projectTokensSpent(f.store), 150 + 40_000);
	assert.ok(150 + 40_000 + reserve > 100_000);
	const refused = await post(f.relay, f.run.key);
	assert.equal(refused.status, 400);
	assert.deepEqual(await refused.json(), {
		error: { message: "project token budget exhausted", type: "invalid_request_error" },
	});
	assert.deepEqual(f.hits, [{ runId: f.run.runId, reason: "budget" }]);
	assert.equal(f.upstream.calls.length, 1);
	assert.equal(modelRequests(f.store, f.run.runId), 1);
	assert.equal(budgetRows(f.store, f.run.runId).length, 1);
	assert.ok(!isRetryableAssistantError(asAssistantError("400 project token budget exhausted")));
});

test("upstream 400 becomes a sanitized, non-retryable 400 and fails the run", async (t) => {
	const f = await setup(t);
	f.upstream.handler = (_call, res) => errorReply(res, 400);
	const message = await piCall(f.relay, f.run.key);
	assert.equal(message.stopReason, "error");
	assert.ok(message.errorMessage?.includes("upstream rejected the request (status 400)"), message.errorMessage);
	assert.ok(!message.errorMessage?.includes(SECRET_DETAIL));
	assert.equal(isRetryableAssistantError(message), false, message.errorMessage);
	assert.deepEqual(f.hits, [{ runId: f.run.runId, reason: "upstream_400" }]);
	assert.equal(f.upstream.calls.length, 1);

	const other = f.addRun();
	const response = await post(f.relay, other.key);
	assert.equal(response.status, 400);
	assert.equal(response.headers.get("x-should-retry"), "false");
	const text = await response.text();
	assert.equal(
		text,
		'{"error":{"message":"upstream rejected the request (status 400)","type":"invalid_request_error"}}',
	);
	assert.ok(!isRetryableAssistantError(asAssistantError(`OpenAI API error (400): ${text}`)));
	assert.ok(!isRetryableAssistantError(asAssistantError("400 upstream rejected the request (status 400)")));
	// The failed run is refused from now on without reaching upstream.
	assert.equal((await post(f.relay, f.run.key)).status, 400);
	assert.equal(f.upstream.calls.length, 2);
	assert.equal(modelRequests(f.store, f.run.runId), 1);
	await waitFor(() => budgetRows(f.store, f.run.runId)[0]?.state === "unknown");
});

test("upstream 401 and 403 become a sanitized, non-retryable 401 and fail the run", async (t) => {
	const f = await setup(t);
	f.upstream.handler = (_call, res) => errorReply(res, 401);
	const message = await piCall(f.relay, f.run.key);
	assert.equal(message.stopReason, "error");
	assert.ok(message.errorMessage?.includes("upstream rejected the credentials (status 401)"), message.errorMessage);
	assert.ok(!message.errorMessage?.includes(SECRET_DETAIL));
	assert.equal(isRetryableAssistantError(message), false, message.errorMessage);
	assert.deepEqual(f.hits, [{ runId: f.run.runId, reason: "upstream_401" }]);

	f.upstream.handler = (_call, res) => errorReply(res, 403);
	const other = f.addRun();
	const response = await post(f.relay, other.key);
	assert.equal(response.status, 401);
	const text = await response.text();
	assert.equal(
		text,
		'{"error":{"message":"upstream rejected the credentials (status 401)","type":"authentication_error"}}',
	);
	assert.ok(!isRetryableAssistantError(asAssistantError(`OpenAI API error (401): ${text}`)));
	assert.deepEqual(f.hits.at(-1), { runId: other.runId, reason: "upstream_401" });
	// "run key not open" is not retryable either.
	assert.ok(!isRetryableAssistantError(asAssistantError('OpenAI API error (401): {"message":"run key not open"}')));
});

test("upstream 429 and 5xx keep their status and Retry-After and are retryable for Pi", async (t) => {
	const f = await setup(t);
	for (const status of [429, 500, 502, 503, 504]) {
		f.upstream.handler = (_call, res) => errorReply(res, status, { "retry-after": "7", "x-secret": "nope" });
		const message = await piCall(f.relay, f.run.key);
		assert.equal(message.stopReason, "error");
		assert.ok(message.errorMessage?.includes(`upstream error (status ${status})`), message.errorMessage);
		assert.ok(!message.errorMessage?.includes(SECRET_DETAIL));
		assert.equal(isRetryableAssistantError(message), true, message.errorMessage);

		const response = await post(f.relay, f.run.key);
		assert.equal(response.status, status);
		assert.equal(response.headers.get("retry-after"), "7");
		assert.equal(response.headers.get("x-secret"), null);
		const text = await response.text();
		assert.equal(text, `{"error":{"message":"upstream error (status ${status})"}}`);
		assert.ok(isRetryableAssistantError(asAssistantError(`OpenAI API error (${status}): ${text}`)));
	}
	assert.deepEqual(f.hits, []);
	assert.equal(modelRequests(f.store, f.run.runId), 10);
	await waitFor(() => budgetRows(f.store, f.run.runId).every((row) => row.state === "unknown"));
});

test("an unreachable upstream answers 502, retryable, and keeps the reservation", async (t) => {
	const closed = createServer();
	await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
	const port = (closed.address() as AddressInfo).port;
	await new Promise<void>((resolve) => closed.close(() => resolve()));
	const f = await setup(t, { baseUrl: `http://127.0.0.1:${port}/v1` });
	const response = await post(f.relay, f.run.key);
	assert.equal(response.status, 502);
	const text = await response.text();
	assert.equal(text, '{"error":{"message":"upstream connection failed (status 502)"}}');
	assert.ok(isRetryableAssistantError(asAssistantError(`OpenAI API error (502): ${text}`)));
	const message = await piCall(f.relay, f.run.key);
	assert.equal(isRetryableAssistantError(message), true, message.errorMessage);
	assert.deepEqual(f.hits, []);
	await waitFor(() => {
		const rows = budgetRows(f.store, f.run.runId);
		return rows.length === 2 && rows.every((row) => row.state === "unknown");
	});
});

test("a stream without usage leaves the budget row unknown with its reservation", async (t) => {
	const f = await setup(t);
	f.upstream.handler = (_call, res) => sseReply(res, responseEvents("no usage", undefined));
	const response = await post(f.relay, f.run.key);
	assert.equal(response.status, 200);
	await response.text();
	const rows = await waitFor(() => {
		const all = budgetRows(f.store, f.run.runId);
		return all[0]?.state === "unknown" ? all : undefined;
	});
	assert.equal(rows[0]?.actual, null);
	assert.equal(projectTokensSpent(f.store), rows[0]?.reserved);

	// response.incomplete usage reconciles; CRLF framing split across chunks is parsed.
	f.upstream.handler = async (_call, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		const text = responseEvents("cut", { input_tokens: 9, output_tokens: 4 }, "response.incomplete")
			.map((event) => sseFrame(event).replaceAll("\n", "\r\n"))
			.join("");
		for (let i = 0; i < text.length; i += 7) {
			res.write(text.slice(i, i + 7));
			if (i % 70 === 0) await sleep(1);
		}
		res.end();
	};
	const second = await post(f.relay, f.run.key);
	await second.text();
	await waitFor(() => budgetRows(f.store, f.run.runId)[1]?.state === "reconciled");
	assert.equal(budgetRows(f.store, f.run.runId)[1]?.actual, 13);
});

test("max_output_tokens is clamped to 16K, set when absent, and left absent for a Codex gateway", async (t) => {
	const f = await setup(t);
	const cases: [Record<string, unknown>, number | undefined][] = [
		[{ max_output_tokens: 100_000 }, DEMO_LIMITS.maxOutputTokens],
		[{ max_output_tokens: 500 }, 500],
		[{}, DEMO_LIMITS.maxOutputTokens],
		[{ max_output_tokens: "lots" }, DEMO_LIMITS.maxOutputTokens],
	];
	for (const [extra, expected] of cases) {
		const response = await post(f.relay, f.run.key, requestBody(extra));
		await response.arrayBuffer();
		assert.equal(f.upstream.calls.at(-1)?.body.max_output_tokens, expected, JSON.stringify(extra));
	}
	const rows = await waitFor(() => {
		const all = budgetRows(f.store, f.run.runId);
		return all.length === 4 ? all : undefined;
	});
	assert.equal(rows[1]?.reserved, DEMO_LIMITS.maxInputTokens + 500);

	const codex = await setup(t, { codexGateway: true });
	const absent = await post(codex.relay, codex.run.key, requestBody());
	await absent.arrayBuffer();
	assert.ok(!("max_output_tokens" in (codex.upstream.calls.at(-1)?.body ?? {})));
	const tooMany = await post(codex.relay, codex.run.key, requestBody({ max_output_tokens: 99_999 }));
	await tooMany.arrayBuffer();
	assert.equal(codex.upstream.calls.at(-1)?.body.max_output_tokens, DEMO_LIMITS.maxOutputTokens);
});

test("a client disconnect aborts the upstream request", async (t) => {
	const f = await setup(t);
	const events = responseEvents("never finished", USAGE);
	f.upstream.handler = (_call, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(sseFrame(events[0] as object));
		// Never ends on its own.
	};
	const controller = new AbortController();
	const response = await post(f.relay, f.run.key, requestBody(), controller.signal);
	const reader = response.body?.getReader();
	assert.ok(reader);
	const first = await reader.read();
	assert.ok(!first.done);
	controller.abort();
	await waitFor(() => f.upstream.aborted === 1, { what: "upstream request aborted" });
	await waitFor(() => budgetRows(f.store, f.run.runId)[0]?.state === "unknown");
});

test("requests of other runs and invalid bodies are not counted", async (t) => {
	const f = await setup(t);
	const notJson = await fetch(`${f.relay.url}/responses`, {
		method: "POST",
		headers: { authorization: `Bearer ${f.run.key}`, "content-type": "application/json" },
		body: "{not json",
	});
	assert.equal(notJson.status, 400);
	await notJson.arrayBuffer();
	const serverState = await post(f.relay, f.run.key, requestBody({ previous_response_id: "resp_0" }));
	assert.equal(serverState.status, 400);
	await serverState.arrayBuffer();
	assert.equal(modelRequests(f.store, f.run.runId), 0);
	assert.equal(f.upstream.calls.length, 0);
	assert.deepEqual(f.hits, []);
	// Concurrent requests are each counted exactly once.
	const responses = await Promise.all(Array.from({ length: 8 }, () => post(f.relay, f.run.key)));
	await Promise.all(responses.map((response) => response.arrayBuffer()));
	assert.equal(modelRequests(f.store, f.run.runId), 8);
	assert.equal(f.upstream.calls.length, 8);
});

test("close() aborts in-flight upstream requests and settles their budget rows", async (t) => {
	const f = await setup(t);
	f.upstream.handler = (_call, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(": keep-alive\n\n");
	};
	const pending = post(f.relay, f.run.key).then(
		async (response) => {
			await response.text().catch(() => "");
		},
		() => {},
	);
	await waitFor(() => f.upstream.calls.length === 1);
	await f.relay.close();
	await pending;
	assert.equal(budgetRows(f.store, f.run.runId)[0]?.state, "unknown");
	await waitFor(() => f.upstream.aborted === 1);
});
