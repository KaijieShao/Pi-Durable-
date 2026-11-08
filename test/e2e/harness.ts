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
 *   Docker sandbox instead (opt-in, see dockerUnavailable()).
 *
 * Limits are DEMO_LIMITS unless a test overrides some (and says why). Debugging: E2E_LOG=1.
 */
import "../helpers/env.ts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CoordinatorConfig, parseCoordinatorConfig } from "../../src/coordinator/config.ts";
import { type Coordinator, startCoordinator } from "../../src/coordinator/coordinator.ts";
import { DEMO_LIMITS, type Limits } from "../../src/coordinator/limits.ts";
import { createRunLauncher } from "../../src/coordinator/runner-launcher.ts";
import { createLocalSandbox, type LocalCheck } from "../../src/coordinator/sandbox/local.ts";
import type { Row } from "../../src/coordinator/store.ts";
import { createLogger, type Logger, silentLogger } from "../../src/runtime/log.ts";
import { FakeBotApi, type ServerMessage } from "../fixtures/fake-bot-api.ts";
import { sleep } from "../helpers/env.ts";
import { createOriginRepo, FakeGitHub, originGit } from "../helpers/fake-github.ts";
import { type FakeHandler, FakeModel, type FakeStep } from "../helpers/fake-model.ts";

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
 * Why the Docker variant does not run, or false. Opt-in with E2E_DOCKER=1: the Coordinator's restart recovery kills
 * EVERY container labelled pi-durable.managed=1 on this Docker daemon (production behaviour on a dedicated VM), which
 * would also kill containers of other test runs sharing the daemon.
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
			...env,
		},
		{ cwd: dir, home: dir, uid: 1000, gid: 1000 },
	);
}

export type Stack = Awaited<ReturnType<typeof startStack>>;

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
	const containerUser: Record<string, string> = options.sandbox === "docker" ? { CONTAINER_USER: hostUser() } : {};
	const config: CoordinatorConfig = stackConfig(dir, urls, { ...containerUser, ...options.env });
	const log = stackLogger();
	const limits: Limits = { ...DEMO_LIMITS, ...options.limits };
	const sandbox =
		options.sandbox === "docker"
			? {}
			: {
					sandbox: createLocalSandbox({
						taskDir: config.paths.taskDir,
						checks: { test: nodeTestCheck, ...options.checks },
					}),
				};
	const deps = {
		remoteUrl: origin.bare,
		...sandbox,
		launcher: createRunLauncher({ dataDir: config.paths.dataDir, log, testEnv: { PI_RUNNER_TEST_FAST_RETRY: "1" } }),
		limits,
		log,
		// Test-only: a 1 s long poll (30 s in production) so stop() and restart() are quick.
		pollTimeoutSeconds: 1,
		// Test-only: 50 ms base delay between GitHub/push retries (1 s in production).
		retryDelayMs: 50,
	};
	const stopFakes = async (): Promise<void> => {
		await Promise.allSettled([model.stop(), github.stop(), bot.stop()]);
		await rm(dir, { recursive: true, force: true });
	};
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
