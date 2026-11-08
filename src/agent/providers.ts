import { type AnyModel, type AuthContext, isModelType, type Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { codexGatewayHook } from "./openai-relay.ts";

/**
 * The pi-ai provider for an id. Anthropic is loaded directly; any other built-in provider comes from the full
 * catalog, which is loaded only when needed.
 */
export async function loadProvider(
	id: string,
	context: Pick<AuthContext, "env"> = { env: async (name) => process.env[name] },
): Promise<Provider | undefined> {
	if (id === "anthropic") return anthropicProvider() as unknown as Provider;
	const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
	const provider = builtinProviders().find((provider) => provider.id === id);
	const endpoint = id === "openai" ? await context.env("OPENAI_BASE_URL") : undefined;
	return provider && endpoint
		? openAIEndpoint(provider, endpoint, (await context.env("OPENAI_CODEX_GATEWAY")) === "1")
		: provider;
}

function openAIEndpoint(provider: Provider, endpoint: string, codexGateway: boolean): Provider {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error("OPENAI_BASE_URL must be a valid HTTP(S) API endpoint.");
	}
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("OPENAI_BASE_URL requires HTTPS (or local HTTP), without credentials, query or fragment.");
	}
	const baseUrl = url.href.replace(/\/+$/, "");
	return {
		...provider,
		baseUrl,
		// Custom gateways use API keys, never the user's separate ChatGPT OAuth session.
		auth: { apiKey: provider.auth.apiKey },
		getModels: () => provider.getModels().map((model) => endpointModel(model, baseUrl, codexGateway)),
		getAllModels: () =>
			(provider.getAllModels?.() ?? provider.getModels()).map((model) => endpointModel(model, baseUrl, codexGateway)),
		stream: (model, context, options) =>
			provider.stream(
				model,
				context,
				codexGateway ? ({ ...options, onPayload: codexGatewayHook(options?.onPayload) } as typeof options) : options,
			),
		streamSimple: (model, context, options) =>
			provider.streamSimple(
				model,
				context,
				codexGateway ? { ...options, onPayload: codexGatewayHook(options?.onPayload) } : options,
			),
	};
}

function endpointModel<T extends AnyModel>(model: T, baseUrl: string, codexGateway: boolean): T {
	if (!codexGateway || !isModelType(model, "chat")) return { ...model, baseUrl };
	return {
		...model,
		baseUrl,
		// Older gateways drop incremental tool declarations; send the full tool set at the top level.
		compat: {
			...model.compat,
			supportsMidConvoSystemMessages: false,
			supportsAdditionalTools: false,
			supportsToolSearch: false,
			supportsMidConvoEffort: false,
			supportsExplicitPromptCacheMode: false,
			supportsOpenAIGrammarTools: false,
			supportsMaxOutputTokens: false,
		},
	};
}
