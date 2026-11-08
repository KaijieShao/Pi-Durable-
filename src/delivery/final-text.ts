import type { Message } from "@earendil-works/pi-ai";

/** The user-visible text of a final answer: text parts of a stop/length answer without tool calls. */
export function finalReplyText(message: Message | undefined): string | undefined {
	if (message?.role !== "assistant" || !["stop", "length"].includes(message.stopReason)) return undefined;
	if (message.content.some((part) => part.type === "toolCall")) return undefined;
	const text = message.content
		.filter((part) => part.type === "text" && !isCommentary(part.textSignature))
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
	return text === "" ? undefined : text;
}

function isCommentary(signature: string | undefined): boolean {
	if (signature === undefined) return false;
	try {
		const parsed = JSON.parse(signature) as { v?: unknown; phase?: unknown } | null;
		return parsed?.v === 1 && parsed.phase === "commentary";
	} catch {
		return false;
	}
}
