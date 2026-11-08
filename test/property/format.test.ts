import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { splitForTelegram, TELEGRAM_TEXT_LIMIT } from "../../src/format/chunk.ts";
import { escapeHtml } from "../../src/format/escape.ts";
import { ALLOWED_TAGS, isBalanced, markdownToTelegramHtml } from "../../src/format/markdown-html.ts";
import { check } from "../helpers/property.ts";

const fragments = fc.constantFrom(
	"```ts\n",
	"```\n",
	"\n```\n",
	"~~~\n",
	"`",
	"``",
	"**",
	"__",
	"_",
	"*",
	"~~",
	"||",
	"&",
	"&amp;",
	"<",
	">",
	"> quote\n",
	"# Heading\n",
	"\n",
	"\n\n",
	"\r\n",
	" ",
	"😀",
	"👍🏽",
	"снег",
	"[link](https://example.com/a_b*c)",
	"[bad](javascript:alert(1))",
	"snake_case_name",
	"",
);
const words = fc.string({ unit: "binary", maxLength: 40 });
const longWord = fc.string({ unit: fc.constantFrom("a", "&", "<", "😀"), minLength: 100, maxLength: 3000 });
const markdown = fc
	.array(
		fc.oneof({ weight: 5, arbitrary: fragments }, { weight: 3, arbitrary: words }, { weight: 1, arbitrary: longWord }),
		{ maxLength: 400 },
	)
	.map((parts) => parts.join(""));

const allowed = new Set<string>(ALLOWED_TAGS);
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function onlyAllowedTags(html: string): boolean {
	for (const match of html.matchAll(/<\/?([a-z-]+)[^>]*>/g)) if (!allowed.has(match[1] ?? "")) return false;
	return !/<(?![a-z/])/.test(html);
}

function entitiesComplete(html: string): boolean {
	return [...html.matchAll(/&/g)].every((match) => /^&(amp|lt|gt|quot);/.test(html.slice(match.index)));
}

test("P-chunk: every chunk fits, is balanced, complete and non-empty; plain slices cover the input", (t) => {
	check(
		t,
		markdown,
		(input) => {
			const chunks = splitForTelegram(input);
			for (const chunk of chunks) {
				assert.ok(chunk.html.length <= TELEGRAM_TEXT_LIMIT, `chunk of ${chunk.html.length}`);
				assert.ok(isBalanced(chunk.html), "balanced tags");
				assert.ok(onlyAllowedTags(chunk.html), "allowed tags only");
				assert.ok(entitiesComplete(chunk.html), "no cut entity");
				assert.ok(!loneSurrogate.test(chunk.html) && !loneSurrogate.test(chunk.plain), "no lone surrogate");
				assert.ok(chunk.plain.trim() !== "", "non-empty");
			}
			const strip = (text: string) => text.replace(/\s+/g, "");
			assert.equal(strip(chunks.map((chunk) => chunk.plain).join("")), strip(input.replace(/\r\n?/g, "\n")));
		},
		200,
	);
});

test("P-chunk: large inputs (10k-60k chars) split within limits", (t) => {
	const big = fc
		.array(fc.oneof(fragments, words, longWord), { minLength: 300, maxLength: 1500 })
		.map((parts) => parts.join(""));
	check(
		t,
		big,
		(input) => {
			const chunks = splitForTelegram(input);
			assert.ok(chunks.length >= 1);
			for (const chunk of chunks) {
				assert.ok(chunk.html.length <= TELEGRAM_TEXT_LIMIT);
				assert.ok(isBalanced(chunk.html));
				assert.ok(entitiesComplete(chunk.html));
			}
		},
		25,
	);
});

test("P-html: allowed tags only, balanced, never throws, no double escaping", (t) => {
	check(t, markdown, (input) => {
		const html = markdownToTelegramHtml(input);
		assert.ok(onlyAllowedTags(html));
		assert.ok(isBalanced(html));
		assert.ok(entitiesComplete(html));
		if (!input.includes("&amp;")) assert.ok(!html.includes("&amp;amp;"));
		assert.ok(!html.includes(""));
	});
});

test("P-html: text without markdown syntax round-trips to its escaped form", (t) => {
	const plain = fc.string({ unit: fc.constantFrom(..."abc XYZ 019.,:;!?&<'\"=+-/😀снег".split("")), maxLength: 200 });
	check(t, plain, (input) => {
		assert.equal(markdownToTelegramHtml(input), escapeHtml(input));
	});
});

test("long code block is split with the fence reopened in every chunk", () => {
	const code = Array.from({ length: 400 }, (_, i) => `const value${i} = ${i}; // & < >`).join("\n");
	const chunks = splitForTelegram(`Intro\n\n\`\`\`ts\n${code}\n\`\`\`\nOutro`);
	assert.ok(chunks.length >= 3);
	for (const chunk of chunks.slice(1, -1)) assert.match(chunk.html, /^<pre><code class="language-ts">/);
	assert.ok(chunks.every((chunk) => chunk.html.length <= TELEGRAM_TEXT_LIMIT));
});

test("markdown examples", () => {
	assert.equal(
		markdownToTelegramHtml("**bold** and _it_ and `x<y`"),
		"<b>bold</b> and <i>it</i> and <code>x&lt;y</code>",
	);
	assert.equal(markdownToTelegramHtml("snake_case_name stays"), "snake_case_name stays");
	assert.equal(markdownToTelegramHtml("[a](https://x.y/?q=1&r=2)"), '<a href="https://x.y/?q=1&amp;r=2">a</a>');
	assert.equal(markdownToTelegramHtml("[a](javascript:alert)"), "[a](javascript:alert)");
	assert.equal(markdownToTelegramHtml("# Title"), "<b>Title</b>");
	assert.equal(markdownToTelegramHtml("> q1\n> q2\nx"), "<blockquote>q1\nq2</blockquote>\nx");
	assert.equal(
		markdownToTelegramHtml("```py\nprint(1<2)\n"),
		'<pre><code class="language-py">print(1&lt;2)</code></pre>',
	);
	assert.equal(markdownToTelegramHtml("```\nraw\n", { autoCloseFence: false }), "```\nraw\n");
	assert.equal(markdownToTelegramHtml("**a _b** c_"), "<b>a _b</b> c_");
});
