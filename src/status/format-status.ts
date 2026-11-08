export type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

export type StatusInfo = {
	readonly version: string;
	readonly model: string;
	readonly thinking: string;
	readonly auth: string;
	readonly busy: boolean;
	readonly tool: string | undefined;
	readonly queued: number;
	readonly contextTokens: number;
	readonly contextWindow: number | undefined;
	readonly chat: UsageTotals;
	readonly total: UsageTotals;
	readonly uptimeMs: number;
	readonly voice: boolean;
	readonly plugins: {
		readonly loaded: readonly string[];
		readonly problems: readonly { plugin: string; reason: string }[];
	};
};

export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

function formatUsage(usage: UsageTotals): string {
	const tokens = `in ${formatTokens(usage.input + usage.cacheRead + usage.cacheWrite)}, out ${formatTokens(usage.output)}`;
	return `${tokens}, $${usage.cost.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Plain-text /status block. */
export function formatStatus(info: StatusInfo): string {
	const window = info.contextWindow;
	const percent = window === undefined || window === 0 ? "" : ` (${Math.round((info.contextTokens / window) * 100)}%)`;
	const context = `${formatTokens(info.contextTokens)}${window === undefined ? "" : ` / ${formatTokens(window)}`}${percent}`;
	const state = info.busy ? `working${info.tool === undefined ? "" : ` (${info.tool})`}` : "idle";
	return [
		`pi-durable-telegram ${info.version}, up ${formatDuration(info.uptimeMs)}`,
		`Model: ${info.model}, thinking ${info.thinking}`,
		`Auth: ${info.auth}`,
		`State: ${state}, queued: ${info.queued}`,
		`Context: ${context}`,
		`This chat: ${formatUsage(info.chat)}`,
		`All chats: ${formatUsage(info.total)}`,
		`Voice: ${info.voice ? "on" : "off (no DEEPGRAM_API_KEY)"}`,
		formatPlugins(info.plugins),
	].join("\n");
}

function formatPlugins({ loaded, problems }: StatusInfo["plugins"]): string {
	const failed = problems.map((problem) => `${problem.plugin} (${problem.reason.slice(0, 80)})`);
	return `Plugins: ${loaded.join(", ") || "none"}${failed.length > 0 ? `; problems: ${failed.join(", ")}` : ""}`;
}
