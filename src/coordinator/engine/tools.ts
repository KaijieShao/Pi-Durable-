/**
 * Tool calls from a run's Pi process (Agent Execution § Tool Surface, § Policy Hook). The runner's beforeTool hook
 * already applied the allow rules; the Coordinator validates again with the same pure policy
 * (src/runner/policy.ts: second layer, identical rules) and executes the call only in the run's own containers:
 * read/edit/write in the task's agent container, run_check in a fresh check container with the worktree read-only.
 * Results are capped at the tool-result limit with truncation marked. Never a host fallback.
 */
import { type AllowedCall, evaluateToolCall, toFsRequest } from "../../runner/policy.ts";
import type { ToolResult } from "../../runner/protocol.ts";
import type { AgentSandbox } from "../ports.ts";
import { type ActiveRun, type Ctx, capBytes, describeError } from "./context.ts";

export type ToolCall = { readonly name: string; readonly args: Record<string, unknown> };

const STOPPED: ToolResult = { ok: false, text: "run stopped" };

/** Run an allowed call in the run's own containers. */
async function run(
	ctx: Ctx,
	active: ActiveRun,
	agentBox: AgentSandbox,
	worktree: string,
	call: AllowedCall,
): Promise<ToolResult> {
	const request = toFsRequest(call);
	// STUB(spec: agent-execution.md § Uncertain Effects): no edit/write intent (target, pre-hash, intended hash) is
	// persisted before execution, so an unknown outcome is not reconciled file by file. Edits are not replay-safe:
	// after a crash the run is failed as interrupted and never resubmitted, and the next run sees the worktree as is.
	if (request !== undefined) {
		const response = await agentBox.fileOp(request);
		if (!response.ok) return { ok: false, text: `${response.code}: ${response.message}` };
		return { ok: true, text: response.truncated ? `${response.output}\n[truncated]` : response.output };
	}
	if (call.tool !== "run_check") return { ok: false, text: "denied: tool is not allowed" };
	const op = call.args.operation;
	const check = await ctx.sandbox.runCheck({
		taskId: active.taskId,
		generation: active.generation,
		worktree,
		op,
		writable: false,
		timeoutMs: ctx.limits.checkDeadlineMs,
	});
	const exit = check.exitCode === undefined ? "" : ` (exit ${check.exitCode})`;
	const output = check.truncated ? `${check.output}\n[truncated]` : check.output;
	return { ok: check.outcome === "passed", text: `run_check ${op}: ${check.outcome}${exit}\n${output}` };
}

/** Execute one tool call for `active`'s own sandbox; never throws. */
export async function executeTool(ctx: Ctx, active: ActiveRun, call: ToolCall): Promise<ToolResult> {
	if (active.decision !== undefined && active.decision.kind !== "normal") return STOPPED;
	const { agentBox, worktree } = active;
	if (agentBox === undefined || worktree === undefined) return STOPPED;
	const decision = evaluateToolCall(call.name, call.args, { checkOps: ctx.sandbox.checkOps() });
	if (!decision.allowed) {
		ctx.log.info("tool_denied", { run: active.runId, tool: call.name, layer: "coordinator" });
		return { ok: false, text: `denied: ${decision.reason}` };
	}
	let result: ToolResult;
	try {
		result = await run(ctx, active, agentBox, worktree, decision.call);
	} catch (error) {
		ctx.log.warn("tool_failed", { run: active.runId, tool: call.name, error: describeError(error) });
		result = { ok: false, text: "unavailable: the tool could not be executed" };
	}
	const capped = capBytes(result.text, ctx.limits.toolResultBytes);
	ctx.log.debug("tool_done", { run: active.runId, tool: call.name, ok: result.ok, truncated: capped.truncated });
	return { ok: result.ok, text: capped.text };
}
