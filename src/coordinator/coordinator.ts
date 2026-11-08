/**
 * Coordinator wiring (Architecture § Components; Interfaces and Storage § Recovery After a Restart; Deployment §
 * Processes). One process: Telegram poller → command handler (one transaction per update) → engine (dispatch, runs,
 * review, merge, cancel) ↔ relay (127.0.0.1) and the outbox sender. Startup order:
 *
 *   private dirs → data-dir lock → Store → getMe (username must match; log can_read_all_group_messages) →
 *   sandbox.available() (fail closed: no execution starts, logged and posted once) → git.ensureRepo + fetchBase →
 *   recovery (steps 1–3) → relay (step 4) → outbox → poller → engine ticks (step 5: dispatch).
 *
 * Secrets stay in `config` (memory only) and go only to the relay (model key), git/GitHub (GitHub token) and the
 * Telegram client (bot token). Production defaults: Docker sandbox, real git and GitHub, real Telegram,
 * DEMO_LIMITS; the local test sandbox is only ever passed in by tests.
 */
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireDataDirLock, type DataDirLock } from "../runtime/lock.ts";
import { createLogger, errorSummary, type Logger } from "../runtime/log.ts";
import { ensurePrivateDir } from "../runtime/private-dir.ts";
import { handleUpdate } from "./commands.ts";
import { ConfigError, type CoordinatorConfig, describeConfig } from "./config.ts";
import { createEngine, type Engine } from "./engine.ts";
import { createGit, type Git } from "./git.ts";
import { createGitHub } from "./github.ts";
import { DEMO_LIMITS, type Limits } from "./limits.ts";
import { type OutboxSender, startOutbox } from "./outbox.ts";
import type { GitHubApi, RunLauncher, Sandbox, TelegramApi } from "./ports.ts";
import { startRelay } from "./relay.ts";
import { createRunLauncher } from "./runner-launcher.ts";
import { createDockerSandbox } from "./sandbox/docker.ts";
import { Store } from "./store.ts";
import { createTelegramApi } from "./telegram/api.ts";
import { type Poller, startPoller } from "./telegram/poller.ts";

export type CoordinatorDeps = {
	readonly telegram?: TelegramApi;
	readonly github?: GitHubApi;
	readonly git?: Git;
	readonly sandbox?: Sandbox;
	readonly launcher?: RunLauncher;
	/** Tests only: shorter deadlines, smaller caps. Production always uses DEMO_LIMITS. */
	readonly limits?: Limits;
	readonly now?: () => number;
	readonly log?: Logger;
	/** Remote the git module fetches from / pushes to; default config.github.remoteUrl (tests: a local bare repo). */
	readonly remoteUrl?: string;
	/** fetch for the Telegram, GitHub and relay upstream clients (tests: 127.0.0.1 fakes). */
	readonly fetch?: typeof fetch;
	/** Tests: poller long-poll timeout in seconds (30 in production). */
	readonly pollTimeoutSeconds?: number;
	/** Tests: base delay between GitHub/push retries (1 s in production). */
	readonly retryDelayMs?: number;
};

export type Coordinator = {
	readonly store: Store;
	readonly engine: Engine;
	/** http://127.0.0.1:P/v1 */
	readonly relayUrl: string;
	/** Stop polling and dispatch, abort live runs (recovery marks them interrupted next start), close everything. */
	stop(): Promise<void>;
	/** Resolves when the poller, the engine and the outbox are all idle (tests). */
	idle(): Promise<void>;
};

const ENFORCEMENT_NOTICE_KEY = "enforcement_unavailable_noticed";

/** Refuse to start unless `taskDir` is a mount point (Deployment § Disk and Data: task disk missing → no start). */
async function requireMountPoint(taskDir: string): Promise<void> {
	let mounted: boolean;
	try {
		mounted = (await stat(taskDir)).dev !== (await stat(dirname(taskDir))).dev;
	} catch {
		throw new ConfigError([{ variable: "PI_TASK_DIR", message: "the task disk is not mounted (directory missing)" }]);
	}
	if (!mounted)
		throw new ConfigError([{ variable: "PI_TASK_DIR", message: "is not a mount point (PI_REQUIRE_TASK_MOUNT=1)" }]);
}

type Parts = {
	store?: Store;
	engine?: Engine;
	relay?: { close(): Promise<void> };
	outbox?: { stop(): Promise<void> };
	poller?: { stop(): Promise<void> };
};

type Setup = {
	readonly config: CoordinatorConfig;
	readonly deps: CoordinatorDeps;
	readonly log: Logger;
	readonly limits: Limits;
};

function fetchOption(deps: CoordinatorDeps): { fetch?: typeof fetch } {
	return deps.fetch === undefined ? {} : { fetch: deps.fetch };
}

/** Private data dirs and the task dir; with PI_REQUIRE_TASK_MOUNT nothing is written unless the task disk is mounted. */
async function prepareDirs(config: CoordinatorConfig): Promise<void> {
	const { dataDir, taskDir } = config.paths;
	if (config.paths.requireTaskMount) await requireMountPoint(taskDir);
	await ensurePrivateDir(dataDir);
	await ensurePrivateDir(join(dataDir, "conversations"));
	await ensurePrivateDir(join(dataDir, "run-home"));
	await mkdir(taskDir, { recursive: true, mode: 0o750 });
}

/** getMe: the token must belong to the configured bot; log whether privacy mode hides plain group messages. */
async function checkBot({ config, deps, log }: Setup): Promise<TelegramApi> {
	const telegram =
		deps.telegram ??
		createTelegramApi({ token: config.telegram.botToken, apiRoot: config.telegram.apiRoot, ...fetchOption(deps) });
	const me = await telegram.getMe();
	if (me.username.toLowerCase() !== config.telegram.botUsername.toLowerCase()) {
		throw new ConfigError([
			{ variable: "TELEGRAM_BOT_USERNAME", message: "does not match the username Telegram reports for this token" },
		]);
	}
	log.info("telegram_bot", { username: me.username, can_read_all_group_messages: me.canReadAllGroupMessages });
	return telegram;
}

/** Fails closed: without enforcement the engine dispatches nothing; the group is told once per outage. */
async function checkSandbox({ config, deps, log, limits }: Setup, store: Store, now: () => number): Promise<Sandbox> {
	const sandbox =
		deps.sandbox ??
		createDockerSandbox({
			bin: config.docker.bin,
			agentImage: config.docker.agentImage,
			checkImage: config.docker.checkImage,
			user: config.docker.user,
			taskDir: config.paths.taskDir,
			limits,
			log,
			setupScript: config.setupScript,
		});
	const available = await sandbox
		.available()
		.catch((): { ok: false; reason: string } => ({ ok: false, reason: "sandbox check failed" }));
	if (available.ok) {
		store.tx(() => store.run("DELETE FROM meta WHERE key = ?", ENFORCEMENT_NOTICE_KEY));
		return sandbox;
	}
	log.error("sandbox_unavailable", { reason: available.reason });
	store.tx(() => {
		if (store.getMeta(ENFORCEMENT_NOTICE_KEY) !== undefined) return;
		store.setMeta(ENFORCEMENT_NOTICE_KEY, String(now()));
		store.enqueue({
			chatId: config.telegram.groupChatId,
			priority: "required",
			kind: "enforcement_unavailable",
			text: "Task execution is paused: container enforcement is unavailable, so no run starts. Commands are still saved and queued.",
		});
	});
	return sandbox;
}

/** The bare repository and the latest main (a fetch failure is not fatal: each first run fetches again). */
async function prepareGit({ config, deps, log }: Setup): Promise<Git> {
	const git =
		deps.git ??
		createGit({
			taskDir: config.paths.taskDir,
			remoteUrl: deps.remoteUrl ?? config.github.remoteUrl,
			baseBranch: config.github.baseBranch,
			token: config.github.token,
			author: { name: config.git.authorName, email: config.git.authorEmail },
			log,
		});
	await git.ensureRepo();
	await git.fetchBase().catch((error: unknown) => log.warn("fetch_base_failed", { error: errorSummary(error) }));
	return git;
}

function startRelayFor(setup: Setup, store: Store, engine: Engine) {
	const { config, deps, log, limits } = setup;
	return startRelay({
		store,
		limits,
		upstream: { baseUrl: config.model.upstreamBaseUrl, apiKey: config.model.openaiApiKey },
		codexGateway: config.model.codexGateway,
		projectTokenCeiling: config.model.projectTokenCeiling,
		onRunLimit: (runId, reason) => engine.onRunLimit(runId, reason),
		log,
		port: config.relay.port,
		...fetchOption(deps),
	});
}

function startPollerFor(setup: Setup, store: Store, telegram: TelegramApi, engine: Engine, outbox: OutboxSender) {
	const { config, deps, log, limits } = setup;
	const commandContext = { config, limits, log };
	return startPoller({
		store,
		api: telegram,
		log,
		...(deps.pollTimeoutSeconds === undefined ? {} : { timeoutSeconds: deps.pollTimeoutSeconds }),
		onUpdate: (update) => {
			// One transaction per update (commands.ts); then the engine reads the database.
			const result = handleUpdate(store, commandContext, update);
			outbox.kick();
			if (result.kick) engine.kick();
		},
		onFatal: (error) => log.error("telegram_poller_fatal", { error: errorSummary(error) }),
	});
}

/** Stop polling, stop dispatch and abort runs, close the relay, the outbox, the store, release the lock. */
async function shutdown(parts: Parts, lock: DataDirLock, log: Logger): Promise<void> {
	const step = async (name: string, work: () => Promise<void> | void): Promise<void> => {
		try {
			await work();
		} catch (error) {
			log.warn("coordinator_stop_step_failed", { step: name, error: errorSummary(error) });
		}
	};
	await step("poller", () => parts.poller?.stop());
	await step("engine", () => parts.engine?.stop());
	await step("relay", () => parts.relay?.close());
	await step("outbox", () => parts.outbox?.stop());
	await step("store", () => parts.store?.close());
	await step("lock", () => lock.release());
}

/** Poller, engine and outbox idle, nothing due in the outbox and no run in flight (tests). */
async function idleAll(store: Store, engine: Engine, outbox: OutboxSender, poller: Poller, now: () => number) {
	for (let round = 0; round < 50; round++) {
		await poller.idle();
		await engine.idle();
		await outbox.idle();
		const due = store.get<{ n: number }>(
			"SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending' AND next_attempt_at <= ?",
			now(),
		)?.n;
		if ((due ?? 0) === 0 && engine.activeRuns().length === 0) return;
	}
}

/** Everything after the lock and the store, in the startup order of the design. */
async function boot(setup: Setup, parts: Parts, store: Store, now: () => number) {
	const { config, deps, log, limits } = setup;
	const telegram = await checkBot(setup);
	const sandbox = await checkSandbox(setup, store, now);
	const git = await prepareGit(setup);
	const github =
		deps.github ??
		createGitHub({
			apiUrl: config.github.apiUrl,
			repo: config.github.repo,
			token: config.github.token,
			log,
			...fetchOption(deps),
		});
	const launcher = deps.launcher ?? createRunLauncher({ dataDir: config.paths.dataDir, log });
	let outboxKick: () => void = () => {};
	const engine = createEngine({
		store,
		config,
		limits,
		git,
		github,
		sandbox,
		launcher,
		log,
		now,
		onOutbox: () => outboxKick(),
		...(deps.retryDelayMs === undefined ? {} : { retryDelayMs: deps.retryDelayMs }),
	});
	parts.engine = engine;
	// Recovery steps 1–3 before the relay (step 4), polling or dispatch (step 5).
	await engine.recover();
	const relay = await startRelayFor(setup, store, engine);
	parts.relay = relay;
	engine.setRelayUrl(relay.url);
	const threadId = config.telegram.topicId === 1 ? undefined : config.telegram.topicId;
	const outbox = startOutbox({ store, api: telegram, threadId, log, now });
	outboxKick = () => outbox.kick();
	parts.outbox = outbox;
	outbox.kick();
	const poller = startPollerFor(setup, store, telegram, engine, outbox);
	parts.poller = poller;
	engine.start();
	log.info("coordinator_started", { relay_port: new URL(relay.url).port });
	return { engine, relay, outbox, poller };
}

export async function startCoordinator(config: CoordinatorConfig, deps: CoordinatorDeps = {}): Promise<Coordinator> {
	const log = deps.log ?? createLogger({ level: config.logLevel });
	const setup: Setup = { config, deps, log, limits: deps.limits ?? DEMO_LIMITS };
	const now = deps.now ?? Date.now;
	await prepareDirs(config);
	const lock: DataDirLock = acquireDataDirLock(config.paths.dataDir);
	const parts: Parts = {};
	try {
		const store = new Store(join(config.paths.dataDir, "coordinator.sqlite"), now);
		parts.store = store;
		log.info("coordinator_starting", describeConfig(config));
		const { engine, relay, outbox, poller } = await boot(setup, parts, store, now);
		let stopping: Promise<void> | undefined;
		return {
			store,
			engine,
			relayUrl: relay.url,
			stop(): Promise<void> {
				stopping ??= (async () => {
					log.info("coordinator_stopping");
					await shutdown(parts, lock, log);
					log.info("coordinator_stopped");
				})();
				return stopping;
			},
			idle: () => idleAll(store, engine, outbox, poller, now),
		};
	} catch (error) {
		await shutdown(parts, lock, log);
		throw error;
	}
}
