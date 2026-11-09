import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Store } from "../../src/coordinator/store.ts";
import { CleanupFailure, DEFAULT_CONFIG } from "./policy.ts";
import {
	candidates,
	deleteWithLease,
	policyFor,
	runWorker,
	type Source,
	validateConfig,
	type WorkerConfig,
} from "./worker.ts";

const HEAD = "a".repeat(40),
	MERGE = "b".repeat(40);
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "cleanup-adapter-"));
	const database = join(root, "coordinator.sqlite");
	const store = new Store(database);
	for (const [id, state, archived] of [
		[1, "merged", 1],
		[2, "review", 0],
		[3, "cancelled", 1],
		[4, "merged", 0],
	] as const) {
		store.run(
			"INSERT INTO tasks(id,chat_id,creator_id,agent_id,text,update_id,state,branch,archived,head_commit,posted_head,tests_passed_head,pr_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			id,
			-1001,
			2001,
			"alpha",
			"PRIVATE TASK BODY MUST NOT BE READ",
			id,
			state,
			`task/${id}`,
			archived,
			HEAD,
			HEAD,
			HEAD,
			id,
			1,
			1,
		);
	}
	const approval = Number(
		store.run(
			"INSERT INTO approvals(task_id,user_id,update_id,head_commit,state,created_at) VALUES(1,2001,50,?,'consumed',1)",
			HEAD,
		).lastInsertRowid,
	);
	store.run(
		"INSERT INTO merge_intents(task_id,approval_id,head_commit,state,merge_commit,created_at,settled_at) VALUES(1,?,?,'merged',?,1,2)",
		approval,
		HEAD,
		MERGE,
	);
	store.close();
	const source: Source = {
		repository: "owner/demo",
		database,
		taskDir: join(root, "tasks"),
		taskPrefix: "task/",
		secretId: "test-repo-token",
	};
	const config: WorkerConfig = {
		stateDir: join(root, "cleanup-state"),
		sources: [source],
		policy: {
			...DEFAULT_CONFIG,
			mode: "dry-run",
			acceptanceComplete: true,
			activationApproved: true,
			notBeforeMs: 1,
			repository: "owner/demo",
		},
	};
	return { root, database, source, config };
}
const digest = async (path: string) =>
	createHash("sha256")
		.update(await readFile(path))
		.digest("hex");

test("metadata scanner excludes open, cancelled and unarchived tasks and does not change the source DB", async (t) => {
	const f = await fixture();
	t.after(() => rm(f.root, { recursive: true, force: true }));
	const before = await digest(f.database);
	const found = candidates(f.source);
	assert.equal(found.jobs.length, 1);
	assert.equal(found.jobs[0]?.job.taskId, 1);
	assert.equal(found.retained.review, 1);
	assert.equal(found.retained.cancelled, 1);
	assert.equal(found.retained.merged, 1);
	assert.ok(!JSON.stringify(found).includes("PRIVATE TASK BODY"));
	assert.equal(await digest(f.database), before);
});
test("legacy cutoff exemption requires the complete separately approved immutable tuple", async (t) => {
	const f = await fixture();
	t.after(() => rm(f.root, { recursive: true, force: true }));
	const candidate = candidates(f.source).jobs[0];
	assert.ok(candidate);
	const policy = { ...f.config.policy, notBeforeMs: 100000 };
	assert.equal(policyFor(candidate, policy).notBeforeMs, 100000);
	const approved = {
		...candidate,
		source: {
			...f.source,
			approvedLegacy: [{ branch: "task/1", taskId: 1, prNumber: 1, reviewedHead: HEAD, mergeCommit: MERGE }],
		},
	};
	assert.equal(policyFor(approved, policy).notBeforeMs, 1);
	assert.equal(
		policyFor({ ...approved, job: { ...approved.job, reviewedHead: "c".repeat(40) } }, policy).notBeforeMs,
		100000,
	);
});
test("disabled worker opens no source, writes no journal and requests no credential", async (t) => {
	const f = await fixture();
	t.after(() => rm(f.root, { recursive: true, force: true }));
	let called = false;
	await runWorker(
		{ ...f.config, policy: { ...f.config.policy, mode: "disabled" } },
		async () => {
			called = true;
			throw new Error("must not request");
		},
		() => {},
	);
	assert.equal(called, false);
	assert.equal(existsSync(f.config.stateDir), false);
});
test("unavailable GitHub preflight writes a retry only in the independent journal; merged tasks stay merged", async (t) => {
	const f = await fixture();
	t.after(() => rm(f.root, { recursive: true, force: true }));
	const before = await digest(f.database);
	const saved = globalThis.fetch;
	globalThis.fetch = async () => new Response("{}", { status: 503 });
	t.after(() => {
		globalThis.fetch = saved;
	});
	await runWorker(
		f.config,
		async () => "not-a-real-token",
		() => {},
	);
	const db = new DatabaseSync(join(f.config.stateDir, "cleanup.sqlite"), { readOnly: true });
	const row = db.prepare("SELECT result FROM cleanup_jobs").get() as { result: string };
	assert.equal(JSON.parse(row.result).state, "retry");
	db.close();
	assert.equal(await digest(f.database), before);
	assert.equal(candidates(f.source).jobs[0]?.job.taskId, 1);
});

test("positive GitHub preflight uses the canonical repository URL and records only a dry-run candidate", async (t) => {
	const f = await fixture();
	t.after(() => rm(f.root, { recursive: true, force: true }));
	const before = await digest(f.database);
	const saved = globalThis.fetch;
	const calls: string[] = [];
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: enumerate the complete read-only GitHub protocol fixture in one place.
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		calls.push(url.href);
		const path = decodeURIComponent(url.pathname);
		let body: unknown;
		if (path === "/repos/owner/demo") body = { default_branch: "main" };
		else if (path === "/repos/owner/demo/pulls" && url.search) body = [];
		else if (path === "/repos/owner/demo/pulls/1")
			body = {
				number: 1,
				merged: true,
				merged_at: "2026-01-01T00:00:00Z",
				merge_commit_sha: MERGE,
				head: { ref: "task/1", sha: HEAD },
				base: { ref: "main", repo: { full_name: "owner/demo" } },
			};
		else if (path.endsWith("/git/ref/heads/task/1")) body = { object: { sha: HEAD } };
		else if (path.endsWith("/branches/task/1")) body = { protected: false };
		else if (path.includes("/compare/")) body = { status: "ahead" };
		else if (path.endsWith(`/git/commits/${HEAD}`)) body = { sha: HEAD };
		else if (path.endsWith(`/git/commits/${MERGE}`)) body = { sha: MERGE };
		else return new Response("{}", { status: 404 });
		return new Response(JSON.stringify(body), { status: 200 });
	};
	t.after(() => {
		globalThis.fetch = saved;
	});
	await runWorker(
		f.config,
		async () => "not-a-real-token",
		() => {},
	);
	const db = new DatabaseSync(join(f.config.stateDir, "cleanup.sqlite"), { readOnly: true });
	const row = db.prepare("SELECT result FROM cleanup_jobs").get() as { result: string };
	assert.equal(JSON.parse(row.result).state, "would-delete");
	db.close();
	assert.ok(calls.includes("https://api.github.com/repos/owner/demo"));
	assert.ok(!calls.includes("https://api.github.com/repos/owner/demo/"));
	assert.equal(await digest(f.database), before);
});
test("configuration refuses relative DB paths and incomplete historical authorizations", async () => {
	const base: WorkerConfig = { stateDir: "/tmp/cleanup-test", sources: [], policy: { ...DEFAULT_CONFIG } };
	validateConfig(base);
	assert.throws(() =>
		validateConfig({
			...base,
			sources: [
				{
					repository: "owner/demo",
					database: "relative.sqlite",
					taskDir: "/tmp/tasks",
					taskPrefix: "task/",
					secretId: "token",
				},
			],
		}),
	);
	assert.throws(() =>
		validateConfig({
			...base,
			sources: [
				{
					repository: "owner/demo",
					database: "/tmp/source.sqlite",
					taskDir: "/tmp/tasks",
					taskPrefix: "task/",
					secretId: "token",
					approvedLegacy: [{ branch: "main", taskId: 1, prNumber: 1, reviewedHead: HEAD, mergeCommit: MERGE }],
				},
			],
		}),
	);
});

test("real Git deletion lease rejects a changed head, deletes the reviewed head and preserves main and recovery objects", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "cleanup-lease-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const remote = join(root, "remote.git"),
		seed = join(root, "seed");
	const env = {
		...process.env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Cleanup test",
		GIT_AUTHOR_EMAIL: "cleanup@example.test",
		GIT_COMMITTER_NAME: "Cleanup test",
		GIT_COMMITTER_EMAIL: "cleanup@example.test",
	};
	const git = (argv: string[], allowed = [0]) => {
		const r = spawnSync("git", argv, { encoding: "utf8", env });
		assert.ok(allowed.includes(r.status ?? -1), r.stderr);
		return r.stdout.trim();
	};
	git(["init", "--bare", remote]);
	git(["init", "-b", "main", seed]);
	await writeFile(join(seed, "file.txt"), "one\n");
	git(["-C", seed, "add", "."]);
	git(["-C", seed, "commit", "-m", "one"]);
	const first = git(["-C", seed, "rev-parse", "HEAD"]);
	git(["-C", seed, "push", remote, "HEAD:main", "HEAD:task/1"]);
	await writeFile(join(seed, "file.txt"), "two\n");
	git(["-C", seed, "commit", "-am", "two"]);
	const changed = git(["-C", seed, "rev-parse", "HEAD"]);
	git(["-C", seed, "push", remote, "HEAD:task/1"]);
	await assert.rejects(
		deleteWithLease(remote, "refs/heads/task/1", first, "fake-test-token", join(root, "worker.git")),
		(e) => e instanceof CleanupFailure && e.category === "changed",
	);
	assert.equal(git(["--git-dir", remote, "rev-parse", "refs/heads/task/1"]), changed);
	await deleteWithLease(remote, "refs/heads/task/1", changed, "fake-test-token", join(root, "worker.git"));
	git(["--git-dir", remote, "show-ref", "--verify", "--quiet", "refs/heads/task/1"], [1]);
	assert.equal(git(["--git-dir", remote, "rev-parse", "refs/heads/main"]), first);
	git(["--git-dir", remote, "cat-file", "-e", `${changed}^{commit}`]);
});
