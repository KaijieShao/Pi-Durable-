import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A fake GitHub REST API over a local bare repository (the test "origin" the Coordinator's git pushes to).
 * Implements exactly the endpoints src/coordinator/github.ts uses, with GitHub's rules that matter here:
 * one open pull request per head/base (422), "No commits between" (422), merge only of the current head sha (409),
 * the "branch must be up to date" rule (405 unless the base tip is an ancestor of the head) and a real merge commit
 * (parents: base tip, head; tree of head) written with `git commit-tree` onto refs/heads/<base>.
 * Fault injection: fail the next N matching calls, perform an effect then drop the response, move main mid-merge.
 */

export type FakePull = {
	number: number;
	title: string;
	body: string;
	head: string;
	base: string;
	state: "open" | "closed";
	merged: boolean;
	mergeCommitSha: string | undefined;
	/** Head commit frozen when the pull request was closed or merged (an open one follows refs/heads/<head>). */
	closedHeadSha: string | undefined;
	createdAt: string;
};

export type FakeCall = { method: string; path: string };

type Fault = { method: string; pattern: RegExp; status: number; remaining: number };
type Drop = { method: string; pattern: RegExp; remaining: number };
type Reply = { status: number; body: unknown };

const ZERO = "0000000000000000000000000000000000000000";

/** Run git against `bare` with hooks and outside config disabled. */
export async function originGit(
	bare: string,
	args: readonly string[],
	options: { input?: string; env?: Record<string, string>; okCodes?: readonly number[] } = {},
): Promise<{ code: number; stdout: string }> {
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: dirname(bare),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		LC_ALL: "C",
		GIT_AUTHOR_NAME: "GitHub",
		GIT_AUTHOR_EMAIL: "noreply@github.com",
		GIT_COMMITTER_NAME: "GitHub",
		GIT_COMMITTER_EMAIL: "noreply@github.com",
		...options.env,
	};
	const argv = ["-c", "core.hooksPath=/dev/null", "--git-dir", bare, ...args];
	return new Promise((resolve, reject) => {
		const child = spawn("git", argv, { env, stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			const stdout = Buffer.concat(out).toString("utf8");
			if ((options.okCodes ?? [0]).includes(code ?? -1)) resolve({ code: code ?? -1, stdout });
			else reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(err).toString("utf8").trim()}`));
		});
		// Git can reject its arguments and close stdin before a large fixture input has drained.
		// Its exit status is authoritative; other input-stream errors still reject the operation.
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") reject(error);
		});
		child.stdin.end(options.input ?? "");
	});
}

async function refSha(bare: string, ref: string): Promise<string | undefined> {
	const result = await originGit(bare, ["rev-parse", "-q", "--verify", `${ref}^{commit}`], { okCodes: [0, 1] });
	return result.code === 0 ? result.stdout.trim() : undefined;
}

async function isAncestor(bare: string, ancestor: string, descendant: string): Promise<boolean> {
	const result = await originGit(bare, ["merge-base", "--is-ancestor", ancestor, descendant], { okCodes: [0, 1] });
	return result.code === 0;
}

/**
 * Commit `files` (null = delete) onto `branch` of the bare repository with plumbing (no working copy, no hooks).
 * A missing branch starts from `from` (a ref or sha), or as a root commit. Returns the new commit.
 */
export async function commitOnOrigin(
	bare: string,
	branch: string,
	files: Record<string, string | null>,
	options: { message?: string; from?: string } = {},
): Promise<string> {
	const current = await refSha(bare, `refs/heads/${branch}`);
	const parent = current ?? (options.from === undefined ? undefined : await refSha(bare, options.from));
	const index = join(tmpdir(), `fake-github-index-${randomBytes(6).toString("hex")}`);
	const env = { GIT_INDEX_FILE: index };
	try {
		await originGit(bare, parent === undefined ? ["read-tree", "--empty"] : ["read-tree", parent], { env });
		for (const [path, content] of Object.entries(files)) {
			if (content === null) {
				await originGit(bare, ["update-index", "--force-remove", "--", path], { env });
				continue;
			}
			const blob = (await originGit(bare, ["hash-object", "-w", "--stdin"], { input: content })).stdout.trim();
			await originGit(bare, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
		}
		const tree = (await originGit(bare, ["write-tree"], { env })).stdout.trim();
		const parents = parent === undefined ? [] : ["-p", parent];
		const message = options.message ?? `Update ${branch}`;
		const commit = (await originGit(bare, ["commit-tree", tree, ...parents, "-m", message])).stdout.trim();
		await originGit(bare, ["update-ref", `refs/heads/${branch}`, commit, current ?? ZERO]);
		return commit;
	} finally {
		await rm(index, { force: true });
	}
}

/** A bare repository `<dir>/origin.git` whose main branch has one commit with `files`. */
export async function createOriginRepo(
	dir: string,
	files: Record<string, string>,
): Promise<{ bare: string; mainSha: string }> {
	const bare = join(dir, "origin.git");
	await mkdir(dir, { recursive: true });
	await originGit(bare, ["-c", "init.defaultBranch=main", "init", "--quiet", "--bare", "--template=", bare]);
	await originGit(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	const mainSha = await commitOnOrigin(bare, "main", files, { message: "Initial commit" });
	return { bare, mainSha };
}

export class FakeGitHub {
	readonly pulls = new Map<number, FakePull>();
	readonly calls: FakeCall[] = [];
	/** Runs inside the merge handler before GitHub's checks: e.g. move main between the Coordinator's check and merge. */
	beforeMerge: (() => Promise<void>) | undefined;
	/** Test-only: close/delete a newly-created PR's branch before its response is delivered or lost. */
	afterCreate: ((pull: FakePull) => Promise<void>) | undefined;
	readonly #bare: string;
	readonly #repo: string;
	readonly #owner: string;
	readonly #baseBranch: string;
	readonly #token: string | undefined;
	#server: Server | undefined;
	#faults: Fault[] = [];
	#drops: Drop[] = [];
	#nextNumber = 1;
	#queue: Promise<void> = Promise.resolve();

	constructor(options: { bareRepo: string; repo: string; baseBranch?: string; token?: string }) {
		this.#bare = options.bareRepo;
		this.#repo = options.repo;
		this.#owner = options.repo.split("/")[0] ?? "";
		this.#baseBranch = options.baseBranch ?? "main";
		this.#token = options.token;
	}

	get baseBranch(): string {
		return this.#baseBranch;
	}

	/** Starts on 127.0.0.1; returns the API root (pass as `apiUrl`). */
	async start(): Promise<string> {
		const server = createServer((req, res) => {
			this.#accept(req, res);
		});
		this.#server = server;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	async stop(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (server === undefined) return;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/** The next `count` calls matching method and `pathPattern` (tested on path + query) answer `status`, no effect. */
	failNext(method: string, pathPattern: RegExp, status: number, count = 1): void {
		this.#faults.push({ method: method.toUpperCase(), pattern: pathPattern, status, remaining: count });
	}

	/** The next `count` matching calls perform their effect, then the connection is destroyed without a response. */
	dropResponseAfterEffect(method: string, pathPattern: RegExp, count = 1): void {
		this.#drops.push({ method: method.toUpperCase(), pattern: pathPattern, remaining: count });
	}

	count(method: string, pathPattern: RegExp): number {
		return this.calls.filter((call) => call.method === method.toUpperCase() && pathPattern.test(call.path)).length;
	}

	/** The pull request's head commit as GitHub would report it now. */
	async headSha(pull: FakePull): Promise<string> {
		if (pull.closedHeadSha !== undefined) return pull.closedHeadSha;
		return (await refSha(this.#bare, `refs/heads/${pull.head}`)) ?? ZERO;
	}

	#accept(req: IncomingMessage, res: ServerResponse): void {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const run = () => this.#process(req, res, Buffer.concat(chunks).toString("utf8"));
			this.#queue = this.#queue.then(run, run).catch(() => undefined);
		});
	}

	async #process(req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> {
		const method = (req.method ?? "GET").toUpperCase();
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = `${url.pathname}${url.search}`;
		this.calls.push({ method, path });
		if (this.#token !== undefined && req.headers.authorization !== `Bearer ${this.#token}`) {
			return send(res, { status: 401, body: { message: "Bad credentials" } });
		}
		const fault = take(this.#faults, method, path);
		if (fault !== undefined) return send(res, { status: fault.status, body: { message: "injected failure" } });
		let reply: Reply;
		try {
			reply = await this.#route(method, url, raw === "" ? {} : JSON.parse(raw));
		} catch (error) {
			reply = { status: 500, body: { message: `fake GitHub error: ${String(error)}` } };
		}
		if (take(this.#drops, method, path) !== undefined) {
			req.socket.destroy();
			return;
		}
		send(res, reply);
	}

	async #route(method: string, url: URL, body: Record<string, unknown>): Promise<Reply> {
		const prefix = `/repos/${this.#repo}`;
		if (!url.pathname.startsWith(`${prefix}/`)) return notFound();
		const rest = url.pathname.slice(prefix.length);
		const routes: [string, RegExp, (match: RegExpExecArray) => Promise<Reply>][] = [
			["GET", /^\/pulls$/, () => this.#list(url.searchParams)],
			["POST", /^\/pulls$/, () => this.#create(body)],
			["GET", /^\/pulls\/(\d+)$/, (match) => this.#get(Number(match[1]))],
			["PATCH", /^\/pulls\/(\d+)$/, (match) => this.#update(Number(match[1]), body)],
			["PUT", /^\/pulls\/(\d+)\/merge$/, (match) => this.#merge(Number(match[1]), body)],
			["GET", /^\/git\/ref\/heads\/(.+)$/, (match) => this.#ref(decodePath(match[1] ?? ""))],
			["GET", /^\/compare\/(.+)$/, (match) => this.#compare(decodePath(match[1] ?? ""))],
		];
		for (const [verb, pattern, handler] of routes) {
			const match = verb === method ? pattern.exec(rest) : null;
			if (match !== null) return handler(match);
		}
		return notFound();
	}

	async #json(pull: FakePull): Promise<Record<string, unknown>> {
		const headSha = await this.headSha(pull);
		const baseSha = (await refSha(this.#bare, `refs/heads/${pull.base}`)) ?? ZERO;
		return {
			number: pull.number,
			html_url: `https://github.com/${this.#repo}/pull/${pull.number}`,
			url: `https://api.github.com/repos/${this.#repo}/pulls/${pull.number}`,
			state: pull.state,
			title: pull.title,
			body: pull.body,
			merged: pull.merged,
			merged_at: pull.merged ? pull.createdAt : null,
			merge_commit_sha: pull.mergeCommitSha ?? null,
			created_at: pull.createdAt,
			head: {
				ref: pull.head,
				sha: headSha,
				label: `${this.#owner}:${pull.head}`,
				repo: { full_name: this.#repo },
			},
			base: { ref: pull.base, sha: baseSha, label: `${this.#owner}:${pull.base}`, repo: { full_name: this.#repo } },
		};
	}

	async #list(query: URLSearchParams): Promise<Reply> {
		const state = query.get("state") ?? "open";
		const head = query.get("head");
		const base = query.get("base");
		const matches = [...this.pulls.values()]
			.filter((pull) => state === "all" || pull.state === state)
			.filter((pull) => head === null || `${this.#owner}:${pull.head}` === head)
			.filter((pull) => base === null || pull.base === base)
			.sort((a, b) => b.number - a.number);
		return { status: 200, body: await Promise.all(matches.map((pull) => this.#json(pull))) };
	}

	async #get(number: number): Promise<Reply> {
		const pull = this.pulls.get(number);
		return pull === undefined ? notFound() : { status: 200, body: await this.#json(pull) };
	}

	async #create(body: Record<string, unknown>): Promise<Reply> {
		const title = typeof body.title === "string" ? body.title : "";
		const head = typeof body.head === "string" ? body.head.replace(new RegExp(`^${this.#owner}:`), "") : "";
		const base = typeof body.base === "string" ? body.base : "";
		const headSha = await refSha(this.#bare, `refs/heads/${head}`);
		const baseSha = await refSha(this.#bare, `refs/heads/${base}`);
		if (title === "" || headSha === undefined || baseSha === undefined) {
			return invalid({ resource: "PullRequest", field: headSha === undefined ? "head" : "base", code: "invalid" });
		}
		const open = [...this.pulls.values()].find((p) => p.state === "open" && p.head === head && p.base === base);
		if (open !== undefined) {
			return invalid({
				resource: "PullRequest",
				code: "custom",
				message: `A pull request already exists for ${this.#owner}:${head}.`,
			});
		}
		if (await isAncestor(this.#bare, headSha, baseSha)) {
			return invalid({ resource: "PullRequest", code: "custom", message: `No commits between ${base} and ${head}` });
		}
		const pull: FakePull = {
			number: this.#nextNumber++,
			title,
			body: typeof body.body === "string" ? body.body : "",
			head,
			base,
			state: "open",
			merged: false,
			mergeCommitSha: undefined,
			closedHeadSha: undefined,
			createdAt: new Date().toISOString(),
		};
		this.pulls.set(pull.number, pull);
		await this.afterCreate?.(pull);
		return { status: 201, body: await this.#json(pull) };
	}

	async #update(number: number, body: Record<string, unknown>): Promise<Reply> {
		const pull = this.pulls.get(number);
		if (pull === undefined) return notFound();
		if (typeof body.title === "string") pull.title = body.title;
		if (typeof body.body === "string") pull.body = body.body;
		if (body.state === "closed" && pull.state === "open") {
			pull.closedHeadSha = await this.headSha(pull);
			pull.state = "closed";
		} else if (body.state === "open" && pull.state === "closed" && !pull.merged) {
			pull.closedHeadSha = undefined;
			pull.state = "open";
		}
		return { status: 200, body: await this.#json(pull) };
	}

	async #merge(number: number, body: Record<string, unknown>): Promise<Reply> {
		const pull = this.pulls.get(number);
		if (pull === undefined) return notFound();
		if (this.beforeMerge !== undefined) await this.beforeMerge();
		if (pull.state !== "open") return { status: 405, body: { message: "Pull Request is not mergeable" } };
		if (body.merge_method !== undefined && body.merge_method !== "merge") {
			return { status: 405, body: { message: "Merge method not allowed on this repository" } };
		}
		const head = await this.headSha(pull);
		if (typeof body.sha === "string" && body.sha !== head) {
			return { status: 409, body: { message: "Head branch was modified. Review and try the merge again." } };
		}
		const baseTip = await refSha(this.#bare, `refs/heads/${pull.base}`);
		if (baseTip === undefined || !(await isAncestor(this.#bare, baseTip, head))) {
			return { status: 405, body: { message: "Head branch is not up to date with the base branch" } };
		}
		const title = typeof body.commit_title === "string" ? body.commit_title : `Merge pull request #${number}`;
		const tree = (await originGit(this.#bare, ["rev-parse", `${head}^{tree}`])).stdout.trim();
		const args = ["commit-tree", tree, "-p", baseTip, "-p", head, "-m", title];
		const commit = (await originGit(this.#bare, args)).stdout.trim();
		await originGit(this.#bare, ["update-ref", `refs/heads/${pull.base}`, commit, baseTip]);
		pull.merged = true;
		pull.state = "closed";
		pull.closedHeadSha = head;
		pull.mergeCommitSha = commit;
		return { status: 200, body: { sha: commit, merged: true, message: "Pull Request successfully merged" } };
	}

	async #ref(branch: string): Promise<Reply> {
		const sha = await refSha(this.#bare, `refs/heads/${branch}`);
		if (sha === undefined) return notFound();
		return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } } };
	}

	async #compare(basehead: string): Promise<Reply> {
		const split = basehead.indexOf("...");
		if (split < 0) return notFound();
		const base = await this.#resolve(basehead.slice(0, split));
		const head = await this.#resolve(basehead.slice(split + 3));
		if (base === undefined || head === undefined) return notFound();
		const count = async (range: string) => Number((await originGit(this.#bare, ["rev-list", "--count", range])).stdout);
		const ahead = await count(`${base}..${head}`);
		const behind = await count(`${head}..${base}`);
		const status =
			ahead === 0 && behind === 0 ? "identical" : behind === 0 ? "ahead" : ahead === 0 ? "behind" : "diverged";
		return { status: 200, body: { status, ahead_by: ahead, behind_by: behind, total_commits: ahead } };
	}

	async #resolve(name: string): Promise<string | undefined> {
		if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith("-")) return undefined;
		const branch = await refSha(this.#bare, `refs/heads/${name}`);
		if (branch !== undefined) return branch;
		return /^[0-9a-f]{7,64}$/.test(name) ? refSha(this.#bare, name) : undefined;
	}
}

function take<T extends { method: string; pattern: RegExp; remaining: number }>(
	list: T[],
	method: string,
	path: string,
): T | undefined {
	const found = list.find((entry) => entry.remaining > 0 && entry.method === method && entry.pattern.test(path));
	if (found !== undefined) found.remaining -= 1;
	return found;
}

function decodePath(path: string): string {
	return path.split("/").map(decodeURIComponent).join("/");
}

function notFound(): Reply {
	return { status: 404, body: { message: "Not Found" } };
}

function invalid(error: Record<string, unknown>): Reply {
	return { status: 422, body: { message: "Validation Failed", errors: [error] } };
}

function send(res: ServerResponse, reply: Reply): void {
	const text = JSON.stringify(reply.body);
	res.writeHead(reply.status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
	});
	res.end(text);
}
