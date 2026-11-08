import "../helpers/env.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { createGit } from "../../src/coordinator/git.ts";
import { createGitHub } from "../../src/coordinator/github.ts";
import { type GitHubApi, GitHubError } from "../../src/coordinator/ports.ts";
import { createLogger, silentLogger } from "../../src/runtime/log.ts";
import { commitOnOrigin, createOriginRepo, FakeGitHub, originGit } from "../helpers/fake-github.ts";

const REPO = "acme/widgets";
const TOKEN = "github_pat_test_token_0123456789";
const roots: string[] = [];
const fakes: FakeGitHub[] = [];

after(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
afterEach(async () => {
	for (const fake of fakes.splice(0)) await fake.stop();
});

type World = { fake: FakeGitHub; github: GitHubApi; bare: string; mainSha: string; apiUrl: string; root: string };

async function world(): Promise<World> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pd-github-")));
	roots.push(root);
	const { bare, mainSha } = await createOriginRepo(root, { "a.txt": "one\n" });
	const fake = new FakeGitHub({ bareRepo: bare, repo: REPO, token: TOKEN });
	fakes.push(fake);
	const apiUrl = await fake.start();
	const github = createGitHub({ apiUrl, repo: REPO, token: TOKEN, log: silentLogger, retryDelaysMs: [1, 1] });
	return { fake, github, bare, mainSha, apiUrl, root };
}

const branchTip = async (bare: string, branch: string) =>
	(await originGit(bare, ["rev-parse", `refs/heads/${branch}`])).stdout.trim();

async function taskBranch(w: World, id = 1): Promise<string> {
	return commitOnOrigin(w.bare, `task/${id}`, { [`task-${id}.txt`]: `task ${id}\n` }, { from: "refs/heads/main" });
}

async function openPull(w: World, id = 1) {
	const head = await taskBranch(w, id);
	const pull = await w.github.createPullRequest({
		head: `task/${id}`,
		base: "main",
		title: `Task ${id}: demo`,
		body: "body",
	});
	return { head, pull };
}

test("find, create, update and close a pull request", async () => {
	const w = await world();
	const head = await taskBranch(w);
	assert.equal(await w.github.findPullRequest("task/1", "main"), undefined);
	const created = await w.github.createPullRequest({ head: "task/1", base: "main", title: "Task 1: demo", body: "v1" });
	assert.deepEqual(created, {
		number: 1,
		url: `https://github.com/${REPO}/pull/1`,
		state: "open",
		merged: false,
		headSha: head,
		headRef: "task/1",
		baseRef: "main",
		mergeCommitSha: undefined,
	});
	assert.deepEqual(await w.github.findPullRequest("task/1", "main"), created);
	assert.equal(await w.github.findPullRequest("task/2", "main"), undefined);
	const updated = await w.github.updatePullRequest(1, { body: "v2" });
	assert.equal(updated.number, 1);
	assert.equal(w.fake.pulls.get(1)?.body, "v2");
	assert.equal(w.fake.pulls.get(1)?.title, "Task 1: demo");
	const next = await commitOnOrigin(w.bare, "task/1", { "more.txt": "more\n" });
	assert.equal((await w.github.getPullRequest(1)).headSha, next, "an open pull request follows its branch");
	const closed = await w.github.closePullRequest(1);
	assert.equal(closed.state, "closed");
	assert.equal(closed.merged, false);
	assert.equal((await w.github.findPullRequest("task/1", "main"))?.state, "closed");
	assert.deepEqual(
		w.fake.calls.map((call) => call.method),
		["GET", "POST", "GET", "GET", "PATCH", "GET", "PATCH", "GET"],
	);
});

test("a duplicate or empty pull request is refused with 422 (not transient)", async () => {
	const w = await world();
	await openPull(w);
	await assert.rejects(
		w.github.createPullRequest({ head: "task/1", base: "main", title: "again", body: "" }),
		(error: unknown) => {
			assert.ok(error instanceof GitHubError);
			assert.equal(error.status, 422);
			assert.equal(error.transient, false);
			assert.match(error.message, /already exists/);
			return true;
		},
	);
	await originGit(w.bare, ["update-ref", "refs/heads/task/2", w.mainSha]); // a branch with no commits beyond main
	await assert.rejects(
		w.github.createPullRequest({ head: "task/2", base: "main", title: "empty", body: "" }),
		/No commits between main and task\/2/,
	);
	assert.equal(w.fake.pulls.size, 1);
});

test("merge creates a merge commit on main (parents main, head; tree of head)", async () => {
	const w = await world();
	const { head } = await openPull(w);
	const result = await w.github.mergePullRequest(1, head, "Merge task 1");
	assert.equal(result.merged, true);
	assert.ok(result.merged);
	const main = await branchTip(w.bare, "main");
	assert.equal(result.sha, main);
	const parents = (await originGit(w.bare, ["rev-list", "--parents", "-n", "1", main])).stdout.trim().split(" ");
	assert.deepEqual(parents.slice(1), [w.mainSha, head]);
	assert.equal((await originGit(w.bare, ["log", "-1", "--format=%s", main])).stdout.trim(), "Merge task 1");
	const tree = async (rev: string) => (await originGit(w.bare, ["rev-parse", `${rev}^{tree}`])).stdout.trim();
	assert.equal(await tree(main), await tree(head));
	const pull = await w.github.getPullRequest(1);
	assert.equal(pull.merged, true);
	assert.equal(pull.state, "closed");
	assert.equal(pull.mergeCommitSha, main);
	assert.equal(pull.headSha, head);
	assert.equal(await w.github.branchContains("main", head), true);
	assert.equal(await w.github.branchSha("main"), main);
});

test("merge with a stale head sha is refused (409) and nothing merges", async () => {
	const w = await world();
	const { head } = await openPull(w);
	await commitOnOrigin(w.bare, "task/1", { "late.txt": "pushed after approval\n" });
	const result = await w.github.mergePullRequest(1, head, "Merge task 1");
	assert.equal(result.merged, false);
	assert.ok(!result.merged && result.status === 409);
	assert.match(result.reason, /Head branch was modified/);
	assert.equal(await branchTip(w.bare, "main"), w.mainSha);
	assert.equal((await w.github.getPullRequest(1)).state, "open");
});

test("merge when main moved is refused (405), also when it moves between the check and the merge", async () => {
	const w = await world();
	const { head } = await openPull(w);
	const moved = await commitOnOrigin(w.bare, "main", { "other.txt": "another task merged\n" });
	const refused = await w.github.mergePullRequest(1, head, "Merge task 1");
	assert.ok(!refused.merged && refused.status === 405);
	assert.match(refused.reason, /not up to date/);
	assert.equal(await branchTip(w.bare, "main"), moved);

	// Bring the branch up to date (as the Coordinator's mergeBase + push would), then move main mid-merge.
	const tree = (await originGit(w.bare, ["rev-parse", `${head}^{tree}`])).stdout.trim();
	const combined = (
		await originGit(w.bare, ["commit-tree", tree, "-p", head, "-p", moved, "-m", "combine"])
	).stdout.trim();
	await originGit(w.bare, ["update-ref", "refs/heads/task/1", combined, head]);
	let movedAgain = "";
	w.fake.beforeMerge = async () => {
		w.fake.beforeMerge = undefined;
		movedAgain = await commitOnOrigin(w.bare, "main", { "third.txt": "raced\n" });
	};
	const raced = await w.github.mergePullRequest(1, combined, "Merge task 1");
	assert.ok(!raced.merged && raced.status === 405);
	assert.equal(await branchTip(w.bare, "main"), movedAgain);
	assert.equal(await w.github.branchContains("main", combined), false);
});

test("branchContains: identical/ahead true, diverged or unknown commit false; branchSha of a missing branch", async () => {
	const w = await world();
	const head = await taskBranch(w);
	assert.equal(await w.github.branchContains("main", w.mainSha), true, "identical");
	assert.equal(await w.github.branchContains("task/1", w.mainSha), true, "ahead");
	assert.equal(await w.github.branchContains("main", head), false, "not contained");
	assert.equal(await w.github.branchContains("main", "0123456789abcdef0123456789abcdef01234567"), false, "404");
	assert.equal(await w.github.branchContains("task/404", head), false, "missing branch → 404");
	assert.equal(await w.github.branchSha("task/1"), head);
	assert.equal(await w.github.branchSha("task/404"), undefined);
	await assert.rejects(w.github.branchContains("main", "../etc"), GitHubError);
});

test("a transient 503 on a read is retried with backoff; persistent failure surfaces as transient", async () => {
	const w = await world();
	await openPull(w);
	const lines: string[] = [];
	const github = createGitHub({
		apiUrl: w.apiUrl,
		repo: REPO,
		token: TOKEN,
		log: createLogger({ level: "debug", sink: (_level, line) => lines.push(line) }),
		retryDelaysMs: [1, 1],
	});
	w.fake.failNext("GET", /\/pulls\/1$/, 503, 2);
	assert.equal((await github.getPullRequest(1)).number, 1);
	assert.equal(w.fake.count("GET", /\/pulls\/1$/), 3);
	w.fake.failNext("GET", /\/pulls\?/, 503, 3);
	await assert.rejects(github.findPullRequest("task/1", "main"), (error: unknown) => {
		assert.ok(error instanceof GitHubError);
		assert.equal(error.status, 503);
		assert.equal(error.transient, true);
		return true;
	});
	assert.equal(w.fake.count("GET", /\/pulls\?/), 3, "3 tries in total");
	w.fake.failNext("GET", /\/pulls\/1$/, 404, 1);
	await assert.rejects(github.getPullRequest(1), (error: unknown) => error instanceof GitHubError && !error.transient);
	assert.equal(w.fake.count("GET", /\/pulls\/1$/), 4, "a 404 is not retried");
	assert.ok(lines.some((line) => line.includes("github_retry")));
	assert.ok(!lines.join("\n").includes(TOKEN), "token never logged");
});

test("a write that fails with 503 is not retried internally", async () => {
	const w = await world();
	await openPull(w);
	w.fake.failNext("PATCH", /\/pulls\/1$/, 503);
	await assert.rejects(w.github.updatePullRequest(1, { body: "new" }), (error: unknown) => {
		assert.ok(error instanceof GitHubError);
		assert.equal(error.status, 503);
		assert.equal(error.transient, true);
		return true;
	});
	assert.equal(w.fake.count("PATCH", /\/pulls\/1$/), 1);
	assert.equal(w.fake.pulls.get(1)?.body, "body", "no effect");
	w.fake.failNext("PUT", /\/pulls\/1\/merge$/, 502);
	await assert.rejects(w.github.mergePullRequest(1, await branchTip(w.bare, "task/1"), "Merge"), GitHubError);
	assert.equal(w.fake.count("PUT", /\/merge$/), 1);
});

test("lost pull request response: the effect happened, findPullRequest finds it, no second pull request", async () => {
	const w = await world();
	const head = await taskBranch(w);
	w.fake.dropResponseAfterEffect("POST", /\/pulls$/);
	await assert.rejects(
		w.github.createPullRequest({ head: "task/1", base: "main", title: "Task 1: demo", body: "" }),
		(error: unknown) => {
			assert.ok(error instanceof GitHubError);
			assert.equal(error.status, undefined);
			assert.equal(error.transient, true);
			return true;
		},
	);
	assert.equal(w.fake.count("POST", /\/pulls$/), 1, "write not retried");
	const found = await w.github.findPullRequest("task/1", "main");
	assert.equal(found?.number, 1);
	assert.equal(found?.headSha, head);
	assert.equal(w.fake.pulls.size, 1);
});

test("lost merge response: branchContains shows main already has the head (no second merge)", async () => {
	const w = await world();
	const { head } = await openPull(w);
	w.fake.dropResponseAfterEffect("PUT", /\/merge$/);
	await assert.rejects(w.github.mergePullRequest(1, head, "Merge task 1"), GitHubError);
	assert.equal(await w.github.branchContains("main", head), true);
	assert.equal((await w.github.getPullRequest(1)).merged, true);
	assert.equal(w.fake.count("PUT", /\/merge$/), 1);
});

test("requests carry the API headers; a bad token is a non-transient 401", async () => {
	const w = await world();
	const seen: Headers[] = [];
	const recording: typeof fetch = (input, init) => {
		seen.push(new Headers(init?.headers));
		return fetch(input, init);
	};
	const github = createGitHub({
		apiUrl: `${w.apiUrl}/`,
		repo: REPO,
		token: TOKEN,
		log: silentLogger,
		fetch: recording,
	});
	assert.equal(await github.branchSha("main"), w.mainSha);
	assert.equal(seen[0]?.get("authorization"), `Bearer ${TOKEN}`);
	assert.equal(seen[0]?.get("accept"), "application/vnd.github+json");
	assert.equal(seen[0]?.get("x-github-api-version"), "2022-11-28");
	assert.equal(w.fake.calls.at(-1)?.path, `/repos/${REPO}/git/ref/heads/main`);
	const wrong = createGitHub({
		apiUrl: w.apiUrl,
		repo: REPO,
		token: "wrong",
		log: silentLogger,
		retryDelaysMs: [1, 1],
	});
	await assert.rejects(wrong.branchSha("main"), (error: unknown) => {
		assert.ok(error instanceof GitHubError);
		assert.equal(error.status, 401);
		assert.equal(error.transient, false);
		return true;
	});
});

test("git + GitHub: push, open the PR, main moves (405), combine with mergeBase, push, merge exactly that head", async () => {
	const w = await world();
	const taskDir = join(w.root, "tasks");
	const author = { name: "Coordinator", email: "coordinator@example.invalid" };
	const git = createGit({
		taskDir,
		remoteUrl: w.bare,
		baseBranch: "main",
		token: undefined,
		author,
		log: silentLogger,
	});
	await git.ensureRepo();
	const base = await git.fetchBase();
	const path = join(taskDir, "worktrees", "task-1");
	await git.createWorktree("task/1", path, base);
	writeFileSync(join(path, "feature.txt"), "feature\n");
	const first = await git.checkpoint(path, "Task 1: run 1 checkpoint");
	assert.equal(await git.remoteBranchSha("task/1"), undefined);
	await git.push(path, "task/1");
	assert.equal(await git.remoteBranchSha("task/1"), first.commit);
	const pr =
		(await w.github.findPullRequest("task/1", "main")) ??
		(await w.github.createPullRequest({ head: "task/1", base: "main", title: "Task 1: feature", body: "" }));
	assert.equal(pr.headSha, first.commit);

	const moved = await commitOnOrigin(w.bare, "main", { "other.txt": "another task\n" });
	const refused = await w.github.mergePullRequest(pr.number, first.commit, "Merge task 1");
	assert.ok(!refused.merged && refused.status === 405);
	assert.equal(await git.fetchBase(), moved);
	assert.equal(await git.isAncestor(moved, first.commit), false);
	const combined = await git.mergeBase(path);
	assert.ok(!combined.conflict && combined.moved);
	await git.push(path, "task/1");
	assert.equal((await w.github.getPullRequest(pr.number)).headSha, combined.commit);

	const merged = await w.github.mergePullRequest(pr.number, combined.commit, "Merge task 1");
	assert.ok(merged.merged);
	assert.equal(await w.github.branchContains("main", combined.commit), true);
	assert.equal(await git.fetchBase(), merged.sha);
	assert.equal(await git.isAncestor(combined.commit, git.baseRef), true);
	await git.removeWorktree(path);
	assert.ok(!existsSync(path));
	assert.equal(await w.github.branchSha("task/1"), combined.commit, "branch kept on GitHub");
});
