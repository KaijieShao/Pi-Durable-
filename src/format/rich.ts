import { codePointCut, truncate } from "./escape.ts";
import { closesFence, type FenceOpener, parseFenceOpener } from "./fence.ts";

/** Margins under Telegram's 32768 characters and 500 blocks per rich message (our block count is an estimate). */
export const RICH_LIMITS = { chars: 30_000, blocks: 400 };
export type RichLimits = typeof RICH_LIMITS;
export const THINKING = "<tg-thinking>Thinking…</tg-thinking>";
const DATA_MAX_BYTES = 64;
const BLOCK_TAG = /<(\/?)(details|tg-button-row|tg-collage|tg-slideshow)\b/gi;
const BUTTON = /<tg-button(?=[\s>])([^>]*)>([\s\S]*?)<\/tg-button>/gi;
const DATA_ATTR = /(\sdata=")([^"]*)(")/i;
const CALLBACK = /\stype="callback_data"/i;
const ROW = /<tg-button-row\b[^>]*>[\s\S]*?<\/tg-button-row>/gi;

type Unit = { lines: string[]; chars: number; blocks: number };

/**
 * Split rich Markdown into messages within `limits`. Cuts fall on blank lines outside code fences and block tags
 * (`<details>`, button rows, collages); a single block too big for one message is cut by lines, its fence closed and
 * reopened.
 */
export function splitRich(markdown: string, limits: RichLimits = RICH_LIMITS): string[] {
	const out: string[] = [];
	let current: Unit = { lines: [], chars: 0, blocks: 0 };
	for (const unit of units(markdown.replace(/\r\n?/g, "\n")).flatMap((each) => fit(each, limits))) {
		const fits = current.chars + unit.chars + 2 <= limits.chars && current.blocks + unit.blocks <= limits.blocks;
		if (!fits && current.lines.length > 0) {
			out.push(current.lines.join("\n"));
			current = { lines: [], chars: 0, blocks: 0 };
		}
		const lines = current.lines.length === 0 ? unit.lines : [...current.lines, "", ...unit.lines];
		current = { lines, chars: current.chars + unit.chars + 2, blocks: current.blocks + unit.blocks };
	}
	if (current.lines.length > 0) out.push(current.lines.join("\n"));
	return out;
}

/** Groups of lines between safe blank lines; each counts its characters and (estimated) blocks. */
function units(text: string): Unit[] {
	const out: Unit[] = [{ lines: [], chars: 0, blocks: 0 }];
	for (const { line, cut, block } of scan(text)) {
		const unit = out.at(-1) as Unit;
		if (cut) {
			if (unit.lines.length > 0) out.push({ lines: [], chars: 0, blocks: 0 });
			continue;
		}
		unit.lines.push(line);
		unit.chars += line.length + 1;
		unit.blocks += block ? 1 : 0;
	}
	return out.filter((unit) => unit.lines.length > 0);
}

/** Per line: a blank line where a cut is safe, and whether the line starts a block (outside fences). */
function scan(text: string): { line: string; cut: boolean; block: boolean }[] {
	let fence: FenceOpener | undefined;
	let depth = 0;
	return text.split("\n").map((line) => {
		const outside = fence === undefined;
		const blank = line.trim() === "";
		const info = { line, cut: blank && outside && depth === 0, block: outside && !blank };
		if (outside) depth = Math.max(0, depth + tagBalance(line));
		fence = nextFence(line, fence);
		return info;
	});
}

function nextFence(line: string, fence: FenceOpener | undefined): FenceOpener | undefined {
	if (fence === undefined) return parseFenceOpener(line);
	return closesFence(line, fence) ? undefined : fence;
}

function tagBalance(line: string): number {
	let balance = 0;
	for (const match of line.matchAll(BLOCK_TAG)) balance += match[1] === "/" ? -1 : 1;
	return balance;
}

/** A unit within the limits as is, else cut by lines (a fence open at a cut is closed and reopened). */
function fit(unit: Unit, limits: RichLimits): Unit[] {
	if (unit.chars <= limits.chars && unit.blocks <= limits.blocks) return [unit];
	const out: Unit[] = [];
	const room = Math.floor(limits.chars * 0.95);
	let piece: string[] = [];
	let size = 0;
	let fence: FenceOpener | undefined;
	const flush = (close: boolean) => {
		const lines = close && fence !== undefined ? [...piece, fence.marker] : piece;
		if (piece.length > 0) out.push({ lines, chars: size + 10, blocks: lines.length });
		piece = fence === undefined ? [] : [fence.line];
		size = fence === undefined ? 0 : fence.line.length + 1;
	};
	for (const line of unit.lines.flatMap((each) => hardCut(each, room))) {
		if (size + line.length >= room || piece.length >= limits.blocks - 2) flush(true);
		piece.push(line);
		size += line.length + 1;
		fence = nextFence(line, fence);
	}
	flush(false);
	return out;
}

function hardCut(line: string, size: number): string[] {
	const out: string[] = [];
	let rest = line;
	while (rest.length > size) {
		const cut = codePointCut(rest, size);
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	return [...out, rest];
}

/**
 * Callback data is 1-64 bytes: empty `data` takes the label; longer `data` is cut on a character (and entity)
 * boundary; a cut that collides with another button's data in the same text gets a `#2`, `#3`… suffix.
 * Deterministic, so a resend matches.
 */
export function shortenButtonsData(markdown: string): string {
	const fitting = [...markdown.matchAll(BUTTON)].map((match) => DATA_ATTR.exec(match[1] ?? "")?.[2] ?? "");
	const seen = new Set(fitting.filter((data) => data !== "" && Buffer.byteLength(data) <= DATA_MAX_BYTES));
	return markdown.replace(BUTTON, (button: string, _attrs: string, label: string) =>
		button.replace(DATA_ATTR, (_m, head: string, data: string, tail: string) => {
			const full = data === "" ? labelData(label) : data;
			let short = cutBytes(full, DATA_MAX_BYTES);
			for (let n = 2; short !== full && seen.has(short); n++)
				short = `${cutBytes(full, DATA_MAX_BYTES - 1 - String(n).length)}#${n}`;
			seen.add(short);
			return `${head}${short}${tail}`;
		}),
	);
}

function labelData(label: string): string {
	const text = label.replace(/<[^>]*>/g, "").trim();
	return text.replace(/"/g, "&quot;") || "?";
}

function cutBytes(text: string, max: number): string {
	let out = "";
	for (const [atom] of text.matchAll(/&(?:#\d+|#x[\da-f]+|[a-z]+);|[\s\S]/giu)) {
		if (Buffer.byteLength(out + atom) > max) break;
		out += atom;
	}
	return out;
}

/** Buttons as plain `[label]` text and no button rows: for the HTML fallback and drafts. */
export function stripButtons(markdown: string): string {
	return markdown
		.replace(BUTTON, (_m, _attrs: string, label: string) => `[${label.trim()}] `)
		.replace(/<\/?tg-button-row\b[^>]*>/gi, "")
		.replace(/[ \t]+$/gm, "");
}

export function hasCallbackButtons(markdown: string): boolean {
	return [...markdown.matchAll(BUTTON)].some((match) => CALLBACK.test(match[1] ?? ""));
}

/**
 * The text with the first callback button whose data is `data` shown as chosen and its choices disabled; undefined
 * when no callback button carries that data. A button inside a `<tg-button-row>` disables only its own row, so the
 * other questions of the message stay answerable; a button outside any row disables every callback button. When two
 * rows carry the same data, the first one is chosen.
 */
export function markChosen(markdown: string, data: string): string | undefined {
	const tapped = [...markdown.matchAll(BUTTON)].find(
		(match) => CALLBACK.test(match[1] ?? "") && decodeEntities(DATA_ATTR.exec(match[1] ?? "")?.[2] ?? "") === data,
	);
	if (tapped === undefined) return undefined;
	const row = [...markdown.matchAll(ROW)].find(
		(match) => match.index <= tapped.index && tapped.index < match.index + match[0].length,
	);
	if (row === undefined) return disableChoices(markdown, data);
	const end = row.index + row[0].length;
	return markdown.slice(0, row.index) + disableChoices(row[0], data) + markdown.slice(end);
}

/** Every callback button of `text` disabled, the first one whose data is `data` marked ✅. */
function disableChoices(text: string, data: string): string {
	let chosen = false;
	return text.replace(BUTTON, (button: string, attrs: string, label: string) => {
		if (!CALLBACK.test(attrs)) return button;
		const hit = !chosen && decodeEntities(DATA_ATTR.exec(attrs)?.[2] ?? "") === data;
		chosen ||= hit;
		const kept = attrs.replace(CALLBACK, "").replace(DATA_ATTR, "");
		const style = hit ? ` style="success"` : "";
		return `<tg-button type="disabled"${hit ? kept.replace(/\sstyle="[^"]*"/i, "") : kept}${style}>${hit ? `✅ ${label}` : label}</tg-button>`;
	});
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

function decodeEntities(text: string): string {
	return text.replace(/&(#39|[a-z]+);/gi, (entity, name: string) => ENTITIES[name.toLowerCase()] ?? entity);
}

/** A streaming frame as draft Markdown: buttons as labels, a trailing unfinished tag cut, `THINKING` when empty. */
export function draftMarkdown(text: string): string {
	const body = stripButtons(text)
		.replace(/<[^>]*$/, "")
		.trim();
	return body === "" ? THINKING : body;
}

/** One line of a sent text for the model's context, collapsed and cut to `max` characters. */
export function contextLine(markdown: string, max: number): string {
	return truncate(stripButtons(markdown).replace(/\s+/g, " ").trim(), max);
}
