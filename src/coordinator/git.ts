import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { errorSummary, type Logger } from "../runtime/log.ts";
import { redact } from "../runtime/redact.ts";

/**
 * The only place that runs git (Architecture § Git repository and GitHub). The project code is untrusted, so every
 * invocation disables hooks, fsmonitor, system/global config and in-tree attributes (no clean/smudge filters, diff
 * or merge drivers), never discovers a repository on its own (explicit --git-dir everywhere) and starts from an empty
 * environment. The GitHub token reaches git only through GIT_CONFIG_COUNT environment variables of network
 * operations: never argv, a URL, the repository config or a log line.
 *
 * Layout: a bare repository at `<taskDir>/repo.git` (main fetched into `refs/remotes/origin/<base>`), one linked
 * worktree of it per open task. The remote URL is passed explicitly on fetch/push; nothing relies on local config.
 */

export type GitErrorCode = "conflict" | "rejected" | "timeout" | "failed";

export class GitError extends Error {
	readonly code: GitErrorCode;
	readonly exitCode: number | undefined;
	/** Redacted, capped stderr for diagnostics (may name files and refs): never logged by this module. */
	readonly stderr: string;
	constructor(code: GitErrorCode, message: string, details: { exitCode?: number | undefined; stderr?: string } = {}) {
		super(message);
		this.name = "GitError";
		this.code = code;
		this.exitCode = details.exitCode;
		this.stderr = details.stderr ?? "";
	}
}

export type MergeBaseResult =
	/** `moved` = a merge commit was created because the base had commits the branch lacked. */
	| { readonly conflict: false; readonly commit: string; readonly moved: boolean }
	/** Nothing merged; the merge stays in progress in the worktree (MERGE_HEAD, conflict markers). */
	| { readonly conflict: true; readonly files: string[] };

/** One uncommitted change of a worktree against its last checkpoint (HEAD). */
export type WorktreeChange = { readonly path: string; readonly change: "new" | "modified" | "deleted" | "conflict" };

export type Git = {
	ensureRepo(): Promise<void>;
	/** Fetch the base branch into `baseRef`; returns its commit. */
	fetchBase(): Promise<string>;
	/** The branch's commit on the remote (GitHub), or undefined if it does not exist there. */
	remoteBranchSha(branch: string): Promise<string | undefined>;
	createWorktree(branch: string, path: string, base: string): Promise<void>;
	/** Delete the worktree folder and its registration; the branch is kept. */
	removeWorktree(path: string): Promise<void>;
	/**
	 * True if `path` is this repository's worktree, checked out on `branch` at commit `base`, with nothing staged,
	 * changed or untracked (ignored files allowed). Never throws for a missing or foreign path (false).
	 */
	isPristineWorktree(path: string, branch: string, base: string): Promise<boolean>;
	/**
	 * Delete a local branch that has no commits of its own: its tip is still `createdAt` (the commit it was created
	 * at), or is on the fetched base branch. A missing branch is fine. A branch with commits of its own, or one
	 * checked out in a worktree, is refused (GitError).
	 */
	deleteBranch(branch: string, createdAt?: string): Promise<void>;
	head(path: string): Promise<string>;
	/** Stage everything (untracked included, .gitignore respected) and commit if anything changed or a merge is open. */
	checkpoint(path: string, message: string): Promise<{ commit: string; created: boolean }>;
	/** Push HEAD to refs/heads/<branch>; never forced. Non-fast-forward → GitError "rejected". */
	push(path: string, branch: string): Promise<void>;
	/** Merge the fetched base (`baseRef`) into the worktree's branch with a merge commit. */
	mergeBase(path: string): Promise<MergeBaseResult>;
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	changedFiles(base: string, head: string): Promise<string[]>;
	/**
	 * Stat + patch of the worktree against `base`, untracked files included (.gitignore respected: what the next
	 * checkpoint would commit), capped at `maxBytes` (marked "[truncated]"). The worktree's own index is not touched.
	 */
	diffSummary(path: string, base: string, maxBytes: number): Promise<string>;
	/**
	 * What the worktree holds beyond its last checkpoint (HEAD): changed, deleted, new (untracked, .gitignore respected)
	 * and conflicted files, sorted. Read only (no optional locks, nothing staged).
	 */
	uncommittedChanges(path: string): Promise<WorktreeChange[]>;
	/** A file's content at `rev` (capped at 1 MiB), or undefined if it is not a file there. */
	showFile(rev: string, path: string): Promise<string | undefined>;
	/**
	 * Bytes a checkout of `rev` takes on disk, estimated from the sizes git records: every file rounded up to whole
	 * 4 KiB blocks (an empty file counts one block); submodules count nothing (Capacity § Disk, src/coordinator/disk.ts).
	 */
	checkoutBytes(rev: string): Promise<number>;
	/** The tree id of commit `rev` (the git object hash of its content). */
	treeId(rev: string): Promise<string>;
	/**
	 * Write the files of commit `rev` into `dest`, an existing empty directory inside the task directory (not the
	 * repository): the tree `git archive` would hold, without any git data. Through a scratch index (read-tree, then
	 * checkout-index into `dest`), so git's own path checks apply and the repository's index is never touched.
	 */
	exportTree(rev: string, dest: string): Promise<void>;
	/** refs/remotes/origin/<base> */
	readonly baseRef: string;
};

export type GitAuthor = { readonly name: string; readonly email: string };

export type GitOptions = {
	readonly taskDir: string;
	/** https://github.com/<repo>.git in production; a local path or file:// URL in tests. */
	readonly remoteUrl: string;
	readonly baseBranch: string;
	readonly token: string | undefined;
	readonly author: GitAuthor;
	readonly log: Logger;
	/** Defaults: local 30 s, network 120 s. */
	readonly timeouts?: { readonly localMs?: number; readonly networkMs?: number };
	/** git executable (default "git", resolved through PATH). */
	readonly bin?: string;
};

/** Git's well-known empty tree: used as the attribute source so the worktree's .gitattributes are never read. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const SHOW_FILE_MAX_BYTES = 1024 * 1024;
/** The block a checked-out file is rounded up to in checkoutBytes(). */
const CHECKOUT_BLOCK_BYTES = 4096;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TRUNCATED = "\n[truncated]";

export function isLocalRemote(remoteUrl: string): boolean {
	return remoteUrl.startsWith("file://") || isAbsolute(remoteUrl);
}

/** Config passed with `-c` on every invocation (command-line config wins over every config file). */
export function hardeningConfig(remoteUrl: string): string[] {
	const config = [
		"core.hooksPath=/dev/null",
		"core.fsmonitor=false",
		"core.symlinks=true",
		"protocol.allow=never",
		"protocol.https.allow=always",
		// Additive hardening beyond the blueprint's list (same intent: untrusted code, our config only).
		"core.attributesFile=/dev/null",
		`attr.tree=${EMPTY_TREE}`,
		"safe.bareRepository=explicit",
		"credential.helper=",
		"http.followRedirects=false",
		"commit.gpgSign=false",
		"gc.autoDetach=false",
		"maintenance.autoDetach=false",
	];
	if (isLocalRemote(remoteUrl)) config.push("protocol.file.allow=always");
	return config;
}

export type GitInvocation = { readonly argv: string[]; readonly env: Record<string, string> };

/**
 * argv and environment for one git call. The environment is built from scratch (only PATH is inherited). The token
 * is added only for network calls to an https remote, as an extra header scoped to the remote's origin.
 */
export function buildGitInvocation(options: {
	readonly args: readonly string[];
	readonly remoteUrl: string;
	readonly token: string | undefined;
	readonly network: boolean;
	readonly home: string;
	readonly author: GitAuthor;
	readonly path?: string | undefined;
	/** A scratch index (GIT_INDEX_FILE) for one call; never inherited from the Coordinator's environment. */
	readonly indexFile?: string | undefined;
}): GitInvocation {
	const argv = [...hardeningConfig(options.remoteUrl).flatMap((entry) => ["-c", entry]), ...options.args];
	const env: Record<string, string> = {
		PATH: options.path ?? process.env.PATH ?? "/usr/bin:/bin",
		HOME: options.home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ATTR_SOURCE: EMPTY_TREE,
		GIT_AUTHOR_NAME: options.author.name,
		GIT_AUTHOR_EMAIL: options.author.email,
		GIT_COMMITTER_NAME: options.author.name,
		GIT_COMMITTER_EMAIL: options.author.email,
		LC_ALL: "C",
	};
	if (options.indexFile !== undefined) env.GIT_INDEX_FILE = options.indexFile;
	const header = options.network ? authHeader(options.remoteUrl, options.token) : undefined;
	if (header !== undefined) {
		env.GIT_CONFIG_COUNT = "1";
		env.GIT_CONFIG_KEY_0 = header.key;
		env.GIT_CONFIG_VALUE_0 = header.value;
	}
	return { argv, env };
}

function authHeader(remoteUrl: string, token: string | undefined): { key: string; value: string } | undefined {
	if (token === undefined || token === "" || isLocalRemote(remoteUrl)) return undefined;
	const url = new URL(remoteUrl);
	if (url.protocol !== "https:") return undefined;
	const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
	return { key: `http.${url.origin}/.extraheader`, value: `AUTHORIZATION: basic ${basic}` };
}

/** True for a path with a `.git` component (any case, trailing dots/spaces, 8.3 short name, ignorable chars). */
export function isGitInternalPath(path: string): boolean {
	return path.split(/[/\\]/).some((segment) => {
		const name = segment
			.replace(/[​-‏‪-‮⁪-⁯﻿]/g, "")
			.replace(/[. ]+$/, "")
			.toLowerCase();
		return name === ".git" || name === "git~1";
	});
}

function validRemote(remoteUrl: string): boolean {
	if (isLocalRemote(remoteUrl)) return true;
	try {
		const url = new URL(remoteUrl);
		return url.protocol === "https:" && url.username === "" && url.password === "";
	} catch {
		return false;
	}
}

function assertBranch(branch: string): void {
	const ok =
		/^[A-Za-z0-9._/-]{1,200}$/.test(branch) &&
		!branch.startsWith("-") &&
		!branch.startsWith("/") &&
		!branch.endsWith("/") &&
		!branch.includes("..") &&
		!branch.includes("//") &&
		!branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock") || part.endsWith("."));
	if (!ok) throw new GitError("failed", "invalid branch name");
}

function assertRev(rev: string): void {
	if (!/^[A-Za-z0-9._/^~{}-]{1,256}$/.test(rev) || rev.startsWith("-"))
		throw new GitError("failed", "invalid revision");
}

function assertRepoPath(path: string): void {
	const ok =
		path !== "" &&
		!isAbsolute(path) &&
		!path.includes("\0") &&
		!path.startsWith("-") &&
		!path.split("/").some((part) => part === ".." || part === ".");
	if (!ok) throw new GitError("failed", "invalid repository path");
}

type RawResult = {
	readonly code: number | null;
	readonly stdout: Buffer;
	readonly stderr: string;
	readonly truncated: boolean;
	readonly overflow: boolean;
	readonly timedOut: boolean;
};

type SpawnLimits = { readonly timeoutMs: number; readonly maxStdoutBytes: number; readonly truncate: boolean };

/** Bounded output buffer: keeps at most `max` bytes; `push` returns false once something was dropped. */
class Capped {
	readonly #chunks: Buffer[] = [];
	readonly #max: number;
	#bytes = 0;
	constructor(max: number) {
		this.#max = max;
	}
	push(chunk: Buffer): boolean {
		const room = this.#max - this.#bytes;
		if (room <= 0) return chunk.length === 0;
		this.#chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
		this.#bytes += Math.min(chunk.length, room);
		return chunk.length <= room;
	}
	get buffer(): Buffer {
		return Buffer.concat(this.#chunks);
	}
}

/** Run git in its own process group, so a timeout also kills remote helpers (git-remote-https). */
function spawnGit(bin: string, invocation: GitInvocation, limits: SpawnLimits): Promise<RawResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(bin, invocation.argv, {
			env: invocation.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const out = new Capped(limits.maxStdoutBytes);
		const err = new Capped(MAX_STDERR_BYTES);
		const state = { truncated: false, overflow: false, timedOut: false };
		const killGroup = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			state.timedOut = true;
			killGroup();
		}, limits.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			if (state.truncated || state.overflow || out.push(chunk)) return;
			if (limits.truncate) state.truncated = true;
			else state.overflow = true;
			killGroup();
		});
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code, stdout: out.buffer, stderr: err.buffer.toString("utf8"), ...state });
		});
	});
}

type ExecOptions = {
	readonly op: string;
	readonly network?: boolean;
	readonly okCodes?: readonly number[];
	readonly maxStdoutBytes?: number;
	readonly truncate?: boolean;
	/** Remove lock files a killed git process may have left (only called when we hold the matching mutex). */
	readonly onTimeout?: () => Promise<void>;
	/** GIT_INDEX_FILE for this call (an absolute path of a scratch index). */
	readonly indexFile?: string;
};

type ExecResult = {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly truncated: boolean;
};

export function createGit(options: GitOptions): Git {
	if (!validRemote(options.remoteUrl)) throw new GitError("failed", "remote URL must be https:// or a local path");
	assertBranch(options.baseBranch);
	const { log, remoteUrl, author, token } = options;
	const bin = options.bin ?? "git";
	const taskDir = resolve(options.taskDir);
	const repoDir = join(taskDir, "repo.git");
	const home = join(taskDir, "git-home");
	const baseBranch = options.baseBranch;
	const baseRef = `refs/remotes/origin/${baseBranch}`;
	const localMs = options.timeouts?.localMs ?? 30_000;
	const networkMs = options.timeouts?.networkMs ?? 120_000;
	const repo = ["--git-dir", repoDir];
	const queues = new Map<string, Promise<void>>();
	let homeReady: Promise<void> | undefined;

	/** One git process at a time per resource (the bare repo's shared refs, or one worktree). */
	function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = queues.get(key) ?? Promise.resolve();
		const result = previous.then(fn);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		queues.set(key, tail);
		void tail.then(() => {
			if (queues.get(key) === tail) queues.delete(key);
		});
		return result;
	}

	async function exec(args: readonly string[], execOptions: ExecOptions): Promise<ExecResult> {
		homeReady ??= mkdir(home, { recursive: true, mode: 0o700 }).then(() => undefined);
		await homeReady;
		const network = execOptions.network === true;
		const timeoutMs = network ? networkMs : localMs;
		const indexFile = execOptions.indexFile;
		const invocation = buildGitInvocation({ args, remoteUrl, token, network, home, author, indexFile });
		const started = Date.now();
		let raw: RawResult;
		try {
			raw = await spawnGit(bin, invocation, {
				timeoutMs,
				maxStdoutBytes: execOptions.maxStdoutBytes ?? MAX_STDOUT_BYTES,
				truncate: execOptions.truncate === true,
			});
		} catch (error) {
			log.warn("git_spawn_failed", { op: execOptions.op, error: errorSummary(error) });
			throw new GitError("failed", `git ${execOptions.op} could not start`);
		}
		return settle(execOptions, raw, Date.now() - started, timeoutMs);
	}

	async function settle(execOptions: ExecOptions, raw: RawResult, ms: number, timeoutMs: number): Promise<ExecResult> {
		const op = execOptions.op;
		const stderr = redact(raw.stderr).slice(0, 4000);
		if (raw.timedOut) {
			log.warn("git_timeout", { op, ms });
			await execOptions.onTimeout?.().catch(() => undefined);
			throw new GitError("timeout", `git ${op} timed out after ${timeoutMs} ms`, { stderr });
		}
		if (raw.overflow) throw new GitError("failed", `git ${op} output exceeded the limit`);
		const code = raw.truncated ? 0 : (raw.code ?? -1);
		if (!(execOptions.okCodes ?? [0]).includes(code)) {
			log.warn("git_failed", { op, exit: code, ms });
			throw new GitError("failed", `git ${op} failed (exit ${code})`, { exitCode: code, stderr });
		}
		log.debug("git", { op, exit: code, ms });
		return { code, stdout: raw.stdout.toString("utf8"), stderr, truncated: raw.truncated };
	}

	/** `--git-dir <admin dir> --work-tree <path>` for a linked worktree of our repository; no discovery. */
	async function worktreeArgs(path: string): Promise<string[]> {
		const target = resolve(path);
		const gitdir = await worktreeGitDir(target);
		if (gitdir === undefined) throw new GitError("failed", "not a worktree of the task repository");
		return ["--git-dir", gitdir, "--work-tree", target];
	}

	async function worktreeGitDir(target: string): Promise<string | undefined> {
		try {
			const dotGit = join(target, ".git");
			if (!(await lstat(dotGit)).isFile()) return undefined;
			const line = (await readFile(dotGit, "utf8")).split("\n")[0] ?? "";
			const match = /^gitdir: (.+)$/.exec(line.trim());
			if (match?.[1] === undefined) return undefined;
			const gitdir = resolve(target, match[1]);
			// Compare real paths: git records them resolved (e.g. /private/var on macOS, a symlinked task disk).
			const expected = await realpath(join(repoDir, "worktrees"));
			return (await realpath(dirname(gitdir))) === expected ? gitdir : undefined;
		} catch {
			return undefined;
		}
	}

	const clearIndexLock = (path: string) => async () => {
		const gitdir = await worktreeGitDir(resolve(path));
		if (gitdir !== undefined) await rm(join(gitdir, "index.lock"), { force: true });
	};

	async function revParse(prefix: readonly string[], rev: string): Promise<string> {
		const result = await exec([...prefix, "rev-parse", "--verify", `${rev}^{commit}`], {
			op: "rev-parse",
		});
		return result.stdout.trim();
	}

	async function maybeRef(prefix: readonly string[], ref: string): Promise<string | undefined> {
		const result = await exec([...prefix, "rev-parse", "-q", "--verify", `${ref}^{commit}`], {
			op: "rev-parse",
			okCodes: [0, 1],
		});
		return result.code === 0 ? result.stdout.trim() : undefined;
	}

	async function ancestor(ancestorRev: string, descendant: string): Promise<boolean> {
		const result = await exec([...repo, "merge-base", "--is-ancestor", ancestorRev, descendant], {
			op: "merge-base",
			okCodes: [0, 1],
		});
		return result.code === 0;
	}

	function nulList(stdout: string): string[] {
		return stdout.split("\0").filter((entry) => entry !== "");
	}

	async function unmergedFiles(wt: readonly string[]): Promise<string[]> {
		const result = await exec([...wt, "ls-files", "-u", "-z"], { op: "ls-files" });
		const files = nulList(result.stdout).map((entry) => entry.slice(entry.indexOf("\t") + 1));
		return [...new Set(files)].sort();
	}

	async function assertClean(wt: readonly string[]): Promise<void> {
		const status = await exec([...wt, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { op: "status" });
		if (status.stdout !== "") throw new GitError("failed", "worktree has uncommitted changes");
	}

	async function initRepo(): Promise<void> {
		await mkdir(taskDir, { recursive: true, mode: 0o700 });
		if (!existsSync(join(repoDir, "HEAD"))) {
			await exec(["-c", `init.defaultBranch=${baseBranch}`, "init", "--quiet", "--bare", "--template=", repoDir], {
				op: "init",
			});
		}
		const bare = await exec([...repo, "rev-parse", "--is-bare-repository"], { op: "rev-parse" });
		if (bare.stdout.trim() !== "true") throw new GitError("failed", "task repository is not a bare repository");
	}

	async function fetchRemoteBase(): Promise<string> {
		await exec(
			[
				...repo,
				"fetch",
				"--quiet",
				"--no-tags",
				"--no-recurse-submodules",
				"--no-write-fetch-head",
				remoteUrl,
				`+refs/heads/${baseBranch}:${baseRef}`,
			],
			{ op: "fetch", network: true, onTimeout: () => rm(join(repoDir, `${baseRef}.lock`), { force: true }) },
		);
		return revParse(repo, baseRef);
	}

	async function lsRemote(branch: string): Promise<string | undefined> {
		assertBranch(branch);
		const ref = `refs/heads/${branch}`;
		const result = await exec([...repo, "ls-remote", "--refs", remoteUrl, ref], { op: "ls-remote", network: true });
		for (const line of result.stdout.split("\n")) {
			const [sha, name] = line.trim().split("\t");
			if (name === ref && sha !== undefined && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
		}
		return undefined;
	}

	/** A path that already exists counts as created only if it is our clean worktree on `branch` at `base`. */
	async function adoptExisting(target: string, branch: string, base: string): Promise<void> {
		const wt = await worktreeArgs(target);
		const current = await exec([...wt, "symbolic-ref", "-q", "HEAD"], { op: "symbolic-ref", okCodes: [0, 1] });
		const head = await maybeRef(wt, "HEAD");
		const baseSha = await revParse(repo, base);
		if (current.stdout.trim() !== `refs/heads/${branch}` || head !== baseSha)
			throw new GitError("failed", "worktree path already exists");
		await assertClean(wt);
	}

	async function pristine(path: string, branch: string, base: string): Promise<boolean> {
		assertBranch(branch);
		assertRev(base);
		const target = resolve(path);
		if (!existsSync(target)) return false;
		try {
			await adoptExisting(target, branch, base);
			return true;
		} catch (error) {
			if (error instanceof GitError) return false;
			throw error;
		}
	}

	async function dropBranch(branch: string, createdAt: string | undefined): Promise<void> {
		assertBranch(branch);
		if (createdAt !== undefined) assertRev(createdAt);
		const tip = await maybeRef(repo, `refs/heads/${branch}`);
		if (tip === undefined) return;
		if (tip !== createdAt && !(await ancestor(tip, baseRef)))
			throw new GitError("failed", "refusing to delete a branch with commits of its own");
		await exec([...repo, "worktree", "prune"], { op: "worktree-prune" });
		await exec([...repo, "branch", "-D", branch], { op: "branch-delete" });
	}

	async function addWorktree(branch: string, path: string, base: string): Promise<void> {
		assertBranch(branch);
		assertRev(base);
		const target = resolve(path);
		await exec([...repo, "worktree", "prune"], { op: "worktree-prune" });
		if (existsSync(target)) return adoptExisting(target, branch, base);
		const baseSha = await revParse(repo, base);
		const tip = await maybeRef(repo, `refs/heads/${branch}`);
		if (tip !== undefined && tip !== baseSha) throw new GitError("failed", "branch already exists at another commit");
		const args =
			tip === undefined
				? ["worktree", "add", "--quiet", "--no-track", "-b", branch, target, baseSha]
				: ["worktree", "add", "--quiet", target, branch];
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		try {
			await exec([...repo, ...args], { op: "worktree-add" });
		} catch (error) {
			await discardWorktree(target).catch(() => undefined);
			throw error;
		}
	}

	/** Only a folder inside the task directory (and not the repository or git's home) may be deleted. */
	async function assertDeletable(target: string): Promise<void> {
		const roots = new Set([taskDir, await realpath(taskDir).catch(() => taskDir)]);
		for (const root of roots) {
			const inside = target.startsWith(root + sep);
			const reserved = [join(root, "repo.git"), join(root, "git-home")].some(
				(dir) => target === dir || target.startsWith(dir + sep),
			);
			if (inside && !reserved) return;
		}
		throw new GitError("failed", "refusing to delete a path outside the task directory");
	}

	async function discardWorktree(target: string): Promise<void> {
		await assertDeletable(target);
		if (existsSync(target)) {
			await exec([...repo, "worktree", "remove", "--force", "--force", target], {
				op: "worktree-remove",
				okCodes: [0, 1, 128],
			});
			await rm(target, { recursive: true, force: true });
		}
		await exec([...repo, "worktree", "prune"], { op: "worktree-prune" });
	}

	async function stagedPaths(wt: readonly string[]): Promise<string[]> {
		const result = await exec([...wt, "diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"], {
			op: "diff",
		});
		return nulList(result.stdout);
	}

	async function commitAll(path: string, message: string): Promise<{ commit: string; created: boolean }> {
		const wt = await worktreeArgs(path);
		const onTimeout = clearIndexLock(path);
		await exec([...wt, "add", "--all"], { op: "add", onTimeout });
		const staged = await stagedPaths(wt);
		if (staged.some(isGitInternalPath)) throw new GitError("failed", "refusing to commit a path inside .git");
		const merging = (await maybeRef(wt, "MERGE_HEAD")) !== undefined;
		if (staged.length === 0 && !merging) return { commit: await revParse(wt, "HEAD"), created: false };
		if ((await unmergedFiles(wt)).length > 0) throw new GitError("conflict", "unmerged files remain");
		const flags = [
			"--quiet",
			"--no-verify",
			"--no-gpg-sign",
			"--cleanup=verbatim",
			...(merging ? ["--allow-empty"] : []),
		];
		await exec([...wt, "commit", ...flags, "-m", message], { op: "commit", onTimeout });
		return { commit: await revParse(wt, "HEAD"), created: true };
	}

	async function pushHead(path: string, branch: string): Promise<void> {
		assertBranch(branch);
		const wt = await worktreeArgs(path);
		const result = await exec(
			[...wt, "push", "--porcelain", "--no-verify", "--recurse-submodules=no", remoteUrl, `HEAD:refs/heads/${branch}`],
			{ op: "push", network: true, okCodes: [0, 1] },
		);
		if (result.code === 0) return;
		const reason = pushRejection(result.stdout);
		if (reason === undefined)
			throw new GitError("failed", "git push failed (exit 1)", { exitCode: 1, stderr: result.stderr });
		log.warn("git_push_rejected", { reason });
		throw new GitError("rejected", `push rejected: ${reason}`, { exitCode: 1, stderr: result.stderr });
	}

	async function merge(path: string): Promise<MergeBaseResult> {
		const wt = await worktreeArgs(path);
		const onTimeout = clearIndexLock(path);
		// A merge left open here (e.g. a crash after a conflict, before it was recorded) is redone from scratch.
		if ((await maybeRef(wt, "MERGE_HEAD")) !== undefined)
			await exec([...wt, "merge", "--abort"], { op: "merge-abort", onTimeout });
		const head = await revParse(wt, "HEAD");
		const baseSha = await revParse(repo, baseRef);
		if (await ancestor(baseSha, head)) return { conflict: false, commit: head, moved: false };
		await assertClean(wt);
		const branch = (await exec([...wt, "symbolic-ref", "--short", "-q", "HEAD"], { op: "symbolic-ref" })).stdout.trim();
		const message = `Merge ${baseBranch} (${baseSha.slice(0, 7)}) into ${branch}`;
		const flags = ["--no-ff", "--no-edit", "--no-verify", "--no-stat", "--no-log", "--no-gpg-sign"];
		const result = await exec([...wt, "merge", ...flags, "-m", message, baseSha], {
			op: "merge",
			okCodes: [0, 1],
			onTimeout,
		});
		if (result.code === 0) return { conflict: false, commit: await revParse(wt, "HEAD"), moved: true };
		const files = await unmergedFiles(wt);
		if (files.length > 0 && (await maybeRef(wt, "MERGE_HEAD")) !== undefined) {
			log.info("git_merge_conflict", { files: files.length });
			return { conflict: true, files };
		}
		throw new GitError("failed", "git merge failed (exit 1)", { exitCode: 1, stderr: result.stderr });
	}

	/**
	 * A scratch index holding the whole worktree (a copy of its index, then `add --all`: untracked files included,
	 * .gitignore respected), so a diff of it shows what the next checkpoint would commit. Removed by the caller.
	 */
	async function scratchIndex(wt: readonly string[], gitdir: string): Promise<string> {
		const indexFile = join(gitdir, `pi-scratch-${randomBytes(8).toString("hex")}.index`);
		const copied = await copyFile(join(gitdir, "index"), indexFile).then(
			() => true,
			() => false,
		);
		if (!copied) await exec([...wt, "read-tree", "HEAD"], { op: "read-tree", indexFile });
		await exec([...wt, "add", "--all"], { op: "add", indexFile });
		return indexFile;
	}

	async function diff(path: string, base: string, maxBytes: number): Promise<string> {
		assertRev(base);
		const wt = await worktreeArgs(path);
		const indexFile = await scratchIndex(wt, wt[1] as string);
		try {
			const common = [...wt, "diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv"];
			const limit = Math.max(0, Math.floor(maxBytes));
			const options = { op: "diff", maxStdoutBytes: limit + 1, truncate: true, indexFile };
			const stat = await exec([...common, "--stat=120", "--summary", base, "--"], options);
			const patch = await exec([...common, "--patch", "-U3", base, "--"], options);
			const text = stat.stdout === "" && patch.stdout === "" ? "" : `${stat.stdout}\n${patch.stdout}`;
			return capBytes(text, limit);
		} finally {
			await rm(indexFile, { force: true });
			await rm(`${indexFile}.lock`, { force: true });
		}
	}

	async function uncommitted(path: string): Promise<WorktreeChange[]> {
		const wt = await worktreeArgs(path);
		const args = [
			...wt,
			"--no-optional-locks",
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
			"--no-renames",
		];
		const result = await exec(args, { op: "status" });
		const changes = nulList(result.stdout).map((entry): WorktreeChange => {
			return { path: entry.slice(3), change: statusChange(entry.slice(0, 2)) };
		});
		return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	}

	async function show(rev: string, file: string): Promise<string | undefined> {
		assertRev(rev);
		assertRepoPath(file);
		const spec = `${rev}:${file}`;
		const type = await exec([...repo, "cat-file", "-t", spec], { op: "cat-file", okCodes: [0, 1, 128] });
		if (type.code !== 0 || type.stdout.trim() !== "blob") return undefined;
		const blob = await exec([...repo, "cat-file", "blob", spec], {
			op: "cat-file",
			maxStdoutBytes: SHOW_FILE_MAX_BYTES,
			truncate: true,
		});
		return blob.stdout;
	}

	async function checkout(rev: string): Promise<number> {
		assertRev(rev);
		const result = await exec([...repo, "ls-tree", "-r", "-l", "-z", rev], { op: "ls-tree" });
		let total = 0;
		for (const entry of nulList(result.stdout)) {
			// "<mode> SP <type> SP <object> SP <size, padded> TAB <path>"
			const [, type, , size] = entry.slice(0, entry.indexOf("\t")).trim().split(/\s+/);
			if (type !== "blob") continue;
			const bytes = Number(size);
			if (!Number.isSafeInteger(bytes) || bytes < 0) throw new GitError("failed", "unexpected git ls-tree output");
			total += Math.max(1, Math.ceil(bytes / CHECKOUT_BLOCK_BYTES)) * CHECKOUT_BLOCK_BYTES;
		}
		return total;
	}

	async function exportCommit(rev: string, dest: string): Promise<void> {
		assertRev(rev);
		const target = resolve(dest);
		await assertDeletable(target);
		if (!(await lstat(target)).isDirectory()) throw new GitError("failed", "export target is not a directory");
		const indexFile = join(repoDir, `pi-export-${randomBytes(8).toString("hex")}.index`);
		try {
			await exec([...repo, "read-tree", `${rev}^{tree}`], { op: "read-tree", indexFile });
			await exec([...repo, "--work-tree", target, "checkout-index", "--all", "--force"], {
				op: "checkout-index",
				indexFile,
			});
		} finally {
			await rm(indexFile, { force: true });
			await rm(`${indexFile}.lock`, { force: true });
		}
	}

	const wtKey = (path: string) => `wt:${resolve(path)}`;

	return {
		baseRef,
		ensureRepo: () => serialized("repo", initRepo),
		fetchBase: () => serialized("repo", fetchRemoteBase),
		remoteBranchSha: (branch) => lsRemote(branch),
		createWorktree: (branch, path, base) => serialized("repo", () => addWorktree(branch, path, base)),
		removeWorktree: (path) => serialized(wtKey(path), () => serialized("repo", () => discardWorktree(resolve(path)))),
		isPristineWorktree: (path, branch, base) => serialized(wtKey(path), () => pristine(path, branch, base)),
		deleteBranch: (branch, createdAt) => serialized("repo", () => dropBranch(branch, createdAt)),
		head: (path) => serialized(wtKey(path), async () => revParse(await worktreeArgs(path), "HEAD")),
		checkpoint: (path, message) => serialized(wtKey(path), () => commitAll(path, message)),
		push: (path, branch) => serialized(wtKey(path), () => pushHead(path, branch)),
		mergeBase: (path) => serialized(wtKey(path), () => merge(path)),
		isAncestor: async (ancestorRev, descendant) => {
			assertRev(ancestorRev);
			assertRev(descendant);
			return ancestor(ancestorRev, descendant);
		},
		changedFiles: async (base, head) => {
			assertRev(base);
			assertRev(head);
			const result = await exec([...repo, "diff", "--name-only", "-z", "--no-renames", base, head, "--"], {
				op: "diff",
			});
			return nulList(result.stdout);
		},
		diffSummary: (path, base, maxBytes) => serialized(wtKey(path), () => diff(path, base, maxBytes)),
		uncommittedChanges: (path) => serialized(wtKey(path), () => uncommitted(path)),
		showFile: (rev, file) => show(rev, file),
		checkoutBytes: (rev) => checkout(rev),
		treeId: async (rev) => {
			assertRev(rev);
			return (await exec([...repo, "rev-parse", "--verify", `${rev}^{tree}`], { op: "rev-parse" })).stdout.trim();
		},
		exportTree: (rev, dest) => serialized("repo", () => exportCommit(rev, dest)),
	};
}

/** The kind of change of a `git status --porcelain=v1` XY code. */
function statusChange(code: string): WorktreeChange["change"] {
	if (code.includes("U") || code === "DD" || code === "AA") return "conflict";
	if (code === "??" || code.includes("A")) return "new";
	if (code.includes("D")) return "deleted";
	return "modified";
}

/** The refusal of a `git push --porcelain` (`!\t<src>:<dst>\t[rejected] (non-fast-forward)`), if any. */
export function pushRejection(porcelain: string): string | undefined {
	for (const line of porcelain.split("\n")) {
		if (!line.startsWith("!")) continue;
		const summary = line.split("\t")[2]?.trim() ?? "";
		if (/rejected/.test(summary)) return summary.replace(/^\[|\]/g, "").slice(0, 200);
	}
	return undefined;
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes on a character boundary, marking the cut. */
function capBytes(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	const marker = Buffer.byteLength(TRUNCATED);
	if (maxBytes <= marker) return "";
	let end = maxBytes - marker;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return `${bytes.subarray(0, end).toString("utf8")}${TRUNCATED}`;
}
