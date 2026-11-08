import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEnv } from "node:util";
import {
	ConfigError,
	describeConfig,
	type Env,
	loadCoordinatorConfig,
	parseCoordinatorConfig,
} from "../../src/coordinator/config.ts";
import "../helpers/env.ts";

const BOT_TOKEN = `123456789:${"A".repeat(35)}`;
const OPENAI_KEY = "sk-test-openai-key-0000000000000000";
const GITHUB = "github_pat_test_0000000000000000000000";
const DEFAULTS = { cwd: "/srv/work", home: "/home/me", uid: 1000, gid: 1000 };

const VALID: Env = {
	TELEGRAM_BOT_TOKEN: BOT_TOKEN,
	TELEGRAM_BOT_USERNAME: "smule_code_bot",
	TELEGRAM_GROUP_CHAT_ID: "-1001234567890",
	TELEGRAM_OWNER_ID: "111111111",
	PI_AGENTS: "alpha,beta",
	PI_MODEL: "gpt-5.5",
	OPENAI_API_KEY: OPENAI_KEY,
	PROJECT_TOKEN_CEILING: "2000000",
	GITHUB_TOKEN: GITHUB,
	GITHUB_REPO: "acme/signup-demo",
};

const REQUIRED = [
	"TELEGRAM_BOT_TOKEN",
	"TELEGRAM_BOT_USERNAME",
	"TELEGRAM_GROUP_CHAT_ID",
	"TELEGRAM_OWNER_ID",
	"PI_AGENTS",
	"PI_MODEL",
	"OPENAI_API_KEY",
	"PROJECT_TOKEN_CEILING",
	"GITHUB_TOKEN",
	"GITHUB_REPO",
];

function parse(extra: Env = {}, defaults: Parameters<typeof parseCoordinatorConfig>[1] = DEFAULTS) {
	return parseCoordinatorConfig({ ...VALID, ...extra }, defaults);
}

/** The problems of a rejected env; fails if the env was accepted. */
function problems(env: Env, defaults: Parameters<typeof parseCoordinatorConfig>[1] = DEFAULTS) {
	try {
		parseCoordinatorConfig(env, defaults);
	} catch (error) {
		assert.ok(error instanceof ConfigError, String(error));
		return error.problems;
	}
	assert.fail("the configuration was accepted");
}

const variables = (env: Env) => problems(env).map((problem) => problem.variable);

test("a full valid environment parses, with the documented defaults", () => {
	const config = parse();
	assert.equal(config.telegram.botToken, BOT_TOKEN);
	assert.equal(config.telegram.botUsername, "smule_code_bot");
	assert.equal(config.telegram.apiRoot, "https://api.telegram.org");
	assert.equal(config.telegram.groupChatId, -1001234567890);
	assert.equal(config.telegram.topicId, 1);
	assert.equal(config.telegram.ownerId, 111111111);
	assert.equal(config.telegram.memberIds, undefined);
	assert.deepEqual(config.agents, ["alpha", "beta"]);
	assert.equal(config.model.provider, "openai");
	assert.equal(config.model.modelId, "gpt-5.5");
	assert.equal(config.model.thinkingLevel, "medium");
	assert.equal(config.model.upstreamBaseUrl, "https://api.openai.com/v1");
	assert.equal(config.model.openaiApiKey, OPENAI_KEY);
	assert.equal(config.model.codexGateway, false);
	assert.equal(config.model.projectTokenCeiling, 2_000_000);
	assert.equal(config.github.token, GITHUB);
	assert.equal(config.github.repo, "acme/signup-demo");
	assert.equal(config.github.baseBranch, "main");
	assert.equal(config.github.remoteUrl, "https://github.com/acme/signup-demo.git");
	assert.equal(config.git.branchPrefix, "task/");
	assert.equal(config.paths.dataDir, "/home/me/.local/state/pi-durable-coordinator");
	assert.equal(config.paths.taskDir, "/home/me/.local/state/pi-durable-coordinator/tasks");
	assert.equal(config.paths.requireTaskMount, false);
	assert.equal(config.docker.agentImage, "pi-durable-agent:demo");
	assert.equal(config.docker.checkImage, "pi-durable-check:demo");
	assert.equal(config.docker.user, "1000:1000");
	assert.equal(config.relay.port, 0);
	assert.equal(config.setupScript, ".pi/setup.sh");
	assert.equal(config.logLevel, "info");
});

test("optional settings are honoured: topic, member allowlist, gateway, paths, images, log level", () => {
	const config = parse({
		TELEGRAM_BOT_USERNAME: "@smule_code_bot",
		TELEGRAM_GROUP_TOPIC_ID: "42",
		TELEGRAM_MEMBER_IDS: "222, 333,222,",
		PI_THINKING: "high",
		OPENAI_BASE_URL: "https://gateway.example.test/openai/v1/",
		OPENAI_CODEX_GATEWAY: "1",
		GITHUB_BASE_BRANCH: "develop",
		PI_DATA_DIR: "data",
		PI_TASK_DIR: "/mnt/tasks",
		AGENT_IMAGE: "agent:x",
		CHECK_IMAGE: "check:x",
		CONTAINER_USER: "1500:1500",
		PI_SETUP_SCRIPT: "scripts/setup.sh",
		LOG_LEVEL: "debug",
	});
	assert.equal(config.telegram.botUsername, "smule_code_bot");
	assert.equal(config.telegram.topicId, 42);
	assert.deepEqual(config.telegram.memberIds, [222, 333]);
	assert.equal(config.model.thinkingLevel, "high");
	assert.equal(config.model.upstreamBaseUrl, "https://gateway.example.test/openai/v1");
	assert.equal(config.model.codexGateway, true);
	assert.equal(config.github.baseBranch, "develop");
	assert.equal(config.paths.dataDir, "/srv/work/data");
	assert.equal(config.paths.taskDir, "/mnt/tasks");
	assert.equal(config.docker.agentImage, "agent:x");
	assert.equal(config.docker.checkImage, "check:x");
	assert.equal(config.docker.user, "1500:1500");
	assert.equal(config.setupScript, "scripts/setup.sh");
	assert.equal(config.logLevel, "debug");
});

test("every missing required variable is reported, one problem each", () => {
	assert.deepEqual(variables({}), REQUIRED);
	for (const name of REQUIRED) {
		assert.deepEqual(variables({ ...VALID, [name]: undefined }), [name], name);
		assert.deepEqual(variables({ ...VALID, [name]: "   " }), [name], `${name} blank`);
	}
});

test("PI_PROVIDER must be openai: Pi reaches the model only through the relay", () => {
	assert.equal(parse({ PI_PROVIDER: "openai" }).model.provider, "openai");
	for (const provider of ["anthropic", "openai-codex", "faux", "OPENAI"]) {
		const found = problems({ ...VALID, PI_PROVIDER: provider });
		assert.deepEqual(
			found.map((problem) => problem.variable),
			["PI_PROVIDER"],
			provider,
		);
		assert.match(found[0]?.message ?? "", /must be openai/);
	}
});

test("agent ids: lower-cased, unique case-insensitively, letters first, at most 32 characters", () => {
	assert.deepEqual(parse({ PI_AGENTS: " Alpha, BETA ,gamma-2,delta_x," }).agents, [
		"alpha",
		"beta",
		"gamma-2",
		"delta_x",
	]);
	assert.deepEqual(parse({ PI_AGENTS: `a${"b".repeat(31)}` }).agents, [`a${"b".repeat(31)}`]);
	for (const agents of ["alpha,ALPHA", "1abc", "-a", "a b", "al.pha", `a${"b".repeat(32)}`, ",", "é"]) {
		assert.deepEqual([...new Set(variables({ ...VALID, PI_AGENTS: agents }))], ["PI_AGENTS"], agents);
	}
	assert.match(problems({ ...VALID, PI_AGENTS: "alpha,Alpha" })[0]?.message ?? "", /duplicate agent id alpha/);
	assert.match(problems({ ...VALID, PI_AGENTS: " , " })[0]?.message ?? "", /required|at least one/);
});

test("Telegram ids: the group is negative, the owner and members positive, the token well-formed", () => {
	for (const [name, value] of [
		["TELEGRAM_GROUP_CHAT_ID", "1001234567890"],
		["TELEGRAM_GROUP_CHAT_ID", "-0"],
		["TELEGRAM_GROUP_CHAT_ID", "group"],
		["TELEGRAM_OWNER_ID", "-5"],
		["TELEGRAM_OWNER_ID", "1.5"],
		["TELEGRAM_MEMBER_IDS", "1,x"],
		["TELEGRAM_GROUP_TOPIC_ID", "0"],
		["TELEGRAM_BOT_TOKEN", "not-a-token"],
		["TELEGRAM_BOT_USERNAME", "bad name"],
		["PROJECT_TOKEN_CEILING", "0"],
		["PI_THINKING", "extreme"],
		["LOG_LEVEL", "trace"],
		["GITHUB_REPO", "no-slash"],
		["PI_SETUP_SCRIPT", "/etc/setup.sh"],
		["PI_SETUP_SCRIPT", "../setup.sh"],
	] as const) {
		assert.deepEqual(variables({ ...VALID, [name]: value }), [name], `${name}=${value}`);
	}
});

test("OPENAI_BASE_URL: HTTPS, or HTTP only on localhost; no credentials, query or fragment; never echoed", () => {
	for (const [value, expected] of [
		["https://gateway.example.test/v1", "https://gateway.example.test/v1"],
		["https://gateway.example.test/v1///", "https://gateway.example.test/v1"],
		["http://127.0.0.1:1234/v1", "http://127.0.0.1:1234/v1"],
		["http://localhost:8080/v1", "http://localhost:8080/v1"],
		["http://[::1]:8080/v1", "http://[::1]:8080/v1"],
	] as const) {
		assert.equal(parse({ OPENAI_BASE_URL: value }).model.upstreamBaseUrl, expected, value);
	}
	for (const value of [
		"not a URL",
		"http://remote.example.test/v1",
		"ftp://gateway.example.test/v1",
		"https://name:private@gateway.example.test/v1",
		"https://gateway.example.test/v1?key=private",
		"https://gateway.example.test/v1#private",
	]) {
		const found = problems({ ...VALID, OPENAI_BASE_URL: value });
		assert.deepEqual(
			found.map((problem) => problem.variable),
			["OPENAI_BASE_URL"],
			value,
		);
		assert.ok(!found[0]?.message.includes("private"), "the URL is not echoed");
	}
});

test("CONTAINER_USER is never root: explicit uid 0 is refused, a root Coordinator defaults to nobody", () => {
	for (const user of ["0:0", "0:1000", "root", "1000", "-1:0", "abc:def", "00:0"]) {
		assert.deepEqual(variables({ ...VALID, CONTAINER_USER: user }), ["CONTAINER_USER"], user);
	}
	assert.equal(parse({}, { cwd: "/", home: "/root", uid: 0, gid: 0 }).docker.user, "65534:65534");
	assert.equal(parse({}, { cwd: "/", home: "/home/me", uid: 501, gid: 20 }).docker.user, "501:20");
	assert.equal(
		parse({ CONTAINER_USER: "1000:1000" }, { cwd: "/", home: "/root", uid: 0, gid: 0 }).docker.user,
		"1000:1000",
	);
});

test("describeConfig and every problem message are free of secret values", () => {
	const config = parse({ OPENAI_BASE_URL: "https://gateway.example.test/v1" });
	const summary = JSON.stringify(describeConfig(config));
	for (const secret of [BOT_TOKEN, BOT_TOKEN.split(":")[1] ?? "", OPENAI_KEY, GITHUB]) {
		assert.ok(!summary.includes(secret), "summary leaks a secret");
	}
	assert.match(summary, /smule_code_bot/);
	assert.match(summary, /alpha,beta/);
	const bad = {
		...VALID,
		TELEGRAM_BOT_TOKEN: "secret-token-value-123",
		OPENAI_BASE_URL: "https://u:secret-pass@x.test",
	};
	const error = (() => {
		try {
			parseCoordinatorConfig(bad, DEFAULTS);
		} catch (caught) {
			return caught as ConfigError;
		}
		return assert.fail("accepted");
	})();
	assert.ok(error instanceof ConfigError);
	assert.ok(!error.message.includes("secret-token-value-123"));
	assert.ok(!error.message.includes("secret-pass"));
});

test("loadCoordinatorConfig reads an env file; variables already set win; an unreadable file is a ConfigError", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdt-config-"));
	const names = [...Object.keys(VALID), "LOG_LEVEL"];
	try {
		const file = join(dir, ".env.local");
		const lines = Object.entries(VALID).map(([name, value]) => `${name}=${value}`);
		await writeFile(file, `${lines.join("\n")}\nLOG_LEVEL=debug\nPI_DATA_DIR=${join(dir, "data")}\n`, { mode: 0o600 });
		process.env.PI_MODEL = "gpt-from-environment";
		const config = loadCoordinatorConfig({ envFile: file });
		assert.equal(config.model.modelId, "gpt-from-environment");
		assert.equal(config.logLevel, "debug");
		assert.equal(config.paths.dataDir, join(dir, "data"));
		assert.throws(
			() => loadCoordinatorConfig({ envFile: join(dir, "missing.env") }),
			(error: unknown) => error instanceof ConfigError && error.problems[0]?.variable === "--env-file",
		);
	} finally {
		for (const name of [...names, "PI_DATA_DIR"]) delete process.env[name];
		await rm(dir, { recursive: true, force: true });
	}
});

test(".env.example parses once secrets and ids are filled in, and names only variables the parser reads", async () => {
	const root = join(import.meta.dirname, "../..");
	const example = await readFile(join(root, ".env.example"), "utf8");
	const source = await readFile(join(root, "src/coordinator/config.ts"), "utf8");
	const filled = {
		...parseEnv(example),
		TELEGRAM_BOT_TOKEN: BOT_TOKEN,
		TELEGRAM_GROUP_CHAT_ID: "-1001234567890",
		TELEGRAM_OWNER_ID: "111111111",
		OPENAI_API_KEY: OPENAI_KEY,
		GITHUB_TOKEN: GITHUB,
		GITHUB_REPO: "acme/signup-demo",
	};
	const config = parseCoordinatorConfig(filled, DEFAULTS);
	assert.equal(config.telegram.botUsername, "smule_code_bot");
	assert.equal(config.model.provider, "openai");
	for (const secret of ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "GITHUB_TOKEN"]) {
		assert.equal(parseEnv(example)[secret], "", `${secret} has no value in .env.example`);
	}
	const named = [...example.matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1] ?? "");
	assert.ok(named.length >= 30);
	for (const name of named) {
		assert.ok(source.includes(`"${name}"`) || source.includes(`env.${name}`), `${name} is not read by config.ts`);
	}
});
