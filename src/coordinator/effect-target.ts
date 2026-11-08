/**
 * The target of a file change, seen from the Coordinator (Agent Execution § Uncertain Effects: "Intent (target,
 * pre-hash, intended hash) is persisted before execution ... The target is inspected. If it matches the intended
 * result, it's 'applied'; if it matches the pre-hash, it's 'currently unchanged'. Anything else freezes the group.").
 *
 * A target's state is one string, compared for equality only:
 *   "absent"                    no file there (a missing parent directory included);
 *   "sha256:<hex>"              a regular file, by content;
 *   "symlink:<sha256 of link>"  a symbolic link, by its text (never followed);
 *   "directory" | "special"     not a regular file;
 *   "blocked:symlink" | "blocked:not-a-directory"   a parent the confined file operation refuses to pass.
 * The worktree is read on the host, never following a symbolic link (each parent is checked with lstat, the file is
 * opened with O_NOFOLLOW and must be the inode lstat saw) and confined to the worktree: the path must pass the same
 * policy as the tool call (relative, no "..", no ".git" segment). Metadata only: nothing here logs or returns content.
 *
 * The intended state of an `edit` mirrors deploy/docker/fsop.mjs (editOp): the file must be a regular UTF-8 text file
 * of at most 4 MiB without NUL bytes (a leading BOM is dropped, as its decoder does), `oldText` must occur exactly once
 * unless `replaceAll`, and the result must fit in 4 MiB. A change that the file operation would refuse intends no
 * change (intended = pre).
 */
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { confinePath } from "../runner/policy.ts";
import type { FsRequest } from "./ports.ts";

export const ABSENT = "absent";

/** fsop.mjs: the largest file `edit` reads, and the largest result it writes. */
export const MAX_EDIT_FILE_BYTES = 4 * 1024 * 1024;
/** fsop.mjs: the largest `write`. */
export const MAX_WRITE_BYTES = 1024 * 1024;

const READ_FLAGS =
	constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);
const CHUNK = 64 * 1024;

/** The target could not be inspected (the worktree is gone, a permission error, it changed while it was read). */
export class TargetUnreadable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TargetUnreadable";
	}
}

export function contentHash(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export type Inspected = {
	readonly state: string;
	/** The content of a regular file of at most `keepBytes` bytes (when asked for). */
	readonly bytes?: Buffer | undefined;
};

async function lstatOrAbsent(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (code === "ENOENT") return undefined;
		throw new TargetUnreadable(`the target could not be inspected (${typeof code === "string" ? code : "error"})`);
	}
}

/** The worktree's real path; refuses a missing root (nothing can be told about its files). */
async function rootOf(worktree: string): Promise<string> {
	try {
		const root = await realpath(worktree);
		if (!(await lstat(root)).isDirectory()) throw new TargetUnreadable("the worktree is not a directory");
		return root;
	} catch (error) {
		if (error instanceof TargetUnreadable) throw error;
		throw new TargetUnreadable("the worktree is missing");
	}
}

/** Hash a regular file opened without following links; it must be the inode `expected` (lstat) describes. */
async function hashFile(
	path: string,
	expected: { readonly dev: number; readonly ino: number },
	keepBytes: number,
): Promise<Inspected> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, READ_FLAGS);
	} catch {
		throw new TargetUnreadable("the target could not be opened");
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
			throw new TargetUnreadable("the target changed while it was inspected");
		}
		const hash = createHash("sha256");
		const kept: Buffer[] = [];
		let keptBytes = 0;
		const buffer = Buffer.alloc(CHUNK);
		for (let position = 0; ; ) {
			const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			hash.update(chunk);
			if (keptBytes <= keepBytes) {
				kept.push(Buffer.from(chunk));
				keptBytes += bytesRead;
			}
			position += bytesRead;
		}
		const state = `sha256:${hash.digest("hex")}`;
		return keptBytes <= keepBytes ? { state, bytes: Buffer.concat(kept) } : { state };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** Walk the parents of `segments` under `root` with lstat: the target's path, or the state that ends the walk. */
async function walkParents(root: string, segments: readonly string[]): Promise<{ target: string } | { state: string }> {
	let current = root;
	for (const segment of segments.slice(0, -1)) {
		current = join(current, segment);
		const stat = await lstatOrAbsent(current);
		if (stat === undefined) return { state: ABSENT };
		if (stat.isSymbolicLink()) return { state: "blocked:symlink" };
		if (!stat.isDirectory()) return { state: "blocked:not-a-directory" };
	}
	return { target: join(current, segments[segments.length - 1] as string) };
}

/**
 * The state of `path` in `worktree` (see the module comment); with `keepBytes`, also the content of a regular file of
 * at most that many bytes. Throws TargetUnreadable when it cannot be told; a path the policy refuses is refused here.
 */
export async function inspectTarget(worktree: string, path: string, keepBytes = -1): Promise<Inspected> {
	const confined = confinePath(path);
	if (!confined.ok) throw new TargetUnreadable("the path is not confined to the worktree");
	const walked = await walkParents(await rootOf(worktree), confined.path.split("/"));
	if ("state" in walked) return { state: walked.state };
	const target = walked.target;
	const stat = await lstatOrAbsent(target);
	if (stat === undefined) return { state: ABSENT };
	if (stat.isSymbolicLink()) {
		const link = await readlink(target).catch(() => {
			throw new TargetUnreadable("the link could not be read");
		});
		return { state: `symlink:${createHash("sha256").update(link).digest("hex")}` };
	}
	if (stat.isDirectory()) return { state: "directory" };
	if (!stat.isFile()) return { state: "special" };
	return hashFile(target, { dev: Number(stat.dev), ino: Number(stat.ino) }, keepBytes);
}

/** The state of `path` in `worktree` (inspectTarget without content). */
export async function targetState(worktree: string, path: string): Promise<string> {
	return (await inspectTarget(worktree, path)).state;
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) count++;
	return count;
}

/** The file after `edit` as fsop.mjs computes it, or undefined where fsop.mjs refuses the edit (no change). */
export function editedContent(
	bytes: Buffer,
	edit: { readonly oldText: string; readonly newText: string; readonly replaceAll?: boolean | undefined },
): Buffer | undefined {
	if (bytes.length > MAX_EDIT_FILE_BYTES || bytes.includes(0) || edit.oldText.length === 0) return undefined;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
	const count = countOccurrences(text, edit.oldText);
	if (count === 0 || (count > 1 && edit.replaceAll !== true)) return undefined;
	const data = Buffer.from(text.split(edit.oldText).join(edit.newText), "utf8");
	return data.length > MAX_EDIT_FILE_BYTES ? undefined : data;
}

export type PlannedChange = {
	readonly tool: "edit" | "write";
	/** The canonical worktree-relative target. */
	readonly path: string;
	readonly pre: string;
	readonly intended: string;
};

/** States a file operation cannot turn into a file: a change there can only be refused. */
function unchangeable(state: string): boolean {
	return state !== ABSENT && !state.startsWith("sha256:");
}

/**
 * The intent of an `edit` or `write` before it runs: its target, the target's state now, and the state if the change
 * applies (equal to now when the file operation would refuse it). Throws TargetUnreadable when the target cannot be
 * inspected (the change must not run then: its outcome could never be reconciled).
 */
export async function planFileChange(
	worktree: string,
	request: Extract<FsRequest, { op: "edit" | "write" }>,
): Promise<PlannedChange> {
	const confined = confinePath(request.path);
	if (!confined.ok) throw new TargetUnreadable("the path is not confined to the worktree");
	const path = confined.path;
	if (request.op === "write") {
		const pre = await targetState(worktree, path);
		const data = Buffer.from(request.content, "utf8");
		const intended = unchangeable(pre) || data.length > MAX_WRITE_BYTES ? pre : contentHash(data);
		return { tool: "write", path, pre, intended };
	}
	const inspected = await inspectTarget(worktree, path, MAX_EDIT_FILE_BYTES);
	const edited = inspected.bytes === undefined ? undefined : editedContent(inspected.bytes, request);
	return {
		tool: "edit",
		path,
		pre: inspected.state,
		intended: edited === undefined ? inspected.state : contentHash(edited),
	};
}

export type Reconciled = "applied" | "unchanged" | "unresolved";

/**
 * Agent Execution § Uncertain Effects, step 3: the observed target against the intent. Matching the state before
 * reads as "currently unchanged" (also when the change intended no difference); else matching the intended result is
 * "applied"; anything else is unresolved (the group freezes).
 */
export function classifyTarget(observed: string, pre: string, intended: string): Reconciled {
	if (observed === pre) return "unchanged";
	if (observed === intended) return "applied";
	return "unresolved";
}
