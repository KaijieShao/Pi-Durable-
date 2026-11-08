/**
 * Effects outside SQLite: pushes and GitHub changes (Interfaces and Storage § Coordinator to GitHub). A change is
 * retried only after reading GitHub's current state ("find PR by head/base before creating; compare branch before
 * pushing; check main contains head before merging again"); an outcome that stays unknown raises `UnknownEffect`,
 * and the caller freezes the group ("If the outcome is still unknown, the group freezes").
 *
 * A push GitHub refuses because the task branch changed outside the Coordinator is a definite outcome, not an unknown
 * one (nothing was pushed): it raises `BranchMoved`, and only that task is held (branch-hold.ts) while the group
 * carries on. The Coordinator never force-pushes.
 */
import { existsSync } from "node:fs";
import { type BranchHold, branchHoldKey, readBranchHold } from "../branch-hold.ts";
import { GitError } from "../git.ts";
import { archiveHeld } from "../messages.ts";
import { GitHubError, type PullRequest } from "../ports.ts";
import {
	BranchMoved,
	type Ctx,
	clipText,
	describeError,
	enqueueTask,
	freezeGroup,
	loadTask,
	sleep,
	type TaskRow,
	taskRef,
	tx,
	UnknownEffect,
	worktreePath,
} from "./context.ts";
import { effectsOpen } from "./intents.ts";

const ATTEMPTS = 3;

/** A GitHub read; reads are retried inside the client. A failure that is not a definite refusal is unknown. */
export async function ghRead<T>(ctx: Ctx, what: string, read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (error) {
		if (error instanceof GitHubError && !error.transient) throw error;
		ctx.log.warn("github_read_failed", { what, error: describeError(error) });
		throw new UnknownEffect(`GitHub could not be read (${what})`);
	}
}

type Attempt<T> = { readonly done: true; readonly value: T } | { readonly done: false };
const NOT_DONE = { done: false } as const;

function backoff(ctx: Ctx, attempt: number): Promise<void> {
	return sleep(ctx.retryDelayMs * 2 ** (attempt - 1));
}

/** One attempt of a change; a definite refusal on the first attempt is thrown (the change did not happen). */
async function attemptChange<T>(
	ctx: Ctx,
	what: string,
	attempt: number,
	change: () => Promise<T>,
): Promise<Attempt<T>> {
	try {
		return { done: true, value: await change() };
	} catch (error) {
		if (error instanceof GitHubError && !error.transient && attempt === 0) throw error;
		ctx.log.warn("github_change_failed", { what, attempt, error: describeError(error) });
		return NOT_DONE;
	}
}

/** A retry: read GitHub's state first (Interfaces § Coordinator to GitHub); change again only if it is not done. */
async function retryAfterReading<T>(
	ctx: Ctx,
	what: string,
	attempt: number,
	change: () => Promise<T>,
	readBack: () => Promise<T | undefined>,
): Promise<Attempt<T>> {
	await backoff(ctx, attempt);
	let state: T | undefined;
	try {
		state = await readBack();
	} catch (error) {
		ctx.log.warn("github_readback_failed", { what, attempt, error: describeError(error) });
		return NOT_DONE;
	}
	if (state !== undefined) return { done: true, value: state };
	return attemptChange(ctx, what, attempt, change);
}

/**
 * A GitHub change, retried with backoff; before each retry `readBack` reads GitHub's state and returns the result
 * if the change already took effect (undefined = not done, try again). A definite refusal on the first attempt is
 * thrown as is (the change did not happen); an outcome still unknown after the attempts is an UnknownEffect.
 */
export async function ghChange<T>(
	ctx: Ctx,
	what: string,
	change: () => Promise<T>,
	readBack: () => Promise<T | undefined>,
): Promise<T> {
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const result =
			attempt === 0
				? await attemptChange(ctx, what, attempt, change)
				: await retryAfterReading(ctx, what, attempt, change, readBack);
		if (result.done) return result.value;
	}
	throw new UnknownEffect(`the outcome of ${what} on GitHub is unknown`);
}

/**
 * A push of a task branch. `expected`: where the Coordinator believes GitHub's branch is (the task's head_commit, the
 * last commit it pushed there, or the base commit before its first push).
 */
export type PushTarget = {
	readonly branch: string;
	readonly path: string;
	readonly head: string;
	readonly expected: string | null;
	/** Active tasks already published must not silently recreate a deleted branch. Terminal archives may. */
	readonly mustExist?: boolean;
};

/** One push attempt: GitHub holds `head`; not yet (try again); or refused although the branch had not moved. */
type PushAttempt = "pushed" | "again" | "refused";

/**
 * GitHub refused the push (not a fast-forward of its branch). Read the branch again: moved outside the Coordinator
 * (neither `head` nor `expected`) → BranchMoved, a definite outcome. Refused although the branch is still where the
 * Coordinator left it → "refused", an unexplained refusal (e.g. a branch rule): retried like any failed call, and if it
 * stays so the group freezes (fails closed). Unreadable or gone → the next attempt decides.
 */
async function classifyRefusal(ctx: Ctx, p: PushTarget, attempt: number): Promise<PushAttempt> {
	const remote = await ctx.git.remoteBranchSha(p.branch).catch(() => null);
	if (remote === undefined && p.mustExist) throw new BranchMoved(p.branch, null, p.head, "branch_deleted");
	if (remote === null || remote === undefined || remote === p.head) return "again";
	if (remote === p.expected) {
		ctx.log.warn("push_refused_unexplained", { branch: p.branch, attempt });
		return "refused";
	}
	ctx.log.warn("push_branch_moved", { branch: p.branch, attempt });
	throw new BranchMoved(p.branch, remote, p.head);
}

/** Compare with GitHub, then push if needed. */
async function pushOnce(ctx: Ctx, p: PushTarget, attempt: number): Promise<PushAttempt> {
	let remote: string | undefined;
	try {
		remote = await ctx.git.remoteBranchSha(p.branch);
	} catch (error) {
		ctx.log.warn("push_compare_failed", { branch: p.branch, attempt, error: describeError(error) });
		return "again";
	}
	if (remote === p.head) return "pushed";
	if (remote === undefined && p.mustExist) throw new BranchMoved(p.branch, null, p.head, "branch_deleted");
	try {
		await ctx.git.push(p.path, p.branch, { requireExisting: p.mustExist === true });
	} catch (error) {
		if (error instanceof GitError && error.code === "rejected") return classifyRefusal(ctx, p, attempt);
		ctx.log.warn("push_failed", { branch: p.branch, attempt, error: describeError(error) });
	}
	return "again";
}

/**
 * Push the task branch so GitHub holds `head` (no force). Compares with GitHub first; after the push GitHub must
 * report exactly `head`. GitHub refusing it because the branch changed outside the Coordinator → BranchMoved (a
 * definite outcome); a push still unconfirmed after the attempts (network errors, a lost answer that cannot be read
 * back, a refusal nothing explains) → UnknownEffect.
 */
export async function pushBranch(ctx: Ctx, p: PushTarget): Promise<void> {
	let last: PushAttempt = "again";
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		if (attempt > 0) await backoff(ctx, attempt);
		last = await pushOnce(ctx, p, attempt);
		if (last === "pushed") return;
	}
	const confirmed = await ctx.git.remoteBranchSha(p.branch).catch(() => null);
	if (confirmed === p.head) return;
	if (confirmed === undefined && p.mustExist) throw new BranchMoved(p.branch, null, p.head, "branch_deleted");
	if (last === "refused") throw new UnknownEffect(`GitHub refused the push of ${p.branch}`);
	throw new UnknownEffect(`the push of ${p.branch} could not be confirmed`);
}

/** pushBranch, with a branch moved outside the Coordinator returned instead of thrown. */
export async function pushOrMoved(ctx: Ctx, p: PushTarget): Promise<BranchMoved | undefined> {
	try {
		await pushBranch(ctx, p);
		return undefined;
	} catch (error) {
		if (error instanceof BranchMoved) return error;
		throw error;
	}
}

/**
 * The commit the Coordinator last pushed to the task's branch: its head_commit once a run's checkpoint was pushed
 * (runs.checkpoint_commit is set only then), else null (it never pushed the branch).
 */
export function lastPushed(ctx: Ctx, task: TaskRow): string | null {
	const pushed = ctx.store.get<{ n: number }>(
		"SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND checkpoint_commit IS NOT NULL",
		task.id,
	)?.n;
	return (pushed ?? 0) > 0 ? task.head_commit : null;
}

/**
 * Save a task's hold (inside a transaction) and look at its branch again after branchRecheckMs. True when it is new
 * or says something new (a message is due): a restart that redoes the same refused push posts nothing again.
 */
export function saveHold(ctx: Ctx, taskId: number, hold: BranchHold): boolean {
	const before = readBranchHold(ctx.store, taskId);
	ctx.store.setMeta(branchHoldKey(taskId), JSON.stringify(hold));
	ctx.heldDue.set(taskId, ctx.now() + ctx.branchRecheckMs);
	ctx.heldRestored.delete(taskId);
	return (
		before === undefined ||
		before.kind !== hold.kind ||
		before.local !== hold.local ||
		before.github !== hold.github ||
		before.cause !== hold.cause ||
		before.prNumber !== hold.prNumber
	);
}

/** Drop a task's hold (inside a transaction): its work is on GitHub, or the task no longer needs the push. */
export function clearHold(ctx: Ctx, taskId: number): void {
	ctx.store.run("DELETE FROM meta WHERE key = ?", branchHoldKey(taskId));
	ctx.heldDue.delete(taskId);
	ctx.heldRestored.delete(taskId);
}

/** The task's pull request: by number, else matched by repository, base and head branch (lost responses). */
export async function findTaskPullRequest(ctx: Ctx, task: TaskRow): Promise<PullRequest | undefined> {
	if (task.pr_number !== null) {
		const number = task.pr_number;
		return ghRead(ctx, "pull request", () => ctx.github.getPullRequest(number));
	}
	if (task.branch === null) return undefined;
	const branch = task.branch;
	const found = await ghRead(ctx, "pull request lookup", () =>
		ctx.github.findPullRequest(branch, ctx.config.github.baseBranch),
	);
	if (found !== undefined) bindPullRequest(ctx, task.id, found);
	return found;
}

/** Close an open pull request; a retry first reads it back. */
export async function closePullRequest(ctx: Ctx, number: number): Promise<PullRequest> {
	return ghChange(
		ctx,
		`closing pull request #${number}`,
		() => ctx.github.closePullRequest(number),
		async () => {
			const pr = await ctx.github.getPullRequest(number);
			return pr.state === "closed" ? pr : undefined;
		},
	);
}

/**
 * Open the task's pull request once, or update the existing one (one PR per task). Returns undefined when GitHub
 * refuses to open one because the branch has no commits beyond the base.
 */
export async function ensurePullRequest(
	ctx: Ctx,
	task: TaskRow,
	params: { title: string; body: string },
): Promise<PullRequest | undefined> {
	const branch = task.branch;
	if (branch === null) return undefined;
	const base = ctx.config.github.baseBranch;
	const update = async (pr: PullRequest): Promise<PullRequest> =>
		ghChange(
			ctx,
			`updating pull request #${pr.number}`,
			() => ctx.github.updatePullRequest(pr.number, { body: params.body }),
			async () => {
				// Read the state before retrying; an update carries no effect we could detect, so retry it.
				const current = await ctx.github.getPullRequest(pr.number);
				return current.state === "open" ? undefined : current;
			},
		);
	const existing = await findTaskPullRequest(ctx, loadTask(ctx, task.id));
	if (existing !== undefined) {
		bindPullRequest(ctx, task.id, existing);
		return existing.state === "open" && !existing.merged ? update(existing) : existing;
	}
	return createTaskPullRequest(ctx, task.id, branch, base, params);
}

async function createTaskPullRequest(
	ctx: Ctx,
	taskId: number,
	branch: string,
	base: string,
	params: { title: string; body: string },
): Promise<PullRequest | undefined> {
	try {
		const created = await ghChange(
			ctx,
			"opening the pull request",
			() => ctx.github.createPullRequest({ head: branch, base, title: params.title, body: params.body }),
			async () => {
				const found = await ctx.github.findPullRequest(branch, base);
				// A closed/merged PR still proves creation happened. Never retry creation in that case.
				return found;
			},
		);
		bindPullRequest(ctx, taskId, created);
		return created;
	} catch (error) {
		if (error instanceof GitHubError && error.status === 422) {
			const found = await ghRead(ctx, "pull request lookup", () => ctx.github.findPullRequest(branch, base));
			if (found !== undefined) bindPullRequest(ctx, taskId, found);
			return found;
		}
		throw error;
	}
}

/** Bind the first observed PR immediately, before later I/O can lose it. The mapping never changes. */
function bindPullRequest(ctx: Ctx, taskId: number, pr: PullRequest): void {
	tx(ctx, () => {
		const current = loadTask(ctx, taskId);
		if (current.pr_number !== null && current.pr_number !== pr.number)
			throw new UnknownEffect(`the original pull request of ${taskRef(taskId)} does not match GitHub`);
		ctx.store.run(
			"UPDATE tasks SET pr_number = COALESCE(pr_number, ?), pr_url = COALESCE(pr_url, ?) WHERE id = ?",
			pr.number,
			pr.url,
			taskId,
		);
	});
}

export type ArchiveResult = { readonly prClosed: boolean; readonly branchKept: boolean; readonly head: string | null };

/**
 * Archive a task's worktree (Architecture § Review and merge, last bullets): its run is finalized and verified
 * stopped already. For a failed or cancelled task: final checkpoint of everything left (untracked included,
 * .gitignore respected), push (compared with GitHub first), close the pull request, then delete the folder only
 * after GitHub confirms the push; the branch is kept. For a merged task the folder is just deleted. The completion
 * and `message(result)` are saved in one transaction. "held": GitHub refused the final push because the branch
 * changed outside the Coordinator, so the worktree is kept and the task held (holdArchive) until it is restored.
 */
export async function archiveTask(
	ctx: Ctx,
	taskId: number,
	message: ((result: ArchiveResult) => string) | undefined,
): Promise<"archived" | "held"> {
	// Fails closed: the final checkpoint commits and pushes everything left, so only once every effect is reconciled.
	if (effectsOpen(ctx.store, taskId))
		throw new UnknownEffect(`the file changes of ${taskRef(taskId)} are not reconciled`);
	const task = loadTask(ctx, taskId);
	const path = task.worktree_path;
	if (path === null) {
		await archiveWithoutWorktree(ctx, task, message);
		return "archived";
	}
	const saved = task.state === "merged" ? undefined : await saveAndClose(ctx, task, path);
	if (saved?.moved !== undefined) {
		holdArchive(ctx, task, { ...saved, moved: saved.moved });
		return "held";
	}
	if (existsSync(path)) await ctx.git.removeWorktree(path);
	else await ctx.git.removeWorktree(path).catch(() => undefined);
	const head = saved?.head ?? task.head_commit ?? task.base_commit;
	const pr = saved?.pr;
	const result: ArchiveResult = { prClosed: saved?.prClosed ?? false, branchKept: task.branch !== null, head };
	tx(ctx, () => {
		ctx.store.run(
			`UPDATE tasks SET worktree_path = NULL, archived = 1, head_commit = COALESCE(?, head_commit),
			   pr_number = COALESCE(pr_number, ?), pr_url = COALESCE(pr_url, ?), updated_at = ? WHERE id = ?`,
			head,
			pr?.number ?? null,
			pr?.url ?? null,
			ctx.now(),
			taskId,
		);
		clearHold(ctx, taskId);
		if (message !== undefined) enqueueTask(ctx, task, "task_final", message(result));
	});
	ctx.log.info("task_archived", { task: taskId, state: task.state, pr_closed: result.prClosed });
	return "archived";
}

/** Archive a failed or cancelled task (recovery, a held archive's retry) with its usual final message. */
export async function archiveEnded(ctx: Ctx, taskId: number): Promise<"archived" | "held"> {
	const task = loadTask(ctx, taskId);
	if (task.state === "merged") return archiveTask(ctx, taskId, undefined);
	const kind = task.state === "cancelled" ? "cancelled" : "failed";
	return archiveTask(ctx, taskId, (result) => terminalText(loadTask(ctx, taskId), kind, task.reason, result));
}

/** No worktree was recorded; a folder may exist if a crash came between creating and recording it. */
async function archiveWithoutWorktree(
	ctx: Ctx,
	task: TaskRow,
	message: ((result: ArchiveResult) => string) | undefined,
): Promise<void> {
	const stray = worktreePath(ctx, task.id);
	if (existsSync(stray)) await ctx.git.removeWorktree(stray).catch(() => undefined);
	const result: ArchiveResult = { prClosed: false, branchKept: false, head: null };
	if (message !== undefined) tx(ctx, () => enqueueTask(ctx, task, "task_final", message(result)));
}

type Saved = {
	readonly head: string | null;
	readonly pr: PullRequest | undefined;
	readonly prClosed: boolean;
	/** The final push was refused: the branch changed outside the Coordinator. */
	readonly moved: BranchMoved | undefined;
};

/**
 * Final checkpoint, push (confirmed by GitHub), close the pull request. A push refused because the branch moved still
 * closes the pull request (the task is over and nothing of it may merge), but the folder stays (archiveTask).
 */
async function saveAndClose(ctx: Ctx, task: TaskRow, path: string): Promise<Saved> {
	let head = task.head_commit ?? task.base_commit;
	if (existsSync(path)) head = (await ctx.git.checkpoint(path, `${taskRef(task.id)}: final checkpoint`)).commit;
	const moved =
		head !== null && task.branch !== null
			? await pushOrMoved(ctx, { branch: task.branch, path, head, expected: task.head_commit })
			: undefined;
	let pr = await findTaskPullRequest(ctx, task);
	if (pr !== undefined && pr.state === "open" && !pr.merged) pr = await closePullRequest(ctx, pr.number);
	return { head, pr, prClosed: pr !== undefined && pr.state === "closed" && !pr.merged, moved };
}

/** "Task 12 cancelled." / "Task 12 failed: <reason>.": the first sentence of a task's final message. */
export function terminalHead(id: number, kind: "failed" | "cancelled", reason: string | null): string {
	const why = reason === null || reason === "" || reason === "cancelled" ? "" : `: ${clipText(reason, 300)}`;
	return kind === "failed" ? `${taskRef(id)} failed${why || ": run failed"}.` : `${taskRef(id)} cancelled${why}.`;
}

/**
 * GitHub refused the final push of an ended task because its branch changed outside the Coordinator: keep the
 * worktree (the folder is deleted only after GitHub confirms the push), record the pull request, hold the task and
 * say so; the archive is redone once the branch is restored (engine/held.ts). Never freezes the group.
 */
function holdArchive(ctx: Ctx, task: TaskRow, saved: Saved & { readonly moved: BranchMoved }): void {
	const pushed = lastPushed(ctx, task);
	const { moved, pr } = saved;
	tx(ctx, () => {
		const now = ctx.now();
		const current = loadTask(ctx, task.id);
		ctx.store.run(
			"UPDATE tasks SET pr_number = COALESCE(pr_number, ?), pr_url = COALESCE(pr_url, ?), updated_at = ? WHERE id = ?",
			pr?.number ?? null,
			pr?.url ?? null,
			now,
			task.id,
		);
		const hold: BranchHold = {
			kind: "archive",
			runId: null,
			interrupted: false,
			branch: moved.branch,
			local: moved.local,
			pushed,
			github: moved.github,
			since: now,
		};
		if (!saveHold(ctx, task.id, hold)) return;
		const kind = current.state === "cancelled" ? "cancelled" : "failed";
		const facts = { taskId: task.id, branch: moved.branch, github: moved.github, local: moved.local, pushed };
		const lead = terminalHead(task.id, kind, current.reason);
		enqueueTask(ctx, current, "task_held", archiveHeld({ ...facts, lead, prClosed: saved.prClosed }));
	});
	ctx.log.warn("archive_held", { task: task.id, state: task.state, pr_closed: saved.prClosed });
}

/** "Task 12 failed: <reason>. Pull request closed; branch task/12 kept." / "Task 12 cancelled. …". */
export function terminalText(
	task: { id: number; branch: string | null },
	kind: "failed" | "cancelled",
	reason: string | null,
	result: ArchiveResult,
): string {
	const head = terminalHead(task.id, kind, reason);
	const tail = result.prClosed
		? ` Pull request closed; branch ${task.branch} kept.`
		: result.branchKept
			? ` Branch ${task.branch} kept.`
			: "";
	const hint = kind === "failed" ? " Send a new /task for further work." : "";
	return `${head}${tail}${hint}`;
}

/**
 * Report an effect error: an unknown effect freezes the group with its reason; any other unexpected failure of a
 * GitHub/git step also freezes it (fail closed), naming the step.
 */
export function effectFailed(ctx: Ctx, error: unknown, step: string): void {
	if (ctx.stopped) return;
	ctx.log.error("effect_failed", { step, error: describeError(error) });
	freezeGroup(ctx, error instanceof UnknownEffect ? error.message : `${step} failed`);
}
