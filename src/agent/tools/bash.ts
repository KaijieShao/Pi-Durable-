import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { isSecretName } from "../../config/scrub.ts";

const exactNames = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LANGUAGE",
	"TERM",
	"COLORTERM",
	"TZ",
	"SHELL",
	"TMPDIR",
	"EDITOR",
	"VISUAL",
	"PAGER",
	"SSH_AUTH_SOCK",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
]);
const prefixes = ["LC_", "XDG_", "NODE_", "npm_config_", "NVM_", "BUN_", "UV_", "PYTHON"];

/** The shell environment the agent's bash gets: an allowlist of harmless variables, never a secret. */
export function buildSafeEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined || isSecretName(name)) continue;
		if (exactNames.has(name) || prefixes.some((prefix) => name.startsWith(prefix))) env[name] = value;
	}
	env.TERM ??= "dumb";
	env.GIT_PAGER = "cat";
	env.PAGER ??= "cat";
	return env;
}

/** `bash` that does not inherit the service's environment: only `env` reaches the command. */
export function createSafeBashTool(env: Readonly<Record<string, string>>): ToolRegistration {
	return createBashTool({
		prepare: (execution) => {
			execution.inheritEnv = false;
			execution.env = { ...env };
		},
	}) as unknown as ToolRegistration;
}
