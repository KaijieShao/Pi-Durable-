/**
 * Tool calls from a run's Pi process (Agent Execution § Tool Surface, § Policy Hook). The runner's beforeTool hook
 * already applied the allow rules; the Coordinator validates again with the same pure policy
 * (src/runner/policy.ts: second layer, identical rules) and executes the call only in the run's own containers:
 * read/edit/write in the task's agent container, run_check in a fresh check container with the worktree read-only.
 * Results are capped at the tool-result limit with truncation marked. Never a host fallback.
 *
 * Uncertain effects (Agent Execution § Uncertain Effects; engine/intents.ts): a run's edits and writes run one at a
 * time. Each first inspects its target on the host and saves its intent (target, pre-hash, intended hash), then runs
 * in the container and is settled by the answer: applied; or, after a refusal (the file operation answered, so it has
 * ended, and nothing else of the run competes), the target is inspected again: as before → failed, the intended
 * result → applied, anything else → unresolved (the group freezes and the run is revoked at once). An answer that
 * leaves the outcome unknown (the client was killed at its deadline, or no answer could be read) stops the run: "The
 * model never re-runs an uncertain mutation". Finalize then confirms termination and reconciles the intent, and
 * dispatch waits for that. A run_check is saved too, so one in flight at a crash is reported failed once termination
 * is confirmed.
 */
import { type AllowedCall, evaluateToolCall, toFsRequest } from "../../runner/policy.ts";
import type { ToolResult } from "../../runner/protocol.ts";
import { classifyTarget, type PlannedChange, planFileChange, targetState } from "../effect-target.ts";
import { UNCERTAIN_TOOL_RESULT, uncertainChangeReason } from "../messages.ts";
import type { AgentSandbox, FsRequest, FsResponse } from "../ports.ts";
import { type ActiveRun, type Ctx, capBytes, describeError } from "./context.ts";
import { decide } from "./finalize.ts";
import { freezeOnUnresolved, recordChange, recordCheck, settleIntent } from "./intents.ts";

export type ToolCall = { readonly name: string; readonly args: Record<string, unknown> };

const STOPPED: ToolResult = { ok: false, text: "run stopped" };

type Change = Extract<FsRequest, { op: "edit" | "write" }>;

/** No new effect may start: the run was revoked (cancel, limit, failure, a refusal over the cap) or is finalizing. */
function barred(ctx: Ctx, active: ActiveRun): boolean {
	if (ctx.stopped || active.effectsClosed || active.capRefused) return true;
	return active.decision !== undefined && active.decision.kind !== "normal";
}

function answered(response: FsResponse): ToolResult {
	if (!response.ok) return { ok: false, text: `${response.code}: ${response.message}` };
	return { ok: true, text: response.truncated ? `${response.output}\n[truncated]` : response.output };
}

/** One change after the previous one of the run has settled. */
function serialized(active: ActiveRun, work: () => Promise<ToolResult>): Promise<ToolResult> {
	const result = active.effects.then(work);
	active.effects = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

/**
 * The outcome is unknown: keep the intent pending, stop the run (no further call of it runs, the model is told not to
 * repeat the change) and hold dispatch until finalize has reconciled it.
 */
function uncertain(ctx: Ctx, active: ActiveRun, intent: number, plan: PlannedChange): ToolResult {
	ctx.reconciling.add(active.runId);
	ctx.log.warn("tool_effect_uncertain", { run: active.runId, task: active.taskId, intent, tool: plan.tool });
	decide(ctx, active, { kind: "failed", reason: uncertainChangeReason(plan.path), cause: "run failed" });
	return { ok: false, text: UNCERTAIN_TOOL_RESULT };
}

/**
 * The file operation refused the change and has ended; this run's other changes wait (serialized), so the target can
 * be inspected now: unchanged → failed as reported; the intended result → applied after all; else unresolved.
 */
async function afterRefusal(
	ctx: Ctx,
	active: ActiveRun,
	p: {
		readonly intent: number;
		readonly plan: PlannedChange;
		readonly worktree: string;
		readonly response: FsResponse;
	},
): Promise<ToolResult> {
	const observed = await targetState(p.worktree, p.plan.path).catch(() => undefined);
	if (ctx.stopped || active.effectsClosed) return answered(p.response);
	if (observed === undefined) return uncertain(ctx, active, p.intent, p.plan);
	const outcome = classifyTarget(observed, p.plan.pre, p.plan.intended);
	if (outcome === "unchanged") {
		settleIntent(ctx, p.intent, "failed", { hash: observed });
		return answered(p.response);
	}
	settleIntent(ctx, p.intent, outcome, { hash: observed, reconciled: true });
	ctx.log.warn("tool_refusal_reconciled", { run: active.runId, intent: p.intent, outcome });
	if (outcome === "applied") {
		return { ok: true, text: `${p.plan.path}: the change is applied (the file has the intended content).` };
	}
	// Unresolved: the group freezes (its running tasks are cancelled "group frozen"). This run is revoked here, in the
	// same step, not on the engine's next pass: no further call of it may touch the file ("The model never re-runs an
	// uncertain mutation").
	freezeOnUnresolved(ctx, active.taskId, [p.plan.path]);
	decide(ctx, active, { kind: "cancelled", reason: "group frozen", cause: "cancelled" });
	return { ok: false, text: UNCERTAIN_TOOL_RESULT };
}

/** Inspect the target, save the intent, execute in the agent container, settle. */
async function change(
	ctx: Ctx,
	active: ActiveRun,
	p: { readonly box: AgentSandbox; readonly worktree: string; readonly request: Change },
): Promise<ToolResult> {
	if (barred(ctx, active)) return STOPPED;
	let plan: PlannedChange;
	try {
		plan = await planFileChange(p.worktree, p.request);
	} catch (error) {
		// Never run a change whose outcome could not be reconciled later.
		ctx.log.warn("tool_target_unreadable", { run: active.runId, error: describeError(error) });
		return { ok: false, text: "unavailable: the target could not be inspected before the change, so it was not made" };
	}
	// Checked again in the same synchronous step as the save: once finalize closed the run's effects, nothing new.
	if (barred(ctx, active)) return STOPPED;
	const intent = recordChange(ctx, active, plan);
	const response = await p.box
		.fileOp(p.request)
		.catch((): FsResponse => ({ ok: false, code: "unavailable", message: "no answer", uncertain: true }));
	// Stopping, or finalize reconciles the run's intents now: the pending intent is theirs.
	if (ctx.stopped || active.effectsClosed) return answered(response);
	if (response.ok) {
		settleIntent(ctx, intent, "applied");
		return answered(response);
	}
	if (response.uncertain === true) return uncertain(ctx, active, intent, plan);
	return afterRefusal(ctx, active, { intent, plan, worktree: p.worktree, response });
}

/** A run_check: saved first (so one in flight at a crash is reported failed), settled when it returns. */
async function check(ctx: Ctx, active: ActiveRun, worktree: string, op: string): Promise<ToolResult> {
	if (barred(ctx, active)) return STOPPED;
	const intent = recordCheck(ctx, active, op);
	try {
		const result = await ctx.sandbox.runCheck({
			taskId: active.taskId,
			generation: active.generation,
			worktree,
			op,
			writable: false,
			timeoutMs: ctx.limits.checkDeadlineMs,
		});
		const exit = result.exitCode === undefined ? "" : ` (exit ${result.exitCode})`;
		const output = result.truncated ? `${result.output}\n[truncated]` : result.output;
		return { ok: result.outcome === "passed", text: `run_check ${op}: ${result.outcome}${exit}\n${output}` };
	} finally {
		if (!ctx.stopped && !active.effectsClosed) settleIntent(ctx, intent, "done");
	}
}

/** Run an allowed call in the run's own containers. */
async function run(
	ctx: Ctx,
	active: ActiveRun,
	agentBox: AgentSandbox,
	worktree: string,
	call: AllowedCall,
): Promise<ToolResult> {
	const request = toFsRequest(call);
	if (request !== undefined && request.op !== "read") {
		return serialized(active, () => change(ctx, active, { box: agentBox, worktree, request }));
	}
	if (request !== undefined) return answered(await agentBox.fileOp(request));
	if (call.tool !== "run_check") return { ok: false, text: "denied: tool is not allowed" };
	return check(ctx, active, worktree, call.args.operation);
}

/** Execute one tool call for `active`'s own sandbox; never throws. */
export async function executeTool(ctx: Ctx, active: ActiveRun, call: ToolCall): Promise<ToolResult> {
	if (active.capRefused || (active.decision !== undefined && active.decision.kind !== "normal")) return STOPPED;
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
