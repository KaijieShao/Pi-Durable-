import { escapeAttribute, escapeHtml } from "./escape.ts";
import { closesFence, type FenceOpener, parseFenceOpener } from "./fence.ts";

/** Tags this converter emits; Telegram accepts these in HTML parse mode. */
export const ALLOWED_TAGS = ["b", "i", "u", "s", "code", "pre", "a", "blockquote", "tg-spoiler"] as const;

export type MarkdownOptions = {
	/** Render an unclosed fence as code up to the end (default true); false keeps it as literal text. */
	readonly autoCloseFence?: boolean;
};

/** Private-use character marking held fragments; removed from the input first. */
const PLACEHOLDER = "\uE000";

/**
 * Convert model Markdown to Telegram-safe HTML. Text is escaped first; only allowed tags are emitted, always properly
 * nested: an inline span is wrapped only when its content is already balanced.
 */
export function markdownToTelegramHtml(markdown: string, options: MarkdownOptions = {}): string {
	const slots: string[] = [];
	const hold = (html: string) => `${PLACEHOLDER}${slots.push(html) - 1}${PLACEHOLDER}`;
	const source = markdown.replace(/\r\n?/g, "\n").replaceAll(PLACEHOLDER, "");
	const withoutFences = extractFences(source, hold, options.autoCloseFence ?? true);
	const lines = withoutFences.split("\n").map((line) => renderLine(line, hold));
	const html = groupBlockquotes(lines).join("\n");
	return html.replace(/\uE000(\d+)\uE000/g, (_m, index: string) => slots[Number(index)] ?? "");
}

function extractFences(source: string, hold: (html: string) => string, autoClose: boolean): string {
	const out: string[] = [];
	let open: { opener: FenceOpener; body: string[] } | undefined;
	for (const line of source.split("\n")) {
		if (open === undefined) {
			const opener = parseFenceOpener(line);
			if (opener === undefined) out.push(line);
			else open = { opener, body: [] };
		} else if (closesFence(line, open.opener)) {
			out.push(hold(codeBlock(open.body.join("\n"), open.opener.lang)));
			open = undefined;
		} else open.body.push(line);
	}
	if (open !== undefined) out.push(...unclosedFence(open.opener, open.body, hold, autoClose));
	return out.join("\n");
}

function unclosedFence(
	opener: FenceOpener,
	body: string[],
	hold: (html: string) => string,
	autoClose: boolean,
): string[] {
	return autoClose ? [hold(codeBlock(body.join("\n"), opener.lang))] : [opener.line, ...body];
}

function codeBlock(code: string, lang: string): string {
	const safeLang = lang.replace(/[^A-Za-z0-9_+-]/g, "").slice(0, 32);
	const open = safeLang === "" ? "<pre>" : `<pre><code class="language-${safeLang}">`;
	const close = safeLang === "" ? "</pre>" : "</code></pre>";
	return `${open}${escapeHtml(code.replace(/\n+$/, ""))}${close}`;
}

type Rule = { readonly pattern: RegExp; readonly tag: string };

const inlineRules: readonly Rule[] = [
	{ pattern: /\*\*(?=\S)([^\n]*?\S)\*\*/g, tag: "b" },
	{ pattern: /(?<![\w_])__(?=\S)([^\n]*?\S)__(?![\w_])/g, tag: "b" },
	{ pattern: /~~(?=\S)([^\n]*?\S)~~/g, tag: "s" },
	{ pattern: /\|\|(?=\S)([^\n]*?\S)\|\|/g, tag: "tg-spoiler" },
	{ pattern: /(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, tag: "i" },
	{ pattern: /(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, tag: "i" },
];

function renderLine(line: string, hold: (html: string) => string): string {
	let text = holdInlineCode(line, hold);
	text = holdLinks(text, hold);
	text = escapeHtml(text);
	for (const rule of inlineRules) text = wrapBalanced(text, rule);
	const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(text);
	return heading === null ? text : `<b>${heading[1]}</b>`;
}

function holdInlineCode(line: string, hold: (html: string) => string): string {
	return line.replace(/(`+)([^`\n]+?)\1(?!`)/g, (_m, _ticks: string, code: string) =>
		hold(`<code>${escapeHtml(code)}</code>`),
	);
}

const linkPattern = /\[([^\]\n]+)\]\(\s*([^)\s]+)\s*\)/g;

function holdLinks(line: string, hold: (html: string) => string): string {
	return line.replace(linkPattern, (match, label: string, url: string) => {
		if (!/^(https?:|tg:|mailto:)/i.test(url)) return match;
		return hold(`<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`);
	});
}

function wrapBalanced(text: string, rule: Rule): string {
	return text.replace(rule.pattern, (match, inner: string) =>
		isBalanced(inner) ? `<${rule.tag}>${inner}</${rule.tag}>` : match,
	);
}

function groupBlockquotes(lines: readonly string[]): string[] {
	const out: string[] = [];
	let quote: string[] = [];
	const flush = () => {
		if (quote.length > 0) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
		quote = [];
	};
	for (const line of lines) {
		const match = /^&gt; ?(.*)$/.exec(line);
		if (match === null) {
			flush();
			out.push(line);
		} else quote.push(match[1] ?? "");
	}
	flush();
	return out;
}

const tagPattern = /<(\/?)([a-z-]+)(?:\s[^>]*)?>/g;

/** Whether every tag in `html` is closed in order (a stack check over the allowed tags). */
export function isBalanced(html: string): boolean {
	const stack: string[] = [];
	for (const match of html.matchAll(tagPattern)) {
		const [, closing, name] = match;
		if (closing === "") stack.push(name ?? "");
		else if (stack.pop() !== name) return false;
	}
	return stack.length === 0;
}
