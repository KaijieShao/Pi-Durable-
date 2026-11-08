import assert from "node:assert/strict";
import { test } from "node:test";
import { isSecretName, scrubSecrets } from "../../src/config/scrub.ts";
import { createLogger, formatLine } from "../../src/runtime/log.ts";
import { redact } from "../../src/runtime/redact.ts";

test("redact masks tokens, keys and auth headers", () => {
	const token = `1234567890:${"A".repeat(35)}`;
	assert.equal(redact(`https://api.telegram.org/bot${token}/getMe`), "https://api.telegram.org/bot<redacted>/getMe");
	assert.ok(!redact(`token ${token} here`).includes("AAAA"));
	assert.ok(!redact("x sk-ant-oat01-abcdefghijklmnopqrst y").includes("abcdefgh"));
	assert.ok(!redact("Authorization: Bearer abc.def.ghijklmnop").includes("ghijklmnop"));
	assert.ok(!redact('{"refresh_token":"rt-1234567890"}').includes("1234567890"));
	assert.equal(redact("plain text stays"), "plain text stays");
});

test("logger: one redacted line per event, level threshold", () => {
	const lines: string[] = [];
	const log = createLogger({ level: "info", sink: (_l, line) => lines.push(line) });
	log.debug("hidden");
	log.info("delivered", { chat: 1, text: "two words", url: `bot123456:${"b".repeat(35)}` });
	assert.equal(lines.length, 1);
	assert.equal(lines[0], 'info delivered chat=1 text="two words" url=bot<redacted>');
	assert.equal(formatLine("warn", "x", { e: new Error("boom\nstack") }), 'warn x e="Error: boom"');
});

test("secrets are scrubbed from the environment; ordinary variables stay", () => {
	const env: Record<string, string | undefined> = {
		TELEGRAM_BOT_TOKEN: "t",
		OPENAI_API_KEY: "o",
		OPENAI_BASE_URL: "https://relay.example.test/v1",
		GITHUB_TOKEN: "g",
		PATH: "/bin",
		HOME: "/h",
		LANG: "C",
		PI_AGENTS: "alpha",
	};
	const removed = scrubSecrets(env);
	assert.deepEqual(Object.keys(removed).sort(), [
		"GITHUB_TOKEN",
		"OPENAI_API_KEY",
		"OPENAI_BASE_URL",
		"TELEGRAM_BOT_TOKEN",
	]);
	assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "PI_AGENTS"]);
	assert.ok(isSecretName("OPENAI_API_KEY") && isSecretName("GITHUB_TOKEN") && !isSecretName("PATH"));
});
