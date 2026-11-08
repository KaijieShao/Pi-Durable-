import type { Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

/**
 * The pi-ai provider for an id. Anthropic is loaded directly; any other built-in provider comes from the full
 * catalog, which is loaded only when needed.
 */
export async function loadProvider(id: string): Promise<Provider | undefined> {
	if (id === "anthropic") return anthropicProvider() as unknown as Provider;
	const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
	return builtinProviders().find((provider) => provider.id === id);
}
