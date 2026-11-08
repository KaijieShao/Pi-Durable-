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
	assert.deepEqual(config.evaluation, { hiddenTestsDir: undefined, image: "pi-durable-evaluator:demo" });
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

test("Pi process isolation: systemd by default on Linux, the local process mode elsewhere; names validated", () => {
	const linux = parse({}, { ...DEFAULTS, platform: "linux", username: "pi-coordinator" });
	assert.deepEqual(linux.runner, {
		isolation: "systemd",
		user: "pi-runner",
		group: "pi-durable",
		slice: "pi-durable-runs.slice",
		systemdRunBin: "systemd-run",
		systemctlBin: "systemctl",
	});
	assert.equal(parse({}, { ...DEFAULTS, platform: "darwin" }).runner.isolation, "process");
	const explicit = parse(
		{
			PI_RUNNER_ISOLATION: "process",
			PI_RUNNER_USER: "pi_run-2",
			PI_RUNNER_GROUP: "pi-shared",
			PI_RUNNER_SLICE: "pi-runs.slice",
			SYSTEMD_RUN_BIN: "/usr/bin/systemd-run",
			SYSTEMCTL_BIN: "/usr/bin/systemctl",
		},
		{ ...DEFAULTS, platform: "linux" },
	);
	assert.deepEqual(explicit.runner, {
		isolation: "process",
		user: "pi_run-2",
		group: "pi-shared",
		slice: "pi-runs.slice",
		systemdRunBin: "/usr/bin/systemd-run",
		systemctlBin: "/usr/bin/systemctl",
	});
	const bad: [string, string][] = [
		["PI_RUNNER_ISOLATION", "none"],
		["PI_RUNNER_ISOLATION", "docker"],
		["PI_RUNNER_USER", "root"],
		["PI_RUNNER_USER", "Pi"],
		["PI_RUNNER_USER", "pi runner"],
		["PI_RUNNER_USER", "../pi"],
		["PI_RUNNER_GROUP", "root"],
		["PI_RUNNER_GROUP", "pi:durable"],
		["PI_RUNNER_SLICE", "-.slice"],
		["PI_RUNNER_SLICE", "pi--runs.slice"],
		["PI_RUNNER_SLICE", "pi-runs.service"],
		["PI_RUNNER_SLICE", "system.slice extra"],
		["SYSTEMD_RUN_BIN", "bin/systemd-run"],
		["SYSTEMD_RUN_BIN", "/usr/bin/systemd run"],
		["SYSTEMCTL_BIN", "/usr/bin/systemctl'"],
		["SYSTEMCTL_BIN", "$HOME/systemctl"],
	];
	for (const [name, value] of bad) {
		assert.deepEqual(variables({ ...VALID, [name]: value }), [name], `${name}=${value}`);
	}
});

test("systemd isolation refuses the Coordinator's own user as the Pi user", () => {
	const own = { ...DEFAULTS, platform: "linux" as const, username: "pi-coordinator" };
	assert.deepEqual(
		problems({ ...VALID, PI_RUNNER_USER: "pi-coordinator" }, own).map((problem) => problem.variable),
		["PI_RUNNER_USER"],
	);
	// The local process mode runs as the Coordinator's user by definition.
	assert.equal(
		parse({ PI_RUNNER_ISOLATION: "process", PI_RUNNER_USER: "pi-coordinator" }, own).runner.user,
		"pi-coordinator",
	);
	const summary = describeConfig(parse({}, own));
	assert.equal(summary.runner_isolation, "systemd");
	assert.equal(summary.runner_user, "pi-runner");
	assert.equal(summary.runner_slice, "pi-durable-runs.slice");
});

test("the evaluator: hidden tests outside PI_DATA_DIR and PI_TASK_DIR (the agents' containers mount from there); the image", () => {
	const config = parse({
		PI_EVAL_HIDDEN_TESTS_DIR: "/srv/hidden",
		EVALUATOR_IMAGE: "evaluator:x",
		PI_TASK_DIR: "/mnt/t",
	});
	assert.deepEqual(config.evaluation, { hiddenTestsDir: "/srv/hidden", image: "evaluator:x" });
	assert.equal(parse({ PI_EVAL_HIDDEN_TESTS_DIR: "hidden" }).evaluation.hiddenTestsDir, "/srv/work/hidden");
	const hidden = (env: Env) =>
		problems({ ...VALID, ...env }).filter((problem) => problem.variable === "PI_EVAL_HIDDEN_TESTS_DIR").length;
	// Inside the task directory, the task directory itself, a parent of it, inside the data directory: refused.
	for (const dir of ["/mnt/t/hidden", "/mnt/t", "/mnt", "/data/hidden", "/data"])
		assert.equal(hidden({ PI_TASK_DIR: "/mnt/t", PI_DATA_DIR: "/data", PI_EVAL_HIDDEN_TESTS_DIR: dir }), 1, dir);
	assert.equal(hidden({ PI_TASK_DIR: "/mnt/t", PI_EVAL_HIDDEN_TESTS_DIR: "/mnt/tests,ro" }), 1, "not mountable");
	// A sibling whose name only starts like the task directory is outside it.
	assert.equal(
		parse({ PI_TASK_DIR: "/mnt/t", PI_EVAL_HIDDEN_TESTS_DIR: "/mnt/tt" }).evaluation.hiddenTestsDir,
		"/mnt/tt",
	);
});

test("disk limits: unset by default (DEMO_LIMITS apply, no task disk budget); sizes in bytes or K/M/G/T", () => {
	assert.deepEqual(parse().disk, {
		bootMinFreeBytes: undefined,
		taskMinFreeBytes: undefined,
		taskBudgetBytes: undefined,
		worktreeHeadroomBytes: undefined,
	});
	const config = parse({
		PI_BOOT_DISK_MIN_FREE: "2GiB",
		PI_TASK_DISK_MIN_FREE: "512M",
		PI_TASK_DISK_BUDGET: "1073741824",
		PI_WORKTREE_HEADROOM: "0",
	});
	assert.deepEqual(config.disk, {
		bootMinFreeBytes: 2 * 1024 ** 3,
		taskMinFreeBytes: 512 * 1024 ** 2,
		taskBudgetBytes: 1024 ** 3,
		worktreeHeadroomBytes: 0,
	});
	assert.equal(parse({ PI_TASK_DISK_BUDGET: "30 GB" }).disk.taskBudgetBytes, 30 * 1024 ** 3);
	assert.equal(parse({ PI_TASK_DISK_BUDGET: "1t" }).disk.taskBudgetBytes, 1024 ** 4);
	assert.equal(parse({ PI_WORKTREE_HEADROOM: "64KiB" }).disk.worktreeHeadroomBytes, 64 * 1024);
	const summary = describeConfig(config);
	assert.equal(summary.boot_disk_min_free, 2 * 1024 ** 3);
	assert.equal(summary.task_disk_budget, 1024 ** 3);
	assert.equal(describeConfig(parse()).task_disk_budget, undefined);
	// A floor or a budget of 0 would switch a check off: refused, like every other malformed size.
	for (const [name, value] of [
		["PI_BOOT_DISK_MIN_FREE", "0"],
		["PI_TASK_DISK_MIN_FREE", "0K"],
		["PI_TASK_DISK_BUDGET", "0"],
		["PI_TASK_DISK_BUDGET", "-5"],
		["PI_TASK_DISK_BUDGET", "1.5G"],
		["PI_WORKTREE_HEADROOM", "lots"],
		["PI_WORKTREE_HEADROOM", "5P"],
		["PI_BOOT_DISK_MIN_FREE", "99999999999999999T"],
	] as const) {
		assert.deepEqual(variables({ ...VALID, [name]: value }), [name], `${name}=${value}`);
	}
});
