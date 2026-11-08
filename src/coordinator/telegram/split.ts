/**
 * Telegram refuses messages over 4096 characters (counted in UTF-16 units). A longer outgoing text is split into
 * ordered parts instead of being cut: each part is at most 4096 units including a "[i/n] " marker, broken at the
 * last line break (else the last space) in the second half of the part, and never inside a surrogate pair.
 * `Store.enqueue` queues the parts as consecutive outbox rows, which the strict (priority, id) order sends in order.
 *
 * A bound keeps a runaway text from flooding the group: at most MAX_TELEGRAM_PARTS parts; beyond that the last part
 * says how many characters were left out. (The Coordinator's own texts stay far below it.)
 */

export const TELEGRAM_TEXT_LIMIT = 4096;
export const MAX_TELEGRAM_PARTS = 10;
/** Room for the "[10/10] " marker (8 units) with a margin. */
const MARKER_RESERVE = 12;

export function splitTelegramText(
	text: string,
	limit: number = TELEGRAM_TEXT_LIMIT,
	maxParts: number = MAX_TELEGRAM_PARTS,
): string[] {
	if (text.length <= limit) return [text];
	const body = limit - MARKER_RESERVE;
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > body) {
		if (chunks.length === maxParts - 1) break;
		const { end, next } = cutPoint(rest, body);
		chunks.push(rest.slice(0, end));
		rest = rest.slice(next);
	}
	chunks.push(rest.length <= body ? rest : omitted(rest, body));
	const total = chunks.length;
	return chunks.map((chunk, index) => `[${index + 1}/${total}] ${chunk}`);
}

/** Where to end this part (`end`) and where the next one starts (`next`, skipping the separator broken at). */
function cutPoint(text: string, max: number): { end: number; next: number } {
	const floor = Math.floor(max / 2);
	const newline = text.lastIndexOf("\n", max);
	if (newline >= floor) return { end: newline, next: newline + 1 };
	const space = text.lastIndexOf(" ", max);
	if (space >= floor) return { end: space, next: space + 1 };
	const end = isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
	return { end, next: end };
}

/** The final part when the text needs more than the allowed parts: as much as fits, then what was left out. */
function omitted(text: string, max: number): string {
	let keep = max - 60;
	if (isHighSurrogate(text.charCodeAt(keep - 1))) keep--;
	return `${text.slice(0, keep)}… [${text.length - keep} more characters not sent]`;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}
