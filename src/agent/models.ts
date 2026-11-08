import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AuthContext,
	type CredentialStore,
	createModels,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { loadProvider } from "./providers.ts";

/**
 * Auth context for pi-ai that reads provider variables from a snapshot taken before secrets were scrubbed from
 * `process.env`, so keys stay usable for the model but never reach the agent's shell.
 */
export function createAuthContext(
	secrets: Readonly<Record<string, string>>,
	env: NodeJS.ProcessEnv = process.env,
): AuthContext {
	return {
		env: async (name) => secrets[name] ?? env[name],
		fileExists: async (path) => {
			const expanded = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
			return access(expanded).then(
				() => true,
				() => false,
			);
		},
	};
}

export class StartupError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode: number) {
		super(message);
		this.name = "StartupError";
		this.exitCode = exitCode;
	}
}

/** Models with the configured provider registered and credentials from `credentials`. */
export async function createAgentModels(options: {
	readonly provider: string;
	readonly credentials: CredentialStore;
	readonly authContext?: AuthContext;
}): Promise<MutableModels> {
	const provider = await loadProvider(options.provider);
	if (provider === undefined)
		throw new StartupError(`PI_PROVIDER: unknown provider ${JSON.stringify(options.provider)}`, 2);
	const models = createModels({
		credentials: options.credentials,
		...(options.authContext === undefined ? {} : { authContext: options.authContext }),
	});
	models.setProvider(provider);
	return models;
}

/** The configured model, with the thinking level checked against what it supports. Throws `StartupError` (exit 2). */
export function resolveModel(
	models: MutableModels,
	ref: { provider: string; modelId: string },
	thinkingLevel: ModelThinkingLevel,
): Model<Api> {
	const model = models.getModel(ref.provider, ref.modelId);
	if (model === undefined) {
		const known = models
			.getModels(ref.provider)
			.map((each) => each.id)
			.slice(0, 20)
			.join(", ");
		throw new StartupError(`PI_MODEL: ${ref.provider}/${ref.modelId} is unknown. Known: ${known}`, 2);
	}
	const supported = model.reasoning ? getSupportedThinkingLevels(model) : (["off"] as ModelThinkingLevel[]);
	if (!supported.includes(thinkingLevel)) {
		throw new StartupError(
			`PI_THINKING: ${thinkingLevel} is not supported by ${model.id}; use one of ${supported.join(", ")}`,
			2,
		);
	}
	return model;
}
