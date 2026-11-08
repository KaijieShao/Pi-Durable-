import type { BotCommandSpec } from "../../telegram/port.ts";

export const COMMANDS: readonly BotCommandSpec[] = [
	{ command: "new", description: "Start a fresh context (history is kept)" },
	{ command: "stop", description: "Stop the current run; queued messages continue" },
	{ command: "compact", description: "Compact the context, optionally with instructions" },
	{ command: "status", description: "Model, context, spend and queue" },
	{ command: "help", description: "What this bot does" },
];
