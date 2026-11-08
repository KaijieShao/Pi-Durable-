/** Telegram HTML needs only `&`, `<` and `>` escaped in text. */
export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape for a double-quoted attribute value. */
export function escapeAttribute(text: string): string {
	return escapeHtml(text).replace(/"/g, "&quot;");
}

/** Move a cut index back so it does not split a UTF-16 surrogate pair. */
export function codePointCut(text: string, index: number): number {
	if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length));
	const code = text.charCodeAt(index - 1);
	return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

/** The last `count` code units of `text`, not starting inside a surrogate pair. */
export function tail(text: string, count: number): string {
	if (text.length <= count) return text;
	let start = text.length - count;
	const code = text.charCodeAt(start);
	if (code >= 0xdc00 && code <= 0xdfff) start += 1;
	return text.slice(start);
}

/** Truncate to `max` code units on a code point boundary, adding an ellipsis when cut. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, codePointCut(text, max - 1))}…`;
}
