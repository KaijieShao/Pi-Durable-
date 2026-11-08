/**
 * Effects outside SQLite: pushes and GitHub changes (Interfaces and Storage § Coordinator to GitHub). A change is
 * retried only after reading GitHub's current state ("find PR by head/base before creating; compare branch before
 * pushing; check main contains head before merging again"); an outcome that stays unknown raises `UnknownEffect`,
 * and the caller freezes the group.
 */
import { existsSync } from "node:fs";
import { GitError } from "../git.ts";
import { GitHubError, type PullRequest } from "../ports.ts";
import {
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

/** Compare with GitHub, then push if needed. True once GitHub already holds `head`. */
async function pushOnce(ctx: Ctx, branch: string, path: string, head: string, attempt: number): Promise<boolean> {
	let remote: string | undefined;
	try {
		remote = await ctx.git.remoteBranchSha(branch);
	} catch (error) {
		ctx.log.warn("push_compare_failed", { branch, attempt, error: describeError(error) });
		return false;
	}
	if (remote === head) return true;
	try {
		await ctx.git.push(path, branch);
	} catch (error) {
		if (error instanceof GitError && error.code === "rejected") {
			throw new UnknownEffect(`GitHub rejected the push of ${branch} (the remote branch changed)`);
		}
		ctx.log.warn("push_failed", { branch, attempt, error: describeError(error) });
	}
	return false;
}

/**
 * Push the task branch so GitHub holds `head` (no force). Compares with GitHub first; after the push GitHub must
 * report exactly `head`. A rejected push (the remote branch moved) or an unconfirmed one is an unknown effect.
 */
export async function pushBranch(ctx: Ctx, branch: string, path: string, head: string): Promise<void> {
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		if (attempt > 0) await backoff(ctx, attempt);
		if (await pushOnce(ctx, branch, path, head, attempt)) return;
	}
	const confirmed = await ctx.git.remoteBranchSha(branch).catch(() => undefined);
	if (confirmed === head) return;
	throw new UnknownEffect(`the push of ${branch} could not be confirmed`);
}

/** The task's pull request: by number, else matched by repository, base and head branch (lost responses). */
export async function findTaskPullRequest(ctx: Ctx, task: TaskRow): Promise<PullRequest | undefined> {
	if (task.pr_number !== null) {
		const number = task.pr_number;
		return ghRead(ctx, "pull request", () => ctx.github.getPullRequest(number));
	}
	if (task.branch === null) return undefined;
	const branch = task.branch;
	return ghRead(ctx, "pull request lookup", () => ctx.github.findPullRequest(branch, ctx.config.github.baseBranch));
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
	let existing = await findTaskPullRequest(ctx, task);
	if (existing !== undefined && existing.state !== "open" && task.pr_number !== null) {
		// The recorded PR was closed outside the Coordinator: look for an open one for the same head/base.
		existing = await ghRead(ctx, "pull request lookup", () => ctx.github.findPullRequest(branch, base));
	}
	if (existing !== undefined && existing.state === "open") return update(existing);
	try {
		return await ghChange(
			ctx,
			"opening the pull request",
			() => ctx.github.createPullRequest({ head: branch, base, title: params.title, body: params.body }),
			async () => {
				const found = await ctx.github.findPullRequest(branch, base);
				return found !== undefined && found.state === "open" ? found : undefined;
			},
		);
	} catch (error) {
		if (error instanceof GitHubError && error.status === 422) return undefined;
		throw error;
	}
}

export type ArchiveResult = { readonly prClosed: boolean; readonly branchKept: boolean; readonly head: string | null };

/**
 * Archive a task's worktree (Architecture § Review and merge, last bullets): its run is finalized and verified
 * stopped already. For a failed or cancelled task: final checkpoint of everything left (untracked included,
 * .gitignore respected), push (compared with GitHub first), close the pull request, then delete the folder only
 * after GitHub confirms the push; the branch is kept. For a merged task the folder is just deleted. The completion
 * and `message(result)` are saved in one transaction.
 */
export async function archiveTask(
	ctx: Ctx,
	taskId: number,
	message: ((result: ArchiveResult) => string) | undefined,
): Promise<void> {
	const task = loadTask(ctx, taskId);
	const path = task.worktree_path;
	if (path === null) return archiveWithoutWorktree(ctx, task, message);
	const saved = task.state === "merged" ? undefined : await saveAndClose(ctx, task, path);
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
		if (message !== undefined) enqueueTask(ctx, task, "task_final", message(result));
	});
	ctx.log.info("task_archived", { task: taskId, state: task.state, pr_closed: result.prClosed });
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

/** Final checkpoint, push (confirmed by GitHub), close the pull request. */
async function saveAndClose(
	ctx: Ctx,
	task: TaskRow,
	path: string,
): Promise<{ head: string | null; pr: PullRequest | undefined; prClosed: boolean }> {
	let head = task.head_commit ?? task.base_commit;
	if (existsSync(path)) head = (await ctx.git.checkpoint(path, `${taskRef(task.id)}: final checkpoint`)).commit;
	if (head !== null && task.branch !== null) await pushBranch(ctx, task.branch, path, head);
	let pr = await findTaskPullRequest(ctx, task);
	if (pr !== undefined && pr.state === "open" && !pr.merged) pr = await closePullRequest(ctx, pr.number);
	return { head, pr, prClosed: pr !== undefined && pr.state === "closed" && !pr.merged };
}

/** "Task 12 failed: <reason>. Pull request closed; branch task/12 kept." / "Task 12 cancelled. …". */
export function terminalText(
	task: { id: number; branch: string | null },
	kind: "failed" | "cancelled",
	reason: string | null,
	result: ArchiveResult,
): string {
	const why = reason === null || reason === "" || reason === "cancelled" ? "" : `: ${clipText(reason, 300)}`;
	const head =
		kind === "failed" ? `${taskRef(task.id)} failed${why || ": run failed"}.` : `${taskRef(task.id)} cancelled${why}.`;
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
