/**
 * A fake OpenAI Responses upstream on 127.0.0.1 for tests: `POST /v1/responses` answers with a scripted step as a
 * Server-Sent Events stream that pi-ai's openai-responses parser accepts (response.created, output_item.added,
 * output_text.delta / function_call_arguments.delta+done, output_item.done, response.completed with usage), an HTTP
 * error, or a stream that hangs until the client goes away. Records every request (body and Authorization header).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export type FakeToolCall = { readonly name: string; readonly args: Record<string, unknown> };

export type FakeStep =
	/** A final answer. */
	| { readonly text: string; readonly usage?: { readonly input: number; readonly output: number } }
	/** One round of tool calls (optionally after some text). */
	| { readonly toolCalls: readonly FakeToolCall[]; readonly text?: string }
	/** An HTTP error response; `body` defaults to an OpenAI-style JSON error. */
	| { readonly status: number; readonly body?: string; readonly headers?: Readonly<Record<string, string>> }
	/** Headers and `response.created`, then nothing until the client disconnects or the fake stops. */
	| { readonly hang: true };

export type FakeToolResult = { readonly callId: string; readonly output: string };

export type FakeRequest = {
	/** 0-based position among all requests this fake received. */
	readonly index: number;
	// biome-ignore lint/suspicious/noExplicitAny: a raw JSON request body
	readonly body: any;
	readonly auth: string | undefined;
	/** Every text of the request (instructions, messages, tool outputs), joined with newlines. */
	readonly inputText: string;
	/** Texts of user messages, oldest first. */
	readonly userTexts: readonly string[];
	/** Tool results (function_call_output items), oldest first. */
	readonly toolResults: readonly FakeToolResult[];
};

export type FakeHandler = (request: FakeRequest) => FakeStep | Promise<FakeStep>;

export type RecordedRequest = {
	readonly method: string;
	readonly path: string;
	// biome-ignore lint/suspicious/noExplicitAny: a raw JSON request body
	readonly body: any;
	readonly auth: string | undefined;
};

export class FakeModel {
	/** Every POST /v1/responses request, in arrival order. */
	readonly requests: RecordedRequest[] = [];
	#server: Server | undefined;
	readonly #sockets = new Set<Socket>();
	readonly #open = new Set<ServerResponse>();
	#handler: FakeHandler = () => ({ text: "ok" });
	#url = "";

	/** Replace the script; `handler` is asked once per request. */
	script(handler: FakeHandler): void {
		this.#handler = handler;
	}

	/** Listen on an ephemeral 127.0.0.1 port; returns the base URL, e.g. http://127.0.0.1:PORT/v1. */
	async start(): Promise<string> {
		if (this.#server !== undefined) return this.#url;
		const server = createServer((request, response) => {
			void this.#serve(request, response);
		});
		server.on("connection", (socket) => {
			this.#sockets.add(socket);
			socket.on("close", () => this.#sockets.delete(socket));
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		this.#server = server;
		const { port } = server.address() as AddressInfo;
		this.#url = `http://127.0.0.1:${port}/v1`;
		return this.#url;
	}

	get url(): string {
		return this.#url;
	}

	async stop(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (server === undefined) return;
		for (const response of this.#open) response.destroy();
		for (const socket of this.#sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/** Forget recorded requests and install `handler` (default: answer "ok"). */
	reset(handler: FakeHandler = () => ({ text: "ok" })): void {
		this.requests.length = 0;
		this.#handler = handler;
	}

	/** Resolve once at least `count` requests arrived. */
	async waitForRequests(count: number, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (this.requests.length < count) {
			if (Date.now() > deadline) throw new Error(`fake model: ${this.requests.length} of ${count} requests`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const path = (request.url ?? "/").split("?")[0] ?? "/";
		const raw = await readBody(request);
		if (request.method !== "POST" || path !== "/v1/responses") {
			sendJson(response, 404, { error: { message: "not found" } });
			return;
		}
		const body = parseJson(raw);
		if (body === undefined) {
			sendJson(response, 400, { error: { message: "invalid json" } });
			return;
		}
		const auth = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
		const index = this.requests.length;
		this.requests.push({ method: request.method, path, body, auth });
		const step = await this.#ask({
			index,
			body,
			auth,
			inputText: requestTexts(body).join("\n"),
			userTexts: userTexts(body),
			toolResults: toolResults(body),
		});
		if (step === undefined) {
			sendJson(response, 500, { error: { message: "fake handler failed" } });
			return;
		}
		this.#respond(response, step, index, body, raw.length);
	}

	async #ask(request: FakeRequest): Promise<FakeStep | undefined> {
		try {
			return await this.#handler(request);
		} catch {
			return undefined;
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: a raw JSON request body
	#respond(response: ServerResponse, step: FakeStep, index: number, body: any, bodyBytes: number): void {
		if ("status" in step) {
			response.writeHead(step.status, { "content-type": "application/json", ...step.headers });
			response.end(step.body ?? JSON.stringify({ error: { message: `fake error ${step.status}`, type: "fake" } }));
			return;
		}
		const stream = new SseWriter(response, `resp_${index + 1}`, typeof body?.model === "string" ? body.model : "fake");
		this.#open.add(response);
		response.on("close", () => this.#open.delete(response));
		stream.begin();
		if (!("hang" in step)) writeStep(stream, step, bodyBytes);
	}
}

/** The output items of an answer or a tool round, then `response.completed` with usage. */
function writeStep(
	stream: SseWriter,
	step: Extract<FakeStep, { text: string } | { toolCalls: readonly FakeToolCall[] }>,
	bodyBytes: number,
): void {
	if (step.text !== undefined) stream.message(step.text);
	if ("toolCalls" in step) {
		for (const call of step.toolCalls) stream.functionCall(call.name, JSON.stringify(call.args));
	}
	const usage = "usage" in step ? step.usage : undefined;
	stream.complete(usage?.input ?? Math.ceil(bodyBytes / 4), usage?.output ?? 10);
}

/** Every text in a Responses request body: instructions, message contents, and tool outputs. */
// biome-ignore lint/suspicious/noExplicitAny: a raw JSON request body
export function requestTexts(body: any): string[] {
	const texts: string[] = [];
	if (typeof body?.instructions === "string") texts.push(body.instructions);
	for (const item of inputItems(body)) {
		if (item?.type === "function_call_output") texts.push(outputText(item.output));
		else if (item?.type === "function_call") texts.push(`${item.name}(${item.arguments})`);
		else if (item?.content !== undefined) texts.push(contentText(item.content));
	}
	return texts;
}

/** Texts of the user messages in a request body, oldest first. */
// biome-ignore lint/suspicious/noExplicitAny: a raw JSON request body
export function userTexts(body: any): string[] {
	return inputItems(body)
		.filter((item) => item?.role === "user" && item?.type !== "function_call_output")
		.map((item) => contentText(item.content));
}

/** The newest user message text, if any. */
// biome-ignore lint/suspicious/noExplicitAny: a raw JSON request body
export function lastUserText(body: any): string | undefined {
	return userTexts(body).at(-1);
}

/** Tool results (function_call_output items) of a request body, oldest first. */
// biome-ignore lint/suspicious/noExplicitAny: a raw JSON request body
export function toolResults(body: any): FakeToolResult[] {
	return inputItems(body)
		.filter((item) => item?.type === "function_call_output")
		.map((item) => ({ callId: String(item.call_id), output: outputText(item.output) }));
}

/** Text of the assistant messages in a request body (earlier answers replayed as history). */
// biome-ignore lint/suspicious/noExplicitAny: a raw JSON request body
export function assistantTexts(body: any): string[] {
	return inputItems(body)
		.filter((item) => item?.role === "assistant" || item?.type === "message")
		.map((item) => contentText(item.content));
}

// biome-ignore lint/suspicious/noExplicitAny: raw JSON
function inputItems(body: any): any[] {
	if (Array.isArray(body?.input)) return body.input;
	if (typeof body?.input === "string") return [{ role: "user", content: body.input }];
	return [];
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			typeof part?.text === "string" ? [part.text] : typeof part?.refusal === "string" ? [part.refusal] : [],
		)
		.join("\n");
}

function outputText(output: unknown): string {
	return typeof output === "string" ? output : contentText(output);
}

class SseWriter {
	readonly #response: ServerResponse;
	readonly #id: string;
	readonly #model: string;
	// biome-ignore lint/suspicious/noExplicitAny: Responses output items
	readonly #items: any[] = [];
	#sequence = 0;

	constructor(response: ServerResponse, id: string, model: string) {
		this.#response = response;
		this.#id = id;
		this.#model = model;
	}

	begin(): void {
		this.#response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		this.#event("response.created", { response: this.#snapshot("in_progress") });
		this.#event("response.in_progress", { response: this.#snapshot("in_progress") });
	}

	message(text: string): void {
		const outputIndex = this.#items.length;
		const id = `msg_${this.#id}_${outputIndex}`;
		const part = { type: "output_text", text: "", annotations: [] };
		this.#event("response.output_item.added", {
			output_index: outputIndex,
			item: { type: "message", id, status: "in_progress", role: "assistant", content: [] },
		});
		this.#event("response.content_part.added", { item_id: id, output_index: outputIndex, content_index: 0, part });
		const middle = Math.ceil(text.length / 2);
		for (const delta of [text.slice(0, middle), text.slice(middle)]) {
			if (delta === "") continue;
			this.#event("response.output_text.delta", { item_id: id, output_index: outputIndex, content_index: 0, delta });
		}
		this.#event("response.output_text.done", { item_id: id, output_index: outputIndex, content_index: 0, text });
		const done = { ...part, text };
		this.#event("response.content_part.done", { item_id: id, output_index: outputIndex, content_index: 0, part: done });
		const item = { type: "message", id, status: "completed", role: "assistant", content: [done] };
		this.#items.push(item);
		this.#event("response.output_item.done", { output_index: outputIndex, item });
	}

	functionCall(name: string, args: string): void {
		const outputIndex = this.#items.length;
		const id = `fc_${this.#id}_${outputIndex}`;
		const callId = `call_${this.#id}_${outputIndex}`;
		this.#event("response.output_item.added", {
			output_index: outputIndex,
			item: { type: "function_call", id, call_id: callId, name, arguments: "", status: "in_progress" },
		});
		this.#event("response.function_call_arguments.delta", { item_id: id, output_index: outputIndex, delta: args });
		this.#event("response.function_call_arguments.done", { item_id: id, output_index: outputIndex, arguments: args });
		const item = { type: "function_call", id, call_id: callId, name, arguments: args, status: "completed" };
		this.#items.push(item);
		this.#event("response.output_item.done", { output_index: outputIndex, item });
	}

	complete(inputTokens: number, outputTokens: number): void {
		const usage = {
			input_tokens: inputTokens,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: outputTokens,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: inputTokens + outputTokens,
		};
		this.#event("response.completed", { response: { ...this.#snapshot("completed"), usage } });
		this.#response.end();
	}

	#snapshot(status: string) {
		return {
			id: this.#id,
			object: "response",
			created_at: Math.floor(Date.now() / 1000),
			model: this.#model,
			status,
			output: [...this.#items],
		};
	}

	#event(type: string, fields: Record<string, unknown>): void {
		const data = { type, sequence_number: this.#sequence++, ...fields };
		this.#response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
	}
}

// biome-ignore lint/suspicious/noExplicitAny: a raw JSON request body
function parseJson(raw: string): any {
	try {
		return JSON.parse(raw) ?? undefined;
	} catch {
		return undefined;
	}
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}
