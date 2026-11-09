import type { Update } from "grammy/types";
import { Agent, fetch as pooledFetch } from "undici";
import { redact } from "../../runtime/redact.ts";
import {
	type SendMessageParams,
	type TelegramApi,
	TelegramError,
	type TelegramErrorKind,
	type TelegramMe,
} from "../ports.ts";

/**
 * Fetch-based Telegram Bot API client (the subset in `TelegramApi`): POST JSON to `${apiRoot}/bot${token}/<method>`.
 * Errors are `TelegramError` with a classified kind (Interfaces and Storage § Outbox to Telegram):
 *   fetch throws / times out → network; 5xx or a malformed answer → server; 429 → rate_limited (retry_after);
 *   401 / 404 (bad or revoked token, wrong API root) → unauthorized; any other 4xx → permanent.
 * The URL carries the token, so neither the URL nor fetch's own error text ever reaches an error message.
 */
export type TelegramApiOptions = {
	readonly token: string;
	readonly apiRoot: string;
	readonly fetch?: typeof fetch;
	/** HTTP timeout of every call except the long poll, which gets its poll timeout + 10 s. */
	readonly requestTimeoutMs?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const LONG_POLL_MARGIN_MS = 10_000;
const DESCRIPTION_CHARS = 200;

type Envelope = {
	readonly ok?: unknown;
	readonly result?: unknown;
	readonly error_code?: unknown;
	readonly description?: unknown;
	readonly parameters?: { readonly retry_after?: unknown } | null;
};

export function createTelegramApi(options: TelegramApiOptions): TelegramApi {
	// Node's default fetch pool expires idle connections after 4 s. Paced group traffic can sit just beyond that
	// boundary, paying a fresh TCP/TLS handshake for every reply. Keep a small, client-owned pool; two or more
	// connections are necessary so a held getUpdates request cannot block sendMessage. Do not change the global
	// dispatcher (the relay and GitHub use it too), pipeline POSTs, or add transport-level retries of uncertain sends.
	const dispatcher =
		options.fetch === undefined
			? new Agent({
					connections: 4,
					pipelining: 1,
					keepAliveTimeout: 60_000,
					keepAliveMaxTimeout: 60_000,
					allowH2: false,
				})
			: undefined;
	const root = options.apiRoot.replace(/\/+$/, "");
	let closing: Promise<void> | undefined;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const scrub = (text: string): string => {
		let out = text;
		if (options.token !== "") out = out.split(options.token).join("<redacted>");
		if (root !== "") out = out.split(root).join("<api>");
		return redact(out)
			.replace(/[\r\n\t]+/g, " ")
			.slice(0, DESCRIPTION_CHARS);
	};

	/** POST and read the body; any transport failure becomes a `network` TelegramError without URL or cause text. */
	async function request(
		method: string,
		body: Record<string, unknown>,
		timeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<{ status: number; text: string }> {
		if (signal?.aborted) throw new TelegramError("network", `${method}: request aborted`);
		const timer = new AbortController();
		const timeout = setTimeout(() => timer.abort(), timeoutMs);
		const onAbort = () => timer.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const init = {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: timer.signal,
			};
			const url = `${root}/bot${options.token}/${method}`;
			const response =
				options.fetch === undefined ? await pooledFetch(url, { ...init, dispatcher }) : await options.fetch(url, init);
			return { status: response.status, text: await response.text() };
		} catch (error) {
			const reason = transportFailure(error, signal?.aborted === true, timer.signal.aborted, timeoutMs);
			throw new TelegramError("network", `${method}: ${reason}`);
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async function call(
		method: string,
		body: Record<string, unknown>,
		timeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<unknown> {
		const { status, text } = await request(method, body, timeoutMs, signal);
		const envelope = parseEnvelope(text);
		if (envelope?.ok === true && status >= 200 && status < 300) return envelope.result;
		throw refusal(method, status, envelope, scrub);
	}

	return {
		async close(): Promise<void> {
			closing ??= dispatcher?.close() ?? Promise.resolve();
			await closing;
		},

		async getMe(signal?: AbortSignal): Promise<TelegramMe> {
			const result = await call("getMe", {}, requestTimeoutMs, signal);
			if (!isRecord(result) || typeof result.id !== "number" || typeof result.username !== "string")
				throw new TelegramError("server", "getMe: malformed response");
			return {
				id: result.id,
				username: result.username,
				canReadAllGroupMessages: result.can_read_all_group_messages === true,
			};
		},

		async getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<Update[]> {
			const result = await call(
				"getUpdates",
				{ offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
				timeoutSeconds * 1000 + LONG_POLL_MARGIN_MS,
				signal,
			);
			if (!Array.isArray(result)) throw new TelegramError("server", "getUpdates: malformed response");
			return result.filter((u): u is Update => isRecord(u) && Number.isSafeInteger(u.update_id));
		},

		async sendMessage(params: SendMessageParams, signal?: AbortSignal): Promise<{ messageId: number }> {
			const body: Record<string, unknown> = {
				chat_id: params.chatId,
				text: params.text,
				link_preview_options: { is_disabled: true },
			};
			if (params.threadId !== undefined) body.message_thread_id = params.threadId;
			if (params.replyTo !== undefined)
				body.reply_parameters = { message_id: params.replyTo, allow_sending_without_reply: true };
			const result = await call("sendMessage", body, requestTimeoutMs, signal);
			if (!isRecord(result) || typeof result.message_id !== "number")
				throw new TelegramError("server", "sendMessage: malformed response");
			return { messageId: result.message_id };
		},
	};
}

function parseEnvelope(text: string): Envelope | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? (parsed as Envelope) : undefined;
	} catch {
		return undefined;
	}
}

/** The classified error for a non-success answer; the description is Telegram's own text, scrubbed and capped. */
function refusal(
	method: string,
	status: number,
	envelope: Envelope | undefined,
	scrub: (text: string) => string,
): TelegramError {
	const code = typeof envelope?.error_code === "number" ? envelope.error_code : status;
	const kind = classify(code, envelope === undefined || envelope.ok === true);
	const retryAfter = envelope?.parameters?.retry_after;
	const retryAfterSeconds = typeof retryAfter === "number" && retryAfter >= 0 ? retryAfter : undefined;
	const description = typeof envelope?.description === "string" ? `: ${scrub(envelope.description)}` : "";
	return new TelegramError(
		kind,
		`${method}: ${kind} (status ${code})${description}`,
		code,
		kind === "rate_limited" ? retryAfterSeconds : undefined,
	);
}

/** `malformed`: no JSON envelope, or `ok: true` with a non-2xx status: never trusted as a definite refusal. */
function classify(status: number, malformed: boolean): TelegramErrorKind {
	if (status === 429) return "rate_limited";
	if (status === 401 || status === 404) return "unauthorized";
	if (status >= 400 && status < 500 && !malformed) return "permanent";
	return "server";
}

function transportFailure(error: unknown, aborted: boolean, timedOut: boolean, timeoutMs: number): string {
	if (aborted) return "request aborted";
	if (timedOut) return `request timed out after ${Math.round(timeoutMs / 1000)} s`;
	return `connection failed${errorCode(error)}`;
}

/** A system error code such as ECONNREFUSED from fetch's cause, never its message (which may name the URL). */
function errorCode(error: unknown): string {
	const cause = isRecord(error) ? error.cause : undefined;
	const code = isRecord(cause) ? cause.code : undefined;
	return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
