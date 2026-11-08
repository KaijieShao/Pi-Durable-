import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

const AUTH_FILE = "auth.json";

/** pi's agent directory: `PI_CODING_AGENT_DIR` (with `~` expanded), else `~/.pi/agent`, the same rule pi uses. */
export function piAgentDir(env: Env, home: string = env.HOME?.trim() || homedir()): string {
	const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
	if (fromEnv === undefined || fromEnv === "") return join(home, ".pi", "agent");
	if (fromEnv === "~") return home;
	if (fromEnv.startsWith("~/")) return join(home, fromEnv.slice(2));
	return resolve(fromEnv);
}

/**
 * Where credentials live. `PI_AUTH_FILE` wins. Otherwise pi's own `auth.json` is shared, so one `/login` in pi serves
 * the daemon too; a `<dataDir>/auth.json` written by an older version is still used while pi has none.
 */
export function resolveAuthFile(
	env: Env,
	paths: { readonly agentDir: string; readonly dataDir: string; readonly cwd: string },
	exists: (path: string) => boolean = existsSync,
): string {
	const explicit = env.PI_AUTH_FILE?.trim();
	if (explicit !== undefined && explicit !== "") return resolve(paths.cwd, explicit);
	const shared = join(paths.agentDir, AUTH_FILE);
	if (exists(shared)) return shared;
	const legacy = join(paths.dataDir, AUTH_FILE);
	return exists(legacy) ? legacy : shared;
}

/** Provider, model and thinking level from pi's `settings.json`, as fallbacks for unset `PI_*` variables. */
export function piDefaultsEnv(agentDir: string, read: (path: string) => string = readUtf8): Record<string, string> {
	let settings: unknown;
	try {
		settings = JSON.parse(read(join(agentDir, "settings.json")));
	} catch {
		return {};
	}
	if (settings === null || typeof settings !== "object") return {};
	const pick = (key: string): string | undefined => {
		const value = (settings as Record<string, unknown>)[key];
		return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
	};
	const out: Record<string, string> = {};
	const provider = pick("defaultProvider");
	const model = pick("defaultModel");
	const thinking = pick("defaultThinkingLevel");
	// A model id only means something for its provider: take pi's model only together with pi's provider.
	if (provider !== undefined) {
		out.PI_PROVIDER = provider;
		if (model !== undefined) out.PI_MODEL = model;
	}
	if (thinking !== undefined) out.PI_THINKING = thinking;
	return out;
}

function readUtf8(path: string): string {
	return readFileSync(path, "utf8");
}

/**
 * `env` with pi's defaults filled in where the `PI_*` variable is unset. pi's model is taken only when the provider
 * in effect is pi's provider.
 */
export function withPiDefaults(env: Env, piEnv: Readonly<Record<string, string>>): Env {
	const out: Record<string, string | undefined> = { ...env };
	const set = (key: string): boolean => (env[key]?.trim() ?? "") !== "";
	if (!set("PI_PROVIDER") && piEnv.PI_PROVIDER !== undefined) out.PI_PROVIDER = piEnv.PI_PROVIDER;
	const sameProvider = (out.PI_PROVIDER?.trim() ?? "") === (piEnv.PI_PROVIDER ?? "");
	if (!set("PI_MODEL") && sameProvider && piEnv.PI_MODEL !== undefined) out.PI_MODEL = piEnv.PI_MODEL;
	if (!set("PI_THINKING") && piEnv.PI_THINKING !== undefined) out.PI_THINKING = piEnv.PI_THINKING;
	return out;
}
