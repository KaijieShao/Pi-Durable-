/**
 * End-to-end stack for the group Coordinator: everything real except the outside world, which is replaced by
 * 127.0.0.1 fakes. In one temp directory:
 *
 * - FakeBotApi (Telegram Bot API over HTTP; the group's messages are queued as updates),
 * - an "origin" bare repository with a tiny Node project, served by FakeGitHub (GitHub REST over that bare repo),
 * - FakeModel (an OpenAI Responses upstream behind the Coordinator's real relay),
 * - the REAL Coordinator (`startCoordinator`): real commands, engine, relay, outbox, poller, git, GitHub client and
 *   the real Pi runner process per run. The sandbox is the test-only local sandbox by default (fsop.mjs on the host,
 *   and a "test" check that really runs `node --test` in the worktree); `sandbox: "docker"` uses the production
 *   Docker sandbox instead (opt-in, see dockerUnavailable()). Pi processes are forked children ("process" isolation)
 *   by default; `runner: "systemd"` uses the production systemd launcher with test stand-ins for systemd-run and
 *   systemctl (test/helpers/systemd-shims.ts), `runner: "config"` injects no launcher at all (production wiring).
 * - the REAL watchdog core (src/watchdog/watchdog.ts) in this process by default, on its own Store connection to the
 *   same database: it answers the Coordinator's sweep requests, keeps its heartbeat, reaps after a dead Coordinator
 *   and enforces run deadlines, killing this deployment's marked Pi processes (the production marker scan) and the
 *   stack's containers (the local sandbox's live()/killAll(), or the Docker CLI's). `watchdog: "none"` runs none
 *   (tests then start the CLI watchdog as its own process). The Docker variants (`sandbox: "docker"`) get a DOCKER_BIN
 *   wrapper that labels this stack's containers and filters every `docker ps` by that label, so neither the
 *   Coordinator's recovery nor the watchdog's sweeps ever see another run's containers on a shared daemon.
 *
 * Limits are DEMO_LIMITS unless a test overrides some (and says why). Debugging: E2E_LOG=1.
 */
import "../helpers/env.ts";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CoordinatorConfig, parseCoordinatorConfig } from "../../src/coordinator/config.ts";
import { type Coordinator, startCoordinator } from "../../src/coordinator/coordinator.ts";
import { createGit, type Git } from "../../src/coordinator/git.ts";
import { DEMO_LIMITS, type Limits } from "../../src/coordinator/limits.ts";
import type { RunLauncher, Sandbox } from "../../src/coordinator/ports.ts";
import { createRunLauncher } from "../../src/coordinator/runner-launcher.ts";
import { createSystemdRunLauncher } from "../../src/coordinator/runner-systemd.ts";
import { createLocalSandbox, type LocalCheck } from "../../src/coordinator/sandbox/local.ts";
import type { Row } from "../../src/coordinator/store.ts";
import type { WatchdogTimings } from "../../src/coordinator/watchdog-link.ts";
import { createLogger, type Logger, silentLogger } from "../../src/runtime/log.ts";
import { dockerContainerReaper, type Reaper } from "../../src/watchdog/reapers.ts";
import type { Watchdog } from "../../src/watchdog/watchdog.ts";
import { FakeBotApi, type ServerMessage } from "../fixtures/fake-bot-api.ts";
import { sleep } from "../helpers/env.ts";
import { createOriginRepo, FakeGitHub, originGit } from "../helpers/fake-github.ts";
import { type FakeHandler, FakeModel, type FakeStep } from "../helpers/fake-model.ts";
import { createSystemdShims, prepareSystemdLayout, type SystemdShims, testAccounts } from "../helpers/systemd-shims.ts";
import { sandboxReaper, startTestWatchdog } from "../helpers/watchdog.ts";

export const GROUP = -1001234567890;
export const OWNER = 1001;
export const USER1 = 2001;
export const USER2 = 2002;
export const BOT_USERNAME = "pi_e2e_bot";
export const REPO = "acme/demo";
const GITHUB_TOKEN = "ghp_e2e_fake_token_not_real";

/** The tiny Node project on origin's main: `npm test` = `node --test` with one passing test. */
export const PROJECT_FILES: Readonly<Record<string, string>> = {
	"package.json": `${JSON.stringify({ name: "demo", version: "1.0.0", private: true, scripts: { test: "node --test" } }, null, 2)}\n`,
	"README.md": "# demo\n\nA tiny project the e2e agents work on.\n",
	"AGENTS.md": "# Agents\n\nKeep modules small. Every module gets a test in test/. Run the tests before finishing.\n",
	"index.js": "module.exports = { version: 1 };\n",
	"test/index.test.js": [
		'const assert = require("node:assert/strict");',
		'const { test } = require("node:test");',
		'test("version", () => assert.equal(require("../index.js").version, 1));',
		"",
	].join("\n"),
};

export type StackOptions = {
	/** Files on origin's main (default PROJECT_FILES). */
	readonly files?: Readonly<Record<string, string>>;
	/** Overrides of DEMO_LIMITS; each test that passes one says why. */
	readonly limits?: Partial<Limits>;
	/** Check functions by op; "test" defaults to running `node --test` in the worktree. */
	readonly checks?: Readonly<Record<string, LocalCheck>>;
	/** Fake model script (default: answer "ok"). */
	readonly model?: FakeHandler;
	/** Extra Coordinator environment (e.g. TELEGRAM_MEMBER_IDS). */
	readonly env?: Readonly<Record<string, string>>;
	/**
	 * "local" (default): the test-only local sandbox. "docker": no sandbox is injected, so the Coordinator builds its
	 * production Docker sandbox from the config (pi-durable-agent:demo / pi-durable-check:demo, this user's uid:gid).
	 */
	readonly sandbox?: "local" | "docker";
	/**
	 * Pi process launcher. "process" (default): forked children, PI_RUNNER_ISOLATION=process. "systemd": the production
	 * systemd launcher (PI_RUNNER_ISOLATION=systemd) against systemd-run/systemctl stand-ins, with the host setup's data
	 * directory layout. "config": no launcher injected, the Coordinator builds its own from the config (set the
	 * PI_RUNNER_* variables in `env`).
	 */
	readonly runner?: "process" | "systemd" | "config";
	/** Passed to startCoordinator as deps.onFatal (the CLI exits non-zero on it). */
	readonly onFatal?: (reason: string, error: unknown) => void;
	/**
	 * Wrappers around the real git module (built as the Coordinator would build it) and the local sandbox, e.g. to
	 * hold one step of a run's start. The wrapped objects go in as deps.git / deps.sandbox and survive restart().
	 */
	readonly wrap?: { readonly git?: (git: Git) => Git; readonly sandbox?: (sandbox: Sandbox) => Sandbox };
	/** "in-process" (default): the real watchdog core in this process. "none": no watchdog runs. */
	readonly watchdog?: "in-process" | "none";
	/** Coordinator-side watchdog timings (deps.watchdog; production: 30 s answer, 15 s heartbeat). */
	readonly watchdogTimings?: Partial<WatchdogTimings>;
	/** In-process watchdog: the grace after the run deadline (production 60 s). */
	readonly watchdogDeadlineGraceMs?: number;
	/**
	 * In-process watchdog: the run deadline it enforces (default the stack's runDeadlineMs). Shorter than the
	 * Coordinator's own, it shows the watchdog stopping a run on its own.
	 */
	readonly watchdogRunDeadlineMs?: number;
};

export type BotMatch = RegExp | ((message: ServerMessage) => boolean);

/** Debugging: E2E_LOG=1 prints the Coordinator's metadata log lines (never content) to stderr. */
function stackLogger(): Logger {
	if (process.env.E2E_LOG !== "1") return silentLogger;
	return createLogger({ level: "debug", sink: (_level, line) => process.stderr.write(`[e2e] ${line}\n`) });
}

/** `node --test` in the worktree, with a minimal environment (no test-runner context leaks into the child). */
export const nodeTestCheck: LocalCheck = (worktree) =>
	new Promise((resolve) => {
		const child = spawn(process.execPath, ["--test"], {
			cwd: worktree,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: worktree, NODE_NO_WARNINGS: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ exitCode: 127, output: "node could not be started" });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ exitCode: code ?? 1, output: Buffer.concat(chunks).toString("utf8") });
		});
	});

/** uid:gid of this process for the Docker sandbox's containers (never root: fall back to nobody). */
function hostUser(): string {
	const uid = process.getuid?.() ?? 65534;
	const gid = process.getgid?.() ?? 65534;
	return uid === 0 || gid === 0 ? "65534:65534" : `${uid}:${gid}`;
}

/**
 * Why the Docker variant does not run, or false. Opt-in with E2E_DOCKER=1 (slow; real containers). The Coordinator's
 * restart recovery and the watchdog kill EVERY container labelled pi-durable.managed=1 on their Docker daemon
 * (production behaviour on a dedicated VM); here the stack's DOCKER_BIN wrapper (scopedDockerBin) limits "every" to
 * this stack's own containers, so other test runs sharing the daemon are never touched.
 */
export function dockerUnavailable(): string | false {
	if (process.env.E2E_DOCKER !== "1") return "set E2E_DOCKER=1 to run the e2e path on the real Docker sandbox";
	const images = spawnSync("docker", ["image", "inspect", "pi-durable-agent:demo", "pi-durable-check:demo"], {
		timeout: 30_000,
		stdio: "ignore",
	});
	if (images.error !== undefined) return "docker is not installed";
	return images.status === 0 ? false : "docker or the demo images (scripts/build-images.sh) are unavailable";
}

/** The label the Docker variants' wrapper adds to this stack's containers (and filters every `docker ps` by). */
export const SCOPE_LABEL = "pi-durable.e2e-scope";

/**
 * DOCKER_BIN for one stack (TEST ONLY): the real docker CLI, except that `docker run` adds `<SCOPE_LABEL>=<scope>` and
 * `docker ps` filters by it, so "every managed container" (the Coordinator's recovery, the watchdog's sweeps) means
 * this stack's containers only. Undefined when no docker CLI is found (the Docker variants are skipped then).
 */
export async function scopedDockerBin(dir: string, scope: string): Promise<string | undefined> {
	const found = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8", timeout: 10_000 });
	const docker = String(found.stdout ?? "").trim();
	if (found.status !== 0 || !docker.startsWith("/") || `${docker}${dir}`.includes("'")) return undefined;
	await mkdir(dir, { recursive: true });
	const bin = join(dir, "docker-scoped");
	const label = `${SCOPE_LABEL}=${scope}`;
	const script = [
		"#!/bin/sh",
		'case "$1" in',
		`run) shift; exec '${docker}' run --label '${label}' "$@" ;;`,
		`ps) shift; exec '${docker}' ps --filter 'label=${label}' "$@" ;;`,
		`*) exec '${docker}' "$@" ;;`,
		"esac",
		"",
	].join("\n");
	await writeFile(bin, script, { mode: 0o700 });
	return bin;
}

function stackConfig(dir: string, urls: { bot: string; github: string; model: string }, env: StackOptions["env"]) {
	return parseCoordinatorConfig(
		{
			TELEGRAM_BOT_TOKEN: `123456789:${"e".repeat(35)}`,
			TELEGRAM_BOT_USERNAME: BOT_USERNAME,
			TELEGRAM_API_ROOT: urls.bot,
			TELEGRAM_GROUP_CHAT_ID: String(GROUP),
			TELEGRAM_OWNER_ID: String(OWNER),
			PI_AGENTS: "alpha,beta",
			PI_MODEL: "gpt-4.1-mini",
			PI_THINKING: "off",
			OPENAI_BASE_URL: urls.model,
			OPENAI_API_KEY: "sk-e2e-upstream-not-real",
			// The relay reserves 48K input + 16K output = 64K per request; leave room for many requests.
			PROJECT_TOKEN_CEILING: "50000000",
			GITHUB_TOKEN,
			GITHUB_REPO: REPO,
			GITHUB_API_URL: urls.github,
			PI_DATA_DIR: join(dir, "data"),
			PI_TASK_DIR: join(dir, "tasks"),
			// The same Pi process mode on every platform (the default is systemd on Linux); runner: "systemd" overrides it.
			PI_RUNNER_ISOLATION: "process",
			...env,
		},
		{ cwd: dir, home: dir, uid: 1000, gid: 1000 },
	);
}

export type Stack = Awaited<ReturnType<typeof startStack>>;

/** `{ [key]: value }`, or nothing when the value is undefined (an optional dependency). */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/**
 * CONTAINER_USER, and the scoped DOCKER_BIN unless the test brings its own, for the Docker variants. Never the plain
 * docker CLI: without the scope, recovery and the watchdog would remove every managed container on the daemon.
 */
async function dockerVariantEnv(options: StackOptions, dir: string): Promise<Record<string, string>> {
	if (options.sandbox !== "docker") return {};
	const env: Record<string, string> = { CONTAINER_USER: hostUser() };
	if (options.env?.DOCKER_BIN !== undefined) return env;
	const scoped = await scopedDockerBin(join(dir, "bin"), `stack-${randomBytes(6).toString("hex")}`);
	if (scoped === undefined)
		throw new Error("cannot scope the docker CLI for this stack (not found, or a quote in a path)");
	return { ...env, DOCKER_BIN: scoped };
}

export type InProcessWatchdog = {
	start(): void;
	stop(): Promise<void>;
	readonly running: boolean;
	/** Starts a pass now and resolves when it is complete (at once when it is stopped). */
	nextLoop(): Promise<void>;
};

/**
 * The real watchdog core in this process: this deployment's marked Pi processes, and the local sandbox's containers
 * (or, for the Docker variants, the stack's labelled containers through its DOCKER_BIN).
 */
function inProcessWatchdog(
	config: CoordinatorConfig,
	localSandbox: Sandbox | undefined,
	context: { readonly log: Logger; readonly limits: Limits; readonly options: StackOptions },
): InProcessWatchdog {
	const containers: Reaper =
		localSandbox === undefined ? dockerContainerReaper({ bin: config.docker.bin }) : sandboxReaper(localSandbox);
	const grace = context.options.watchdogDeadlineGraceMs;
	let current: Watchdog | undefined;
	return {
		start(): void {
			current ??= startTestWatchdog({
				dataDir: config.paths.dataDir,
				chatId: config.telegram.groupChatId,
				containers,
				log: context.log,
				runDeadlineMs: context.options.watchdogRunDeadlineMs ?? context.limits.runDeadlineMs,
				...(grace === undefined ? {} : { deadlineGraceMs: grace }),
			});
		},
		async stop(): Promise<void> {
			const running = current;
			current = undefined;
			await running?.stop();
		},
		get running(): boolean {
			return current !== undefined;
		},
		nextLoop: (): Promise<void> => current?.nextLoop() ?? Promise.resolve(),
	};
}

/** deps.launcher for the chosen runner mode (none for "config": the Coordinator builds it from the config). */
function stackLauncher(
	runner: StackOptions["runner"],
	config: CoordinatorConfig,
	log: Logger,
): { launcher?: RunLauncher } {
	const testEnv = { PI_RUNNER_TEST_FAST_RETRY: "1" };
	if (runner === "config") return {};
	if (runner !== "systemd") return { launcher: createRunLauncher({ dataDir: config.paths.dataDir, log, testEnv }) };
	return {
		launcher: createSystemdRunLauncher({
			dataDir: config.paths.dataDir,
			log,
			user: config.runner.user,
			group: config.runner.group,
			slice: config.runner.slice,
			systemdRun: config.runner.systemdRunBin,
			systemctl: config.runner.systemctlBin,
			// TEST ONLY: the stand-ins play systemd on this host and hide no home directory; the Pi user and group are
			// resolved as if the host setup had created them.
			platform: "linux",
			protectedHomes: [],
			accounts: testAccounts(config.paths.dataDir, { user: config.runner.user, group: config.runner.group }),
			testEnv,
		}),
	};
}

export type { SystemdShims };

export async function startStack(options: StackOptions = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-e2e-"));
	const bot = new FakeBotApi();
	bot.username = BOT_USERNAME;
	bot.nextUpdateId = 1000;
	const origin = await createOriginRepo(join(dir, "origin"), { ...(options.files ?? PROJECT_FILES) });
	const github = new FakeGitHub({ bareRepo: origin.bare, repo: REPO, token: GITHUB_TOKEN });
	const model = new FakeModel();
	if (options.model !== undefined) model.script(options.model);
	const urls = { bot: await bot.start(), github: await github.start(), model: await model.start() };
	const containerUser = await dockerVariantEnv(options, dir);
	const shims = options.runner === "systemd" ? await createSystemdShims(join(dir, "systemd")) : undefined;
	const systemdEnv: Record<string, string> =
		shims === undefined
			? {}
			: { PI_RUNNER_ISOLATION: "systemd", SYSTEMD_RUN_BIN: shims.systemdRun, SYSTEMCTL_BIN: shims.systemctl };
	const config: CoordinatorConfig = stackConfig(dir, urls, { ...containerUser, ...systemdEnv, ...options.env });
	if (shims !== undefined) await prepareSystemdLayout(config.paths.dataDir);
	const log = stackLogger();
	const limits: Limits = { ...DEMO_LIMITS, ...options.limits };
	const local = (): Sandbox => {
		const created = createLocalSandbox({
			taskDir: config.paths.taskDir,
			checks: { test: nodeTestCheck, ...options.checks },
		});
		return options.wrap?.sandbox?.(created) ?? created;
	};
	const localSandbox = options.sandbox === "docker" ? undefined : local();
	const watchdog = inProcessWatchdog(config, localSandbox, { log, limits, options });
	const wrapGit = options.wrap?.git;
	const wrappedGit =
		wrapGit === undefined
			? {}
			: {
					git: wrapGit(
						createGit({
							taskDir: config.paths.taskDir,
							remoteUrl: origin.bare,
							baseBranch: config.github.baseBranch,
							token: config.github.token,
							author: { name: config.git.authorName, email: config.git.authorEmail },
							log,
						}),
					),
				};
	const deps = {
		remoteUrl: origin.bare,
		...optional("sandbox", localSandbox),
		...wrappedGit,
		...stackLauncher(options.runner, config, log),
		limits,
		log,
		// Test-only: a 1 s long poll (30 s in production) so stop() and restart() are quick.
		pollTimeoutSeconds: 1,
		// Test-only: 50 ms base delay between GitHub/push retries (1 s in production).
		retryDelayMs: 50,
		// Test-only: a task held because its branch changed on GitHub is looked at every second (30 s in production).
		branchRecheckMs: 1000,
		...optional("onFatal", options.onFatal),
		...optional("watchdog", options.watchdogTimings),
	};
	const stopFakes = async (): Promise<void> => {
		await watchdog.stop();
		await Promise.allSettled([model.stop(), github.stop(), bot.stop()]);
		await rm(dir, { recursive: true, force: true });
	};
	// The watchdog runs before the Coordinator (as its unit does): recovery waits for its verified sweep.
	if (options.watchdog !== "none") watchdog.start();
	let coordinator: Coordinator | undefined;
	try {
		coordinator = await startCoordinator(config, deps);
	} catch (error) {
		await stopFakes();
		throw error;
	}
	let nextMessageId = 10_000;

	const current = (): Coordinator => {
		if (coordinator === undefined) throw new Error("the Coordinator is stopped");
		return coordinator;
	};
	const matches = (match: BotMatch, message: ServerMessage): boolean =>
		typeof match === "function" ? match(message) : match.test(message.text);
	const botMessages = (): ServerMessage[] => bot.sent().filter((message) => message.chatId === GROUP);

	/** Queue a group message from `userId` (a fresh update id and message id); returns the message id. */
	const send = (userId: number, text: string, replyTo?: number): number => {
		const messageId = nextMessageId++;
		bot.groupMessage({
			chatId: GROUP,
			fromId: userId,
			text,
			messageId,
			...(replyTo === undefined ? {} : { replyTo: { messageId: replyTo, text: "bot message" } }),
		});
		return messageId;
	};

	const git = async (args: string[], okCodes: number[] = [0]) =>
		(await originGit(origin.bare, args, { okCodes })).stdout.trim();

	return {
		dir,
		bot,
		github,
		model,
		config,
		origin,
		/** The systemd-run / systemctl stand-ins (runner: "systemd" only). */
		shims,
		/** The in-process watchdog (stop it to see the Coordinator fail closed; start it again). */
		watchdog,
		get coordinator(): Coordinator {
			return current();
		},
		/** "/name@bot args" as a privacy-mode group delivers it; returns the command's message id. */
		sendCommand(userId: number, text: string): number {
			const withBot = text.replace(/^\/([A-Za-z_]+)(?=\s|$)/, `/$1@${BOT_USERNAME}`);
			return send(userId, withBot);
		},
		/** A group message exactly as given (e.g. a plain "/task" without @bot); returns its message id. */
		sendMessage(userId: number, text: string): number {
			return send(userId, text);
		},
		/** A reply to the bot's message `toMessageId`; returns the reply's message id. */
		reply(userId: number, toMessageId: number, text: string): number {
			return send(userId, text, toMessageId);
		},
		/** The first bot message in the group (sent after message id `since`) matching `match`. */
		async waitForBotMessage(
			match: BotMatch,
			options: { since?: number; timeoutMs?: number } = {},
		): Promise<ServerMessage> {
			const since = options.since ?? 0;
			const deadline = Date.now() + (options.timeoutMs ?? 60_000);
			for (;;) {
				const found = botMessages().find((message) => message.id > since && matches(match, message));
				if (found !== undefined) return found;
				if (Date.now() > deadline) {
					const sent = botMessages().map((message) => `  #${message.id} ${message.text.slice(0, 200)}`);
					throw new Error(`Timed out waiting for a bot message ${String(match)}; sent:\n${sent.join("\n")}`);
				}
				await sleep(20);
			}
		},
		/** The last `count` bot messages in the group, oldest first. */
		lastBotMessages(count = 10): ServerMessage[] {
			return botMessages().slice(-count);
		},
		/** Highest bot message id so far (use as `since`). */
		lastBotMessageId(): number {
			return botMessages().at(-1)?.id ?? 0;
		},
		tasks<T = Row>(): T[] {
			return current().store.all<T>("SELECT * FROM tasks ORDER BY id");
		},
		runs<T = Row>(): T[] {
			return current().store.all<T>("SELECT * FROM runs ORDER BY id");
		},
		followups<T = Row>(): T[] {
			return current().store.all<T>("SELECT * FROM followups ORDER BY id");
		},
		/** Directories under <taskDir>/worktrees. */
		async worktrees(): Promise<string[]> {
			const root = join(config.paths.taskDir, "worktrees");
			if (!existsSync(root)) return [];
			return (await readdir(root)).sort();
		},
		/** Origin branches (short names), sorted. */
		async branches(): Promise<string[]> {
			const out = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
			return out === "" ? [] : out.split("\n").sort();
		},
		async branchSha(branch: string): Promise<string | undefined> {
			const out = await git(["rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`], [0, 1]);
			return out === "" ? undefined : out;
		},
		async mainSha(): Promise<string> {
			return git(["rev-parse", "refs/heads/main"]);
		},
		/** Parents of a commit on origin. */
		async parents(sha: string): Promise<string[]> {
			return (await git(["rev-list", "--parents", "-n", "1", sha])).split(" ").slice(1);
		},
		async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
			const result = await originGit(origin.bare, ["merge-base", "--is-ancestor", ancestor, descendant], {
				okCodes: [0, 1],
			});
			return result.code === 0;
		},
		/** A file's content at origin's main, or undefined if it does not exist there. */
		async fileAtMain(path: string): Promise<string | undefined> {
			const result = await originGit(origin.bare, ["show", `refs/heads/main:${path}`], { okCodes: [0, 128] });
			return result.code === 0 ? result.stdout : undefined;
		},
		/** Stop the Coordinator and start a new one on the same directories (same fakes). */
		async restart(): Promise<void> {
			await coordinator?.stop();
			coordinator = undefined;
			coordinator = await startCoordinator(config, deps);
		},
		async stop(): Promise<void> {
			try {
				await coordinator?.stop();
			} finally {
				coordinator = undefined;
				await stopFakes();
			}
		},
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Scripted agents for the fake model

export type AgentPlan = {
	/** Chooses the plan by the newest user message (the run's input). */
	readonly when: RegExp;
	/**
	 * Steps by the number of tool results that followed that message: step k answers after k tool rounds. A promise
	 * holds the model's answer until it resolves (e.g. until a follow-up reached Pi).
	 */
	readonly steps: readonly (FakeStep | Promise<FakeStep>)[];
};

// biome-ignore lint/suspicious/noExplicitAny: raw Responses input items
function inputItems(body: any): any[] {
	return Array.isArray(body?.input) ? body.input : [];
}

function itemText(item: { content?: unknown }): string {
	const content = item.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

/** The newest user message of a model request and how many tool rounds have answered since. */
export function agentPosition(request: { readonly body: unknown }): { input: string; round: number } {
	const items = inputItems(request.body);
	let last = -1;
	items.forEach((item, index) => {
		if (item?.role === "user" && item?.type !== "function_call_output") last = index;
	});
	const input = last < 0 ? "" : itemText(items[last]);
	const round = items.slice(last + 1).filter((item) => item?.type === "function_call_output").length;
	return { input, round };
}

/** A model that follows the plan matching the run's input, one step per tool round. */
export function scriptedAgent(plans: readonly AgentPlan[]): FakeHandler {
	return (request) => {
		const { input, round } = agentPosition(request);
		const plan = plans.find((candidate) => candidate.when.test(input));
		if (plan === undefined) return { text: "I have no plan for this input." };
		return plan.steps[round] ?? plan.steps.at(-1) ?? { text: "done" };
	};
}
