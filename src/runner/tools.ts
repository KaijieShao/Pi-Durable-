/**
 * The model's tool surface in the Pi process (Agent Execution § Tool Surface): `read`, `edit`, `write` and
 * `run_check(operation)`, all IPC proxies. The Pi process never touches the worktree: each allowed call goes to the
 * Coordinator as a `tool` message and the model gets the `tool_result` back. A `beforeTool` policy hook allows only
 * these four tools with confined paths and listed operations (fail closed: a throwing hook blocks the call, and every
 * `execute` checks the policy again), and an `afterTool` hook caps every result at the tool-result limit with a
 * visible truncation marker.
 */
import type { Context } from "@earendil-works/chord";
import {
	defineExtension,
	defineTool,
	type Extension,
	hook,
	section,
	type ToolExecutionResult,
	type ToolRegistration,
	ToolTask,
} from "@earendil-works/pi-durable";
import { bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { type AllowedCall, evaluateToolCall } from "./policy.ts";
import type { ToolName, ToolResult } from "./protocol.ts";

/** Executes one allowed call through the Coordinator; resolves with the result the model sees. */
export type ToolInvoker = (call: AllowedCall, signal: AbortSignal | undefined) => Promise<ToolResult>;

export type RunnerExtensionOptions = {
	readonly checkOps: readonly string[];
	/** Cap for every tool result, in UTF-8 bytes, marker included. */
	readonly toolResultBytes: number;
	/** The Coordinator's role text plus the repository's AGENTS.md (already capped by the Coordinator). */
	readonly instructions: string;
	readonly invoke: ToolInvoker;
};

export const RUNNER_EXTENSION_NAME = "pi-durable-runner";

const ROOT_NOTE =
	"Paths are relative to the project root (the task's worktree root): no absolute paths, no '..', no .git. " +
	"There is no shell.";

/** The extension the Pi process installs: the four tools, the policy and cap hooks, and the system sections. */
export function createRunnerExtension(options: RunnerExtensionOptions): Extension {
	const checkOps = [...options.checkOps];
	const tools = createRunnerTools(options);
	return defineExtension({
		name: RUNNER_EXTENSION_NAME,
		tools,
		sections: [
			section("environment", () => environmentText(checkOps)),
			section("project-instructions", () => (options.instructions.trim() === "" ? undefined : options.instructions), {
				tag: false,
			}),
		],
		hooks: [
			hook(ToolTask, {
				beforeTool: (call) => {
					const decision = evaluateToolCall(call.name, call.arguments, { checkOps });
					if (!decision.allowed) return { block: decision.reason };
					return { arguments: { ...decision.call.args } };
				},
				afterTool: (_call, result) => capToolResult(result, options.toolResultBytes),
			}),
		],
	});
}

/** The four IPC-proxy tools. */
export function createRunnerTools(options: RunnerExtensionOptions): ToolRegistration[] {
	const checkOps = [...options.checkOps];
	const limits = { maxBytes: options.toolResultBytes, maxLines: 1_000_000, retain: "head" as const };
	const run = async (name: ToolName, args: unknown, context: Context): Promise<ToolExecutionResult> => {
		// Second check inside the tool itself: if the hook did not run, the call still fails closed.
		const decision = evaluateToolCall(name, args, { checkOps });
		if (!decision.allowed) return errorResult(`Denied by policy: ${decision.reason}`);
		const result = await options.invoke(decision.call, context.abortSignal);
		const text = result.text === "" ? (result.ok ? "(no output)" : "(failed without output)") : result.text;
		return { output: [{ type: "text", text }], isError: !result.ok };
	};
	const common = { executionMode: "sequential" as const, callers: ["model" as const], outputLimits: limits };
	const read = defineTool({
		name: "read",
		description:
			"Read a text file of the project. Returns numbered lines; for large files pass offset (first line, 1-based) " +
			`and limit (number of lines). ${ROOT_NOTE}`,
		parameters: obj({
			path: str({ description: "File path relative to the project root, e.g. src/app.js" }),
			offset: opt(int({ minimum: 0, description: "First line to return (1-based)" })),
			limit: opt(int({ minimum: 1, description: "Maximum number of lines to return" })),
		}),
		...common,
		execute: (args, _api, context) => run("read", args, context),
	});
	const write = defineTool({
		name: "write",
		description:
			"Create a file or replace its whole content (at most 1 MiB). Missing parent directories are created. " +
			ROOT_NOTE,
		parameters: obj({
			path: str({ description: "File path relative to the project root" }),
			content: str({ description: "The complete new file content" }),
		}),
		...common,
		execute: (args, _api, context) => run("write", args, context),
	});
	const edit = defineTool({
		name: "edit",
		description:
			"Edit an existing file: replace oldText with newText. oldText must match exactly once unless replaceAll is " +
			`true. ${ROOT_NOTE}`,
		parameters: obj({
			path: str({ description: "File path relative to the project root" }),
			oldText: str({ description: "Exact text to replace (must be unique in the file unless replaceAll)" }),
			newText: str({ description: "Replacement text" }),
			replaceAll: opt(bool({ description: "Replace every occurrence" })),
		}),
		...common,
		execute: (args, _api, context) => run("edit", args, context),
	});
	const runCheck = defineTool({
		name: "run_check",
		description:
			"Run one approved check operation of the project in a separate sandbox (project read-only, no network) and " +
			`get its outcome and output. Operations: ${checkOps.length === 0 ? "none available" : checkOps.join(", ")}. ` +
			"This is the only way to run commands; there is no shell.",
		parameters: obj({
			operation: checkOps.length === 0 ? str({ description: "No operation is available" }) : oneOf(checkOps),
		}),
		...common,
		execute: (args, _api, context) => run("run_check", args, context),
	});
	return [read, write, edit, runCheck] as unknown as ToolRegistration[];
}

/** Bound every text of a result to `maxBytes` UTF-8 bytes in total, ending with a visible marker when cut. */
export function capToolResult(result: ToolExecutionResult, maxBytes: number): ToolExecutionResult {
	const output = result.output;
	if (output === undefined || output.length === 0) return result;
	const texts = output.flatMap((item) => (item.type === "text" ? [item.text] : []));
	const joined = texts.join("\n");
	const others = output.filter((item) => item.type !== "text");
	const size = utf8Length(joined);
	// Images are never produced by these tools; drop any so the cap holds.
	if (size <= maxBytes && others.length === 0) return result;
	if (size <= maxBytes) return { ...result, output: [{ type: "text", text: joined }] };
	// The marker for `size` dropped bytes is the longest it can be, so kept text plus the real marker fits.
	const kept = truncateUtf8(joined, Math.max(0, maxBytes - utf8Length(truncationMarker(size))));
	return { ...result, output: [{ type: "text", text: `${kept}${truncationMarker(size - utf8Length(kept))}` }] };
}

/** The longest prefix of `text` within `maxBytes` UTF-8 bytes, never splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
	if (utf8Length(text) <= maxBytes) return text;
	const bytes = new TextEncoder().encode(text);
	let end = Math.max(0, maxBytes);
	// Step back over continuation bytes (10xxxxxx) so the cut lands on a character boundary.
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return new TextDecoder().decode(bytes.subarray(0, end));
}

function truncationMarker(droppedBytes: number): string {
	return `\n[truncated: ${droppedBytes} bytes dropped]`;
}

function utf8Length(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function errorResult(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }], isError: true };
}

function environmentText(checkOps: readonly string[]): string {
	return [
		"You work on one task in your own copy of the project (a git worktree). The project root is the worktree root.",
		"Tools: read, write and edit for files, and run_check(operation) for the approved checks " +
			`(${checkOps.length === 0 ? "none available" : checkOps.join(", ")}).`,
		"There is no shell, no network and no git: you cannot run arbitrary commands, install packages or commit.",
		"Paths are relative to the project root; absolute paths, '..' and .git are refused.",
		"Your changes are committed and pushed for review after the run; your final answer is a short summary of " +
			"what you changed and the check results.",
	].join("\n");
}
