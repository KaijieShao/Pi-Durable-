/**
 * The stdio transport between the Coordinator and one Pi process (used when the process runs as a systemd transient
 * unit: `systemd-run --pipe` passes only stdin, stdout and stderr). Newline-delimited JSON: one JSON object per line,
 * UTF-8; JSON.stringify never emits a raw newline, so a line is exactly one frame.
 *
 *   Coordinator → Pi (stdin):  first `{"type":"key","key":...}` (the run key, never in argv, environment or unit
 *                              properties), then the `ToRunner` messages of src/runner/protocol.ts.
 *   Pi → Coordinator (stdout): the `FromRunner` messages, and `{"type":"note","event":...}` metadata lines.
 *
 * Stdout carries only frames; anything else the Pi process prints goes to stderr, which the Coordinator counts and
 * never forwards as text.
 */
import type { Readable } from "node:stream";

/** A frame longer than this is dropped (a `write` of 1 MiB content, JSON-escaped, stays well below it). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** The first frame on the Pi process's stdin. */
export type KeyFrame = { readonly type: "key"; readonly key: string };

/** A metadata line from the Pi process: an event name and primitive fields, never content. */
export type NoteFrame = { readonly type: "note"; readonly event: string } & Readonly<
	Record<string, string | number | boolean>
>;

/** Run keys are short printable tokens (see engine/keys.ts); anything else is refused. */
const RUN_KEY = /^[\x21-\x7e]{16,512}$/;

export function encodeFrame(value: object): string {
	return `${JSON.stringify(value)}\n`;
}

/** The run key of a key frame, or undefined if `value` is not a well-formed one. */
export function keyFromFrame(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const frame = value as { type?: unknown; key?: unknown };
	if (frame.type !== "key" || typeof frame.key !== "string" || !RUN_KEY.test(frame.key)) return undefined;
	return frame.key;
}

export type FrameHandlers = {
	/** One parsed frame (any JSON value; the caller checks its shape). */
	frame(value: unknown): void;
	/** A line that was not JSON, or longer than the limit (dropped up to its newline). */
	invalid(kind: "json" | "oversize"): void;
	/** The stream ended or failed; a trailing partial line is dropped. */
	end(): void;
};

/** Split a byte stream into newline-delimited JSON frames. */
export function readFrames(stream: Readable, handlers: FrameHandlers, maxBytes = MAX_FRAME_BYTES): void {
	const splitter = new LineSplitter(maxBytes, handlers);
	let ended = false;
	const end = (): void => {
		if (ended) return;
		ended = true;
		handlers.end();
	};
	stream.on("data", (chunk: Buffer | string) => splitter.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
	stream.on("end", end);
	stream.on("close", end);
	stream.on("error", end);
}

class LineSplitter {
	readonly #maxBytes: number;
	readonly #handlers: FrameHandlers;
	#parts: Buffer[] = [];
	#length = 0;
	/** Inside an oversize line: discard until its newline. */
	#dropping = false;

	constructor(maxBytes: number, handlers: FrameHandlers) {
		this.#maxBytes = maxBytes;
		this.#handlers = handlers;
	}

	push(chunk: Buffer): void {
		let start = 0;
		for (let newline = chunk.indexOf(0x0a, start); newline >= 0; newline = chunk.indexOf(0x0a, start)) {
			this.#append(chunk.subarray(start, newline));
			this.#line();
			start = newline + 1;
		}
		this.#append(chunk.subarray(start));
	}

	#append(piece: Buffer): void {
		if (this.#dropping || piece.byteLength === 0) return;
		if (this.#length + piece.byteLength > this.#maxBytes) {
			this.#parts = [];
			this.#length = 0;
			this.#dropping = true;
			this.#handlers.invalid("oversize");
			return;
		}
		this.#parts.push(piece);
		this.#length += piece.byteLength;
	}

	#line(): void {
		const parts = this.#parts;
		const dropped = this.#dropping;
		this.#parts = [];
		this.#length = 0;
		this.#dropping = false;
		if (dropped || parts.length === 0) return;
		let value: unknown;
		try {
			value = JSON.parse(Buffer.concat(parts).toString("utf8"));
		} catch {
			this.#handlers.invalid("json");
			return;
		}
		this.#handlers.frame(value);
	}
}
