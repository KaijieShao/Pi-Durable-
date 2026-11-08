import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs, USAGE } from "../../src/cli/args.ts";
import { COORDINATOR_DB, OWNER_EXIT, runOwnerCommand } from "../../src/cli/owner.ts";
import { type CoordinatorHandle, EXIT, runCoordinatorCli, startupExitCode } from "../../src/cli/run.ts";
import { ConfigError, loadOwnerConfig } from "../../src/coordinator/config.ts";
import { ownerFailedEvents, ownerStatus } from "../../src/coordinator/owner/report.ts";
import { TelegramError } from "../../src/coordinator/ports.ts";
import { SCHEMA_VERSION, Store } from "../../src/coordinator/store.ts";
import { LockHeld } from "../../src/runtime/lock.ts";
import { createLogger } from "../../src/runtime/log.ts";
import "../helpers/env.ts";

const BOT_TOKEN = `123456789:${"A".repeat(35)}`;
const OPENAI_KEY = "sk-test-openai-key-0000000000000000";
const GITHUB = "github_pat_test_0000000000000000000000";
const GROUP = -1001234567890;

function validEnv(dataDir: string): NodeJS.ProcessEnv {
	return {
		TELEGRAM_BOT_TOKEN: BOT_TOKEN,
		TELEGRAM_BOT_USERNAME: "smule_code_bot",
		TELEGRAM_GROUP_CHAT_ID: String(GROUP),
		TELEGRAM_OWNER_ID: "111111111",
		PI_AGENTS: "alpha,beta",
		PI_MODEL: "gpt-5.5",
		OPENAI_API_KEY: OPENAI_KEY,
		PROJECT_TOKEN_CEILING: "2000000",
		GITHUB_TOKEN: GITHUB,
		GITHUB_REPO: "acme/signup-demo",
		PI_DATA_DIR: dataDir,
		PATH: "/usr/bin:/bin",
	};
}

async function tempDir(): Promise<{ dir: string; cleanup(): Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "pdt-cli-"));
	return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("argv: run, watchdog, the owner commands, help, version; login is gone", () => {
	assert.deepEqual(parseArgs([]), { command: "help" });
	assert.deepEqual(parseArgs(["--help"]), { command: "help" });
	assert.deepEqual(parseArgs(["run", "-h"]), { command: "help" });
	assert.deepEqual(parseArgs(["--version"]), { command: "version" });
	assert.deepEqual(parseArgs(["run"]), { command: "run" });
	assert.deepEqual(parseArgs(["run", "--env-file", "/e"]), { command: "run", envFile: "/e" });
	assert.deepEqual(parseArgs(["--env-file=/e", "run"]), { command: "run", envFile: "/e" });
	assert.deepEqual(parseArgs(["watchdog"]), { command: "watchdog" });
	assert.deepEqual(parseArgs(["watchdog", "--env-file", "/w.env"]), { command: "watchdog", envFile: "/w.env" });
	assert.deepEqual(parseArgs(["owner", "status"]), { command: "owner", action: "status" });
	assert.deepEqual(parseArgs(["owner", "unfreeze", "--env-file", ".env.local"]), {
		command: "owner",
		action: "unfreeze",
		envFile: ".env.local",
	});
	assert.deepEqual(parseArgs(["--env-file=/e", "owner", "failed-events"]), {
		command: "owner",
		action: "failed-events",
		envFile: "/e",
	});
	// A group chat id is negative: an argument, not an option.
	assert.deepEqual(parseArgs(["owner", "unfreeze", "-1001234567890"]), {
		command: "owner",
		action: "unfreeze",
		group: -1001234567890,
	});
	assert.deepEqual(parseArgs(["owner", "resolve", "3", "7"]), { command: "owner", action: "resolve", intents: [3, 7] });
	assert.deepEqual(parseArgs(["owner", "conversations"]), { command: "owner", action: "conversations" });
	assert.deepEqual(parseArgs(["owner", "conversations", "12"]), {
		command: "owner",
		action: "conversations",
		task: 12,
	});
	assert.deepEqual(parseArgs(["owner", "inspect", "0c8e-41"]), {
		command: "owner",
		action: "inspect",
		conversation: "0c8e-41",
	});
	assert.deepEqual(parseArgs(["owner", "seal"]), { command: "owner", action: "seal" });
	assert.deepEqual(parseArgs(["owner", "seal", "-1001234567890", "--trial", "trial-3", "--tasks", "4,5"]), {
		command: "owner",
		action: "seal",
		group: -1001234567890,
		trial: "trial-3",
		tasks: [4, 5],
	});
	assert.deepEqual(parseArgs(["owner", "seal", "--trial=t1", "--env-file", "/e"]), {
		command: "owner",
		action: "seal",
		trial: "t1",
		envFile: "/e",
	});
	for (const argv of [
		["login", "anthropic"],
		["owner"],
		["owner", "freeze"],
		["owner", "status", "extra"],
		["owner", "unfreeze", "now"],
		["owner", "unfreeze", "-1", "-2"],
		["owner", "resolve"],
		["owner", "resolve", "0"],
		["owner", "resolve", "x"],
		["owner", "conversations", "-3"],
		["owner", "inspect"],
		["owner", "inspect", "../etc"],
		["owner", "seal", "now"],
		["owner", "seal", "--trial"],
		["owner", "seal", "--trial", "../x"],
		["owner", "seal", "--tasks", "1,x"],
		["owner", "seal", "--tasks", "0"],
		["owner", "status", "--trial", "t1"],
		["owner", "unfreeze", "--tasks", "1"],
		["owner", "toString"],
		["run", "now"],
		["watchdog", "now"],
		["run", "--env-file"],
		["run", "--env-file="],
		["run", "--debug"],
		["serve"],
	]) {
		assert.equal(parseArgs(argv).command, "invalid", argv.join(" "));
	}
	assert.match(USAGE, /owner status/);
	for (const command of [
		"unfreeze \\[<group>\\]",
		"resolve <change>",
		"conversations \\[<task>\\]",
		"inspect <conversation>",
		"seal \\[<group>\\] \\[--trial <id>\\] \\[--tasks <id,...>\\]",
	])
		assert.match(USAGE, new RegExp(`owner ${command}`));
	assert.match(USAGE, /watchdog \[--env-file <path>\]/);
	assert.doesNotMatch(USAGE, /login/);
});

test("run: a configuration error prints every problem without values and exits 2 before starting", async () => {
	let started = false;
	const errors: string[] = [];
	const env = { ...validEnv("/nonexistent"), TELEGRAM_BOT_TOKEN: "secret-but-malformed", PI_AGENTS: undefined };
	const result = await runCoordinatorCli({
		env,
		start: async () => {
			started = true;
			return { stop: async () => {} };
		},
		stderr: (text) => errors.push(text),
		processHandlers: false,
	});
	assert.equal(result, EXIT.config);
	assert.equal(started, false);
	const text = errors.join("");
	assert.match(text, /^Configuration error:\n {2}TELEGRAM_BOT_TOKEN: /);
	assert.match(text, /PI_AGENTS: required/);
	assert.ok(!text.includes("secret-but-malformed"));
});

test("run: starts with the parsed config and a logger, scrubs secrets from the environment, stops on shutdown", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const env = validEnv(dir);
		const lines: string[] = [];
		const exits: number[] = [];
		let stopped = 0;
		let seenToken: string | undefined;
		const result = await runCoordinatorCli({
			env,
			start: async (config, deps) => {
				seenToken = config.telegram.botToken;
				deps.log.info("startup_probe");
				return { stop: async () => void stopped++ } satisfies CoordinatorHandle;
			},
			createLog: () => createLogger({ level: "debug", sink: (_level, line) => lines.push(line) }),
			exit: (code) => exits.push(code),
			processHandlers: false,
		});
		assert.ok(typeof result === "object");
		assert.equal(seenToken, BOT_TOKEN);
		for (const name of ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "GITHUB_TOKEN"])
			assert.equal(env[name], undefined, name);
		assert.equal(env.PATH, "/usr/bin:/bin");
		assert.ok(lines.some((line) => line.startsWith("info coordinator_starting ")));
		assert.ok(lines.includes("info startup_probe"));
		assert.ok(lines.some((line) => line.startsWith("info coordinator_running ")));
		const logged = lines.join("\n");
		for (const secret of [BOT_TOKEN, OPENAI_KEY, GITHUB]) assert.ok(!logged.includes(secret), "log leaks a secret");
		await result.shutdown(0, "SIGTERM");
		assert.equal(stopped, 1);
		assert.deepEqual(exits, [0]);
	} finally {
		await cleanup();
	}
});

test("run: a fatal error after startup (poller 401 or crash) stops the Coordinator and exits non-zero", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		for (const [error, code] of [
			[new TelegramError("unauthorized", "getUpdates: unauthorized", 401), EXIT.config],
			[new Error("poller crashed"), EXIT.fatal],
		] as const) {
			const lines: string[] = [];
			const exits: number[] = [];
			let stopped = 0;
			let fatal: ((reason: string, error: unknown) => void) | undefined;
			const result = await runCoordinatorCli({
				env: validEnv(dir),
				start: async (_config, deps) => {
					fatal = deps.onFatal;
					return { stop: async () => void stopped++ } satisfies CoordinatorHandle;
				},
				createLog: () => createLogger({ level: "debug", sink: (_level, line) => lines.push(line) }),
				exit: (exitCode) => exits.push(exitCode),
				processHandlers: false,
			});
			assert.ok(typeof result === "object", "the Coordinator started");
			assert.deepEqual(exits, [], "nothing exits before the fatal error");
			assert.ok(fatal !== undefined, "the CLI hands the Coordinator an onFatal callback");
			fatal("telegram_poller_fatal", error);
			await waitUntil(() => exits.length > 0);
			assert.equal(stopped, 1, "the Coordinator is stopped before exiting");
			assert.deepEqual(exits, [code]);
			assert.notEqual(code, 0);
			assert.ok(lines.some((line) => line.startsWith("error fatal reason=telegram_poller_fatal")));
		}
	} finally {
		await cleanup();
	}
});

async function waitUntil(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("run: a failed start runs the shutdown path and exits 1, 2 (rejected token) or 3 (data dir locked)", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		for (const [error, code] of [
			[new Error("docker exploded"), EXIT.fatal],
			[new TelegramError("unauthorized", "getMe 401", 401), EXIT.config],
			[new LockHeld(undefined, "DATA_DIR is used by pid 7"), EXIT.locked],
			[new ConfigError([{ variable: "TELEGRAM_BOT_USERNAME", message: "does not match getMe" }]), EXIT.config],
		] as const) {
			const exits: number[] = [];
			const errors: string[] = [];
			const lines: string[] = [];
			const result = await runCoordinatorCli({
				env: validEnv(dir),
				start: async () => {
					throw error;
				},
				createLog: () => createLogger({ level: "debug", sink: (_level, line) => lines.push(line) }),
				stderr: (text) => errors.push(text),
				exit: (exitCode) => exits.push(exitCode),
				processHandlers: false,
			});
			assert.equal(result, code, error.message);
			assert.deepEqual(exits, [code]);
			assert.equal(startupExitCode(error), code);
			assert.ok(lines.some((line) => line.startsWith("error startup_failed ")));
			if (error instanceof ConfigError) assert.match(errors.join(""), /TELEGRAM_BOT_USERNAME: does not match getMe/);
		}
	} finally {
		await cleanup();
	}
});

/** A Coordinator database with a frozen group, two tasks, a slot, a failed event and a quarantined conversation. */
function seed(store: Store): void {
	const now = store.now();
	store.tx(() => {
		store.freeze(GROUP, "stop unconfirmed");
		store.run(
			`INSERT INTO tasks(id, chat_id, creator_id, agent_id, text, update_id, state, pr_number, pr_url, created_at,
			 updated_at) VALUES (12, ?, 1, 'alpha', 'secret task text', 900, 'review', 4, 'https://github.com/acme/r/pull/4', ?, ?)`,
			GROUP,
			now,
			now,
		);
		store.run(
			`INSERT INTO tasks(id, chat_id, creator_id, agent_id, text, update_id, state, reason, created_at, updated_at)
			 VALUES (13, ?, 2, 'beta', 'other text', 901, 'cancelled', 'group frozen', ?, ?)`,
			GROUP,
			now,
			now,
		);
		store.run(
			`INSERT INTO runs(id, task_id, kind, state, requested_by, request_id, input_text, queued_at)
			 VALUES (3, 12, 'followup', 'queued', 1, '905', 'secret follow-up', ?)`,
			now,
		);
		store.run(
			"INSERT INTO slots(kind, task_id, run_id, agent_id, acquired_at) VALUES ('check', 12, NULL, NULL, ?)",
			now,
		);
		store.run(
			"INSERT INTO conversations(id, task_id, path, quarantined, created_at) VALUES ('c1', 12, '/x.sqlite', 1, ?)",
			now,
		);
		const outbox = store.enqueue({ chatId: GROUP, taskId: 12, priority: "required", kind: "review", text: "body" });
		store.run("UPDATE outbox SET state = 'failed' WHERE id = ?", outbox);
		store.run(
			"INSERT INTO failed_events(outbox_id, kind, reason, created_at) VALUES (?, 'telegram_send', 'Bad Request: chat not found', ?)",
			outbox,
			now,
		);
	});
}

test("owner status and failed-events: built from the database, metadata only (no task, follow-up or message text)", async () => {
	const { dir, cleanup } = await tempDir();
	const store = new Store(join(dir, COORDINATOR_DB));
	try {
		seed(store);
		const status = ownerStatus(store, GROUP);
		assert.match(
			status,
			/^Group -1001234567890: frozen \(reason: stop unconfirmed\); owner unfreeze repeats the recovery checks, then reopens dispatch\n/,
		);
		assert.match(status, /Execution slots: 1\/2 in use\n {2}check task 12 since /);
		assert.match(status, /Queued runs: 1/);
		assert.match(status, /#12 alpha review PR #4 https:\/\/github.com\/acme\/r\/pull\/4/);
		assert.match(status, /#13 beta cancelled \(group frozen\) no PR/);
		assert.match(status, /failed events: 1/);
		assert.match(status, /Quarantined conversations: 1 \(read-only: owner conversations, owner inspect <id>\)/);
		assert.ok(!status.includes("secret"), "status shows no task or follow-up text");
		assert.ok(!status.includes("Held tasks"), "no held task, no section");
		// A task held because its branch changed on GitHub outside the Coordinator (src/coordinator/branch-hold.ts).
		store.tx(() =>
			store.setMeta(
				"branch_hold:12",
				JSON.stringify({
					kind: "review",
					runId: 1,
					interrupted: false,
					branch: "task/12",
					local: "c0ffee00a1b2c3d4e5f60718293a4b5c6d7e8f90",
					pushed: "5d6e7f80a1b2c3d4e5f60718293a4b5c6d7e8f90",
					github: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
					since: 0,
				}),
			),
		);
		assert.match(
			ownerStatus(store, GROUP),
			/\nHeld tasks \(their branch changed on GitHub outside the Coordinator\):\n {2}#12 review: task\/12 on GitHub at 1a2b3c4; c0ffee0 waits in the worktree until the branch is back at 5d6e7f8\n/,
		);

		const events = ownerFailedEvents(store);
		assert.match(
			events,
			/^Failed events: 1\n {2}#1 .* kind=telegram_send outbox=1 message=review task=12 reason="Bad Request/,
		);
		assert.ok(!events.includes("body"), "no message text");
		// The group is only ever unfrozen by the running Coordinator (its recovery checks); no function here changes it.
		assert.equal(store.groupState(GROUP).state, "frozen");
	} finally {
		store.close();
		await cleanup();
	}
});

test("owner status shows the watchdog's heartbeat age and its last sweep", async () => {
	const { dir, cleanup } = await tempDir();
	const store = new Store(join(dir, COORDINATOR_DB));
	try {
		const before = ownerStatus(store, GROUP);
		assert.match(before, /\nWatchdog: no heartbeat yet \(is it running\? no run is dispatched without it\)\n/);
		assert.match(before, /\nLast watchdog sweep: none\nPending sweep requests: 0/);
		const now = Date.now();
		store.tx(() => {
			store.setMeta("watchdog_heartbeat_at", String(now - 2_000));
			store.setMeta("watchdog_pid", "4321");
			store.run(
				`INSERT INTO watchdog_sweeps(reason, state, requester_pid, verified, processes_killed, containers_killed,
				   processes_left, containers_left, requested_at, finished_at)
				 VALUES ('coordinator_start', 'done', 77, 1, 1, 2, 0, 0, ?, ?)`,
				now,
				now,
			);
			store.run(
				`INSERT INTO watchdog_sweeps(reason, state, run_id, task_id, generation, verified, processes_killed,
				   containers_killed, processes_left, containers_left, detail, requested_at, finished_at)
				 VALUES ('deadline', 'done', 5, 3, 2, 0, 1, 0, 1, 0, 'processes_left', ?, ?)`,
				now,
				now,
			);
			store.run("INSERT INTO watchdog_sweeps(reason, state, requested_at) VALUES ('recheck', 'pending', ?)", now);
		});
		const status = ownerStatus(store, GROUP);
		assert.match(status, /\nWatchdog: last heartbeat 2 s ago \(pid 4321\)\n/);
		assert.match(
			status,
			/\nLast watchdog sweep: #2 deadline run 5 \(task 3, generation 2\): NOT verified \(processes_left\); killed 1 Pi processes and 0 containers at \d{4}-/,
		);
		assert.match(status, /\nPending sweep requests: 1/);
		store.tx(() => store.setMeta("watchdog_heartbeat_at", String(now - 60_000)));
		assert.match(
			ownerStatus(store, GROUP),
			/last heartbeat 60 s ago \(pid 4321\); stale: no new run starts until it is back/,
		);
	} finally {
		store.close();
		await cleanup();
	}
});

/** Every file of `dir`: name → size, mtime and content hash. */
function files(dir: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(dir)
			.filter((name) => statSync(join(dir, name)).isFile())
			.map((name) => {
				const stats = statSync(join(dir, name));
				return [
					name,
					`${stats.size} ${stats.mtimeMs} ${createHash("sha256")
						.update(readFileSync(join(dir, name)))
						.digest("hex")}`,
				];
			}),
	);
}

test("owner CLI without a running Coordinator: says so and exits 3; status falls back to a labelled read-only status, unfreeze changes nothing", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const out: string[] = [];
		const err: string[] = [];
		const io = { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) };
		assert.equal(await runOwnerCommand({ action: "status" }, { env: validEnv(dir), ...io }), OWNER_EXIT.notRunning);
		assert.match(err.join(""), /^The Coordinator is not running \(no owner socket at .*owner\/owner\.sock\)\./);
		assert.match(err.join(""), /No Coordinator database at .*coordinator\.sqlite either/);
		assert.equal(await runOwnerCommand({ action: "status" }, { env: { PI_DATA_DIR: dir }, ...io }), OWNER_EXIT.config);
		assert.match(err.join(""), /Configuration error:/);

		const store = new Store(join(dir, COORDINATOR_DB));
		seed(store);
		store.close();
		const before = files(dir);
		out.length = 0;
		err.length = 0;
		assert.equal(await runOwnerCommand({ action: "unfreeze" }, { env: validEnv(dir), ...io }), OWNER_EXIT.notRunning);
		assert.match(
			err.join(""),
			/^The Coordinator is not running \(.*\)\. An unfreeze needs the running Coordinator: it repeats the recovery checks before the group may dispatch again\./,
		);
		assert.equal(out.join(""), "", "no fallback for an unfreeze");
		for (const invocation of [
			{ action: "failed-events" },
			{ action: "resolve", intents: [1] },
			{ action: "conversations" },
			{ action: "inspect", conversation: "c1" },
		] as const) {
			assert.equal(await runOwnerCommand(invocation, { env: validEnv(dir), ...io }), OWNER_EXIT.notRunning);
		}
		assert.deepEqual(files(dir), before, "nothing was written: the database is unchanged");
		const reader = new Store(join(dir, COORDINATOR_DB));
		assert.equal(reader.groupState(GROUP).state, "frozen", "still frozen");
		reader.close();

		out.length = 0;
		assert.equal(await runOwnerCommand({ action: "status" }, { env: validEnv(dir), ...io }), OWNER_EXIT.notRunning);
		const fallback = out.join("");
		assert.match(
			fallback,
			/^READ-ONLY STATUS FROM THE DATABASE: the Coordinator is not running, so nothing below is live and no command can change it\.\nGroup -1001234567890: frozen \(reason: stop unconfirmed\)/,
		);
		const printed = out.join("") + err.join("");
		for (const secret of [BOT_TOKEN, OPENAI_KEY, GITHUB]) assert.ok(!printed.includes(secret));
	} finally {
		await cleanup();
	}
});

test("the read-only fallback never migrates or writes: a database of another schema version is refused", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const store = new Store(join(dir, COORDINATOR_DB));
		store.tx(() => store.setMeta("schema_version", "2"));
		store.close();
		const before = files(dir);
		assert.throws(
			() => new Store(join(dir, COORDINATOR_DB), Date.now, { readOnly: true }),
			new RegExp(`has schema 2; this version reads schema ${SCHEMA_VERSION}`),
		);
		const err: string[] = [];
		const code = await runOwnerCommand(
			{ action: "status" },
			{ env: validEnv(dir), stdout: () => {}, stderr: (t) => err.push(t) },
		);
		assert.equal(code, OWNER_EXIT.notRunning);
		assert.match(err.join(""), /The database could not be read: Error: the database has schema 2/);
		const after = files(dir);
		assert.equal(after["coordinator.sqlite"], before["coordinator.sqlite"], "not migrated, not written");
	} finally {
		await cleanup();
	}
});

test("the owner CLI reads no secret: only its own variables, even from the Coordinator's env file; it works without them", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		// The Coordinator's env file, secrets included, with `export` and quotes as people write them.
		const envFile = join(dir, "coordinator.env");
		const lines = Object.entries({ ...validEnv(dir), PI_TASK_DIR: join(dir, "t"), PI_TASK_DISK_BUDGET: "2GiB" }).map(
			([name, value]) => `export ${name}="${value}"`,
		);
		writeFileSync(envFile, `${lines.join("\n")}\n`);
		const env: NodeJS.ProcessEnv = {};
		const config = loadOwnerConfig({ envFile, env });
		assert.deepEqual(config, {
			groupChatId: GROUP,
			paths: { dataDir: dir, taskDir: join(dir, "t") },
			disk: {
				bootMinFreeBytes: undefined,
				taskMinFreeBytes: undefined,
				taskBudgetBytes: 2 * 1024 ** 3,
				worktreeHeadroomBytes: undefined,
			},
		});
		assert.deepEqual(env, {}, "nothing written to the environment");
		const serialized = JSON.stringify(config);
		for (const secret of [BOT_TOKEN, OPENAI_KEY, GITHUB]) assert.ok(!serialized.includes(secret));
		// Real variables win over the file.
		assert.equal(loadOwnerConfig({ envFile, env: { TELEGRAM_GROUP_CHAT_ID: "-42" } }).groupChatId, -42);
		assert.throws(() => loadOwnerConfig({ envFile: join(dir, "none.env"), env: {} }), /--env-file/);

		// No secret in the environment at all: the CLI still works (here: the Coordinator is not running, exit 3).
		const err: string[] = [];
		const io = { stdout: () => {}, stderr: (text: string) => err.push(text) };
		const bare = { PI_DATA_DIR: dir, TELEGRAM_GROUP_CHAT_ID: String(GROUP) };
		assert.equal(await runOwnerCommand({ action: "status" }, { env: bare, ...io }), OWNER_EXIT.notRunning);
		assert.match(err.join(""), /^The Coordinator is not running/);
		assert.equal(
			await runOwnerCommand({ action: "status" }, { env: { ...bare, TELEGRAM_GROUP_CHAT_ID: "12" }, ...io }),
			OWNER_EXIT.config,
		);
		assert.match(err.join(""), /TELEGRAM_GROUP_CHAT_ID: must be a negative integer/);
	} finally {
		await cleanup();
	}
});

test("owner status reports both disks: free space, the limits applied, and what each boot-disk budget holds", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const out: string[] = [];
		const io = { stdout: (text: string) => out.push(text), stderr: (text: string) => out.push(text) };
		const store = new Store(join(dir, COORDINATOR_DB));
		seed(store);
		store.close();
		mkdirSync(join(dir, "conversations"));
		writeFileSync(join(dir, "conversations", "c1.sqlite"), Buffer.alloc(64 * 1024));
		// The Coordinator is not running: the labelled read-only status (exit 3) shows the disks too.
		assert.equal(await runOwnerCommand({ action: "status" }, { env: validEnv(dir), ...io }), OWNER_EXIT.notRunning);
		const status = out.join("");
		assert.match(
			status,
			/\nBoot disk \(PI_DATA_DIR\): \d+\.\d [GT]iB free of \d+\.\d [GT]iB; new tasks are rejected below 1\.0 GiB free\n/,
		);
		assert.match(
			status,
			/\n {2}Database \(coordinator\.sqlite with its WAL\): \d+(\.\d)? [KM]iB; no retention rule enforced yet\n/,
		);
		assert.match(
			status,
			/\n {2}Pi raw-content store \(conversations\/\): (6[4-9]|[7-9]\d|1\d\d) KiB in 1 files, 1 conversations; no retention rule/,
		);
		assert.match(status, /\n {2}Metadata logs: stdout and stderr .*not measured\nTask disk/);
		assert.match(
			status,
			/\nTask disk \(PI_TASK_DIR, not a mount point\): .* free of .*, .* under PI_TASK_DIR in use; \d+ worktrees; budget none \(the disk's own size\); a new worktree needs its files \+ 1\.0 GiB headroom and 1\.0 GiB must stay free\n {2}Retained trials \(PI_TASK_DIR\/snapshots\): 0 sealed snapshots, 0 bytes; kept/,
		);
		assert.ok(!status.includes("New worktrees are held"));

		// The configured limits, and a hold on new worktrees, are shown as such.
		out.length = 0;
		const held = new Store(join(dir, COORDINATOR_DB));
		held.tx(() => held.setMeta("task_disk_wait", "its new worktree needs about 1.0 GiB, but the task disk budget …"));
		held.close();
		const env = {
			...validEnv(dir),
			PI_BOOT_DISK_MIN_FREE: "3GiB",
			PI_TASK_DISK_BUDGET: "30GiB",
			PI_TASK_DISK_MIN_FREE: "2G",
			PI_WORKTREE_HEADROOM: "256MiB",
		};
		assert.equal(await runOwnerCommand({ action: "status" }, { env, ...io }), OWNER_EXIT.notRunning);
		const configured = out.join("");
		assert.match(configured, /new tasks are rejected below 3\.0 GiB free\n/);
		assert.match(
			configured,
			/; budget 30\.0 GiB; a new worktree needs its files \+ 256\.0 MiB headroom and 2\.0 GiB must stay free/,
		);
		assert.match(
			configured,
			/\n {2}New worktrees are held: its new worktree needs about 1\.0 GiB, but the task disk budget …$/m,
		);
		for (const secret of [BOT_TOKEN, OPENAI_KEY, GITHUB]) assert.ok(!configured.includes(secret));
	} finally {
		await cleanup();
	}
});
