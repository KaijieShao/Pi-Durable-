import "../helpers/env.ts";
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	buildGitInvocation,
	createGit,
	EMPTY_TREE,
	type Git,
	GitError,
	isGitInternalPath,
	pushRejection,
} from "../../src/coordinator/git.ts";
import { createLogger, silentLogger } from "../../src/runtime/log.ts";
import { waitFor } from "../helpers/env.ts";
import { commitOnOrigin, createOriginRepo, originGit } from "../helpers/fake-github.ts";

const author = { name: "Test Coordinator", email: "coordinator@example.invalid" };
const roots: string[] = [];

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	roots.push(dir);
	return dir;
}

after(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

type Setup = { git: Git; bare: string; mainSha: string; taskDir: string; repoDir: string; root: string };

async function setup(
	files: Record<string, string> = { "a.txt": "one\ntwo\nthree\n", ".gitignore": "ignored/\n*.log\n" },
) {
	const root = tempDir("pd-git-");
	const { bare, mainSha } = await createOriginRepo(join(root, "origin"), files);
	const taskDir = join(root, "tasks");
	const git = createGit({ taskDir, remoteUrl: bare, baseBranch: "main", token: undefined, author, log: silentLogger });
	await git.ensureRepo();
	return { git, bare, mainSha, taskDir, repoDir: join(taskDir, "repo.git"), root } satisfies Setup;
}

async function withWorktree(s: Setup, id = 1): Promise<{ path: string; branch: string; base: string }> {
	const base = await s.git.fetchBase();
	const path = join(s.taskDir, "worktrees", `task-${id}`);
	const branch = `task/${id}`;
	await s.git.createWorktree(branch, path, base);
	return { path, branch, base };
}

const local = (s: Setup, args: string[]) => originGit(s.repoDir, args).then((r) => r.stdout.trim());
const parents = async (s: Setup, commit: string) =>
	(await local(s, ["rev-list", "--parents", "-n", "1", commit])).split(" ").slice(1);

test("ensureRepo creates a bare repository without template hooks, idempotently; fetchBase returns main", async () => {
	const s = await setup();
	await s.git.ensureRepo();
	assert.equal(await local(s, ["rev-parse", "--is-bare-repository"]), "true");
	assert.ok(!existsSync(join(s.repoDir, "hooks")), "no template hooks copied");
	assert.equal(await s.git.fetchBase(), s.mainSha);
	assert.equal(s.git.baseRef, "refs/remotes/origin/main");
	assert.equal(await local(s, ["rev-parse", s.git.baseRef]), s.mainSha);
	const moved = await commitOnOrigin(s.bare, "main", { "b.txt": "b\n" });
	assert.equal(await s.git.fetchBase(), moved);
});

test("checkoutBytes: every file of a commit rounded up to 4 KiB blocks, nested paths included; bad revisions refused", async () => {
	const s = await setup({
		"empty.txt": "",
		"small.txt": "x".repeat(10),
		"exact.bin": "y".repeat(4096),
		"nested/deeper/big.txt": "z".repeat(5000),
		"with space\tand tab.txt": "w",
	});
	const base = await s.git.fetchBase();
	// 1 + 1 + 1 + 2 + 1 blocks (an empty file counts one block).
	assert.equal(await s.git.checkoutBytes(base), 6 * 4096);
	assert.equal(await s.git.checkoutBytes(s.git.baseRef), 6 * 4096, "the fetched main by its ref");
	const grown = await commitOnOrigin(s.bare, "main", { "more.txt": "m".repeat(9000) });
	await s.git.fetchBase();
	assert.equal(await s.git.checkoutBytes(grown), 9 * 4096);
	await assert.rejects(s.git.checkoutBytes("--output=/tmp/x"), /invalid revision/);
	await assert.rejects(s.git.checkoutBytes("0123456789abcdef0123456789abcdef01234567"), GitError);
});

test("createWorktree checks out the base on a new branch; repeating it is a no-op; a different base is refused", async () => {
	const s = await setup();
	const { path, base } = await withWorktree(s);
	assert.equal(readFileSync(join(path, "a.txt"), "utf8"), "one\ntwo\nthree\n");
	assert.equal(await s.git.head(path), base);
	assert.equal(await local(s, ["rev-parse", "refs/heads/task/1"]), base);
	assert.ok(readFileSync(join(path, ".git"), "utf8").startsWith("gitdir: "), "linked worktree");
	await s.git.createWorktree("task/1", path, base);
	const other = await commitOnOrigin(s.bare, "main", { "c.txt": "c\n" });
	await s.git.fetchBase();
	await assert.rejects(s.git.createWorktree("task/1", join(s.taskDir, "worktrees", "task-1b"), other), GitError);
	await assert.rejects(s.git.createWorktree("--evil", join(s.taskDir, "worktrees", "x"), base), /invalid branch/);
});

test("checkpoint commits tracked and untracked changes, respects .gitignore and is a no-op when clean", async () => {
	const s = await setup();
	const { path, base } = await withWorktree(s);
	writeFileSync(join(path, "a.txt"), "one\nTWO\nthree\n");
	mkdirSync(join(path, "src"));
	writeFileSync(join(path, "src", "new.js"), "export const x = 1;\n");
	mkdirSync(join(path, "ignored"));
	writeFileSync(join(path, "ignored", "secret.txt"), "nope\n");
	writeFileSync(join(path, "debug.log"), "nope\n");
	const first = await s.git.checkpoint(path, "Task 1: run 1 checkpoint");
	assert.equal(first.created, true);
	assert.notEqual(first.commit, base);
	assert.deepEqual(await parents(s, first.commit), [base]);
	const files = (await local(s, ["ls-tree", "-r", "--name-only", first.commit])).split("\n");
	assert.deepEqual(files.sort(), [".gitignore", "a.txt", "src/new.js"]);
	assert.equal(
		await local(s, ["log", "-1", "--format=%s|%an|%ae", first.commit]),
		`Task 1: run 1 checkpoint|${author.name}|${author.email}`,
	);
	assert.deepEqual(await s.git.changedFiles(base, first.commit), ["a.txt", "src/new.js"]);
	const again = await s.git.checkpoint(path, "Task 1: run 2 checkpoint");
	assert.deepEqual(again, { commit: first.commit, created: false });
	assert.equal(await s.git.head(path), first.commit);
});

test("push publishes the branch without force; remoteBranchSha reads it from the remote", async () => {
	const s = await setup();
	const { path, branch } = await withWorktree(s);
	assert.equal(await s.git.remoteBranchSha(branch), undefined);
	writeFileSync(join(path, "b.txt"), "b\n");
	const { commit } = await s.git.checkpoint(path, "checkpoint");
	await s.git.push(path, branch);
	assert.equal(await s.git.remoteBranchSha(branch), commit);
	assert.equal((await originGit(s.bare, ["rev-parse", `refs/heads/${branch}`])).stdout.trim(), commit);
	await s.git.push(path, branch);
	assert.equal(await s.git.remoteBranchSha("task/10"), undefined, "exact ref match only");
});

test("push of a non-fast-forward is rejected with code 'rejected' and leaves the remote alone", async () => {
	const s = await setup();
	const { path, branch } = await withWorktree(s);
	writeFileSync(join(path, "b.txt"), "b\n");
	await s.git.checkpoint(path, "first");
	await s.git.push(path, branch);
	const foreign = await commitOnOrigin(s.bare, branch, { "c.txt": "someone else\n" });
	writeFileSync(join(path, "b.txt"), "b2\n");
	await s.git.checkpoint(path, "second");
	await assert.rejects(s.git.push(path, branch), (error: unknown) => {
		assert.ok(error instanceof GitError);
		assert.equal(error.code, "rejected");
		return true;
	});
	assert.equal(await s.git.remoteBranchSha(branch), foreign);
	assert.equal(pushRejection("To x\n!\tHEAD:refs/heads/t\t[rejected] (fetch first)\nDone\n"), "rejected (fetch first)");
	assert.equal(pushRejection("=\tHEAD:refs/heads/t\t[up to date]\n"), undefined);
});

test("an existing-only normal push cannot recreate a ref deleted after its pre-read; trusted guard is cleaned", async () => {
	const s = await setup(),
		{ path, branch } = await withWorktree(s);
	writeFileSync(join(path, "b.txt"), "one\n");
	await s.git.checkpoint(path, "first");
	await assert.rejects(
		s.git.push(path, branch, { requireExisting: true }),
		(error: unknown) => error instanceof GitError && error.code === "rejected",
	);
	assert.equal(await s.git.remoteBranchSha(branch), undefined);
	await s.git.push(path, branch);
	writeFileSync(join(path, "b.txt"), "two\n");
	const next = await s.git.checkpoint(path, "next");
	await s.git.push(path, branch, { requireExisting: true });
	assert.equal(await s.git.remoteBranchSha(branch), next.commit, "existing refs still fast-forward normally");
	// The engine already read a published head, but it disappears before the actual push connection advertises refs.
	assert.equal(await s.git.remoteBranchSha(branch), next.commit);
	await originGit(s.bare, ["update-ref", "-d", `refs/heads/${branch}`]);
	await assert.rejects(
		s.git.push(path, branch, { requireExisting: true }),
		(error: unknown) => error instanceof GitError && error.code === "rejected",
	);
	assert.equal(await s.git.remoteBranchSha(branch), undefined, "the guard rejects creation, with no force flag");
	assert.deepEqual(
		readdirSync(s.repoDir).filter((name) => name.startsWith("pi-push-guard-")),
		[],
	);
});

test("mergeBase: branch already contains main → no commit, moved false", async () => {
	const s = await setup();
	const { path } = await withWorktree(s);
	writeFileSync(join(path, "b.txt"), "b\n");
	const { commit } = await s.git.checkpoint(path, "work");
	await s.git.fetchBase();
	assert.deepEqual(await s.git.mergeBase(path), { conflict: false, commit, moved: false });
	assert.equal(await s.git.head(path), commit);
});

test("mergeBase: main moved without conflict → merge commit (parents head, main), moved true", async () => {
	const s = await setup();
	const { path } = await withWorktree(s);
	writeFileSync(join(path, "b.txt"), "b\n");
	const { commit } = await s.git.checkpoint(path, "work");
	const main = await commitOnOrigin(s.bare, "main", { "c.txt": "from main\n" });
	assert.equal(await s.git.fetchBase(), main);
	assert.equal(await s.git.isAncestor(main, commit), false);
	const result = await s.git.mergeBase(path);
	assert.equal(result.conflict, false);
	assert.ok(!result.conflict && result.moved);
	assert.deepEqual(await parents(s, result.commit), [commit, main]);
	assert.equal(await s.git.isAncestor(main, result.commit), true);
	assert.equal(readFileSync(join(path, "c.txt"), "utf8"), "from main\n");
	assert.deepEqual(await s.git.checkpoint(path, "noop"), { commit: result.commit, created: false });
});

test("mergeBase: conflict lists files and leaves the merge in progress; checkpoint concludes it", async () => {
	const s = await setup();
	const { path } = await withWorktree(s);
	writeFileSync(join(path, "a.txt"), "one\nbranch\nthree\n");
	const { commit } = await s.git.checkpoint(path, "work");
	const main = await commitOnOrigin(s.bare, "main", { "a.txt": "one\nmain\nthree\n", "d.txt": "d\n" });
	await s.git.fetchBase();
	assert.deepEqual(await s.git.mergeBase(path), { conflict: true, files: ["a.txt"] });
	assert.ok(existsSync(join(s.repoDir, "worktrees", "task-1", "MERGE_HEAD")), "merge left in progress");
	assert.match(readFileSync(join(path, "a.txt"), "utf8"), /^<<<<<<< /m);
	assert.equal(await s.git.head(path), commit, "nothing committed");
	// Repeating it (e.g. after a restart) redoes the same merge and reports the same conflict.
	assert.deepEqual(await s.git.mergeBase(path), { conflict: true, files: ["a.txt"] });
	writeFileSync(join(path, "a.txt"), "one\nbranch and main\nthree\n");
	const resolved = await s.git.checkpoint(path, "Task 1: conflict fix");
	assert.equal(resolved.created, true);
	assert.deepEqual(await parents(s, resolved.commit), [commit, main]);
	assert.ok(!existsSync(join(s.repoDir, "worktrees", "task-1", "MERGE_HEAD")));
	assert.equal(await s.git.isAncestor(main, resolved.commit), true);
});

test("checkpoint concludes a merge even when the resolution equals HEAD's tree", async () => {
	const s = await setup();
	const { path } = await withWorktree(s);
	writeFileSync(join(path, "a.txt"), "one\nbranch\nthree\n");
	const { commit } = await s.git.checkpoint(path, "work");
	const main = await commitOnOrigin(s.bare, "main", { "a.txt": "one\nmain\nthree\n" });
	await s.git.fetchBase();
	assert.equal((await s.git.mergeBase(path)).conflict, true);
	writeFileSync(join(path, "a.txt"), "one\nbranch\nthree\n");
	const resolved = await s.git.checkpoint(path, "keep ours");
	assert.equal(resolved.created, true);
	assert.deepEqual(await parents(s, resolved.commit), [commit, main]);
	assert.equal(
		await local(s, ["rev-parse", `${resolved.commit}^{tree}`]),
		await local(s, ["rev-parse", `${commit}^{tree}`]),
	);
});

test("removeWorktree deletes the folder and its registration, keeps the branch, and is idempotent", async () => {
	const s = await setup();
	const { path, branch } = await withWorktree(s);
	writeFileSync(join(path, "b.txt"), "b\n");
	const { commit } = await s.git.checkpoint(path, "work");
	writeFileSync(join(path, "untracked.txt"), "left over\n");
	await s.git.removeWorktree(path);
	assert.ok(!existsSync(path));
	assert.equal(await local(s, ["rev-parse", `refs/heads/${branch}`]), commit);
	assert.ok(!(await local(s, ["worktree", "list", "--porcelain"])).includes(path));
	await s.git.removeWorktree(path);
	await assert.rejects(s.git.removeWorktree(join(s.root, "elsewhere")), /outside the task directory/);
});

test("isPristineWorktree: only our clean worktree on the branch at the base (ignored files allowed)", async () => {
	const s = await setup();
	const { path, branch, base } = await withWorktree(s);
	assert.equal(await s.git.isPristineWorktree(path, branch, base), true);
	mkdirSync(join(path, "ignored"), { recursive: true });
	writeFileSync(join(path, "ignored", "cache.bin"), "setup output\n");
	assert.equal(await s.git.isPristineWorktree(path, branch, base), true, "ignored files do not count");
	assert.equal(await s.git.isPristineWorktree(path, "task/2", base), false, "another branch");
	writeFileSync(join(path, "partial.txt"), "half done\n");
	assert.equal(await s.git.isPristineWorktree(path, branch, base), false, "an untracked file");
	rmSync(join(path, "partial.txt"));
	writeFileSync(join(path, "a.txt"), "changed\n");
	assert.equal(await s.git.isPristineWorktree(path, branch, base), false, "a changed file");
	const { commit } = await s.git.checkpoint(path, "work");
	assert.equal(await s.git.isPristineWorktree(path, branch, base), false, "not at the base any more");
	assert.equal(await s.git.isPristineWorktree(path, branch, commit), true);
	assert.equal(await s.git.isPristineWorktree(join(s.taskDir, "worktrees", "task-9"), branch, base), false, "missing");
	const foreign = join(s.taskDir, "worktrees", "not-a-worktree");
	mkdirSync(foreign, { recursive: true });
	assert.equal(await s.git.isPristineWorktree(foreign, branch, base), false, "not a worktree of the repository");
});

test("deleteBranch deletes a local branch without commits of its own, is idempotent, refuses one with commits", async () => {
	const s = await setup();
	const { path, branch, base } = await withWorktree(s);
	await assert.rejects(s.git.deleteBranch(branch), GitError, "checked out in a worktree");
	await s.git.removeWorktree(path);
	await commitOnOrigin(s.bare, "main", { "b.txt": "b\n" });
	await s.git.fetchBase();
	await s.git.deleteBranch(branch);
	assert.equal(
		(await originGit(s.repoDir, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`], { okCodes: [0, 1] })).code,
		1,
	);
	await s.git.deleteBranch(branch);
	await s.git.createWorktree(branch, path, base);
	writeFileSync(join(path, "c.txt"), "c\n");
	await s.git.checkpoint(path, "own work");
	await s.git.removeWorktree(path);
	await assert.rejects(s.git.deleteBranch(branch), /commits of its own/);
	const tip = await local(s, ["rev-parse", `refs/heads/${branch}`]);
	await assert.rejects(s.git.deleteBranch(branch, base), /commits of its own/, "it moved past where it was created");
	await s.git.deleteBranch(branch, tip);
	assert.equal(
		(await originGit(s.repoDir, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`], { okCodes: [0, 1] })).code,
		1,
		"still at the commit it was created at",
	);
	await assert.rejects(s.git.deleteBranch("-bad"), /invalid branch name/);
});

test("diffSummary, showFile and changedFiles", async () => {
	const s = await setup({ "a.txt": "one\n", "AGENTS.md": "# Guidance\nBe careful.\n" });
	const { path, base } = await withWorktree(s);
	assert.equal(await s.git.diffSummary(path, base, 10_000), "");
	writeFileSync(join(path, "a.txt"), "one\nadded line\n");
	const summary = await s.git.diffSummary(path, base, 10_000);
	assert.match(summary, /a\.txt \| 1 \+/);
	assert.match(summary, /^\+added line$/m);
	const capped = await s.git.diffSummary(path, base, 60);
	assert.ok(Buffer.byteLength(capped) <= 60);
	assert.ok(capped.endsWith("[truncated]"));
	assert.equal(await s.git.showFile(base, "AGENTS.md"), "# Guidance\nBe careful.\n");
	assert.equal(await s.git.showFile(base, "missing.md"), undefined);
	await assert.rejects(s.git.showFile(base, "../etc/passwd"), /invalid repository path/);
	assert.deepEqual(await s.git.changedFiles(base, base), []);
});

test("uncommittedChanges lists what the worktree holds beyond its last checkpoint; diffSummary includes untracked files; neither stages anything", async () => {
	const s = await setup({ "a.txt": "one\n", "gone.txt": "bye\n", ".gitignore": "ignored/\n*.log\n" });
	const { path, base } = await withWorktree(s);
	assert.deepEqual(await s.git.uncommittedChanges(path), []);
	writeFileSync(join(path, "a.txt"), "one\nchanged\n");
	rmSync(join(path, "gone.txt"));
	mkdirSync(join(path, "new", "deep"), { recursive: true });
	writeFileSync(join(path, "new", "deep", "file.txt"), "untracked content\n");
	writeFileSync(join(path, "debug.log"), "ignored\n");
	mkdirSync(join(path, "ignored"));
	writeFileSync(join(path, "ignored", "x.txt"), "ignored\n");
	assert.deepEqual(await s.git.uncommittedChanges(path), [
		{ path: "a.txt", change: "modified" },
		{ path: "gone.txt", change: "deleted" },
		{ path: "new/deep/file.txt", change: "new" },
	]);
	const summary = await s.git.diffSummary(path, base, 10_000);
	assert.match(summary, /^\+untracked content$/m, "an untracked file is in the summary");
	assert.match(summary, /^\+changed$/m);
	assert.ok(!summary.includes("ignored"), ".gitignore is respected");
	// Nothing was staged in the worktree's own index, and no scratch index is left behind.
	assert.equal(
		await local(s, [
			"--work-tree",
			path,
			"--git-dir",
			join(s.repoDir, "worktrees", "task-1"),
			"diff",
			"--cached",
			"--name-only",
		]),
		"",
	);
	assert.deepEqual(
		readdirSync(join(s.repoDir, "worktrees", "task-1")).filter((name) => name.startsWith("pi-scratch-")),
		[],
	);
	const { commit } = await s.git.checkpoint(path, "everything");
	assert.notEqual(commit, base);
	assert.deepEqual(await s.git.uncommittedChanges(path), [], "the checkpoint took exactly those changes");
});

test("repository hooks, outside config, inherited git env and .gitattributes filters have no effect", async () => {
	const s = await setup({ "a.txt": "one\n" });
	const markers = tempDir("pd-git-markers-");
	const evilHooks = tempDir("pd-git-evil-hooks-");
	const hookNames = [
		"pre-commit",
		"prepare-commit-msg",
		"commit-msg",
		"post-commit",
		"post-checkout",
		"post-merge",
		"pre-merge-commit",
		"pre-push",
		"reference-transaction",
		"post-index-change",
		"post-rewrite",
	];
	mkdirSync(join(s.repoDir, "hooks"), { recursive: true });
	for (const dir of [join(s.repoDir, "hooks"), evilHooks]) {
		for (const name of hookNames) {
			writeFileSync(join(dir, name), `#!/bin/sh\ntouch "${markers}/hook-${name}"\nexit 0\n`);
			chmodSync(join(dir, name), 0o755);
		}
	}
	const filter = (kind: string) => `sh -c 'touch "${markers}/filter-${kind}"; tr a-z A-Z'`;
	const evilConfig = [
		`[core]\n\thooksPath = ${evilHooks}\n\tfsmonitor = sh -c 'touch "${markers}/fsmonitor"'`,
		`[filter "evil"]\n\tclean = ${filter("clean")}\n\tsmudge = ${filter("smudge")}\n\trequired = true`,
		`[diff "evil"]\n\ttextconv = sh -c 'touch "${markers}/textconv"; cat'`,
		`[merge "evil"]\n\tdriver = sh -c 'touch "${markers}/merge-driver"; exit 1'`,
	].join("\n");
	// Local repository config (as if tampered with) and the host's global config.
	writeFileSync(join(s.repoDir, "config"), `${readFileSync(join(s.repoDir, "config"), "utf8")}\n${evilConfig}\n`);
	const evilHome = tempDir("pd-git-evil-home-");
	writeFileSync(join(evilHome, ".gitconfig"), `${evilConfig}\n`);
	const saved = { ...process.env };
	Object.assign(process.env, {
		HOME: evilHome,
		GIT_CONFIG_GLOBAL: join(evilHome, ".gitconfig"),
		GIT_DIR: join(evilHome, "nope.git"),
		GIT_WORK_TREE: evilHome,
		GIT_INDEX_FILE: join(evilHome, "index"),
	});
	try {
		await commitOnOrigin(s.bare, "main", { ".gitattributes": "* filter=evil diff=evil merge=evil\n" });
		const { path, branch, base } = await withWorktree(s);
		writeFileSync(join(path, "a.txt"), "one\nbranch\n");
		writeFileSync(join(path, "lower.txt"), "lowercase content\n");
		const { commit } = await s.git.checkpoint(path, "work");
		assert.equal(await local(s, ["cat-file", "blob", `${commit}:lower.txt`]), "lowercase content");
		await s.git.push(path, branch);
		await commitOnOrigin(s.bare, "main", { "a.txt": "one\nmain\n" });
		await s.git.fetchBase();
		assert.deepEqual(await s.git.mergeBase(path), { conflict: true, files: ["a.txt"] });
		await s.git.diffSummary(path, base, 10_000);
		writeFileSync(join(path, "a.txt"), "one\nresolved\n");
		await s.git.checkpoint(path, "fix");
		await s.git.push(path, branch, { requireExisting: true });
		await s.git.removeWorktree(path);
	} finally {
		for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
		Object.assign(process.env, saved);
	}
	assert.deepEqual(readdirSync(markers), [], "no hook, filter, driver or fsmonitor ran");
});

test("a staged .git path is refused (predicate)", () => {
	for (const path of [
		".git/config",
		"sub/.git/hooks/pre-commit",
		".GIT/x",
		"a/.git./b",
		"a/.git /b",
		"git~1/x",
		"a\\.git\\x",
	]) {
		assert.equal(isGitInternalPath(path), true, path);
	}
	for (const path of ["a.txt", ".gitignore", ".gitattributes", "src/.github/workflows/x.yml", "git/x", ".gitkeep"]) {
		assert.equal(isGitInternalPath(path), false, path);
	}
});

test("buildGitInvocation: hardening flags, scratch environment, token only in env for https network calls", () => {
	process.env.SOME_HOST_SECRET = "host-secret-value";
	const token = "github_pat_example_0123456789";
	const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
	const remote = "https://github.com/acme/widgets.git";
	const common = { remoteUrl: remote, token, home: "/tmp/empty-home", author };
	const push = buildGitInvocation({ ...common, args: ["push", remote, "HEAD:refs/heads/task/1"], network: true });
	const flat = JSON.stringify(push.argv);
	assert.ok(!flat.includes(token) && !flat.includes(basic), "token never in argv");
	assert.equal(push.env.GIT_CONFIG_COUNT, "1");
	assert.equal(push.env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
	assert.equal(push.env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${basic}`);
	for (const flag of [
		"core.hooksPath=/dev/null",
		"core.fsmonitor=false",
		"core.symlinks=true",
		"protocol.allow=never",
		"protocol.https.allow=always",
	]) {
		assert.equal(push.argv[push.argv.indexOf(flag) - 1], "-c", flag);
	}
	assert.ok(!push.argv.includes("protocol.file.allow=always"), "file protocol only for local remotes");
	assert.equal(push.env.GIT_CONFIG_NOSYSTEM, "1");
	assert.equal(push.env.GIT_CONFIG_GLOBAL, "/dev/null");
	assert.equal(push.env.GIT_TERMINAL_PROMPT, "0");
	assert.equal(push.env.GIT_ATTR_SOURCE, EMPTY_TREE);
	assert.equal(push.env.HOME, "/tmp/empty-home");
	assert.equal(push.env.LC_ALL, "C");
	assert.equal(push.env.GIT_AUTHOR_NAME, author.name);
	assert.equal(push.env.GIT_COMMITTER_EMAIL, author.email);
	assert.deepEqual(
		Object.keys(push.env).sort(),
		[
			"GIT_ATTR_SOURCE",
			"GIT_AUTHOR_EMAIL",
			"GIT_AUTHOR_NAME",
			"GIT_COMMITTER_EMAIL",
			"GIT_COMMITTER_NAME",
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_GLOBAL",
			"GIT_CONFIG_KEY_0",
			"GIT_CONFIG_NOSYSTEM",
			"GIT_CONFIG_VALUE_0",
			"GIT_TERMINAL_PROMPT",
			"HOME",
			"LC_ALL",
			"PATH",
		],
		"nothing inherited but PATH",
	);
	const commit = buildGitInvocation({ ...common, args: ["commit", "-m", "x"], network: false });
	assert.equal(commit.env.GIT_CONFIG_COUNT, undefined, "no token for local operations");
	assert.ok(!JSON.stringify(commit).includes(token));
	const localRemote = buildGitInvocation({ ...common, remoteUrl: "/srv/origin.git", args: ["fetch"], network: true });
	assert.ok(localRemote.argv.includes("protocol.file.allow=always"));
	assert.equal(localRemote.env.GIT_CONFIG_COUNT, undefined, "token never sent to a non-https remote");
	delete process.env.SOME_HOST_SECRET;
	assert.throws(
		() =>
			createGit({
				taskDir: "/tmp/x",
				remoteUrl: `https://x:${token}@github.com/a/b.git`,
				baseBranch: "main",
				token,
				author,
				log: silentLogger,
			}),
		/remote URL/,
	);
	assert.throws(
		() =>
			createGit({
				taskDir: "/tmp/x",
				remoteUrl: "http://github.com/a/b.git",
				baseBranch: "main",
				token,
				author,
				log: silentLogger,
			}),
		/remote URL/,
	);
});

test("a network call that hangs times out with code 'timeout', kills the remote helper and never logs the token", async () => {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.resume(); // read (and discard) the TLS hello so EOF is noticed; never answer
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	const lines: string[] = [];
	const token = "github_pat_should_never_be_logged_123";
	const git = createGit({
		taskDir: join(tempDir("pd-git-timeout-"), "tasks"),
		remoteUrl: `https://127.0.0.1:${port}/acme/widgets.git`,
		baseBranch: "main",
		token,
		author,
		log: createLogger({ level: "debug", sink: (_level, line) => lines.push(line) }),
		timeouts: { networkMs: 700 },
	});
	try {
		await git.ensureRepo();
		const started = Date.now();
		await assert.rejects(git.fetchBase(), (error: unknown) => {
			assert.ok(error instanceof GitError);
			assert.equal(error.code, "timeout");
			return true;
		});
		assert.ok(Date.now() - started < 10_000);
		await waitFor(() => sockets.size === 0, { timeoutMs: 5000, what: "remote helper killed" });
		assert.ok(lines.some((line) => line.includes("git_timeout")));
		assert.ok(!lines.join("\n").includes(token));
		assert.ok(!lines.join("\n").includes(Buffer.from(`x-access-token:${token}`).toString("base64")));
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("a task directory reached through a symlink works (git records real paths)", async () => {
	const real = tempDir("pd-git-real-");
	const link = join(tempDir("pd-git-link-"), "tasks-link");
	symlinkSync(real, link);
	const { bare } = await createOriginRepo(join(tempDir("pd-git-origin-"), "origin"), { "a.txt": "a\n" });
	const git = createGit({
		taskDir: link,
		remoteUrl: bare,
		baseBranch: "main",
		token: undefined,
		author,
		log: silentLogger,
	});
	await git.ensureRepo();
	const base = await git.fetchBase();
	const path = join(link, "worktrees", "task-7");
	await git.createWorktree("task/7", path, base);
	writeFileSync(join(path, "b.txt"), "b\n");
	assert.equal((await git.checkpoint(path, "work")).created, true);
	await git.push(path, "task/7");
	await git.removeWorktree(path);
	assert.ok(!existsSync(path));
	await assert.rejects(git.removeWorktree(join(link, "repo.git")), /outside the task directory/);
});
