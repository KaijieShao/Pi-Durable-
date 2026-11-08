/**
 * The watchdog's own configuration (src/watchdog/config.ts) and CLI start (src/cli/watchdog.ts): it needs no secret
 * (Deployment § Secrets: the three secrets are held only in the Coordinator's memory), works with only its own
 * variables, ignores everything else whatever its value, derives the deployment marker exactly as the Coordinator's
 * launcher does, takes only its own variables from an env file, and removes any secret from its environment.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { productionReapers, runWatchdogCli } from "../../src/cli/watchdog.ts";
import { ConfigError } from "../../src/config/shared.ts";
import { parseCoordinatorConfig } from "../../src/coordinator/config.ts";
import { deploymentId } from "../../src/runner/argv.ts";
import { createLogger } from "../../src/runtime/log.ts";
import { loadWatchdogConfig, parseWatchdogConfig } from "../../src/watchdog/config.ts";

const SECRETS = {
	TELEGRAM_BOT_TOKEN: `123456789:${"s".repeat(35)}`,
	OPENAI_API_KEY: "sk-watchdog-test-not-real",
	GITHUB_TOKEN: "ghp_watchdog_test_not_real",
};

async function tempDir(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "watchdog-config-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("only its own variables: no secret, no Coordinator setting needed", () => {
	const config = parseWatchdogConfig(
		{ PI_DATA_DIR: "/var/lib/pi-durable", TELEGRAM_GROUP_CHAT_ID: "-1001234" },
		{ cwd: "/", home: "/home/x", platform: "linux" },
	);
	assert.deepEqual(config, {
		dataDir: "/var/lib/pi-durable",
		deployment: deploymentId("/var/lib/pi-durable"),
		groupChatId: -1001234,
		dockerBin: "docker",
		isolation: "systemd",
		slice: "pi-durable-runs.slice",
		systemctlBin: "systemctl",
		logLevel: "info",
	});
	assert.equal(
		parseWatchdogConfig({ TELEGRAM_GROUP_CHAT_ID: "-5" }, { cwd: "/", home: "/h", platform: "darwin" }).isolation,
		"process",
	);
});

test("it ignores every other variable, whatever its value (a broken bot token, a missing model key...)", () => {
	const config = parseWatchdogConfig(
		{
			TELEGRAM_GROUP_CHAT_ID: "-42",
			TELEGRAM_BOT_TOKEN: "not a token",
			PI_AGENTS: "!!",
			OPENAI_BASE_URL: "ftp://nope",
			GITHUB_REPO: "",
			PROJECT_TOKEN_CEILING: "lots",
		},
		{ cwd: "/", home: "/h", platform: "darwin" },
	);
	assert.equal(config.groupChatId, -42);
	assert.ok(!JSON.stringify(config).includes("not a token"));
});

test("Linux watchdog parsing and the production reaper factory both refuse process isolation", () => {
	const env = { TELEGRAM_GROUP_CHAT_ID: "-42", PI_RUNNER_ISOLATION: " process " };
	const defaults = { cwd: "/", home: "/h", platform: "linux" as const };
	const rejected = (error: unknown) =>
		error instanceof ConfigError &&
		error.problems.length === 1 &&
		error.problems[0]?.variable === "PI_RUNNER_ISOLATION" &&
		/Linux requires systemd isolation in the Pi slice; process isolation is refused/.test(error.message);
	assert.throws(() => parseWatchdogConfig(env, defaults), rejected);
	assert.throws(() => loadWatchdogConfig({ env, platform: "linux" }), rejected);
	const mac = parseWatchdogConfig(env, { ...defaults, platform: "darwin" });
	assert.equal(mac.isolation, "process");
	assert.throws(() => productionReapers(mac, "linux"), rejected, "prebuilt configs cannot bypass the factory guard");
	assert.equal(productionReapers(mac, "darwin").processes.length, 1);
	const systemd = parseWatchdogConfig({ TELEGRAM_GROUP_CHAT_ID: "-42" }, defaults);
	assert.equal(productionReapers(systemd, "linux").processes.length, 2, "the slice reaper and marker fallback remain");
	if (process.platform === "linux") assert.throws(() => productionReapers(mac), rejected);
});

test("the watchdog CLI rejects Linux process mode before logging, starting a loop or creating state", async (t) => {
	const dir = await tempDir(t),
		dataDir = join(dir, "must-not-exist");
	const errors: string[] = [];
	let logs = 0;
	const result = await runWatchdogCli({
		platform: "linux",
		env: { PI_DATA_DIR: dataDir, TELEGRAM_GROUP_CHAT_ID: "-42", PI_RUNNER_ISOLATION: "process" },
		processHandlers: false,
		stderr: (text) => errors.push(text),
		createLog() {
			logs++;
			throw new Error("must reject before logging or starting");
		},
	});
	assert.equal(result, 2);
	assert.equal(logs, 0);
	assert.match(errors.join(""), /PI_RUNNER_ISOLATION: Linux requires systemd/);
	assert.equal(existsSync(dataDir), false);
});

test("the deployment marker is the launcher's: the data directory resolved exactly as the Coordinator resolves it", () => {
	const defaults = { cwd: "/srv/app", home: "/home/pi", platform: "darwin" as const, uid: 501, gid: 20 };
	for (const dataDir of [undefined, "relative/data", "/abs/../abs/data/"]) {
		const env = { ...(dataDir === undefined ? {} : { PI_DATA_DIR: dataDir }), TELEGRAM_GROUP_CHAT_ID: "-7" };
		const coordinator = parseCoordinatorConfig(
			{
				...env,
				...SECRETS,
				TELEGRAM_BOT_USERNAME: "watchdog_test_bot",
				TELEGRAM_OWNER_ID: "1",
				PI_AGENTS: "alpha",
				PI_MODEL: "gpt-4.1-mini",
				PI_THINKING: "off",
				PROJECT_TOKEN_CEILING: "1000",
				GITHUB_REPO: "a/b",
			},
			defaults,
		);
		const watchdog = parseWatchdogConfig(env, defaults);
		assert.equal(watchdog.dataDir, coordinator.paths.dataDir, String(dataDir));
		assert.equal(watchdog.deployment, deploymentId(coordinator.paths.dataDir));
	}
});

test("problems are listed by variable name, never by value", () => {
	try {
		parseWatchdogConfig(
			{ DOCKER_BIN: "docker; rm -rf /", PI_RUNNER_ISOLATION: "chroot", PI_RUNNER_SLICE: "-.slice", LOG_LEVEL: "loud" },
			{ cwd: "/", home: "/h", platform: "linux" },
		);
		assert.fail("expected a ConfigError");
	} catch (error) {
		assert.ok(error instanceof ConfigError);
		assert.deepEqual(
			error.problems.map((problem) => problem.variable),
			["TELEGRAM_GROUP_CHAT_ID", "DOCKER_BIN", "PI_RUNNER_ISOLATION", "PI_RUNNER_SLICE", "LOG_LEVEL"],
		);
		assert.ok(!error.message.includes("rm -rf") && !error.message.includes("loud"));
	}
});

test("from an env file it takes only its own variables; the file's secrets never reach the config or the environment", async (t) => {
	const dir = await tempDir(t);
	const file = join(dir, "coordinator.env");
	await writeFile(
		file,
		[
			"# the Coordinator's file, secrets and all",
			...Object.entries(SECRETS).map(([name, value]) => `${name}=${value}`),
			`export PI_DATA_DIR=${join(dir, "data")}`,
			"TELEGRAM_GROUP_CHAT_ID=-100777",
			"LOG_LEVEL=warn",
			"",
		].join("\n"),
	);
	const env: Record<string, string> = { LOG_LEVEL: "debug" };
	const config = loadWatchdogConfig({ envFile: file, env });
	assert.equal(config.dataDir, join(dir, "data"));
	assert.equal(config.groupChatId, -100777);
	assert.equal(config.logLevel, "debug", "the environment wins over the file");
	assert.deepEqual(env, { LOG_LEVEL: "debug" }, "nothing is written to the environment");
	for (const secret of Object.values(SECRETS)) assert.ok(!JSON.stringify(config).includes(secret));
	assert.throws(() => loadWatchdogConfig({ envFile: join(dir, "missing.env"), env: {} }), ConfigError);
});

test("the CLI starts with no secret in its environment, and removes any it finds", async (t) => {
	const dir = await tempDir(t);
	const lines: string[] = [];
	const log = createLogger({ level: "debug", sink: (_level, line) => lines.push(line) });
	const env: NodeJS.ProcessEnv = {
		PI_DATA_DIR: join(dir, "data"),
		TELEGRAM_GROUP_CHAT_ID: "-100888",
		PI_RUNNER_ISOLATION: "process",
		// The production reapers run: never the real Docker daemon (there is no database here, so nothing is swept).
		DOCKER_BIN: join(dir, "no-docker"),
		...SECRETS,
	};
	// This no-secret/process-mode test explicitly exercises the Mac policy even on Linux CI.
	const started = await runWatchdogCli({ env, platform: "darwin", processHandlers: false, createLog: () => log });
	assert.ok(typeof started !== "number");
	t.after(() => started.stop());
	for (const name of Object.keys(SECRETS)) assert.equal(env[name], undefined, `${name} removed`);
	assert.ok(lines.some((line) => /watchdog_secrets_removed count=3/.test(line)));
	assert.ok(lines.some((line) => /watchdog_starting .*isolation=process/.test(line)));
	for (const secret of Object.values(SECRETS)) assert.ok(!lines.join("\n").includes(secret));
	await started.stop();

	const errors: string[] = [];
	const refused = await runWatchdogCli({ env: {}, processHandlers: false, stderr: (text) => errors.push(text) });
	assert.equal(refused, 2);
	assert.match(errors.join(""), /TELEGRAM_GROUP_CHAT_ID: required/);
});
