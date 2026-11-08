import { codePointCut } from "./escape.ts";
import { type FenceOpener, fenceStateAfter } from "./fence.ts";
import { markdownToTelegramHtml } from "./markdown-html.ts";

export type Chunk = {
	/** Telegram HTML, at most `limit` UTF-16 code units. */
	readonly html: string;
	/** The Markdown slice this chunk came from, sent as plain text when Telegram rejects the HTML. */
	readonly plain: string;
	/** Rich Markdown: the chunk is a rich message (`html` unused). */
	readonly rich?: string;
};

export const TELEGRAM_TEXT_LIMIT = 4096;
const MARKDOWN_WINDOW = 3500;

/**
 * Split Markdown into Telegram messages. Cuts prefer a blank line, then a newline, then a space in the second half of
 * the window, else a hard cut on a code point boundary. A cut inside a fenced block closes it and reopens it with the
 * same opener in the next chunk. Each chunk is re-rendered with a smaller window until its HTML fits `limit`.
 */
export function splitForTelegram(markdown: string, limit = TELEGRAM_TEXT_LIMIT): Chunk[] {
	const text = markdown.replace(/\r\n?/g, "\n");
	const chunks: Chunk[] = [];
	let pos = skipWhitespace(text, 0);
	let fence: FenceOpener | undefined;
	while (pos < text.length) {
		const piece = fitPiece(text, pos, fence, limit);
		if (piece.plain.trim() !== "") chunks.push({ html: piece.html, plain: piece.plain });
		fence = piece.fenceAfter;
		pos = skipWhitespace(text, piece.next);
	}
	return chunks;
}

type Piece = { html: string; plain: string; next: number; fenceAfter: FenceOpener | undefined };

function fitPiece(text: string, pos: number, fence: FenceOpener | undefined, limit: number): Piece {
	let window = MARKDOWN_WINDOW;
	for (;;) {
		const piece = renderPiece(text, pos, window, fence);
		if (piece.html.length <= limit || window <= 1) return piece;
		window = Math.max(1, window - Math.max(100, Math.floor(window / 10)));
	}
}

function renderPiece(text: string, pos: number, window: number, fence: FenceOpener | undefined): Piece {
	const cut = findCut(text, pos, window);
	const plain = text.slice(pos, cut).trimEnd();
	const fenceAfter = fenceStateAfter(plain, fence);
	const reopened = fence === undefined ? "" : `${fence.line}\n`;
	const closed = fenceAfter === undefined ? "" : `\n${fenceAfter.marker}`;
	const html = markdownToTelegramHtml(`${reopened}${plain}${closed}`);
	return { html, plain, next: cut, fenceAfter: cut >= text.length ? undefined : fenceAfter };
}

/** End index (exclusive) of the slice starting at `pos` and at most `window` long. */
export function findCut(text: string, pos: number, window: number): number {
	const end = pos + window;
	if (end >= text.length) return text.length;
	const slice = text.slice(pos, end);
	const half = Math.floor(window / 2);
	for (const separator of ["\n\n", "\n", " "]) {
		const at = slice.lastIndexOf(separator);
		if (at >= half) return pos + at + separator.length;
	}
	const hard = codePointCut(text, end);
	return hard > pos ? hard : Math.min(text.length, end + 1);
}

/** Skip the line breaks at a cut; indentation of the next line is kept. */
function skipWhitespace(text: string, pos: number): number {
	let index = pos;
	while (index < text.length && text[index] === "\n") index += 1;
	return index;
}
