import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	COMMAND_NAME,
	ConfigError,
	type ConfigProblem,
	dataDirFrom,
	type Env,
	isolationFrom,
	isolationProblem,
	nonEmpty,
	readEnvFileOnly,
	SLICE_NAME,
} from "../config/shared.ts";

export { ConfigError, type ConfigProblem, type Env };

/**
 * Coordinator configuration, from the environment (and an optional env file loaded into it first).
 * Secrets (`botToken`, `openaiApiKey`, `githubToken`) live only in this object, in Coordinator memory: never log it;
 * use `describeConfig()` for a secret-free summary.
 */
export type CoordinatorConfig = {
	readonly telegram: {
		readonly botToken: string;
		/** Exact bot username without "@", e.g. smule_code_bot; checked against getMe at startup. */
		readonly botUsername: string;
		readonly apiRoot: string;
		/** The one configured group (negative chat id). Other chats are ignored. */
		readonly groupChatId: number;
		/** Forum topic id; 1 = General or a group without topics. */
		readonly topicId: number;
		/** The group's owner, by Telegram user id: may cancel, follow up and approve any task; runs the owner CLI. */
		readonly ownerId: number;
		/** Optional submitter allowlist; undefined = any member of the group may submit /task. */
		readonly memberIds: readonly number[] | undefined;
	};
	/** Agent ids configured for the group; unique (case-insensitive), lower-cased. */
	readonly agents: readonly string[];
	readonly model: {
		/** Always "openai": Pi talks to the relay's OpenAI-compatible endpoint. */
		readonly provider: "openai";
		readonly modelId: string;
		readonly thinkingLevel: ModelThinkingLevel;
		/** Upstream endpoint the relay forwards to (user's OPENAI_BASE_URL), without trailing slash. */
		readonly upstreamBaseUrl: string;
		/** Real model key: held by the relay only, never given to Pi or containers. */
		readonly openaiApiKey: string;
		/** OPENAI_CODEX_GATEWAY=1: Pi adapts payloads for a Codex-backed gateway (see src/agent/openai-relay.ts). */
		readonly codexGateway: boolean;
		/** Owner-set project token ceiling for the budget ledger. */
		readonly projectTokenCeiling: number;
	};
	readonly github: {
		readonly token: string;
		/** "owner/name". */
		readonly repo: string;
		readonly apiUrl: string;
		readonly baseBranch: string;
		/** Remote the Coordinator fetches from and pushes to (https://github.com/<repo>.git). */
		readonly remoteUrl: string;
	};
	readonly git: {
		readonly branchPrefix: string;
		readonly authorName: string;
		readonly authorEmail: string;
	};
	readonly paths: {
		/** Coordinator SQLite, Pi conversation stores (one SQLite per conversation), logs. Mode 700. */
		readonly dataDir: string;
		/** "Task disk": the git repository, one worktree per open task, check scratch space. */
		readonly taskDir: string;
		/** If set, refuse to start unless `taskDir` is a mount point (GCP task disk). */
		readonly requireTaskMount: boolean;
		/**
		 * PI_STATE_GROUP: a group (name or gid) the database and the lock file are shared with, read-write and read-only
		 * (0660 / 0640), so the watchdog can run as its own user (deploy/systemd/pi-durable-watchdog.service). Unset:
		 * both stay owner-only (the watchdog runs as the Coordinator's user, e.g. on a Mac).
		 */
		readonly stateGroup: string | undefined;
	};
	/**
	 * Disk limits (Capacity § Disk; src/coordinator/disk.ts). Undefined = the DEMO_LIMITS default (minFreeDiskBytes,
	 * worktreeHeadroomBytes); no budget = the task disk's own size is its budget (only the free-space floor applies).
	 */
	readonly disk: {
		/** PI_BOOT_DISK_MIN_FREE: new /task requests are rejected while PI_DATA_DIR's filesystem has less free. */
		readonly bootMinFreeBytes: number | undefined;
		/** PI_TASK_DISK_MIN_FREE: a new worktree is created only if at least this much stays free on the task disk. */
		readonly taskMinFreeBytes: number | undefined;
		/** PI_TASK_DISK_BUDGET: a new worktree is created only if the task disk's usage plus it stays within this. */
		readonly taskBudgetBytes: number | undefined;
		/** PI_WORKTREE_HEADROOM: room a new worktree is assumed to need beyond its checked-out files. */
		readonly worktreeHeadroomBytes: number | undefined;
	};
	readonly docker: {
		readonly bin: string;
		readonly agentImage: string;
		readonly checkImage: string;
		/** uid:gid the containers run as; never root. */
		readonly user: string;
	};
	/**
	 * The isolated evaluator (Architecture § Isolated evaluator; src/coordinator/engine/seal.ts), started only after the
	 * owner seals the group (`owner seal`).
	 */
	readonly evaluation: {
		/**
		 * PI_EVAL_HIDDEN_TESTS_DIR: the hidden tests on the host, mounted read-only in the evaluator container only (Agent
		 * Execution § Protected files: never in an agent or check container). Outside PI_DATA_DIR and PI_TASK_DIR (whose
		 * worktrees and scratch the agent and check containers mount). Unset: sealing is refused.
		 */
		readonly hiddenTestsDir: string | undefined;
		/** EVALUATOR_IMAGE: the trusted evaluator image (default pi-durable-evaluator:demo, scripts/build-images.sh). */
		readonly image: string;
	};
	readonly relay: {
		/** 127.0.0.1 port; 0 = ephemeral. */
		readonly port: number;
	};
	/** Pi processes (Deployment § Processes): how each run's process is isolated. */
	readonly runner: {
		/**
		 * "systemd" (default on Linux): a transient unit per run as `user`/`group` in `slice`, with a per-unit sandbox and
		 * IP filter. "process" (default elsewhere): a child process as the Coordinator's own user, the weaker local mode.
		 */
		readonly isolation: "systemd" | "process";
		/** The Pi user (never root, never the Coordinator's user). */
		readonly user: string;
		/** The group the Pi user shares with the Coordinator for the conversations directory. */
		readonly group: string;
		readonly slice: string;
		/** systemd-run and systemctl: absolute paths or names looked up on PATH. */
		readonly systemdRunBin: string;
		readonly systemctlBin: string;
	};
	/** Repository path (relative to the worktree root) of the checked-in setup script; run if present. */
	readonly setupScript: string;
	readonly logLevel: "debug" | "info" | "warn" | "error";
};

type Collector = { readonly problems: ConfigProblem[]; add(variable: string, message: string): void };

function collector(): Collector {
	return {
		problems: [],
		add(variable, message) {
			this.problems.push({ variable, message });
		},
	};
}

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** A POSIX user or group name (as systemd accepts it for User= / Group=). */
const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;
const BOT_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const AGENT_ID = /^[a-z][a-z0-9_-]{0,31}$/;

/** Load `envFile` into `env` (existing variables win), then parse. Throws `ConfigError`. */
export function loadCoordinatorConfig(options: { envFile?: string; env?: NodeJS.ProcessEnv } = {}): CoordinatorConfig {
	const env = options.env ?? process.env;
	if (options.envFile !== undefined) {
		try {
			if (env === process.env) process.loadEnvFile(options.envFile);
			else
				for (const [key, value] of Object.entries(parseEnv(readFileSync(options.envFile, "utf8")))) env[key] ??= value;
		} catch {
			throw new ConfigError([{ variable: "--env-file", message: `${options.envFile}: cannot be read` }]);
		}
	}
	return parseCoordinatorConfig(env);
}

/**
 * The owner CLI's own configuration (src/cli/owner.ts): only what it needs, never a secret (Deployment § Secrets: "The
 * secrets are held only in the Coordinator's memory"). Every command goes to the running Coordinator over its owner
 * socket, which holds the bot token, the model key and the GitHub token; the CLI reads none of them, not even from the
 * Coordinator's env file: as for the watchdog, its other lines are dropped before parsing (readEnvFileOnly).
 */
export type OwnerConfig = {
	/** TELEGRAM_GROUP_CHAT_ID: the group of `owner unfreeze` without an argument and of the read-only status. */
	readonly groupChatId: number;
	/** Non-secret routing identity for the offline status; live status uses the server's own configuration. */
	readonly topicId: number;
	readonly repository: string | undefined;
	/** PI_DATA_DIR (the owner socket, the database) and PI_TASK_DIR, resolved exactly as for the Coordinator. */
	readonly paths: { readonly dataDir: string; readonly taskDir: string };
	/** The disk settings the read-only status reports (PI_BOOT_DISK_MIN_FREE, ...), parsed as for the Coordinator. */
	readonly disk: CoordinatorConfig["disk"];
};

/** The only variables the owner CLI reads. */
export const OWNER_VARIABLES = [
	"PI_DATA_DIR",
	"PI_TASK_DIR",
	"TELEGRAM_GROUP_CHAT_ID",
	"TELEGRAM_GROUP_TOPIC_ID",
	"GITHUB_REPO",
	"PI_BOOT_DISK_MIN_FREE",
	"PI_TASK_DISK_MIN_FREE",
	"PI_TASK_DISK_BUDGET",
	"PI_WORKTREE_HEADROOM",
] as const;

/** Parse the owner CLI's variables (only those); throws ConfigError listing every problem, never a value. */
export function parseOwnerConfig(
	env: Env,
	defaults: { readonly cwd: string; readonly home: string } = { cwd: process.cwd(), home: homedir() },
): OwnerConfig {
	const out = collector();
	const dataDir = dataDirFrom(env.PI_DATA_DIR, defaults);
	const repository = nonEmpty(env.GITHUB_REPO);
	if (repository !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
		out.add("GITHUB_REPO", "must be owner/name");
	const config: OwnerConfig = {
		groupChatId: parseInteger(env, "TELEGRAM_GROUP_CHAT_ID", out, { negative: true, required: true }),
		topicId: parseInteger(env, "TELEGRAM_GROUP_TOPIC_ID", out, { fallback: 1 }),
		repository,
		paths: { dataDir, taskDir: taskDirFrom(env, dataDir, defaults.cwd) },
		disk: parseDisk(env, out),
	};
	if (out.problems.length > 0) throw new ConfigError(out.problems);
	return config;
}

/**
 * The owner CLI's variables from `env` (they win) and the optional env file: only OWNER_VARIABLES are taken from the
 * file; nothing is written to `env`.
 */
export function loadOwnerConfig(options: { readonly envFile?: string; readonly env?: Env } = {}): OwnerConfig {
	const env = options.env ?? process.env;
	const file = options.envFile === undefined ? {} : readEnvFileOnly(options.envFile, OWNER_VARIABLES);
	if (file === undefined)
		throw new ConfigError([{ variable: "--env-file", message: `${options.envFile}: cannot be read` }]);
	const picked: Record<string, string | undefined> = {};
	for (const name of OWNER_VARIABLES) picked[name] = env[name] ?? file[name];
	return parseOwnerConfig(picked);
}

type Defaults = {
	cwd: string;
	home: string;
	uid?: number;
	gid?: number;
	/** The platform the isolation default is chosen for (default process.platform). */
	platform?: NodeJS.Platform;
	/** The Coordinator's own user name (the Pi user must differ); default os.userInfo(). */
	username?: string;
};

export function parseCoordinatorConfig(
	env: Env,
	defaults: Defaults = { cwd: process.cwd(), home: homedir(), ...uidGid(), ...currentUser() },
): CoordinatorConfig {
	const out = collector();
	const telegram = parseTelegram(env, out);
	const agents = parseAgents(env, out);
	const model = parseModel(env, out);
	const github = parseGitHub(env, out);
	const local = parseLocal(env, out, defaults);
	const runner = parseRunner(env, out, defaults);
	const disk = parseDisk(env, out);
	if (out.problems.length > 0) throw new ConfigError(out.problems);
	return { telegram, agents, model, ...github, ...local, disk, runner };
}

function parseTelegram(env: Env, out: Collector): CoordinatorConfig["telegram"] {
	const botToken = required(env, "TELEGRAM_BOT_TOKEN", out, "from @BotFather");
	if (botToken !== "" && !BOT_TOKEN.test(botToken)) out.add("TELEGRAM_BOT_TOKEN", "does not look like a bot token");
	const botUsername = (nonEmpty(env.TELEGRAM_BOT_USERNAME) ?? "").replace(/^@/, "");
	if (!/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) out.add("TELEGRAM_BOT_USERNAME", "required: bot username without @");
	return {
		botToken,
		botUsername,
		apiRoot: parseUrl(env, "TELEGRAM_API_ROOT", "https://api.telegram.org", out),
		groupChatId: parseInteger(env, "TELEGRAM_GROUP_CHAT_ID", out, { negative: true, required: true }),
		topicId: parseInteger(env, "TELEGRAM_GROUP_TOPIC_ID", out, { fallback: 1 }),
		ownerId: parseInteger(env, "TELEGRAM_OWNER_ID", out, { required: true }),
		memberIds: parseIdList(env, "TELEGRAM_MEMBER_IDS", out),
	};
}

function parseModel(env: Env, out: Collector): CoordinatorConfig["model"] {
	const provider = nonEmpty(env.PI_PROVIDER) ?? "openai";
	if (provider !== "openai")
		out.add("PI_PROVIDER", "must be openai: Pi reaches the model only through the relay's OpenAI-compatible API");
	return {
		provider: "openai",
		modelId: required(env, "PI_MODEL", out, "the pinned model id, e.g. gpt-5.5"),
		thinkingLevel: parseThinking(env, out),
		upstreamBaseUrl: parseUpstream(env, out),
		openaiApiKey: required(env, "OPENAI_API_KEY", out, "the model key, held only by the relay"),
		codexGateway: env.OPENAI_CODEX_GATEWAY === "1",
		projectTokenCeiling: parseInteger(env, "PROJECT_TOKEN_CEILING", out, { required: true }),
	};
}

function parseGitHub(env: Env, out: Collector): Pick<CoordinatorConfig, "github" | "git"> {
	const token = required(env, "GITHUB_TOKEN", out, "fine-grained token for the target repository");
	const repo = nonEmpty(env.GITHUB_REPO) ?? "";
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) out.add("GITHUB_REPO", "required: owner/name");
	const apiUrl = parseUrl(env, "GITHUB_API_URL", "https://api.github.com", out);
	const baseBranch = nonEmpty(env.GITHUB_BASE_BRANCH) ?? "main";
	if (!/^[A-Za-z0-9._/-]+$/.test(baseBranch)) out.add("GITHUB_BASE_BRANCH", "must be a branch name");
	const branchPrefix = nonEmpty(env.GIT_BRANCH_PREFIX) ?? "task/";
	if (!/^[A-Za-z0-9._-]+\/?$/.test(branchPrefix)) out.add("GIT_BRANCH_PREFIX", "letters, digits, . _ - and one /");
	return {
		github: { token, repo, apiUrl, baseBranch, remoteUrl: `https://github.com/${repo}.git` },
		git: {
			branchPrefix,
			authorName: nonEmpty(env.GIT_AUTHOR_NAME) ?? "pi-durable coordinator",
			authorEmail: nonEmpty(env.GIT_AUTHOR_EMAIL) ?? "pi-durable-coordinator@users.noreply.github.com",
		},
	};
}

function parseLocal(
	env: Env,
	out: Collector,
	defaults: Defaults,
): Pick<CoordinatorConfig, "paths" | "docker" | "evaluation" | "relay" | "setupScript" | "logLevel"> {
	const dataDir = dataDirFrom(env.PI_DATA_DIR, defaults);
	const taskDir = taskDirFrom(env, dataDir, defaults.cwd);
	const user = parseContainerUser(env, out, defaults);
	const setupScript = parseSetupScript(env, out);
	const logLevel = parseLogLevel(env, out);
	return {
		paths: {
			dataDir,
			taskDir,
			requireTaskMount: env.PI_REQUIRE_TASK_MOUNT === "1",
			stateGroup: parseStateGroup(env, out),
		},
		docker: {
			bin: nonEmpty(env.DOCKER_BIN) ?? "docker",
			agentImage: nonEmpty(env.AGENT_IMAGE) ?? "pi-durable-agent:demo",
			checkImage: nonEmpty(env.CHECK_IMAGE) ?? "pi-durable-check:demo",
			user,
		},
		evaluation: {
			hiddenTestsDir: parseHiddenTests(env, out, { dataDir, taskDir, cwd: defaults.cwd }),
			image: nonEmpty(env.EVALUATOR_IMAGE) ?? "pi-durable-evaluator:demo",
		},
		relay: { port: parseInteger(env, "RELAY_PORT", out, { fallback: 0, allowZero: true }) },
		setupScript,
		logLevel,
	};
}

/** True if `a` and `b` are the same directory or one contains the other (resolved paths, textually). */
export function pathsOverlap(a: string, b: string): boolean {
	const inside = (child: string, parent: string) =>
		child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
	return inside(a, b) || inside(b, a);
}

/**
 * PI_EVAL_HIDDEN_TESTS_DIR, resolved from `cwd`. It must not overlap PI_DATA_DIR or PI_TASK_DIR: the agent and check
 * containers mount worktrees and scratch space from the task directory, so hidden tests there could be reached by a
 * path or alias (Agent Execution § Protected files: "never mounted in any agent or run_check container view").
 */
function parseHiddenTests(
	env: Env,
	out: Collector,
	where: { readonly dataDir: string; readonly taskDir: string; readonly cwd: string },
): string | undefined {
	const raw = nonEmpty(env.PI_EVAL_HIDDEN_TESTS_DIR);
	if (raw === undefined) return undefined;
	const dir = resolvePath(raw, where.cwd);
	if (/[,"\n\r\0]/.test(dir))
		out.add("PI_EVAL_HIDDEN_TESTS_DIR", "cannot be mounted safely (a comma, quote or newline)");
	else if (pathsOverlap(dir, where.taskDir) || pathsOverlap(dir, where.dataDir))
		out.add(
			"PI_EVAL_HIDDEN_TESTS_DIR",
			"must be outside PI_DATA_DIR and PI_TASK_DIR (agents' containers mount from there)",
		);
	return dir;
}

/** PI_TASK_DIR, resolved from `cwd`; default `<PI_DATA_DIR>/tasks`. */
function taskDirFrom(env: Env, dataDir: string, cwd: string): string {
	return resolvePath(nonEmpty(env.PI_TASK_DIR) ?? join(dataDir, "tasks"), cwd);
}

function parseRunner(env: Env, out: Collector, defaults: Defaults): CoordinatorConfig["runner"] {
	const platform = defaults.platform ?? process.platform;
	const isolation = isolationFrom(env.PI_RUNNER_ISOLATION, platform) as "systemd" | "process";
	const problem = isolationProblem(isolation, platform);
	if (problem !== undefined) out.add(problem.variable, problem.message);
	const user = parseAccount(env, "PI_RUNNER_USER", "pi-runner", out);
	if (isolation === "systemd" && user === defaults.username)
		out.add("PI_RUNNER_USER", "must not be the Coordinator's own user");
	const group = parseAccount(env, "PI_RUNNER_GROUP", "pi-durable", out);
	const slice = nonEmpty(env.PI_RUNNER_SLICE) ?? "pi-durable-runs.slice";
	if (!SLICE_NAME.test(slice) || slice.length > 128)
		out.add("PI_RUNNER_SLICE", "a slice name such as pi-durable-runs.slice (letters, digits, _ and single dashes)");
	return {
		isolation,
		user,
		group,
		slice,
		systemdRunBin: parseCommand(env, "SYSTEMD_RUN_BIN", "systemd-run", out),
		systemctlBin: parseCommand(env, "SYSTEMCTL_BIN", "systemctl", out),
	};
}

function parseDisk(env: Env, out: Collector): CoordinatorConfig["disk"] {
	return {
		bootMinFreeBytes: parseBytes(env, "PI_BOOT_DISK_MIN_FREE", out, 1),
		taskMinFreeBytes: parseBytes(env, "PI_TASK_DISK_MIN_FREE", out, 1),
		taskBudgetBytes: parseBytes(env, "PI_TASK_DISK_BUDGET", out, 1),
		worktreeHeadroomBytes: parseBytes(env, "PI_WORKTREE_HEADROOM", out, 0),
	};
}

const BYTE_UNITS: Readonly<Record<string, number>> = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/** Bytes: digits, optionally with K, M, G or T (powers of 1024; "GiB" and "GB" alike); at least `min`. */
function parseBytes(env: Env, name: string, out: Collector, min: number): number | undefined {
	const raw = nonEmpty(env[name]);
	if (raw === undefined) return undefined;
	const match = /^(\d{1,16})\s*(?:([KMGT])(?:i?B)?)?$/i.exec(raw);
	const value = match === null ? Number.NaN : Number(match[1]) * (BYTE_UNITS[(match[2] ?? "").toLowerCase()] ?? 0);
	if (!Number.isSafeInteger(value) || value < min) {
		out.add(name, `a size in bytes${min > 0 ? " above 0" : ""}, e.g. 1073741824, 512MiB or 2GiB`);
		return undefined;
	}
	return value;
}

function parseStateGroup(env: Env, out: Collector): string | undefined {
	const value = nonEmpty(env.PI_STATE_GROUP);
	if (value === undefined) return undefined;
	if (!(ACCOUNT.test(value) || /^[1-9]\d{0,9}$/.test(value)) || value === "root")
		out.add("PI_STATE_GROUP", "a group name or a gid (not root's)");
	else if (value === (nonEmpty(env.PI_RUNNER_GROUP) ?? "pi-durable"))
		out.add("PI_STATE_GROUP", "must not be PI_RUNNER_GROUP: the Pi user must not read the Coordinator's database");
	return value;
}

function parseAccount(env: Env, name: string, fallback: string, out: Collector): string {
	const value = nonEmpty(env[name]) ?? fallback;
	if (!ACCOUNT.test(value) || value === "root") out.add(name, "a user or group name (lower case, not root)");
	return value;
}

function parseCommand(env: Env, name: string, fallback: string, out: Collector): string {
	const value = nonEmpty(env[name]) ?? fallback;
	if (!COMMAND_NAME.test(value)) out.add(name, "an absolute path or a command name, without spaces or quotes");
	return value;
}

/** A secret-free summary for the startup log. */
export function describeConfig(config: CoordinatorConfig): Record<string, unknown> {
	return {
		group: config.telegram.groupChatId,
		topic: config.telegram.topicId,
		bot: config.telegram.botUsername,
		agents: config.agents.join(","),
		model: `${config.model.provider}/${config.model.modelId}`,
		repo: config.github.repo,
		base: config.github.baseBranch,
		data: config.paths.dataDir,
		tasks: config.paths.taskDir,
		...(config.paths.stateGroup === undefined ? {} : { state_group: config.paths.stateGroup }),
		...diskSummary(config.disk),
		agent_image: config.docker.agentImage,
		check_image: config.docker.checkImage,
		evaluator_image: config.evaluation.image,
		hidden_tests: config.evaluation.hiddenTestsDir === undefined ? "unset" : "set",
		runner_isolation: config.runner.isolation,
		...(config.runner.isolation === "systemd"
			? { runner_user: config.runner.user, runner_group: config.runner.group, runner_slice: config.runner.slice }
			: {}),
	};
}

/** The disk settings that are set (bytes), for the startup log. */
function diskSummary(disk: CoordinatorConfig["disk"]): Record<string, number> {
	const set: Record<string, number> = {};
	if (disk.bootMinFreeBytes !== undefined) set.boot_disk_min_free = disk.bootMinFreeBytes;
	if (disk.taskMinFreeBytes !== undefined) set.task_disk_min_free = disk.taskMinFreeBytes;
	if (disk.taskBudgetBytes !== undefined) set.task_disk_budget = disk.taskBudgetBytes;
	if (disk.worktreeHeadroomBytes !== undefined) set.worktree_headroom = disk.worktreeHeadroomBytes;
	return set;
}

/** Thinking levels the configured model supports, for a startup check against the pi-ai catalog. */
export function supportedThinking(model: Parameters<typeof getSupportedThinkingLevels>[0]): readonly string[] {
	return model.reasoning ? getSupportedThinkingLevels(model) : ["off"];
}

function currentUser(): { username?: string } {
	try {
		return { username: userInfo().username };
	} catch {
		return {};
	}
}

function uidGid(): { uid?: number; gid?: number } {
	return typeof process.getuid === "function" && typeof process.getgid === "function"
		? { uid: process.getuid(), gid: process.getgid() }
		: {};
}

function required(env: Env, name: string, out: Collector, hint: string): string {
	const value = nonEmpty(env[name]);
	if (value === undefined) out.add(name, `required (${hint})`);
	return value ?? "";
}

function parseInteger(
	env: Env,
	name: string,
	out: Collector,
	options: { required?: boolean; negative?: boolean; fallback?: number; allowZero?: boolean },
): number {
	const raw = nonEmpty(env[name]);
	if (raw === undefined) {
		if (options.required === true) out.add(name, "required");
		return options.fallback ?? 0;
	}
	const value = Number(raw);
	if (!integerPattern(options).test(raw) || !Number.isSafeInteger(value)) {
		out.add(name, options.negative === true ? "must be a negative integer" : "must be a positive integer");
		return options.fallback ?? 0;
	}
	return value;
}

function parseContainerUser(env: Env, out: Collector, defaults: Defaults): string {
	const uid = defaults.uid ?? 1000;
	const gid = defaults.gid ?? 1000;
	const user = nonEmpty(env.CONTAINER_USER) ?? (uid === 0 || gid === 0 ? "65534:65534" : `${uid}:${gid}`);
	if (!/^[1-9]\d*:[1-9]\d*$/.test(user)) out.add("CONTAINER_USER", "uid:gid, neither root (0)");
	return user;
}

function parseSetupScript(env: Env, out: Collector): string {
	const setupScript = nonEmpty(env.PI_SETUP_SCRIPT) ?? ".pi/setup.sh";
	if (isAbsolute(setupScript) || setupScript.split("/").includes(".."))
		out.add("PI_SETUP_SCRIPT", "must be a path inside the repository");
	return setupScript;
}

function parseLogLevel(env: Env, out: Collector): CoordinatorConfig["logLevel"] {
	const logLevel = (nonEmpty(env.LOG_LEVEL) ?? "info") as CoordinatorConfig["logLevel"];
	if (!["debug", "info", "warn", "error"].includes(logLevel)) out.add("LOG_LEVEL", "debug, info, warn or error");
	return logLevel;
}

function integerPattern(options: { negative?: boolean; allowZero?: boolean }): RegExp {
	if (options.negative === true) return /^-[1-9]\d*$/;
	return options.allowZero === true ? /^\d+$/ : /^[1-9]\d*$/;
}

function parseIdList(env: Env, name: string, out: Collector): number[] | undefined {
	const raw = nonEmpty(env[name]);
	if (raw === undefined) return undefined;
	const ids = new Set<number>();
	for (const part of raw.split(",").map((piece) => piece.trim())) {
		if (part === "") continue;
		if (/^[1-9]\d{0,15}$/.test(part)) ids.add(Number(part));
		else out.add(name, "comma-separated positive Telegram user ids");
	}
	return [...ids];
}

function parseAgents(env: Env, out: Collector): string[] {
	const raw = nonEmpty(env.PI_AGENTS);
	if (raw === undefined) {
		out.add("PI_AGENTS", "required: comma-separated agent ids, e.g. alpha,beta");
		return [];
	}
	const seen = new Set<string>();
	for (const part of raw.split(",").map((piece) => piece.trim().toLowerCase())) {
		if (part === "") continue;
		if (!AGENT_ID.test(part)) out.add("PI_AGENTS", `invalid agent id ${JSON.stringify(part.slice(0, 32))}`);
		else if (seen.has(part)) out.add("PI_AGENTS", `duplicate agent id ${part}`);
		else seen.add(part);
	}
	if (seen.size === 0) out.add("PI_AGENTS", "needs at least one agent id");
	return [...seen];
}

function parseThinking(env: Env, out: Collector): ModelThinkingLevel {
	const raw = nonEmpty(env.PI_THINKING) ?? "medium";
	if ((THINKING as readonly string[]).includes(raw)) return raw as ModelThinkingLevel;
	out.add("PI_THINKING", `must be one of ${THINKING.join(", ")}`);
	return "medium";
}

/** Same rules as src/agent/providers.ts: HTTPS (or local HTTP), no credentials, query or fragment. */
function parseUpstream(env: Env, out: Collector): string {
	const raw = nonEmpty(env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1";
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		out.add("OPENAI_BASE_URL", "must be a valid HTTP(S) API endpoint");
		return "";
	}
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		out.add("OPENAI_BASE_URL", "requires HTTPS (or local HTTP), without credentials, query or fragment");
	}
	return url.href.replace(/\/+$/, "");
}

function parseUrl(env: Env, name: string, fallback: string, out: Collector): string {
	const raw = nonEmpty(env[name]) ?? fallback;
	if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(raw)) out.add(name, "must be an http(s) URL");
	return raw.replace(/\/+$/, "");
}

function resolvePath(path: string, base: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(base, path);
}
