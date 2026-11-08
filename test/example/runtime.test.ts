import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSafeEnv } from "../../src/agent/tools/bash.ts";
import { chooseOption, describe } from "../../src/auth/interaction.ts";
import { isSecretName, scrubSecrets } from "../../src/config/scrub.ts";
import { createLogger, formatLine } from "../../src/runtime/log.ts";
import { redact } from "../../src/runtime/redact.ts";
import { formatDuration, formatStatus, formatTokens } from "../../src/status/format-status.ts";

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

test("secrets are scrubbed from the environment and never reach bash", () => {
	const env: Record<string, string | undefined> = {
		TELEGRAM_BOT_TOKEN: "t",
		DEEPGRAM_API_KEY: "d",
		ANTHROPIC_OAUTH_TOKEN: "a",
		GITHUB_TOKEN: "g",
		PATH: "/bin",
		HOME: "/h",
		LANG: "C",
		RANDOM_VAR: "r",
	};
	const removed = scrubSecrets(env);
	assert.deepEqual(Object.keys(removed).sort(), [
		"ANTHROPIC_OAUTH_TOKEN",
		"DEEPGRAM_API_KEY",
		"GITHUB_TOKEN",
		"TELEGRAM_BOT_TOKEN",
	]);
	assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "RANDOM_VAR"]);
	const safe = buildSafeEnv({
		...env,
		NPM_TOKEN: "n",
		NODE_AUTH_TOKEN: "x",
		NODE_OPTIONS: "--max-old-space-size=512",
		XDG_CONFIG_HOME: "/c",
	});
	assert.equal(safe.PATH, "/bin");
	assert.equal(safe.NODE_OPTIONS, "--max-old-space-size=512");
	assert.equal(safe.RANDOM_VAR, undefined);
	assert.equal(safe.NODE_AUTH_TOKEN, undefined);
	assert.equal(safe.NPM_TOKEN, undefined);
	assert.ok(isSecretName("OPENAI_API_KEY") && !isSecretName("PATH"));
});

test("headless login answers: copy-code option, URLs printed", () => {
	assert.equal(chooseOption([{ id: "browser" }, { id: "copy_code" }]), "copy_code");
	assert.equal(chooseOption([{ id: "only" }]), "only");
	assert.match(describe({ type: "auth_url", url: "https://claude.ai/oauth?x=1" }), /https:\/\/claude\.ai\/oauth\?x=1/);
	assert.equal(describe({ type: "info", message: "hi" }), "hi");
});

test("status formatting", () => {
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(12_345), "12.3k");
	assert.equal(formatTokens(1_500_000), "1.50M");
	assert.equal(formatDuration(3 * 3_600_000 + 5 * 60_000), "3h 5m");
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const text = formatStatus({
		version: "0.1.0",
		model: "anthropic/claude-opus-5-5",
		thinking: "high",
		auth: "oauth",
		busy: true,
		tool: "bash",
		queued: 2,
		contextTokens: 250_000,
		contextWindow: 1_000_000,
		chat: { ...zero, input: 1000, output: 500, cost: 0.25 },
		total: zero,
		uptimeMs: 60_000,
		voice: false,
		plugins: { loaded: ["search", "skills"], problems: [{ plugin: "mcp", reason: "did not load: no MCP config" }] },
	});
	assert.match(text, /Plugins: search, skills; problems: mcp \(did not load: no MCP config\)/);
	assert.match(text, /Model: anthropic\/claude-opus-5-5, thinking high/);
	assert.match(text, /State: working \(bash\), queued: 2/);
	assert.match(text, /Context: 250\.0k \/ 1\.00M \(25%\)/);
	assert.match(text, /This chat: in 1\.0k, out 500, \$0\.25/);
});
