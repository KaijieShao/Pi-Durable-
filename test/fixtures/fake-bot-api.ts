import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Update } from "grammy/types";

export type ApiCall = { method: string; body: Record<string, unknown> };
export type ServerMessage = { id: number; chatId: number; text: string; replyTo?: number };

/** A minimal Telegram Bot API over HTTP for end-to-end tests of the real grammY polling loop. */
export class FakeBotApi {
	readonly calls: ApiCall[] = [];
	readonly messages = new Map<number, ServerMessage>();
	/** Highest offset a getUpdates call confirmed. */
	confirmed = 0;
	failGetMe: number | undefined;
	failGetUpdates: number | undefined;
	/** Files served by `getFile` and the file download route, by file id. */
	readonly files = new Map<string, Uint8Array>();
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

	count(method: string): number {
		return this.calls.filter((call) => call.method === method).length;
	}

	textsIn(chatId: number): string[] {
		return [...this.messages.values()].filter((m) => m.chatId === chatId).map((m) => m.text);
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const file = /^\/file\/bot[^/]+\/files\/(.+)$/.exec(req.url ?? "")?.[1];
		if (file !== undefined) return this.#download(decodeURIComponent(file), res);
		const method = /\/bot[^/]+\/([A-Za-z]+)/.exec(req.url ?? "")?.[1] ?? "";
		const body = await readBody(req);
		this.calls.push({ method, body });
		const result = await this.#answer(method, body, () => req.socket.destroyed);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(result));
	}

	async #answer(method: string, body: Record<string, unknown>, gone: () => boolean): Promise<unknown> {
		switch (method) {
			case "getMe":
				if (this.failGetMe !== undefined) return { ok: false, error_code: this.failGetMe, description: "Unauthorized" };
				return ok({ id: 42, is_bot: true, first_name: "bot", username: "test_bot" });
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
		const reply = body.reply_parameters as { message_id?: number } | undefined;
		const text = textOf(body);
		this.messages.set(id, {
			id,
			chatId: Number(body.chat_id),
			text,
			...(reply?.message_id === undefined ? {} : { replyTo: reply.message_id }),
		});
		return ok({
			message_id: id,
			date: 1,
			chat: { id: Number(body.chat_id), type: "private" },
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
