import { errorSummary, type Logger } from "../runtime/log.ts";
import { redact } from "../runtime/redact.ts";
import { type GitHubApi, GitHubError, type MergeResult, type PullRequest } from "./ports.ts";

/**
 * GitHub REST client (Interfaces and Storage § Coordinator to GitHub): a fine-grained token for one repository, held
 * only here. Reads are retried with backoff on transient errors (network, 5xx, 429, secondary rate limit); writes
 * (open/update/close a pull request, merge) are never retried here: the caller reads GitHub's state first, then
 * decides (a lost response may still have taken effect). Logs carry route names, statuses and timings only.
 */

export type GitHubOptions = {
	/** API root, e.g. https://api.github.com (no trailing slash needed). */
	readonly apiUrl: string;
	/** "owner/name". */
	readonly repo: string;
	readonly token: string;
	readonly log: Logger;
	readonly fetch?: typeof fetch;
	/** Delays between read attempts; attempts = length + 1. Default [1000, 4000] (3 tries). */
	readonly retryDelaysMs?: readonly number[];
	/** Per-request timeout (default 30 s); a timeout is a transient network error. */
	readonly timeoutMs?: number;
};

const DEFAULT_RETRY_DELAYS_MS = [1000, 4000];
const MAX_RETRY_AFTER_MS = 30_000;
const MERGE_REFUSED = [405, 409, 422];

type Method = "GET" | "POST" | "PATCH" | "PUT";
type Reply = { readonly status: number; readonly data: unknown };

export function createGitHub(options: GitHubOptions): GitHubApi {
	const doFetch = options.fetch ?? globalThis.fetch;
	const root = `${options.apiUrl.replace(/\/+$/, "")}/repos/${options.repo}`;
	const owner = options.repo.split("/")[0] ?? "";
	const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
	const timeoutMs = options.timeoutMs ?? 30_000;
	const log = options.log;
	const headers = {
		authorization: `Bearer ${options.token}`,
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		"user-agent": "pi-durable-coordinator",
	};

	type Attempt = { reply: Reply; retryAfterMs: number | undefined };

	async function once(method: Method, path: string, body: unknown, route: string): Promise<Attempt> {
		const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
		if (body !== undefined) {
			init.body = JSON.stringify(body);
			init.headers = { ...headers, "content-type": "application/json" };
		}
		try {
			const response = await doFetch(`${root}${path}`, init);
			const text = await response.text();
			return { reply: { status: response.status, data: parseJson(text) }, retryAfterMs: retryAfter(response) };
		} catch (error) {
			log.warn("github_network_error", { route, error: errorSummary(error) });
			throw new GitHubError(`GitHub ${route}: network error`, undefined, true);
		}
	}

	type Outcome =
		| { readonly ok: true; readonly reply: Reply }
		| { readonly ok: false; readonly failure: GitHubError; readonly waitMs: number | undefined };

	async function attempt(method: Method, path: string, route: string, accept: readonly number[], body: unknown) {
		const started = Date.now();
		const { reply, retryAfterMs } = await once(method, path, body, route);
		log.debug("github_call", { route, status: reply.status, ms: Date.now() - started });
		if (accept.includes(reply.status)) return { ok: true, reply } satisfies Outcome;
		return { ok: false, failure: statusError(route, reply), waitMs: retryAfterMs } satisfies Outcome;
	}

	async function attemptOrFailure(...args: Parameters<typeof attempt>): Promise<Outcome> {
		try {
			return await attempt(...args);
		} catch (error) {
			if (error instanceof GitHubError) return { ok: false, failure: error, waitMs: undefined };
			throw error;
		}
	}

	const retryable = (failure: GitHubError, n: number, attempts: number) => failure.transient && n < attempts;

	/** Retry-After when GitHub sent one (capped), else the configured delay for this attempt. */
	function backoff(attemptNumber: number, retryAfterMs: number | undefined): number {
		return Math.min(retryAfterMs ?? delays[attemptNumber - 1] ?? 0, MAX_RETRY_AFTER_MS);
	}

	/** One call; `accept` lists the statuses returned to the caller, any other status throws GitHubError. */
	async function call(method: Method, path: string, route: string, accept: readonly number[], body?: unknown) {
		const attempts = method === "GET" ? delays.length + 1 : 1;
		for (let n = 1; ; n += 1) {
			const outcome = await attemptOrFailure(method, path, route, accept, body);
			if (outcome.ok) return outcome.reply;
			if (!retryable(outcome.failure, n, attempts)) throw outcome.failure;
			log.warn("github_retry", { route, status: outcome.failure.status, attempt: n });
			await sleep(backoff(n, outcome.waitMs));
		}
	}

	async function pull(method: Method, path: string, route: string, accept: readonly number[], body?: unknown) {
		const reply = await call(method, path, route, accept, body);
		return toPullRequest(reply.data, route, reply.status);
	}

	return {
		async findPullRequest(head, base) {
			const query = new URLSearchParams({ state: "all", head: `${owner}:${head}`, base, per_page: "100" });
			const reply = await call("GET", `/pulls?${query}`, "pulls.list", [200]);
			if (!Array.isArray(reply.data)) throw unexpected("pulls.list", reply.status);
			const pulls = reply.data
				.map((item) => toPullRequest(item, "pulls.list", reply.status))
				.filter((each) => each.headRef === head && each.baseRef === base)
				.sort((a, b) => b.number - a.number);
			return pulls.find((each) => each.state === "open") ?? pulls[0];
		},
		getPullRequest: async (number) => pull("GET", `/pulls/${pullNumber(number)}`, "pulls.get", [200]),
		createPullRequest: async ({ head, base, title, body }) =>
			pull("POST", "/pulls", "pulls.create", [200, 201], { title, head, base, body }),
		updatePullRequest: async (number, params) => {
			const body: Record<string, string> = {};
			if (params.title !== undefined) body.title = params.title;
			if (params.body !== undefined) body.body = params.body;
			return pull("PATCH", `/pulls/${pullNumber(number)}`, "pulls.update", [200], body);
		},
		closePullRequest: async (number) =>
			pull("PATCH", `/pulls/${pullNumber(number)}`, "pulls.close", [200], { state: "closed" }),
		async mergePullRequest(number, sha, commitTitle): Promise<MergeResult> {
			const body = { sha, merge_method: "merge", commit_title: commitTitle };
			const path = `/pulls/${pullNumber(number)}/merge`;
			const reply = await call("PUT", path, "pulls.merge", [200, ...MERGE_REFUSED], body);
			const data = record(reply.data);
			const reason = typeof data.message === "string" ? sanitize(data.message) : `status ${reply.status}`;
			if (reply.status === 200 && data.merged === true && typeof data.sha === "string") {
				log.info("github_merged", { pr: number });
				return { merged: true, sha: data.sha };
			}
			log.info("github_merge_refused", { pr: number, status: reply.status });
			return { merged: false, status: reply.status, reason };
		},
		async branchSha(branch) {
			const reply = await call("GET", `/git/ref/heads/${encodeBranch(branch)}`, "git.ref", [200, 404]);
			if (reply.status === 404) return undefined;
			const sha = record(record(reply.data).object).sha;
			if (typeof sha !== "string") throw unexpected("git.ref", reply.status);
			return sha;
		},
		async branchContains(branch, commit) {
			if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new GitHubError("invalid commit sha", undefined, false);
			const path = `/compare/${commit}...${encodeBranch(branch)}?per_page=1`;
			const reply = await call("GET", path, "compare", [200, 404]);
			if (reply.status === 404) return false;
			const status = record(reply.data).status;
			if (typeof status !== "string") throw unexpected("compare", reply.status);
			return status === "identical" || status === "ahead";
		},
	};
}

function sleep(ms: number): Promise<void> {
	return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(text: string): unknown {
	if (text === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function retryAfter(response: Response): number | undefined {
	const raw = response.headers.get("retry-after");
	if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
	return Number(raw.trim()) * 1000;
}

/** Network errors, 5xx, 429 and GitHub's rate-limit 403s are transient; everything else is a definite answer. */
function isTransient(status: number, data: unknown): boolean {
	if (status >= 500 || status === 429) return true;
	const message = record(data).message;
	return status === 403 && typeof message === "string" && /rate limit/i.test(message);
}

function statusError(route: string, reply: Reply): GitHubError {
	const detail = errorDetail(reply.data);
	const message = `GitHub ${route} failed (status ${reply.status})${detail === "" ? "" : `: ${detail}`}`;
	return new GitHubError(message, reply.status, isTransient(reply.status, reply.data));
}

/** GitHub's own error text (e.g. "Validation Failed: No commits between main and task/3"), sanitized and capped. */
function errorDetail(data: unknown): string {
	const body = record(data);
	const parts = [body.message, ...(Array.isArray(body.errors) ? body.errors.map((each) => record(each).message) : [])];
	return sanitize(parts.filter((part): part is string => typeof part === "string" && part !== "").join(": "));
}

function sanitize(text: string): string {
	return redact(text.replace(/\s+/g, " ").trim()).slice(0, 300);
}

function unexpected(route: string, status: number): GitHubError {
	return new GitHubError(`GitHub ${route}: unexpected response`, status, false);
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function pullNumber(number: number): number {
	if (!Number.isSafeInteger(number) || number <= 0)
		throw new GitHubError("invalid pull request number", undefined, false);
	return number;
}

function encodeBranch(branch: string): string {
	if (branch === "" || branch.split("/").some((part) => part === "" || part === "." || part === "..")) {
		throw new GitHubError("invalid branch name", undefined, false);
	}
	return branch.split("/").map(encodeURIComponent).join("/");
}

/** GitHub pull request JSON → PullRequest (url = html_url; mergeCommitSha only once merged). */
export function toPullRequest(value: unknown, route = "pulls", status = 200): PullRequest {
	const data = record(value);
	const head = record(data.head);
	const base = record(data.base);
	const fields = [data.html_url, data.state, head.sha, head.ref, base.ref];
	if (typeof data.number !== "number" || fields.some((field) => typeof field !== "string"))
		throw unexpected(route, status);
	const merged = data.merged === true || (typeof data.merged_at === "string" && data.merged_at !== "");
	return {
		number: data.number,
		url: data.html_url as string,
		state: data.state === "open" ? "open" : "closed",
		merged,
		headSha: head.sha as string,
		headRef: head.ref as string,
		baseRef: base.ref as string,
		mergeCommitSha: merged && typeof data.merge_commit_sha === "string" ? data.merge_commit_sha : undefined,
	};
}
