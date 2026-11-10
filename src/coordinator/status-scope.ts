/** Read-only routing history. Old task rows have no repo/topic columns: never guess or backfill them. */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type StatusIdentity = {
	readonly repository: string | undefined;
	readonly topicId: number;
	readonly databasePath: string;
	readonly scopeFile?: string | undefined;
	readonly runtime?: "running" | "starting" | "offline";
};

export type TaskScope = { readonly repository: string; readonly group: number; readonly topic: number };
type Period = TaskScope & { readonly firstTask: number; readonly lastTask: number | null };
export type ScopeIndex = { readonly periods: readonly Period[]; readonly problem?: string };
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

function periodOf(value: unknown): Period | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Record<string, unknown>;
	if (
		typeof v.repository !== "string" ||
		!REPO.test(v.repository) ||
		!Number.isSafeInteger(v.group) ||
		v.group === 0 ||
		!positive(v.topic) ||
		!positive(v.firstTask) ||
		(v.lastTask !== null && (!positive(v.lastTask) || v.lastTask < v.firstTask))
	)
		return undefined;
	return {
		repository: v.repository,
		group: v.group as number,
		topic: v.topic,
		firstTask: v.firstTask,
		lastTask: v.lastTask as number | null,
	};
}

/** A bad/missing index never broadens the default view. Values and raw parser errors are never printed. */
export function readScopeIndex(identity: StatusIdentity | undefined): ScopeIndex {
	const missing = { periods: [], problem: "routing history unavailable; unattributed tasks require --all" } as const;
	if (!identity?.scopeFile) return missing;
	try {
		const stat = statSync(identity.scopeFile);
		if (!stat.isFile() || stat.size > 1024 * 1024) return missing;
		const file = JSON.parse(readFileSync(identity.scopeFile, "utf8")) as Record<string, unknown>;
		if (
			file.version !== 1 ||
			typeof file.database !== "string" ||
			!isAbsolute(file.database) ||
			resolve(file.database) !== resolve(identity.databasePath) ||
			!Array.isArray(file.periods)
		)
			return missing;
		const periods = file.periods.map(periodOf);
		if (periods.some((p) => p === undefined)) return missing;
		const checked = (periods as Period[]).sort((a, b) => a.firstTask - b.firstTask);
		if (
			checked.some(
				(p, i) => i > 0 && (checked[i - 1]?.lastTask === null || p.firstTask <= (checked[i - 1]?.lastTask ?? 0)),
			)
		)
			return missing;
		return { periods: checked };
	} catch {
		return missing;
	}
}

export function taskScope(
	index: ScopeIndex,
	task: { id: number; chat_id: number; pr_url: string | null },
): TaskScope | undefined {
	const period = index.periods.find((p) => task.id >= p.firstTask && (p.lastTask === null || task.id <= p.lastTask));
	if (!period || period.group !== task.chat_id) return undefined;
	const repo = task.pr_url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/[1-9]\d*(?:[/?#]|$)/)?.[1];
	if (task.pr_url !== null && (!repo || repo.toLowerCase() !== period.repository.toLowerCase())) return undefined;
	return period;
}

export function scopeMatches(
	scope: TaskScope | undefined,
	group: number,
	identity: StatusIdentity | undefined,
): boolean {
	return (
		scope !== undefined &&
		identity?.repository !== undefined &&
		scope.group === group &&
		scope.topic === identity.topicId &&
		scope.repository.toLowerCase() === identity.repository.toLowerCase()
	);
}
