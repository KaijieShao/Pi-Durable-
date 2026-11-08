import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import { InboxDoc, LiveDoc, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import { contextTokens } from "../../status/context-usage.ts";
import { formatStatus, type UsageTotals } from "../../status/format-status.ts";
import { recordKey } from "../intake.ts";
import { type MessageScope, reply } from "../scope.ts";

export function totals(state: Readonly<UsageState> | undefined): UsageTotals {
	const sum: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const bucket of [state?.models ?? {}, state?.tools ?? {}]) {
		for (const usage of Object.values(bucket) as unknown as Usage[]) {
			sum.input += usage.input;
			sum.output += usage.output;
			sum.cacheRead += usage.cacheRead;
			sum.cacheWrite += usage.cacheWrite;
			sum.cost += usage.cost.total;
		}
	}
	return sum;
}

async function authLabel(scope: MessageScope, provider: string): Promise<string> {
	const check = await scope.rt.models?.checkAuth(provider).catch(() => undefined);
	return check === undefined
		? `missing (run: pi-durable-telegram login ${provider})`
		: `${check.type}${check.source === undefined ? "" : ` (${check.source})`}`;
}

/** /status: model, thinking, auth, busy state, queue, context use and spend. */
export async function runStatus(scope: MessageScope): Promise<void> {
	if (!(await recordKey(scope.conversation, scope.key, BG, scope.updateId))) return;
	const { harness, models } = scope.rt;
	const id = scope.conversation.id;
	const agent = await scope.conversation.agent(BG);
	const model = agent.model ?? scope.rt.model;
	const live = await harness.snapshot(LiveDoc, id, BG);
	const view = await scope.conversation.context(BG);
	const text = formatStatus({
		version: scope.rt.version,
		model: `${model.provider}/${model.modelId}`,
		thinking: agent.thinkingLevel,
		auth: await authLabel(scope, model.provider),
		busy: live?.run !== undefined,
		tool: live?.tools?.find((slot) => slot.status === "running")?.name,
		queued: (await harness.snapshot(InboxDoc, id, BG))?.items.length ?? 0,
		contextTokens: contextTokens(view.messages),
		contextWindow: models?.getModel(model.provider, model.modelId)?.contextWindow,
		chat: totals(await harness.snapshot(UsageDoc, id, BG)),
		total: totals(await harness.usage(BG)),
		uptimeMs: Date.now() - scope.rt.startedAt,
		voice: scope.rt.stt !== undefined,
		plugins: scope.rt.plugins,
	});
	await reply(scope, text);
}
