import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Update } from "grammy/types";

export type ApiCall = { method: string; body: Record<string, unknown> };
export type ServerMessage = {
	id: number;
	chatId: number;
	text: string;
	replyTo?: number;
	/** `message_thread_id` the message was sent with (forum topic). */
	threadId?: number;
	/** `reply_parameters.allow_sending_without_reply`. */
	allowSendingWithoutReply?: boolean;
	/** `link_preview_options.is_disabled`. */
	linkPreviewDisabled?: boolean;
};

/**
 * A failure injected into the next call(s) of a method:
 * - `{ status }`: a Bot API error answer with that HTTP status and `error_code` (429 carries
 *   `parameters.retry_after` when `retryAfter` is set);
 * - `{ drop: "before" }`: the connection is destroyed before the call takes effect (network failure);
 * - `{ drop: "after" }`: the call takes effect (a sent message is recorded), then the connection is destroyed: the
 *   response is lost, as in a crash between Telegram accepting a message and the sender recording it.
 */
export type InjectedFailure =
	| { readonly status: number; readonly description?: string; readonly retryAfter?: number }
	| { readonly drop: "before" | "after" };

/** Options of a group message built by `groupUpdate` / `FakeBotApi.groupMessage`: from user X, in group G, ... */
export type GroupMessageOptions = {
	/** Group G (negative id). */
	readonly chatId: number;
	/** User X. */
	readonly fromId: number;
	readonly text?: string;
	readonly messageId?: number;
	readonly updateId?: number;
	readonly chatType?: "group" | "supergroup";
	/** Forum topic: the message is a topic message in this thread. */
	readonly threadId?: number;
	/** Reply to message M; `fromBot` (default true) says whether M was the bot's. */
	readonly replyTo?: number | { readonly messageId: number; readonly fromBot?: boolean; readonly text?: string };
	readonly isBot?: boolean;
	/** Deliver as `edited_message` instead of `message`. */
	readonly edited?: boolean;
	/** Extra message fields (sender_chat, forward_origin, caption, ...). */
	readonly extra?: Record<string, unknown>;
	/** Username of the bot replied to (default "test_bot"). */
	readonly botUsername?: string;
	readonly botId?: number;
};

export const DATE = 1_790_000_000;
let nextStandaloneUpdateId = 900_000;
let nextStandaloneMessageId = 100_000;

/** Build a group message update (does not queue it anywhere). */
export function groupUpdate(options: GroupMessageOptions): Update {
	const chat = { id: options.chatId, type: options.chatType ?? "supergroup", title: "group" };
	const topic = options.threadId === undefined ? {} : { message_thread_id: options.threadId, is_topic_message: true };
	const message: Record<string, unknown> = {
		message_id: options.messageId ?? nextStandaloneMessageId++,
		date: DATE,
		chat,
		from: { id: options.fromId, is_bot: options.isBot ?? false, first_name: `U${options.fromId}` },
		...(options.text === undefined ? {} : { text: options.text }),
		...topic,
	};
	const target = replyTarget(options, chat);
	if (target !== undefined) message.reply_to_message = target;
	Object.assign(message, options.extra ?? {});
	const updateId = options.updateId ?? nextStandaloneUpdateId++;
	return (options.edited === true
		? { update_id: updateId, edited_message: { ...message, edit_date: DATE + 1 } }
		: { update_id: updateId, message }) as unknown as Update;
}

/** The `reply_to_message` of a built message: the replied-to message, or a forum topic's creation message. */
function replyTarget(options: GroupMessageOptions, chat: object): Record<string, unknown> | undefined {
	const reply = typeof options.replyTo === "number" ? { messageId: options.replyTo } : options.replyTo;
	const topic = options.threadId === undefined ? {} : { message_thread_id: options.threadId, is_topic_message: true };
	if (reply !== undefined) {
		const bot = {
			id: options.botId ?? 42,
			is_bot: true,
			first_name: "bot",
			username: options.botUsername ?? "test_bot",
		};
		return {
			message_id: reply.messageId,
			date: DATE,
			chat,
			from: (reply.fromBot ?? true) ? bot : { id: 7, is_bot: false, first_name: "Other" },
			text: reply.text ?? "earlier message",
			...topic,
		};
	}
	if (options.threadId === undefined) return undefined;
	// In a forum topic, a message that is not a reply carries the topic's creation message as its reply target.
	return {
		message_id: options.threadId,
		date: DATE,
		chat,
		message_thread_id: options.threadId,
		forum_topic_created: { name: "topic", icon_color: 0 },
	};
}

/**
 * A minimal Telegram Bot API over HTTP (127.0.0.1) for tests: getMe, getUpdates (long poll, capped at 1 s), sendMessage
 * (records thread and reply parameters), editMessageText, getFile; failures injectable per method.
 */
export class FakeBotApi {
	readonly calls: ApiCall[] = [];
	readonly messages = new Map<number, ServerMessage>();
	/** Highest offset a getUpdates call confirmed. */
	confirmed = 0;
	failGetMe: number | undefined;
	failGetUpdates: number | undefined;
	/** Files served by `getFile` and the file download route, by file id. */
	readonly files = new Map<string, Uint8Array>();
	/** getMe answer. */
	botId = 42;
	username = "test_bot";
	canReadAllGroupMessages = false;
	/** Milliseconds to wait before answering a method (after the effect, for sendMessage). */
	readonly delays = new Map<string, number>();
	/** Next update id used by `groupMessage` when none is given. */
	nextUpdateId = 1;
	#failures = new Map<string, InjectedFailure[]>();
	#updates: Update[] = [];
	#nextMessageId = 500;
	#server: Server | undefined;

	async start(): Promise<string> {
		this.#server = createServer((req, res) => void this.#handle(req, res));
		await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
		const { port } = this.#server.address() as AddressInfo;
		return `http://127.0.0.1:${port}`;
	}

	async stop(): Promise<void> {
		this.#server?.closeAllConnections();
		await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
	}

	/** Queue an update; `getUpdates` serves it until an offset above it is confirmed, unless forced. */
	enqueue(update: Update): void {
		this.#updates.push(update);
	}

	/** Serve an update again even though it was confirmed (a redelivery). */
	redeliver(update: Update): void {
		this.#updates.push({ ...update, forced: true } as Update);
	}

	/** Build a group message from user X in group G (ids from this server's counters) and queue it. */
	groupMessage(options: GroupMessageOptions): Update {
		const update = groupUpdate({
			botUsername: this.username,
			botId: this.botId,
			...options,
			updateId: options.updateId ?? this.nextUpdateId++,
			messageId: options.messageId ?? this.#nextMessageId++,
		});
		this.enqueue(update);
		return update;
	}

	/** Make the next `times` calls of `method` fail as described. */
	failNext(method: string, failure: InjectedFailure, times = 1): void {
		const queue = this.#failures.get(method) ?? [];
		for (let i = 0; i < times; i++) queue.push(failure);
		this.#failures.set(method, queue);
	}

	clearFailures(): void {
		this.#failures.clear();
	}

	count(method: string): number {
		return this.calls.filter((call) => call.method === method).length;
	}

	textsIn(chatId: number): string[] {
		return [...this.messages.values()].filter((m) => m.chatId === chatId).map((m) => m.text);
	}

	/** Every message sent, in send order (duplicates included: each send gets a new id). */
	sent(): ServerMessage[] {
		return [...this.messages.values()].sort((a, b) => a.id - b.id);
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const file = /^\/file\/bot[^/]+\/files\/(.+)$/.exec(req.url ?? "")?.[1];
		if (file !== undefined) return this.#download(decodeURIComponent(file), res);
		const method = /\/bot[^/]+\/([A-Za-z]+)/.exec(req.url ?? "")?.[1] ?? "";
		const body = await readBody(req);
		this.calls.push({ method, body });
		const failure = this.#failures.get(method)?.shift();
		if (failure !== undefined && "status" in failure) return refuse(res, failure);
		if (failure?.drop === "before") {
			req.socket.destroy();
			return;
		}
		const result = await this.#answer(method, body, () => req.socket.destroyed);
		const delay = this.delays.get(method);
		if (delay !== undefined) await pauseUnlessGone(delay, req);
		// "after": the call took effect, then the response is lost.
		if (failure !== undefined) req.socket.destroy();
		if (req.socket.destroyed) return;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(result));
	}

	async #answer(method: string, body: Record<string, unknown>, gone: () => boolean): Promise<unknown> {
		switch (method) {
			case "getMe":
				if (this.failGetMe !== undefined) return { ok: false, error_code: this.failGetMe, description: "Unauthorized" };
				return ok({
					id: this.botId,
					is_bot: true,
					first_name: "bot",
					username: this.username,
					can_join_groups: true,
					can_read_all_group_messages: this.canReadAllGroupMessages,
					supports_inline_queries: false,
				});
			case "getUpdates":
				return this.#getUpdates(body, gone);
			case "sendMessage":
			case "sendRichMessage":
				return this.#send(body);
			case "editMessageText":
				return this.#edit(body);
			case "getFile":
				return this.#getFile(body);
			default:
				return ok(true);
		}
	}

	async #getUpdates(body: Record<string, unknown>, gone: () => boolean): Promise<unknown> {
		if (this.failGetUpdates !== undefined)
			return {
				ok: false,
				error_code: this.failGetUpdates,
				description: "Conflict: terminated by other getUpdates request",
			};
		const offset = Number(body.offset ?? 0);
		this.confirmed = Math.max(this.confirmed, offset);
		const deadline = Date.now() + Math.min(Number(body.timeout ?? 0), 1) * 1000;
		for (;;) {
			// A killed client's long poll must not consume updates.
			if (gone()) return ok([]);
			const ready = this.#take(offset);
			if (ready.length > 0 || Date.now() >= deadline) return ok(ready);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	/** Updates to serve at `offset`; confirmed ones are dropped, forced redeliveries are served once more. */
	#take(offset: number): Update[] {
		const isForced = (u: Update) => (u as { forced?: boolean }).forced === true;
		const ready = this.#updates.filter((u) => u.update_id >= offset || isForced(u));
		this.#updates = this.#updates.filter((u) => u.update_id >= offset).map((u) => strip(u));
		return ready.map((u) => strip(u));
	}

	#getFile(body: Record<string, unknown>): unknown {
		const id = String(body.file_id);
		const bytes = this.files.get(id);
		if (bytes === undefined) return { ok: false, error_code: 400, description: "Bad Request: invalid file_id" };
		return ok({ file_id: id, file_unique_id: id, file_size: bytes.length, file_path: `files/${id}` });
	}

	#download(id: string, res: ServerResponse): void {
		const bytes = this.files.get(id);
		res.writeHead(bytes === undefined ? 404 : 200);
		res.end(bytes === undefined ? "not found" : Buffer.from(bytes));
	}

	#send(body: Record<string, unknown>): unknown {
		const id = this.#nextMessageId++;
		const reply = body.reply_parameters as { message_id?: number; allow_sending_without_reply?: boolean } | undefined;
		const preview = body.link_preview_options as { is_disabled?: boolean } | undefined;
		const threadId = typeof body.message_thread_id === "number" ? body.message_thread_id : undefined;
		const chatId = Number(body.chat_id);
		const text = textOf(body);
		this.messages.set(id, {
			id,
			chatId,
			text,
			...(reply?.message_id === undefined ? {} : { replyTo: reply.message_id }),
			...(reply?.allow_sending_without_reply === undefined
				? {}
				: { allowSendingWithoutReply: reply.allow_sending_without_reply }),
			...(threadId === undefined ? {} : { threadId }),
			...(preview?.is_disabled === undefined ? {} : { linkPreviewDisabled: preview.is_disabled }),
		});
		return ok({
			message_id: id,
			date: 1,
			chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" },
			...(threadId === undefined ? {} : { message_thread_id: threadId, is_topic_message: true }),
			text,
		});
	}

	#edit(body: Record<string, unknown>): unknown {
		const message = this.messages.get(Number(body.message_id));
		if (message === undefined)
			return { ok: false, error_code: 400, description: "Bad Request: message to edit not found" };
		if (message.text === textOf(body))
			return { ok: false, error_code: 400, description: "Bad Request: message is not modified" };
		message.text = textOf(body);
		return ok(true);
	}
}

/** A Bot API error answer, with the HTTP status equal to `error_code` as Telegram does. */
function refuse(res: ServerResponse, failure: { status: number; description?: string; retryAfter?: number }): void {
	res.writeHead(failure.status, { "content-type": "application/json" });
	res.end(
		JSON.stringify({
			ok: false,
			error_code: failure.status,
			description: failure.description ?? defaultDescription(failure.status, failure.retryAfter),
			...(failure.retryAfter === undefined ? {} : { parameters: { retry_after: failure.retryAfter } }),
		}),
	);
}

/** Wait `ms`, or less if the client goes away (a hung answer must not keep the test process alive). */
function pauseUnlessGone(ms: number, req: IncomingMessage): Promise<void> {
	return new Promise((resolve) => {
		if (req.socket.destroyed) return resolve();
		const done = () => {
			clearTimeout(timer);
			req.socket.off("close", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		req.socket.once("close", done);
	});
}

function defaultDescription(status: number, retryAfter: number | undefined): string {
	if (status === 429) return `Too Many Requests: retry after ${retryAfter ?? 1}`;
	if (status === 401) return "Unauthorized";
	if (status === 403) return "Forbidden: bot was kicked from the supergroup chat";
	if (status === 404) return "Not Found";
	if (status >= 500) return "Internal Server Error";
	return "Bad Request: chat not found";
}

/** `text`, or the Markdown of a `rich_message`. */
function textOf(body: Record<string, unknown>): string {
	const rich = body.rich_message as { markdown?: string } | undefined;
	return String(rich?.markdown ?? body.text);
}

function strip(update: Update): Update {
	const { forced: _forced, ...rest } = update as Update & { forced?: boolean };
	return rest as Update;
}

function ok(result: unknown) {
	return { ok: true, result };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return {};
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return {};
	}
}
