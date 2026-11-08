import type { Message } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";

/** Tokens the next request's context is estimated to take: last reported usage plus estimates for later messages. */
export function contextTokens(messages: readonly Message[]): number {
	return estimateContextTokens(messages).tokens;
}
