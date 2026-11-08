import { readFile, stat } from "node:fs/promises";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

const MAX_INSTRUCTIONS_BYTES = 64 * 1024;

const HTML_ANSWERS =
	"Answers are shown in Telegram: keep them compact, use simple Markdown (bold, italic, code, code blocks, links), no tables.";

/** Rich mode: what Telegram renders, and how to offer a choice as buttons. */
export const RICH_ANSWERS = `Answers are shown in Telegram as rich messages: Markdown with headings, tables, task lists (- [ ]), code blocks and <details><summary>…</summary>…</details> folds. Keep them compact.
When the user has to choose (yes or no, a few options, the next step), end the answer with one short question line, then buttons:
<tg-button-row><tg-button type="callback_data" data="Да, обновляй">Да</tg-button><tg-button type="callback_data" data="Нет, не сейчас">Нет</tg-button></tg-button-row>
- A tap arrives as the user's next message with exactly the data text: write data in the user's words and language, as a reply that makes sense on its own, never a code.
- data is at most 64 bytes (about 60 Latin or 30 Cyrillic letters); labels are one or two words; 1-4 buttons, one row per decision. Rows are independent: a tap disables only its own row, so one message may ask several questions.
- url and copy_text buttons also exist: <tg-button type="url" url="https://…">Open</tg-button>, <tg-button type="copy_text" text="…">Copy</tg-button>.
- The user may type an answer instead of tapping; treat both the same. No buttons on answers that ask nothing.`;

export function preambleText(workdir: string | undefined, rich = false): string {
	return [
		"You are a personal coding agent. The user talks to you through a private Telegram chat.",
		`Your working directory is ${workdir ?? "the service's working directory"}. You have read, write, edit and bash tools with full access to it.`,
		"Files the user sends are saved under inbox/ in the working directory; the message tells you the path. View images with the read tool.",
		"Use the telegram_send_file tool to send a file from the workspace to the user.",
		rich ? RICH_ANSWERS : HTML_ANSWERS,
		"A tool call interrupted by a restart may already have taken effect: check the current state before repeating it.",
	].join("\n");
}

type Cached = { mtimeMs: number; size: number; text: string };

/** Reads the instructions file per request, re-reading only when its mtime or size changed. */
export function createInstructionsReader(path: string): () => Promise<string> {
	let cached: Cached | undefined;
	return async () => {
		const info = await stat(path).catch(() => undefined);
		if (info === undefined || !info.isFile()) {
			cached = undefined;
			return wrap(path, "none");
		}
		if (cached?.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
			cached = { mtimeMs: info.mtimeMs, size: info.size, text: await readCapped(path) };
		}
		return wrap(path, cached.text);
	};
}

async function readCapped(path: string): Promise<string> {
	const bytes = await readFile(path).catch(() => undefined);
	if (bytes === undefined) return "none (file unreadable)";
	if (bytes.length <= MAX_INSTRUCTIONS_BYTES) return bytes.toString("utf8");
	return `${bytes.subarray(0, MAX_INSTRUCTIONS_BYTES).toString("utf8")}\n[truncated: file is larger than 64 KB]`;
}

function wrap(path: string, body: string): string {
	return `<project_instructions path=${JSON.stringify(path)}>\n${body.trim()}\n</project_instructions>`;
}

/**
 * System prompt: a constant preamble and the project instructions file. The instructions section is always present
 * (a missing file renders "none"), so the prompt cache is not invalidated by a section appearing or disappearing.
 */
export function createPromptExtension(options: { instructionsPath: string; rich?: boolean }): Extension {
	const instructions = createInstructionsReader(options.instructionsPath);
	return defineExtension({
		name: "prompt",
		sections: [
			section("preamble", (input) => preambleText(input.agent.cwd ?? input.env?.cwd, options.rich), { tag: false }),
			section("agents_md", () => instructions(), { tag: false }),
		],
	});
}
