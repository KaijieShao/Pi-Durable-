import { createInterface } from "node:readline";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export type Terminal = {
	readonly input: NodeJS.ReadableStream;
	readonly output: NodeJS.WritableStream;
};

/**
 * Login interaction for a headless server over SSH: `select` prefers the copy-code (headless) option, URLs are
 * printed, codes are read as one line from stdin, secrets are read without echo.
 */
export function createHeadlessInteraction(
	terminal: Terminal = { input: process.stdin, output: process.stdout },
): AuthInteraction & {
	close(): void;
} {
	const lines = createLineReader(terminal);
	const say = (text: string) => terminal.output.write(`${text}\n`);
	return {
		prompt: (prompt: AuthPrompt) => answer(prompt, lines, say),
		notify: (event: AuthEvent) => say(describe(event)),
		close: () => lines.close(),
	};
}

async function answer(prompt: AuthPrompt, lines: LineReader, say: (text: string) => void): Promise<string> {
	if (prompt.type === "select") return chooseOption(prompt.options);
	const hint = prompt.placeholder === undefined ? "" : ` (${prompt.placeholder})`;
	const value = await lines.read(`${prompt.message}${hint} `, prompt.type === "secret", prompt.signal);
	if (prompt.type === "secret") say("");
	return value.trim();
}

/** The headless option when offered (Anthropic: `copy_code`), else the first. */
export function chooseOption(options: readonly { id: string }[]): string {
	const headless = options.find((option) => /copy|code|headless|device/i.test(option.id));
	const chosen = headless ?? options[0];
	if (chosen === undefined) throw new Error("Login offered no options");
	return chosen.id;
}

export function describe(event: AuthEvent): string {
	switch (event.type) {
		case "auth_url":
			return `\nOpen this URL in a browser and sign in:\n\n${event.url}\n${event.instructions ?? ""}`;
		case "device_code":
			return `\nOpen ${event.verificationUri} and enter the code: ${event.userCode}`;
		default:
			return event.message;
	}
}

type LineReader = {
	read(question: string, hidden: boolean, signal?: AbortSignal): Promise<string>;
	close(): void;
};

function createLineReader(terminal: Terminal): LineReader {
	let muted = false;
	const isTty = (terminal.input as { isTTY?: boolean }).isTTY === true;
	const rl = createInterface({ input: terminal.input, output: terminal.output, terminal: isTty });
	// With a TTY readline echoes typed characters itself; muting its writer hides a secret while it is typed.
	const writable = rl as unknown as { _writeToOutput?: (text: string) => void };
	const write = writable._writeToOutput?.bind(rl);
	if (write !== undefined) {
		writable._writeToOutput = (text: string) => {
			if (!muted) write(text);
		};
	}
	return {
		read: (question, hidden, signal) =>
			new Promise<string>((resolve, reject) => {
				terminal.output.write(question);
				muted = hidden;
				const onAbort = () => reject(new Error("Login cancelled"));
				const onClose = () => reject(new Error("Input closed before an answer was given"));
				signal?.addEventListener("abort", onAbort, { once: true });
				rl.once("close", onClose);
				rl.once("line", (line) => {
					muted = false;
					signal?.removeEventListener("abort", onAbort);
					rl.off("close", onClose);
					resolve(line);
				});
			}),
		close: () => rl.close(),
	};
}
