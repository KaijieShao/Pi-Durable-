import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

/** Adapt the normal Responses payload for a gateway backed by the Codex subscription API. */
export function codexGatewayPayload(payload: unknown): Record<string, unknown> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Responses payload.");
	const params = { ...payload } as Record<string, unknown>;
	const input = Array.isArray(params.input) ? [...params.input] : [];
	const instructions: string[] = [];
	while (input[0]?.role === "system" || input[0]?.role === "developer") {
		instructions.push(instructionText(input.shift().content));
	}
	params.instructions =
		params.instructions || instructions.filter(Boolean).join("\n\n") || "You are a helpful assistant.";
	params.input = input;
	params.store = false;
	params.stream = true;
	for (const field of ["max_output_tokens", "temperature", "prompt_cache_retention", "prompt_cache_options"]) {
		delete params[field];
	}
	return params;
}

function instructionText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => (typeof part?.text === "string" ? [part.text] : [])).join("\n");
}

export function codexGatewayHook(
	previous: SimpleStreamOptions["onPayload"],
): NonNullable<SimpleStreamOptions["onPayload"]> {
	return async (payload, model) => codexGatewayPayload((await previous?.(payload, model)) ?? payload);
}
