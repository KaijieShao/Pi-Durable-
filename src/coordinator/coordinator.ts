/**
 * Coordinator wiring (Architecture § Components; Interfaces and Storage § Recovery After a Restart; Deployment §
 * Processes). One process: Telegram poller → command handler (one transaction per update) → engine (dispatch, runs,
 * review, merge, cancel) ↔ relay (127.0.0.1) and the outbox sender. Startup order:
 *
 *   private dirs → data-dir lock → Store → getMe (username must match; log can_read_all_group_messages) →
 *   sandbox.available() + launcher.available() (fail closed: no execution starts, logged and posted once) →
 *   git.ensureRepo + fetchBase → recovery (steps 1–3; step 2 waits for the watchdog's verified sweep, see
 *   engine/watchdog.ts) → relay (step 4) → outbox → poller → engine ticks (step 5: dispatch only once the watchdog
 *   verified this Coordinator's sweep and while its heartbeat is fresh).
 *
 * The owner socket (owner/socket.ts, <PI_DATA_DIR>/owner/owner.sock) listens from right after the Store opened: status
 * and the read-only commands answer during startup too; unfreeze waits until the engine runs.
 *
 * Secrets stay in `config` (memory only) and go only to the relay (model key), git/GitHub (GitHub token) and the
 * Telegram client (bot token); each Pi process gets only its run key. Production defaults: Docker sandbox, Pi
 * processes as transient systemd units in the Pi slice as the Pi user on Linux (PI_RUNNER_ISOLATION=systemd; the
 * weaker local "process" mode elsewhere), real git and GitHub, real Telegram, DEMO_LIMITS, the Docker evaluator (used only
 * after `owner seal`); the local test sandbox and the local test evaluator are only ever passed in by tests.
 */
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireDataDirLock, type DataDirLock } from "../runtime/lock.ts";
import { createLogger, errorSummary, type Logger } from "../runtime/log.ts";
import { ensurePrivateDir, makePrivate } from "../runtime/private-dir.ts";
import { handleUpdate } from "./commands.ts";
import { ConfigError, type CoordinatorConfig, describeConfig } from "./config.ts";
import type { DiskProbe } from "./disk.ts";
import { createEngine, type Enforcement, type Engine, enforcementAvailable } from "./engine.ts";
import { createGit, type Git } from "./git.ts";
import { createGitHub } from "./github.ts";
import { DEMO_LIMITS, type Limits } from "./limits.ts";
import { type OutboxSender, startOutbox } from "./outbox.ts";
import { removeScratchCopies } from "./owner/inspect.ts";
import { ownerService } from "./owner/service.ts";
import { type OwnerSocket, startOwnerSocket } from "./owner/socket.ts";
import type { Evaluator, GitHubApi, RunLauncher, Sandbox, TelegramApi, WatchdogLink } from "./ports.ts";
import { startRelay } from "./relay.ts";
import { createRunLauncher } from "./runner-launcher.ts";
import { createSystemdRunLauncher } from "./runner-systemd.ts";
import { createDockerSandbox } from "./sandbox/docker.ts";
import { createDockerEvaluator } from "./sandbox/evaluator.ts";
import { shareState } from "./state-share.ts";
import { Store } from "./store.ts";
import { createTelegramApi } from "./telegram/api.ts";
import { type Poller, startPoller } from "./telegram/poller.ts";
import {
	createStoreWatchdogLink,
	WATCHDOG_ANSWER_TIMEOUT_MS,
	WATCHDOG_HEARTBEAT_MAX_AGE_MS,
	type WatchdogTimings,
} from "./watchdog-link.ts";

export type CoordinatorDeps = {
	readonly telegram?: TelegramApi;
	readonly github?: GitHubApi;
	readonly git?: Git;
	readonly sandbox?: Sandbox;
	/**
	 * Tests only: the isolated evaluator (a local test evaluator, sandbox/local.ts). Production always builds the Docker
	 * evaluator from the config (EVALUATOR_IMAGE, CONTAINER_USER, DOCKER_BIN); there is no setting for another one.
	 */
	readonly evaluator?: Evaluator;
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
	/** Tests: how often a task held because its branch changed on GitHub is looked at again (30 s in production). */
	readonly branchRecheckMs?: number;
	/**
	 * Tests only: how the boot disk and the task disk are measured (a full or unreadable disk without filling one).
	 * Production always measures the real filesystems (disk.ts systemDiskProbe); there is no setting for it.
	 */
	readonly diskProbe?: DiskProbe;
	/** Tests: how often a task disk too full for a new worktree is measured again (30 s in production). */
	readonly diskRecheckMs?: number;
	/**
	 * Called when the Coordinator can no longer do its job and must not keep running half-alive, e.g. the poller hit
	 * a 401 from getUpdates (token revoked) or crashed: command intake has stopped. The CLI stops the Coordinator
	 * and exits non-zero so systemd (or the operator) sees it (Requirements § Availability: restarts automatically).
	 */
	readonly onFatal?: (reason: string, error: unknown) => void;
	/**
	 * Tests only: a shorter wait for the watchdog's answer (30 s in production) or heartbeat age (15 s), or another
	 * link. Production always talks to the watchdog through the Coordinator's SQLite file (watchdog-link.ts).
	 */
	readonly watchdog?: Partial<WatchdogTimings> & { readonly link?: WatchdogLink };
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
	owner?: OwnerSocket;
	store?: Store;
	engine?: Engine;
	/** The engine once it runs (the owner socket's unfreeze waits for it). */
	running?: Engine;
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

/**
 * The data dirs and the task dir; with PI_REQUIRE_TASK_MOUNT nothing is written unless the task disk is mounted.
 * "process" isolation: everything private to the Coordinator's user (mode 700). "systemd" isolation: the Pi user
 * reaches the data dir through the shared group (mode 0710: traverse only), and `conversations/` (2770, shared group)
 * and `run-home/` (the Pi user's) come from the one-time host setup; the launcher's availability check verifies
 * them (docs/isolation.md).
 */
async function prepareDirs(config: CoordinatorConfig, isolation: RunLauncher["isolation"]): Promise<void> {
	const { dataDir, taskDir } = config.paths;
	if (config.paths.requireTaskMount) await requireMountPoint(taskDir);
	if (isolation === "systemd") {
		await mkdir(dataDir, { recursive: true, mode: 0o710 });
		await chmod(dataDir, 0o710);
	} else {
		await ensurePrivateDir(dataDir);
		await ensurePrivateDir(join(dataDir, "conversations"));
		await ensurePrivateDir(join(dataDir, "run-home"));
	}
	await mkdir(taskDir, { recursive: true, mode: 0o750 });
}

/** The Pi process launcher of the configured isolation (deps.launcher in tests). */
function createLauncher(config: CoordinatorConfig, log: Logger): RunLauncher {
	const { runner } = config;
	if (runner.isolation === "process") {
		if (process.platform === "linux") log.warn("runner_isolation_weak", { isolation: "process" });
		return createRunLauncher({ dataDir: config.paths.dataDir, log });
	}
	return createSystemdRunLauncher({
		dataDir: config.paths.dataDir,
		log,
		user: runner.user,
		group: runner.group,
		slice: runner.slice,
		systemdRun: runner.systemdRunBin,
		systemctl: runner.systemctlBin,
	});
}

const ENFORCEMENT_NOTICE: Readonly<Record<Exclude<Enforcement, { ok: true }>["kind"], string>> = {
	containers:
		"Task execution is paused: container enforcement is unavailable, so no run starts. Commands are still saved and queued.",
	isolation:
		"Task execution is paused: Pi process isolation is unavailable, so no run starts. Commands are still saved and queued.",
};

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

/**
 * Fails closed: without enforcement (containers, Pi process isolation) the engine dispatches nothing; the group is
 * told once per outage.
 */
async function checkSandbox(
	{ config, deps, log, limits }: Setup,
	store: Store,
	now: () => number,
	launcher: RunLauncher,
): Promise<Sandbox> {
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
	const available = await enforcementAvailable(sandbox, launcher, log);
	if (available.ok) {
		store.tx(() => store.run("DELETE FROM meta WHERE key = ?", ENFORCEMENT_NOTICE_KEY));
		return sandbox;
	}
	store.tx(() => {
		if (store.getMeta(ENFORCEMENT_NOTICE_KEY) !== undefined) return;
		store.setMeta(ENFORCEMENT_NOTICE_KEY, String(now()));
		store.enqueue({
			chatId: config.telegram.groupChatId,
			priority: "required",
			kind: "enforcement_unavailable",
			text: ENFORCEMENT_NOTICE[available.kind],
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
		onCapReached: (runId) => engine.onCapReached(runId),
		log,
		port: config.relay.port,
		...fetchOption(deps),
	});
}

function startPollerFor(setup: Setup, store: Store, telegram: TelegramApi, engine: Engine, outbox: OutboxSender) {
	const { config, deps, log, limits } = setup;
	const commandContext = {
		config,
		limits,
		log,
		...(deps.diskProbe === undefined ? {} : { diskProbe: deps.diskProbe }),
	};
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
		onFatal: (error) => {
			log.error("telegram_poller_fatal", { error: errorSummary(error) });
			deps.onFatal?.("telegram_poller_fatal", error);
		},
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
	await step("owner_socket", () => parts.owner?.close());
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
async function boot(setup: Setup, parts: Parts, store: Store, now: () => number, launcher: RunLauncher) {
	const { config, deps, log, limits } = setup;
	const telegram = await checkBot(setup);
	const sandbox = await checkSandbox(setup, store, now, launcher);
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
	let outboxKick: () => void = () => {};
	const evaluator =
		deps.evaluator ??
		createDockerEvaluator({
			bin: config.docker.bin,
			image: config.evaluation.image,
			user: config.docker.user,
			limits,
			log,
		});
	const engine = createEngine({
		store,
		config,
		limits,
		git,
		github,
		sandbox,
		launcher,
		evaluator,
		log,
		now,
		onOutbox: () => outboxKick(),
		...(deps.retryDelayMs === undefined ? {} : { retryDelayMs: deps.retryDelayMs }),
		...(deps.branchRecheckMs === undefined ? {} : { branchRecheckMs: deps.branchRecheckMs }),
		...(deps.diskProbe === undefined ? {} : { diskProbe: deps.diskProbe }),
		...(deps.diskRecheckMs === undefined ? {} : { diskRecheckMs: deps.diskRecheckMs }),
		watchdog: {
			link: deps.watchdog?.link ?? createStoreWatchdogLink(store),
			answerTimeoutMs: deps.watchdog?.answerTimeoutMs ?? WATCHDOG_ANSWER_TIMEOUT_MS,
			heartbeatMaxAgeMs: deps.watchdog?.heartbeatMaxAgeMs ?? WATCHDOG_HEARTBEAT_MAX_AGE_MS,
		},
	});
	parts.engine = engine;
	// Recovery steps 1–3 before the relay (step 4), polling or dispatch (step 5). Step 2 waits for the watchdog.
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
	parts.running = engine;
	log.info("coordinator_started", { relay_port: new URL(relay.url).port });
	return { engine, relay, outbox, poller };
}

export async function startCoordinator(config: CoordinatorConfig, deps: CoordinatorDeps = {}): Promise<Coordinator> {
	const log = deps.log ?? createLogger({ level: config.logLevel });
	const setup: Setup = { config, deps, log, limits: deps.limits ?? DEMO_LIMITS };
	const now = deps.now ?? Date.now;
	const launcher = deps.launcher ?? createLauncher(config, log);
	await prepareDirs(config, launcher.isolation);
	const lock: DataDirLock = acquireDataDirLock(config.paths.dataDir);
	const parts: Parts = {};
	try {
		const database = join(config.paths.dataDir, "coordinator.sqlite");
		// Owner only, whatever the data dir's mode (the Pi group may traverse it under systemd isolation): created 0600
		// before SQLite opens it (its -wal and -shm files take the database's mode), and tightened if it existed.
		closeSync(openSync(database, "a", 0o600));
		const store = new Store(database, now);
		parts.store = store;
		await makePrivate([database, `${database}-wal`, `${database}-shm`]);
		// PI_STATE_GROUP: the watchdog, as its own user, shares the database and reads the lock (state-share.ts).
		const { stateGroup } = config.paths;
		if (stateGroup !== undefined) {
			await shareState(
				config.paths.dataDir,
				stateGroup,
				launcher.isolation === "systemd" ? config.runner.user : undefined,
			);
		}
		log.info("coordinator_starting", { ...describeConfig(config), isolation: launcher.isolation });
		parts.owner = await startOwnerSocket({
			dataDir: config.paths.dataDir,
			log,
			handle: ownerService({ store, config, log, engine: () => parts.running, startedAt: now() }),
		});
		await removeScratchCopies(parts.owner.paths.dir);
		const { engine, relay, outbox, poller } = await boot(setup, parts, store, now, launcher);
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
