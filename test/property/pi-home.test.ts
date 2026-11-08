import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { piAgentDir, piDefaultsEnv, resolveAuthFile, withPiDefaults } from "../../src/config/pi-home.ts";
import { parseConfig } from "../../src/config/schema.ts";
import { check } from "../helpers/property.ts";

const paths = { agentDir: "/home/u/.pi/agent", dataDir: "/home/u/.local/state/pdt", cwd: "/srv/work" };
const shared = "/home/u/.pi/agent/auth.json";
const legacy = "/home/u/.local/state/pdt/auth.json";

test("P-auth-file: PI_AUTH_FILE wins, then pi's file, then a legacy data-dir file, else pi's path", (t) => {
	const explicit = fc.option(fc.constantFrom("/etc/creds.json", "rel/creds.json", "  ", ""), { nil: undefined });
	check(t, fc.tuple(explicit, fc.boolean(), fc.boolean()), ([PI_AUTH_FILE, hasShared, hasLegacy]) => {
		const exists = (path: string) => (path === shared && hasShared) || (path === legacy && hasLegacy);
		const got = resolveAuthFile({ PI_AUTH_FILE }, paths, exists);
		if (PI_AUTH_FILE?.trim())
			assert.equal(got, PI_AUTH_FILE.startsWith("/") ? PI_AUTH_FILE : `/srv/work/${PI_AUTH_FILE}`);
		else if (hasShared) assert.equal(got, shared);
		else if (hasLegacy) assert.equal(got, legacy);
		else assert.equal(got, shared);
	});
});

test("pi agent dir follows PI_CODING_AGENT_DIR with ~ expansion, like pi", () => {
	assert.equal(piAgentDir({}, "/home/u"), "/home/u/.pi/agent");
	assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "~/alt" }, "/home/u"), "/home/u/alt");
	assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/opt/pi" }, "/home/u"), "/opt/pi");
	assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "  " }, "/home/u"), "/home/u/.pi/agent");
});

test("parseConfig picks the credentials file through the injected file check", () => {
	const env = { TELEGRAM_BOT_TOKEN: `12345:${"a".repeat(35)}`, TELEGRAM_ALLOWED_USER_IDS: "1" };
	const base = { cwd: "/srv/work", home: "/home/u" };
	assert.equal(parseConfig(env, { ...base, exists: () => false }).authFile, shared);
	const legacyOnly = (path: string) => path === "/home/u/.local/state/pi-durable-telegram/auth.json";
	assert.equal(
		parseConfig(env, { ...base, exists: legacyOnly }).authFile,
		"/home/u/.local/state/pi-durable-telegram/auth.json",
	);
});

test("pi settings: provider, model and thinking; junk and missing files give nothing", () => {
	const read = (text: string) => () => text;
	assert.deepEqual(
		piDefaultsEnv(
			"/a",
			read('{"defaultProvider":"openai-codex","defaultModel":"gpt-6","defaultThinkingLevel":"high"}'),
		),
		{ PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-6", PI_THINKING: "high" },
	);
	assert.deepEqual(
		piDefaultsEnv("/a", read('{"defaultModel":"gpt-6"}')),
		{},
		"a model without its provider is dropped",
	);
	for (const junk of ["", "null", "[]", "{", '{"defaultProvider":3}', '"x"']) {
		assert.deepEqual(piDefaultsEnv("/a", read(junk)), {}, junk);
	}
	assert.deepEqual(
		piDefaultsEnv("/a", () => {
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		}),
		{},
	);
});

const isSet = (value: string | undefined) => (value?.trim() ?? "") !== "";

function expectedModel(envModel: string | undefined, provider: string | undefined, piHasModel: boolean) {
	if (isSet(envModel)) return envModel;
	return piHasModel && provider === "anthropic" ? "m-pi" : envModel;
}

test("P-pi-defaults: set PI_* variables win; pi's model only rides with pi's provider", (t) => {
	const value = fc.option(fc.constantFrom("anthropic", "openai-codex", "  "), { nil: undefined });
	const model = fc.option(fc.constantFrom("m-env", ""), { nil: undefined });
	check(t, fc.tuple(value, model, fc.boolean()), ([envProvider, envModel, piHasModel]) => {
		const piEnv: Record<string, string> = { PI_PROVIDER: "anthropic", PI_THINKING: "high" };
		if (piHasModel) piEnv.PI_MODEL = "m-pi";
		const out = withPiDefaults({ PI_PROVIDER: envProvider, PI_MODEL: envModel }, piEnv);
		assert.equal(out.PI_PROVIDER, isSet(envProvider) ? envProvider : "anthropic");
		assert.equal(out.PI_MODEL, expectedModel(envModel, out.PI_PROVIDER, piHasModel));
		assert.equal(out.PI_THINKING, "high");
	});
});
