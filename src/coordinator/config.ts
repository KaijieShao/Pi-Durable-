import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";

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
	};
	readonly docker: {
		readonly bin: string;
		readonly agentImage: string;
		readonly checkImage: string;
		/** uid:gid the containers run as; never root. */
		readonly user: string;
	};
	readonly relay: {
		/** 127.0.0.1 port; 0 = ephemeral. */
		readonly port: number;
	};
	/** Repository path (relative to the worktree root) of the checked-in setup script; run if present. */
	readonly setupScript: string;
	readonly logLevel: "debug" | "info" | "warn" | "error";
};

export type ConfigProblem = { readonly variable: string; readonly message: string };

/** Every problem found, one per line; never carries a secret value. */
export class ConfigError extends Error {
	readonly problems: readonly ConfigProblem[];
	constructor(problems: readonly ConfigProblem[]) {
		super(problems.map((p) => `${p.variable}: ${p.message}`).join("\n"));
		this.name = "ConfigError";
		this.problems = problems;
	}
}

export type Env = Readonly<Record<string, string | undefined>>;
type Collector = { readonly problems: ConfigProblem[]; add(variable: string, message: string): void };

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
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

type Defaults = { cwd: string; home: string; uid?: number; gid?: number };

export function parseCoordinatorConfig(
	env: Env,
	defaults: Defaults = { cwd: process.cwd(), home: homedir(), ...uidGid() },
): CoordinatorConfig {
	const out: Collector = {
		problems: [],
		add(variable, message) {
			this.problems.push({ variable, message });
		},
	};
	const telegram = parseTelegram(env, out);
	const agents = parseAgents(env, out);
	const model = parseModel(env, out);
	const github = parseGitHub(env, out);
	const local = parseLocal(env, out, defaults);
	if (out.problems.length > 0) throw new ConfigError(out.problems);
	return { telegram, agents, model, ...github, ...local };
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
): Pick<CoordinatorConfig, "paths" | "docker" | "relay" | "setupScript" | "logLevel"> {
	const dataDir = resolvePath(
		nonEmpty(env.PI_DATA_DIR) ?? join(defaults.home, ".local", "state", "pi-durable-coordinator"),
		defaults.cwd,
	);
	const taskDir = resolvePath(nonEmpty(env.PI_TASK_DIR) ?? join(dataDir, "tasks"), defaults.cwd);
	const user = parseContainerUser(env, out, defaults);
	const setupScript = parseSetupScript(env, out);
	const logLevel = parseLogLevel(env, out);
	return {
		paths: { dataDir, taskDir, requireTaskMount: env.PI_REQUIRE_TASK_MOUNT === "1" },
		docker: {
			bin: nonEmpty(env.DOCKER_BIN) ?? "docker",
			agentImage: nonEmpty(env.AGENT_IMAGE) ?? "pi-durable-agent:demo",
			checkImage: nonEmpty(env.CHECK_IMAGE) ?? "pi-durable-check:demo",
			user,
		},
		relay: { port: parseInteger(env, "RELAY_PORT", out, { fallback: 0, allowZero: true }) },
		setupScript,
		logLevel,
	};
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
		agent_image: config.docker.agentImage,
		check_image: config.docker.checkImage,
	};
}

/** Thinking levels the configured model supports, for a startup check against the pi-ai catalog. */
export function supportedThinking(model: Parameters<typeof getSupportedThinkingLevels>[0]): readonly string[] {
	return model.reasoning ? getSupportedThinkingLevels(model) : ["off"];
}

function uidGid(): { uid?: number; gid?: number } {
	return typeof process.getuid === "function" && typeof process.getgid === "function"
		? { uid: process.getuid(), gid: process.getgid() }
		: {};
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
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
