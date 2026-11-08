/** A Bot API error response: `ok: false` with a code and description. */
export class TelegramApiError extends Error {
	readonly code: number;
	readonly description: string;
	readonly retryAfter: number | undefined;
	constructor(method: string, code: number, description: string, retryAfter?: number) {
		super(`${method}: ${code} ${description}`);
		this.name = "TelegramApiError";
		this.code = code;
		this.description = description;
		this.retryAfter = retryAfter;
	}
}

/**
 * A non-idempotent call whose outcome is unknown (network error, 5xx, malformed response): the message may or may
 * not have been sent. Never retried automatically.
 */
export class TelegramUnknown extends Error {
	constructor(method: string, reason: string) {
		super(`${method}: outcome unknown (${reason})`);
		this.name = "TelegramUnknown";
	}
}

/** An idempotent call that failed after its retries (network or 5xx). */
export class TelegramUnavailable extends Error {
	constructor(method: string, reason: string) {
		super(`${method}: Telegram unavailable (${reason})`);
		this.name = "TelegramUnavailable";
	}
}

export type TelegramErrorKind =
	| { kind: "not_modified" }
	| { kind: "parse_error" }
	| { kind: "message_gone" }
	| { kind: "too_big" }
	| { kind: "retry_after"; seconds: number }
	| { kind: "blocked" }
	| { kind: "unknown" }
	| { kind: "unavailable" }
	| { kind: "rejected"; description: string }
	| { kind: "aborted" }
	| { kind: "other" };

const parseError =
	/can't parse entities|unsupported start tag|unexpected end tag|entity name|parse entities|can't find end/i;
const goneError =
	/message to edit not found|message can't be edited|message_id_invalid|message to be replied not found|message not found/i;

/** Classify any error from a Telegram call by what the caller should do. */
export function classifyTelegramError(error: unknown): TelegramErrorKind {
	if (error instanceof TelegramUnknown) return { kind: "unknown" };
	if (error instanceof TelegramUnavailable) return { kind: "unavailable" };
	if (isAbort(error)) return { kind: "aborted" };
	if (!(error instanceof TelegramApiError)) return { kind: "other" };
	return classifyApiError(error);
}

function classifyApiError(error: TelegramApiError): TelegramErrorKind {
	const text = error.description;
	if (error.code === 429) return { kind: "retry_after", seconds: error.retryAfter ?? 5 };
	if (/message is not modified/i.test(text)) return { kind: "not_modified" };
	if (parseError.test(text)) return { kind: "parse_error" };
	if (goneError.test(text)) return { kind: "message_gone" };
	if (error.code === 413 || /too long|too big|too large/i.test(text)) return { kind: "too_big" };
	if (error.code === 403) return { kind: "blocked" };
	// An idempotent call answered 5xx after its retries: the same as unreachable.
	if (error.code >= 500) return { kind: "unavailable" };
	return { kind: "rejected", description: text.slice(0, 200) };
}

/** Telegram answered 400: the request itself was refused, nothing was sent. */
export function isBadRequest(error: unknown): boolean {
	return error instanceof TelegramApiError && error.code === 400;
}

export function isAbort(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || /aborted|cancel/i.test(error.name));
}

/** A log-safe summary: code and description only, never URLs or causes. */
export function telegramErrorSummary(error: unknown): Record<string, unknown> {
	if (error instanceof TelegramApiError)
		return { error_code: error.code, description: error.description.slice(0, 200) };
	if (error instanceof Error) return { error: error.name, description: error.message.split("\n")[0]?.slice(0, 200) };
	return { error: String(error).slice(0, 200) };
}
