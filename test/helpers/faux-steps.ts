import {
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";

export function gate(): { promise: Promise<void>; open(): void } {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/** A step that waits for `wait` before answering with `answer`. */
export function gated(wait: Promise<void>, answer: () => ReturnType<typeof fauxAssistantMessage>): FauxResponseStep {
	return async () => {
		await wait;
		return answer();
	};
}

/** A step that blocks until the request is aborted (a generation in flight at crash or /stop time). */
export const untilAborted: FauxResponseFactory = (_context, options) =>
	new Promise((resolve) => {
		const done = () =>
			resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" }));
		if (options?.signal?.aborted === true) done();
		options?.signal?.addEventListener("abort", done, { once: true });
	});

export function toolCall(name: string, args: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
}

type ToolResult = Extract<Message, { role: "toolResult" }>;

export function lastToolResult(messages: readonly Message[]): ToolResult | undefined {
	return messages.findLast((message): message is ToolResult => message.role === "toolResult");
}

export function textOf(message: { content: string | readonly { type: string; text?: string }[] } | undefined): string {
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
		.join("");
}

export function lastUserText(messages: readonly Message[]): string {
	const last = messages.findLast((message) => message.role === "user");
	return last === undefined ? "" : textOf(last as never);
}

export function words(count: number, prefix = "word"): string {
	return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
}

/** A step that lets the test look at the request's messages, then answers `reply`. */
export function observe(
	watch: (messages: readonly Message[]) => void,
	reply: ReturnType<typeof fauxAssistantMessage>,
): FauxResponseStep {
	return (context) => {
		watch(context.messages);
		return reply;
	};
}
