/**
 * Engine unit tests: a real Store and the local test sandbox (fsop.mjs subprocesses), an in-memory git + GitHub
 * "world", and a scripted RunLauncher (no Pi process). Commands are simulated by writing the rows commands.ts writes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type TestContext, test } from "node:test";
import type { Update } from "grammy/types";
import { admitRun } from "../../src/coordinator/admission.ts";
import { ConfigError, type CoordinatorConfig, parseCoordinatorConfig } from "../../src/coordinator/config.ts";
import { startCoordinator } from "../../src/coordinator/coordinator.ts";
import { INTERRUPTED_NOTE } from "../../src/coordinator/engine/review.ts";
import { createEngine, type Engine } from "../../src/coordinator/engine.ts";
import { type Git, GitError } from "../../src/coordinator/git.ts";
import { DEMO_LIMITS, type Limits } from "../../src/coordinator/limits.ts";
import {
	type GitHubApi,
	GitHubError,
	type PullRequest,
	type RunLauncher,
	type RunnerExit,
	type RunnerHandle,
	type Sandbox,
	type SendMessageParams,
	type TelegramApi,
	TelegramError,
} from "../../src/coordinator/ports.ts";
import { hashRunKey } from "../../src/coordinator/relay.ts";
import { createLocalSandbox, type LocalCheck } from "../../src/coordinator/sandbox/local.ts";
import { Store } from "../../src/coordinator/store.ts";
import type { FromRunner, RunnerStart, ToRunner } from "../../src/runner/protocol.ts";
import { silentLogger } from "../../src/runtime/log.ts";
import { sleep, waitFor } from "../helpers/env.ts";

const CHAT = -1001;
const OWNER = 42;
const USER = 7;

// ---------------------------------------------------------------------------------------------------------------
// In-memory git + GitHub

type Snapshot = Map<string, string>;
type Pull = {
	number: number;
	head: string;
	base: string;
	title: string;
	body: string;
	state: "open" | "closed";
	merged: boolean;
	mergeCommitSha: string | undefined;
	frozenHead: string | undefined;
};

async function readTree(root: string): Promise<Snapshot> {
	const files: Snapshot = new Map();
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) files.set(relative(root, full), await readFile(full, "utf8"));
		}
	};
	await walk(root);
	return files;
}

async function writeTree(root: string, files: Snapshot): Promise<void> {
	for (const [path, content] of files) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
}

function sameTree(a: Snapshot, b: Snapshot): boolean {
	if (a.size !== b.size) return false;
	for (const [key, value] of a) if (b.get(key) !== value) return false;
	return true;
}

function createWorld() {
	let counter = 0;
	const commits = new Map<string, { parents: string[]; files: Snapshot }>();
	const commit = (parents: string[], files: Snapshot): string => {
		counter++;
		const sha = createHash("sha1")
			.update(`${counter}|${parents.join(",")}`)
			.digest("hex");
		commits.set(sha, { parents, files: new Map(files) });
		return sha;
	};
	const root = commit(
		[],
		new Map([
			["README.md", "# demo\n"],
			["AGENTS.md", "Keep it simple.\n"],
		]),
	);
	const state = { main: root, conflictNext: undefined as string[] | undefined, dropNextCreate: false };
	const remote = new Map<string, string>();
	const worktrees = new Map<string, { branch: string; head: string; mergeParent: string | undefined }>();
	const calls: string[] = [];
	const pulls = new Map<number, Pull>();
	let inflight = 0;
	let maxInflight = 0;
	const exclusive = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
		calls.push(name);
		inflight++;
		maxInflight = Math.max(maxInflight, inflight);
		try {
			await sleep(10);
			return await work();
		} finally {
			inflight--;
		}
	};
	const isAncestor = (ancestor: string, descendant: string): boolean => {
		const seen = new Set<string>();
		const stack = [descendant];
		while (stack.length > 0) {
			const sha = stack.pop() as string;
			if (sha === ancestor) return true;
			if (seen.has(sha)) continue;
			seen.add(sha);
			stack.push(...(commits.get(sha)?.parents ?? []));
		}
		return false;
	};
	const files = (sha: string): Snapshot => commits.get(sha)?.files ?? new Map();
	const wt = (path: string) => {
		const entry = worktrees.get(path);
		if (entry === undefined) throw new GitError("failed", "no such worktree");
		return entry;
	};

	const git: Git = {
		baseRef: "refs/remotes/origin/main",
		async ensureRepo() {},
		async fetchBase() {
			calls.push("fetchBase");
			return state.main;
		},
		async remoteBranchSha(branch) {
			return remote.get(branch);
		},
		async createWorktree(branch, path, base) {
			calls.push("createWorktree");
			if (existsSync(path)) throw new GitError("failed", "worktree exists");
			await mkdir(path, { recursive: true });
			await writeTree(path, files(base));
			worktrees.set(path, { branch, head: base, mergeParent: undefined });
		},
		async removeWorktree(path) {
			calls.push("removeWorktree");
			await rm(path, { recursive: true, force: true });
			worktrees.delete(path);
		},
		async isPristineWorktree(path, branch, base) {
			const entry = worktrees.get(path);
			if (entry === undefined || entry.branch !== branch || entry.head !== base || entry.mergeParent !== undefined)
				return false;
			return sameTree(await readTree(path), files(base));
		},
		async deleteBranch() {
			calls.push("deleteBranch");
		},
		async head(path) {
			return wt(path).head;
		},
		async checkpoint(path) {
			calls.push("checkpoint");
			const entry = wt(path);
			const tree = await readTree(path);
			if (entry.mergeParent === undefined && sameTree(tree, files(entry.head)))
				return { commit: entry.head, created: false };
			const parents = entry.mergeParent === undefined ? [entry.head] : [entry.head, entry.mergeParent];
			entry.head = commit(parents, tree);
			entry.mergeParent = undefined;
			return { commit: entry.head, created: true };
		},
		async push(path, branch) {
			calls.push("push");
			const entry = wt(path);
			const current = remote.get(branch);
			if (current !== undefined && !isAncestor(current, entry.head)) throw new GitError("rejected", "non-fast-forward");
			remote.set(branch, entry.head);
		},
		async mergeBase(path) {
			return exclusive("mergeBase", async () => {
				const entry = wt(path);
				if (state.conflictNext !== undefined) {
					const conflicted = state.conflictNext;
					state.conflictNext = undefined;
					for (const file of conflicted)
						await writeFile(join(path, file), "<<<<<<< ours\na\n=======\nb\n>>>>>>> main\n");
					entry.mergeParent = state.main;
					return { conflict: true as const, files: conflicted };
				}
				const merged = new Map([...files(state.main), ...(await readTree(path))]);
				const sha = commit([entry.head, state.main], merged);
				await writeTree(path, merged);
				entry.head = sha;
				return { conflict: false as const, commit: sha, moved: true };
			});
		},
		async isAncestor(ancestor, descendant) {
			return isAncestor(ancestor, descendant);
		},
		async changedFiles(base, head) {
			const a = files(base);
			const b = files(head);
			return [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key)).sort();
		},
		async diffSummary(path, base) {
			const tree = await readTree(path);
			const a = files(base);
			return [...tree.keys()]
				.filter((key) => a.get(key) !== tree.get(key))
				.map((key) => `M ${key}`)
				.join("\n");
		},
		async showFile(rev, path) {
			return files(rev).get(path);
		},
	};

	const view = (pull: Pull): PullRequest => ({
		number: pull.number,
		url: `https://github.test/acme/demo/pull/${pull.number}`,
		state: pull.state,
		merged: pull.merged,
		headSha: pull.frozenHead ?? remote.get(pull.head) ?? "",
		headRef: pull.head,
		baseRef: pull.base,
		mergeCommitSha: pull.mergeCommitSha,
	});
	const pull = (number: number): Pull => {
		const found = pulls.get(number);
		if (found === undefined) throw new GitHubError("not found", 404, false);
		return found;
	};
	const github: GitHubApi = {
		async findPullRequest(head, base) {
			calls.push("findPullRequest");
			const matches = [...pulls.values()].filter((p) => p.head === head && p.base === base);
			const found = matches.find((p) => p.state === "open") ?? matches.at(-1);
			return found === undefined ? undefined : view(found);
		},
		async getPullRequest(number) {
			return view(pull(number));
		},
		async createPullRequest(params) {
			calls.push("createPullRequest");
			const open = [...pulls.values()].some(
				(p) => p.head === params.head && p.base === params.base && p.state === "open",
			);
			if (open) throw new GitHubError("A pull request already exists", 422, false);
			const sha = remote.get(params.head);
			if (sha === undefined || isAncestor(sha, state.main)) throw new GitHubError("No commits between", 422, false);
			const number = pulls.size + 1;
			pulls.set(number, {
				number,
				...params,
				state: "open",
				merged: false,
				mergeCommitSha: undefined,
				frozenHead: undefined,
			});
			if (state.dropNextCreate) {
				state.dropNextCreate = false;
				throw new GitHubError("network error", undefined, true);
			}
			return view(pull(number));
		},
		async updatePullRequest(number, params) {
			calls.push("updatePullRequest");
			Object.assign(pull(number), params);
			return view(pull(number));
		},
		async closePullRequest(number) {
			calls.push("closePullRequest");
			const p = pull(number);
			p.frozenHead = remote.get(p.head);
			p.state = "closed";
			return view(p);
		},
		async mergePullRequest(number, sha) {
			return exclusive("mergePullRequest", async () => {
				const p = pull(number);
				const head = remote.get(p.head) as string;
				if (head !== sha) return { merged: false as const, status: 409, reason: "head modified" };
				if (!isAncestor(state.main, head)) return { merged: false as const, status: 405, reason: "not up to date" };
				const merge = commit([state.main, head], files(head));
				state.main = merge;
				Object.assign(p, { merged: true, state: "closed", frozenHead: head, mergeCommitSha: merge });
				return { merged: true as const, sha: merge };
			});
		},
		async branchSha(branch) {
			return branch === "main" ? state.main : remote.get(branch);
		},
		async branchContains(branch, sha) {
			const tip = branch === "main" ? state.main : remote.get(branch);
			return tip !== undefined && isAncestor(sha, tip);
		},
	};

	return {
		git,
		github,
		state,
		remote,
		pulls,
		calls,
		root,
		files,
		maxInflight: () => maxInflight,
		/** Another change lands on main (e.g. a peer's merge). */
		advanceMain(name: string, content: string): string {
			const next = new Map(files(state.main));
			next.set(name, content);
			state.main = commit([state.main], next);
			return state.main;
		},
		/** A commit on top of `parent` (e.g. someone pushing to a task branch). */
		commitOn(parent: string, name: string, content: string): string {
			const next = new Map(files(parent));
			next.set(name, content);
			return commit([parent], next);
		},
	};
}

type World = ReturnType<typeof createWorld>;

// ---------------------------------------------------------------------------------------------------------------
// Scripted runner

type FakeRun = {
	readonly start: RunnerStart;
	readonly key: string;
	readonly received: ToRunner[];
	keyStateAtAbort: string | undefined;
	emit(message: FromRunner): void;
	next(type: ToRunner["type"]): Promise<ToRunner>;
	release(): void;
	readonly released: Promise<"release">;
	exit(code?: number | null, signal?: NodeJS.Signals | null): void;
};

type Script = (run: FakeRun) => Promise<void>;

function createFakeLauncher(onAbort: (run: FakeRun) => void) {
	const runs: FakeRun[] = [];
	const control = { script: workScript() as Script };
	const launcher: RunLauncher = {
		isolation: "process",
		available: async () => ({ ok: true }),
		launch(start, key, onMessage): RunnerHandle {
			let resolveExit: (exit: RunnerExit) => void = () => {};
			const exited = new Promise<RunnerExit>((resolve) => {
				resolveExit = resolve;
			});
			let done = false;
			const queue: ToRunner[] = [];
			const waiters: Array<{ type: string; resolve: (message: ToRunner) => void }> = [];
			let release: () => void = () => {};
			const released = new Promise<"release">((resolve) => {
				release = () => resolve("release");
			});
			const run: FakeRun = {
				start,
				key,
				received: [],
				keyStateAtAbort: undefined,
				emit(message) {
					if (!done) setImmediate(() => onMessage(message));
				},
				next(type) {
					const index = queue.findIndex((message) => message.type === type);
					if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0] as ToRunner);
					return new Promise((resolve) => waiters.push({ type, resolve }));
				},
				release,
				released,
				exit(code = 0, signal = null) {
					if (done) return;
					done = true;
					setImmediate(() => resolveExit({ code, signal }));
				},
			};
			runs.push(run);
			void control.script(run).catch(() => run.exit(1));
			return {
				pid: undefined,
				send(message: ToRunner) {
					if (done) throw new Error("channel closed");
					run.received.push(message);
					if (message.type === "abort") onAbort(run);
					const index = waiters.findIndex((waiter) => waiter.type === message.type);
					if (index >= 0) (waiters.splice(index, 1)[0] as { resolve: (m: ToRunner) => void }).resolve(message);
					else queue.push(message);
				},
				kill() {
					run.exit(null, "SIGKILL");
				},
				exited,
			};
		},
		isRunner: () => false,
		killRunner: () => {},
		leftovers: () => [],
	};
	return { launcher, runs, control };
}

/** Write a file, then answer. */
function workScript(
	path = "src/feature.js",
	content = "export const feature = 1;\n",
	answer = "Added the feature.",
): Script {
	return async (run) => {
		run.emit({ type: "ready" });
		run.emit({ type: "tool", id: 1, name: "write", args: { path, content } });
		await run.next("tool_result");
		run.emit({ type: "finished", outcome: "answered", answer, delivered: [], unconsumed: [], answered: [] });
		run.exit(0);
	};
}

/** Write wip.txt, then wait for an abort (finished aborted) or a release (finished answered). */
function holdScript(): Script {
	return async (run) => {
		run.emit({ type: "ready" });
		run.emit({ type: "tool", id: 1, name: "write", args: { path: "wip.txt", content: "work in progress\n" } });
		await run.next("tool_result");
		const event = await Promise.race([run.next("abort"), run.released]);
		if (event === "release") {
			run.emit({ type: "finished", outcome: "answered", answer: "Done.", delivered: [], unconsumed: [], answered: [] });
		} else {
			run.emit({ type: "finished", outcome: "aborted", delivered: [], unconsumed: [], answered: [] });
		}
		run.exit(0);
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Harness

function testConfig(dir: string): CoordinatorConfig {
	return parseCoordinatorConfig(
		{
			TELEGRAM_BOT_TOKEN: `123456:${"a".repeat(35)}`,
			TELEGRAM_BOT_USERNAME: "engine_test_bot",
			TELEGRAM_GROUP_CHAT_ID: String(CHAT),
			TELEGRAM_OWNER_ID: String(OWNER),
			PI_AGENTS: "alpha,beta,gamma,delta,omega",
			PI_MODEL: "gpt-test",
			PI_THINKING: "off",
			OPENAI_API_KEY: "sk-test-not-real",
			PROJECT_TOKEN_CEILING: "1000000",
			GITHUB_TOKEN: "ghp_test_not_real",
			GITHUB_REPO: "acme/demo",
			PI_DATA_DIR: join(dir, "data"),
			PI_TASK_DIR: join(dir, "tasks"),
		},
		{ cwd: dir, home: dir, uid: 1000, gid: 1000 },
	);
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(
	t: TestContext,
	options: {
		limits?: Partial<Limits>;
		checks?: Record<string, LocalCheck>;
		store?: Store;
		dir?: string;
		world?: World;
		/** The engine's clock (default: the store's). */
		now?: () => number;
		/** Wraps the local sandbox (e.g. to report a leftover container). */
		sandbox?: (sandbox: Sandbox) => Sandbox;
	} = {},
) {
	const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "engine-test-")));
	if (options.dir === undefined) t.after(() => rm(dir, { recursive: true, force: true }));
	const config = testConfig(dir);
	await mkdir(config.paths.dataDir, { recursive: true });
	await mkdir(config.paths.taskDir, { recursive: true });
	const store = options.store ?? new Store(join(config.paths.dataDir, "coordinator.sqlite"));
	const world = options.world ?? createWorld();
	const local = createLocalSandbox({
		taskDir: config.paths.taskDir,
		...(options.checks ? { checks: options.checks } : {}),
	});
	const sandbox = options.sandbox?.(local) ?? local;
	const keyState = (key: string) =>
		store.get<{ state: string }>("SELECT state FROM run_keys WHERE key_hash = ?", hashRunKey(key))?.state;
	const fake = createFakeLauncher((run) => {
		run.keyStateAtAbort = keyState(run.key);
	});
	const limits: Limits = {
		...DEMO_LIMITS,
		stopGraceMs: 300,
		checkDeadlineMs: 3000,
		runDeadlineMs: 30_000,
		minFreeDiskBytes: 0,
		...options.limits,
	};
	const engine: Engine = createEngine({
		store,
		config,
		limits,
		git: world.git,
		github: world.github,
		sandbox,
		launcher: fake.launcher,
		log: silentLogger,
		retryDelayMs: 5,
		freeBytes: async () => 1e12,
		...(options.now === undefined ? {} : { now: options.now }),
	});
	engine.setRelayUrl("http://127.0.0.1:9/v1");
	if (options.store === undefined) {
		t.after(async () => {
			await engine.stop();
			store.close();
		});
	} else {
		t.after(() => engine.stop());
	}
	return { dir, config, store, world, sandbox, fake, limits, engine, keyState };
}

let nextUpdate = 5000;

function submitTask(h: Harness, agent: string, text: string, user = USER): number {
	const updateId = nextUpdate++;
	return h.store.tx(() => {
		const now = Date.now();
		h.store.run(
			`INSERT INTO commands(update_id, chat_id, user_id, message_id, kind, outcome, received_at)
			 VALUES (?, ?, ?, ?, 'task', 'accepted', ?)`,
			updateId,
			CHAT,
			user,
			updateId + 100_000,
			now,
		);
		const taskId = h.store.run(
			`INSERT INTO tasks(chat_id, creator_id, agent_id, text, update_id, state, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
			CHAT,
			user,
			agent,
			text,
			updateId,
			now,
			now,
		).lastInsertRowid;
		const admitted = admitRun(h.store, h.limits, {
			taskId,
			kind: "initial",
			requestedBy: user,
			requestId: String(updateId),
			inputText: text,
		});
		assert.ok(admitted.ok);
		return taskId;
	});
}

function steer(h: Harness, taskId: number, runId: number, text: string): { followupId: number; updateId: number } {
	const updateId = nextUpdate++;
	const followupId = h.store.tx(() => {
		const id = h.store.run(
			`INSERT INTO followups(task_id, update_id, user_id, message_id, text, mode, run_id, state, created_at)
			 VALUES (?, ?, ?, ?, ?, 'steer', ?, 'pending', ?)`,
			taskId,
			updateId,
			USER,
			updateId + 100_000,
			text,
			runId,
			Date.now(),
		).lastInsertRowid;
		h.store.run("UPDATE tasks SET followup_count = followup_count + 1 WHERE id = ?", taskId);
		return id;
	});
	return { followupId, updateId };
}

function followupRun(h: Harness, taskId: number, text: string): number {
	const updateId = nextUpdate++;
	return h.store.tx(() => {
		const admitted = admitRun(h.store, h.limits, {
			taskId,
			kind: "followup",
			requestedBy: USER,
			requestId: String(updateId),
			inputText: text,
		});
		assert.ok(admitted.ok, admitted.ok ? "" : admitted.reason);
		const now = Date.now();
		const followupId = h.store.run(
			`INSERT INTO followups(task_id, update_id, user_id, message_id, text, mode, run_id, state, created_at, settled_at)
			 VALUES (?, ?, ?, ?, ?, 'run', ?, 'started', ?, ?)`,
			taskId,
			updateId,
			USER,
			updateId + 100_000,
			text,
			admitted.runId,
			now,
			now,
		).lastInsertRowid;
		h.store.run("UPDATE runs SET followup_id = ? WHERE id = ?", followupId, admitted.runId);
		return admitted.runId;
	});
}

function approve(h: Harness, taskId: number): number {
	const updateId = nextUpdate++;
	return h.store.tx(() => {
		const task = h.store.get<{ posted_head: string | null; state: string }>("SELECT * FROM tasks WHERE id = ?", taskId);
		assert.equal(task?.state, "review");
		assert.ok(task?.posted_head);
		const id = h.store.run(
			`INSERT INTO approvals(task_id, user_id, update_id, head_commit, state, created_at)
			 VALUES (?, ?, ?, ?, 'valid', ?)`,
			taskId,
			USER,
			updateId,
			task.posted_head,
			Date.now(),
		).lastInsertRowid;
		h.store.run("UPDATE tasks SET state = 'merging' WHERE id = ?", taskId);
		return id;
	});
}

function requestCancel(h: Harness, taskId: number): void {
	h.store.tx(() =>
		h.store.run("UPDATE tasks SET cancel_requested = 1, cancel_requested_by = ? WHERE id = ?", USER, taskId),
	);
}

type TaskRecord = Record<string, unknown> & {
	state: string;
	reason: string | null;
	worktree_path: string | null;
	branch: string | null;
	base_commit: string | null;
	head_commit: string | null;
	posted_head: string | null;
	tests_passed_head: string | null;
	pr_number: number | null;
	archived: number;
};
type RunRecord = Record<string, unknown> & {
	id: number;
	state: string;
	reason: string | null;
	conversation_id: string | null;
	review_done: number;
	checkpoint_commit: string | null;
	answer: string | null;
};

const taskRow = (h: Harness, id: number) =>
	h.store.get<TaskRecord>("SELECT * FROM tasks WHERE id = ?", id) as TaskRecord;
const runsOf = (h: Harness, taskId: number) =>
	h.store.all<RunRecord>("SELECT * FROM runs WHERE task_id = ? ORDER BY id", taskId);
const slotCount = (h: Harness) => h.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM slots")?.n ?? 0;
const messages = (h: Harness, kind?: string) =>
	h.store
		.all<{ kind: string; text: string; reply_to: number | null; task_id: number | null }>(
			"SELECT * FROM outbox ORDER BY id",
		)
		.filter((row) => kind === undefined || row.kind === kind);
const count = (list: readonly string[], name: string) => list.filter((entry) => entry === name).length;

async function runToReview(h: Harness, agent = "alpha", text = "add the feature"): Promise<number> {
	const taskId = submitTask(h, agent, text);
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).state, "review");
	return taskId;
}

// ---------------------------------------------------------------------------------------------------------------
// Tests

test("dispatch respects 2 global slots and 1 run per agent, FIFO", async (t) => {
	const h = await harness(t);
	h.fake.control.script = holdScript();
	const t1 = submitTask(h, "alpha", "one");
	const t2 = submitTask(h, "alpha", "two");
	const t3 = submitTask(h, "beta", "three");
	const t4 = submitTask(h, "gamma", "four");
	h.engine.kick();
	await waitFor(() => h.fake.runs.length === 2, { what: "two runs" });
	await sleep(150);
	const runFor = (taskId: number) => h.fake.runs.find((run) => run.start.taskId === taskId);
	assert.deepEqual(h.fake.runs.map((run) => run.start.taskId).sort(), [t1, t3].sort());
	assert.equal(slotCount(h), 2);
	assert.deepEqual(
		h.store.all<{ agent_id: string }>("SELECT agent_id FROM slots ORDER BY agent_id").map((row) => row.agent_id),
		["alpha", "beta"],
	);
	assert.equal(runsOf(h, t2)[0]?.state, "queued");
	assert.equal(runsOf(h, t4)[0]?.state, "queued");
	// Alpha's run ends normally: its slot is released only after the review step; then t2 (alpha) is next in FIFO.
	runFor(t1)?.release();
	await waitFor(() => h.fake.runs.length === 3, { what: "third run" });
	assert.equal(h.fake.runs[2]?.start.taskId, t2);
	assert.equal(taskRow(h, t1).state, "review");
	assert.equal(runsOf(h, t4)[0]?.state, "queued");
	assert.equal(slotCount(h), 2);
	for (const run of h.fake.runs) run.release();
	await waitFor(() => h.fake.runs.length === 4, { what: "fourth run" });
	h.fake.runs[3]?.release();
	await h.engine.idle();
	assert.equal(slotCount(h), 0);
	for (const id of [t1, t2, t3, t4]) assert.equal(taskRow(h, id).state, "review");
});

test("a first run waits while the group has 4 open tasks", async (t) => {
	const h = await harness(t);
	const now = Date.now();
	for (let i = 0; i < 4; i++) {
		h.store.tx(() =>
			h.store.run(
				`INSERT INTO tasks(chat_id, creator_id, agent_id, text, update_id, state, worktree_path, branch, created_at, updated_at)
				 VALUES (?, ?, 'omega', 'open', ?, 'review', ?, ?, ?, ?)`,
				CHAT,
				USER,
				900 + i,
				join(h.config.paths.taskDir, "worktrees", `open-${i}`),
				`task/open-${i}`,
				now,
				now,
			),
		);
	}
	const waiting = submitTask(h, "alpha", "wait for reviews");
	h.engine.kick();
	await h.engine.idle();
	assert.equal(h.fake.runs.length, 0);
	assert.equal(taskRow(h, waiting).state, "queued");
	h.store.tx(() =>
		h.store.run("UPDATE tasks SET state = 'merged', worktree_path = NULL, archived = 1 WHERE update_id = 900"),
	);
	h.engine.kick();
	await h.engine.idle();
	assert.equal(h.fake.runs.length, 1);
	assert.equal(taskRow(h, waiting).state, "review");
});

test("two first runs cannot both take the last open-task place", async (t) => {
	const h = await harness(t);
	const now = Date.now();
	for (let i = 0; i < 3; i++) {
		h.store.tx(() =>
			h.store.run(
				`INSERT INTO tasks(chat_id, creator_id, agent_id, text, update_id, state, worktree_path, branch, created_at, updated_at)
				 VALUES (?, ?, 'omega', 'open', ?, 'review', ?, ?, ?, ?)`,
				CHAT,
				USER,
				800 + i,
				join(h.config.paths.taskDir, "worktrees", `open-${i}`),
				`task/open-${i}`,
				now,
				now,
			),
		);
	}
	h.fake.control.script = holdScript();
	const first = submitTask(h, "alpha", "first");
	const second = submitTask(h, "beta", "second");
	h.engine.kick();
	await waitFor(() => h.fake.runs.length === 1, { what: "one run" });
	await sleep(150);
	assert.equal(h.fake.runs.length, 1);
	assert.equal(h.fake.runs[0]?.start.taskId, first);
	assert.equal(runsOf(h, second)[0]?.state, "queued");
	h.fake.runs[0]?.release();
	await h.engine.idle();
	assert.equal(taskRow(h, first).state, "review");
	assert.equal(runsOf(h, second)[0]?.state, "queued");
});

test("normal completion: one branch+worktree, review step, PR once, posted_head, slot released; follow-up reuses PR and conversation", async (t) => {
	const h = await harness(t);
	const taskId = await runToReview(h, "alpha", "add email validation");
	const first = h.fake.runs[0] as FakeRun;
	assert.equal(first.start.fresh, true);
	assert.equal(first.start.input.content, "add email validation");
	assert.match(first.start.instructions, /Keep it simple\./);
	assert.deepEqual(first.start.checkOps, ["test"]);
	const task = taskRow(h, taskId);
	assert.equal(task.branch, "task/1".replace("1", String(taskId)));
	assert.equal(task.worktree_path, join(h.config.paths.taskDir, "worktrees", `task-${taskId}`));
	assert.equal(task.base_commit, h.world.root);
	assert.ok(task.head_commit);
	assert.equal(task.head_commit, h.world.remote.get(task.branch as string));
	assert.equal(task.posted_head, task.head_commit);
	assert.equal(task.tests_passed_head, task.head_commit);
	assert.equal(task.pr_number, 1);
	assert.equal(h.world.files(task.head_commit as string).get("src/feature.js"), "export const feature = 1;\n");
	const [run] = runsOf(h, taskId);
	assert.equal(run?.state, "finished");
	assert.equal(run?.review_done, 1);
	assert.equal(run?.checkpoint_commit, task.head_commit);
	assert.equal(run?.answer, "Added the feature.");
	assert.equal(h.keyState(first.key), "closed");
	assert.equal(slotCount(h), 0);
	const conversation = h.store.get<{ reusable: number; quarantined: number }>(
		"SELECT * FROM conversations WHERE id = ?",
		run?.conversation_id as string,
	);
	assert.deepEqual({ ...conversation }, { ...conversation, reusable: 1, quarantined: 0 });
	const review = messages(h, "task_review");
	assert.equal(review.length, 1);
	assert.match(review[0]?.text ?? "", new RegExp(`Task ${taskId} is ready for review \\(run 1\\)\\. Tests: passed\\.`));
	assert.match(
		review[0]?.text ?? "",
		/Pull request: https:\/\/github\.test\/acme\/demo\/pull\/1\. Head: [0-9a-f]{7}\. Test files changed: none\./,
	);
	assert.match(review[0]?.text ?? "", /send \/approve \d+\./);
	assert.equal(count(h.world.calls, "createPullRequest"), 1);
	assert.equal(count(h.world.calls, "createWorktree"), 1);

	// A follow-up during review: another run on the same branch, PR and (clean) conversation.
	h.fake.control.script = workScript("test/feature.test.js", "test('x', () => {});\n", "Added a test.");
	const run2 = followupRun(h, taskId, "add a unit test too");
	h.engine.kick();
	await h.engine.idle();
	const second = h.fake.runs[1] as FakeRun;
	assert.equal(second.start.fresh, false);
	assert.equal(second.start.conversationPath, first.start.conversationPath);
	assert.equal(second.start.input.content, "add a unit test too");
	assert.notEqual(second.key, first.key);
	const runs = runsOf(h, taskId);
	assert.equal(runs[1]?.id, run2);
	assert.equal(runs[1]?.conversation_id, runs[0]?.conversation_id);
	const after = taskRow(h, taskId);
	assert.equal(after.state, "review");
	assert.equal(after.pr_number, 1);
	assert.notEqual(after.head_commit, task.head_commit);
	assert.equal(after.posted_head, after.head_commit);
	assert.equal(count(h.world.calls, "createPullRequest"), 1);
	assert.ok(count(h.world.calls, "updatePullRequest") >= 1);
	assert.equal(count(h.world.calls, "createWorktree"), 1);
	assert.match(messages(h, "task_review")[1]?.text ?? "", /\(run 2\).*Test files changed: test\/feature\.test\.js\./s);
	assert.equal(slotCount(h), 0);
});

test("a lost pull request response is found by head/base: no second pull request", async (t) => {
	const h = await harness(t);
	h.world.state.dropNextCreate = true;
	const taskId = await runToReview(h);
	assert.equal(h.world.pulls.size, 1);
	assert.equal(count(h.world.calls, "createPullRequest"), 1);
	assert.equal(taskRow(h, taskId).pr_number, 1);
	assert.equal(h.store.groupState(CHAT).state, "normal");
});

test("limit: key closed before abort, task failed, PR closed, worktree archived, slot released", async (t) => {
	const h = await harness(t);
	const taskId = await runToReview(h);
	h.fake.control.script = holdScript();
	const runId = followupRun(h, taskId, "keep going");
	h.engine.kick();
	await waitFor(() => runsOf(h, taskId)[1]?.state === "running", { what: "second run running" });
	await waitFor(() => h.fake.runs[1]?.received.some((m) => m.type === "tool_result"), { what: "tool result" });
	const { followupId } = steer(h, taskId, runId, "also this");
	h.engine.onRunLimit(runId, "request_cap");
	await h.engine.idle();
	const held = h.fake.runs[1] as FakeRun;
	assert.equal(held.keyStateAtAbort, "closed");
	assert.ok(held.received.some((m) => m.type === "abort"));
	const task = taskRow(h, taskId);
	assert.equal(task.state, "failed");
	assert.equal(task.reason, "request limit reached (30 per run)");
	assert.equal(task.worktree_path, null);
	assert.equal(task.archived, 1);
	assert.equal(existsSync(join(h.config.paths.taskDir, "worktrees", `task-${taskId}`)), false);
	assert.equal(h.world.pulls.get(1)?.state, "closed");
	// The final checkpoint (with the run's unpushed work) is on GitHub before the folder was deleted.
	const remoteHead = h.world.remote.get(task.branch as string) as string;
	assert.equal(h.world.files(remoteHead).get("wip.txt"), "work in progress\n");
	assert.equal(runsOf(h, taskId)[1]?.state, "failed");
	assert.equal(slotCount(h), 0);
	const followup = h.store.get<{ state: string; reason: string }>("SELECT * FROM followups WHERE id = ?", followupId);
	assert.equal(followup?.state, "expired");
	assert.equal(followup?.reason, "expired (limit)");
	const final = messages(h, "task_final");
	assert.equal(final.length, 1);
	assert.equal(
		final[0]?.text,
		`Task ${taskId} failed: request limit reached (30 per run). Pull request closed; branch task/${taskId} kept. Send a new /task for further work.`,
	);
	// A second limit callback for the same run is ignored.
	h.engine.onRunLimit(runId, "budget");
	await h.engine.idle();
	assert.equal(messages(h, "task_final").length, 1);
});

// Agent Execution § Finalize and Pending Inputs: "if the cap is already reached, it expires"; Evaluation "Steer with
// cap used": the steer expires and no new run starts, while the run itself completes normally.

type FollowupState = { state: string; reason: string | null };
const followupRow = (h: Harness, id: number): FollowupState => ({
	...(h.store.get<FollowupState>("SELECT state, reason FROM followups WHERE id = ?", id) as FollowupState),
});
const outcomesOf = (h: Harness, updateId: number) =>
	h.store
		.all<{ text: string }>("SELECT text FROM outbox WHERE reply_to = ?", updateId + 100_000)
		.map((row) => row.text);
const reusable = (h: Harness, conversationId: string | null | undefined) =>
	h.store.get<{ reusable: number }>("SELECT reusable FROM conversations WHERE id = ?", conversationId ?? null)
		?.reusable;

test("cap reached: Pi is told, no steer is sent any more, every unsettled steer expires (limit), no new run", async (t) => {
	const h = await harness(t);
	h.fake.control.script = holdScript();
	const taskId = submitTask(h, "alpha", "use the last request");
	h.engine.kick();
	await waitFor(() => h.fake.runs[0]?.received.some((m) => m.type === "tool_result"), { what: "tool result" });
	const held = h.fake.runs[0] as FakeRun;
	const runId = runsOf(h, taskId)[0]?.id as number;
	// A: sent to Pi before the cap was reached; Pi never reports on it (in transit when Pi took the cap).
	const a = steer(h, taskId, runId, "A: sent before the cap");
	h.engine.kick();
	await waitFor(() => held.received.some((m) => m.type === "steer"), { what: "steer A sent" });
	h.engine.onCapReached(runId);
	assert.deepEqual(
		held.received.filter((m) => m.type === "cap_reached"),
		[{ type: "cap_reached" }],
	);
	// B: accepted after the cap was reached: never sent, it expires at once.
	const b = steer(h, taskId, runId, "B: after the cap");
	h.engine.kick();
	await waitFor(() => followupRow(h, b.followupId).state === "expired", { what: "B expired" });
	assert.equal(held.received.filter((m) => m.type === "steer").length, 1, "B never reaches Pi");
	assert.equal(runsOf(h, taskId)[0]?.state, "running", "the run goes on: its last request may bring the answer");
	h.engine.onCapReached(runId);
	assert.equal(held.received.filter((m) => m.type === "cap_reached").length, 1, "told once");

	held.release();
	await h.engine.idle();
	const task = taskRow(h, taskId);
	assert.deepEqual([task.state, task.pr_number], ["review", 1]);
	const runs = runsOf(h, taskId);
	assert.deepEqual(
		runs.map((run) => run.state),
		["finished"],
		"A is not admitted as another run",
	);
	for (const { followupId, updateId } of [a, b]) {
		assert.deepEqual(followupRow(h, followupId), { state: "expired", reason: "expired (limit)" });
		assert.deepEqual(outcomesOf(h, updateId), [`Follow-up to Task ${taskId} expired: the run hit a limit.`]);
	}
	assert.equal(reusable(h, runs[0]?.conversation_id), 1, "the run answered and Pi went idle: reusable");
	assert.equal(messages(h, "task_final").length, 0);
});

/** Write wip.txt, take one steer, then on abort report `finished` aborted with `report(steerRequestId)`. */
function cappedScript(
	report: (run: FakeRun, steerRequestId: string) => Partial<Extract<FromRunner, { type: "finished" }>>,
): Script {
	return async (run) => {
		run.emit({ type: "ready" });
		run.emit({ type: "tool", id: 1, name: "write", args: { path: "wip.txt", content: "work in progress\n" } });
		await run.next("tool_result");
		const sent = (await run.next("steer")) as Extract<ToRunner, { type: "steer" }>;
		run.emit({ type: "steer_status", requestId: sent.requestId, status: "submitted" });
		await run.next("abort");
		run.emit({
			type: "finished",
			outcome: "aborted",
			delivered: [],
			unconsumed: [],
			answered: [],
			...report(run, sent.requestId),
		});
		run.exit(0);
	};
}

async function steerThenCapRefusal(h: Harness, taskId: number): Promise<{ runId: number; followupId: number }> {
	h.engine.kick();
	await waitFor(() => h.fake.runs[0]?.received.some((m) => m.type === "tool_result"), { what: "tool result" });
	const runId = runsOf(h, taskId)[0]?.id as number;
	const { followupId } = steer(h, taskId, runId, "one more thing");
	h.engine.kick();
	await waitFor(() => followupRow(h, followupId).state === "submitted", { what: "steer submitted" });
	h.engine.onRunLimit(runId, "request_cap");
	// Revoked at once, decided later: the run left 'running' (a reply is refused as "stopping", not taken as a steer).
	assert.deepEqual([runsOf(h, taskId)[0]?.state, taskRow(h, taskId).state], ["finalizing", "running"]);
	h.engine.onRunLimit(runId, "request_cap");
	await h.engine.idle();
	return { runId, followupId };
}

test("cap refusal after the run's own input was answered (a successor Pi started anyway): review, steer expired", async (t) => {
	const h = await harness(t);
	h.fake.control.script = cappedScript((run, steerId) => ({
		answer: "Own answer.",
		answered: [run.start.input.requestId],
		unconsumed: [steerId],
	}));
	const taskId = submitTask(h, "alpha", "answer, then a refused successor");
	const { followupId } = await steerThenCapRefusal(h, taskId);
	const held = h.fake.runs[0] as FakeRun;
	assert.equal(held.keyStateAtAbort, "closed", "revoked before the abort");
	assert.equal(held.received.filter((m) => m.type === "abort").length, 1);
	const task = taskRow(h, taskId);
	assert.deepEqual([task.state, task.reason, task.pr_number, task.archived], ["review", null, 1, 0]);
	assert.equal(h.world.pulls.get(1)?.state, "open");
	const runs = runsOf(h, taskId);
	assert.deepEqual(
		runs.map((run) => [run.state, run.reason, run.answer, run.review_done]),
		[["finished", null, "Own answer.", 1]],
		"the task keeps its own result; no new run",
	);
	assert.deepEqual(followupRow(h, followupId), { state: "expired", reason: "expired (limit)" });
	assert.match(messages(h, "task_review")[0]?.text ?? "", /is ready for review \(run 1\)/);
	assert.equal(messages(h, "task_final").length, 0);
	assert.equal(reusable(h, runs[0]?.conversation_id), 0, "Pi was aborted: the next run starts a fresh conversation");
	assert.equal(slotCount(h), 0);
});

test("cap refusal that cut off a successor the model was working on is a limit failure", async (t) => {
	const h = await harness(t);
	h.fake.control.script = cappedScript((run, steerId) => ({
		answer: "Own answer.",
		answered: [run.start.input.requestId],
		delivered: [steerId],
	}));
	const taskId = submitTask(h, "alpha", "answer, then a successor cut by the cap");
	const { followupId } = await steerThenCapRefusal(h, taskId);
	const task = taskRow(h, taskId);
	assert.deepEqual([task.state, task.reason], ["failed", "request limit reached (30 per run)"]);
	assert.deepEqual(followupRow(h, followupId), { state: "delivered", reason: null });
	assert.equal(runsOf(h, taskId)[0]?.state, "failed");
	assert.equal(messages(h, "task_final").length, 1);
});

test("cap refusal with no runner report within the stop grace is a limit failure", async (t) => {
	const h = await harness(t);
	h.fake.control.script = async (run) => {
		run.emit({ type: "ready" });
		run.emit({ type: "tool", id: 1, name: "write", args: { path: "wip.txt", content: "work in progress\n" } });
		await run.next("tool_result");
		await run.next("abort");
		// Never reports `finished` and never exits: the stop grace decides, then finalize kills it.
	};
	const taskId = submitTask(h, "alpha", "silent after the cap");
	h.engine.kick();
	await waitFor(() => h.fake.runs[0]?.received.some((m) => m.type === "tool_result"), { what: "tool result" });
	const runId = runsOf(h, taskId)[0]?.id as number;
	h.engine.onRunLimit(runId, "request_cap");
	assert.deepEqual(
		[runsOf(h, taskId)[0]?.state, runsOf(h, taskId)[0]?.reason, taskRow(h, taskId).state],
		["finalizing", null, "running"],
		"revoked at once; decided only once the runner reports, or after the grace",
	);
	await waitFor(() => taskRow(h, taskId).state === "failed", { what: "limit failure after the grace" });
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).reason, "request limit reached (30 per run)");
	assert.deepEqual(
		[runsOf(h, taskId)[0]?.state, runsOf(h, taskId)[0]?.reason],
		["failed", "request limit reached (30 per run)"],
	);
	assert.match(messages(h, "task_final")[0]?.text ?? "", /failed: request limit reached \(30 per run\)/);
});

test("cancel a running task: key closed before abort, steer expired once, final checkpoint pushed, archived", async (t) => {
	const h = await harness(t);
	h.fake.control.script = holdScript();
	const taskId = submitTask(h, "alpha", "long task");
	h.engine.kick();
	await waitFor(() => h.fake.runs[0]?.received.some((m) => m.type === "tool_result"), { what: "tool result" });
	const [run] = runsOf(h, taskId);
	const { followupId, updateId } = steer(h, taskId, run?.id as number, "a steer");
	h.engine.kick();
	await waitFor(() => h.fake.runs[0]?.received.some((m) => m.type === "steer"), { what: "steer sent" });
	const sent = h.fake.runs[0]?.received.find((m) => m.type === "steer");
	assert.deepEqual(sent, { type: "steer", requestId: String(updateId), content: "a steer" });
	requestCancel(h, taskId);
	h.engine.kick();
	await h.engine.idle();
	assert.equal(h.fake.runs[0]?.keyStateAtAbort, "closed");
	const task = taskRow(h, taskId);
	assert.equal(task.state, "cancelled");
	assert.equal(task.worktree_path, null);
	assert.equal(runsOf(h, taskId)[0]?.state, "cancelled");
	const remoteHead = h.world.remote.get(`task/${taskId}`) as string;
	assert.equal(h.world.files(remoteHead).get("wip.txt"), "work in progress\n");
	const followup = h.store.get<{ state: string; reason: string }>("SELECT * FROM followups WHERE id = ?", followupId);
	assert.equal(followup?.state, "expired");
	assert.equal(followup?.reason, "expired (cancelled)");
	const outcomes = h.store.all<{ text: string }>("SELECT text FROM outbox WHERE reply_to = ?", updateId + 100_000);
	assert.deepEqual(
		outcomes.map((row) => row.text),
		[`Follow-up to Task ${taskId} expired: the task was cancelled.`],
	);
	assert.equal(messages(h, "task_final")[0]?.text, `Task ${taskId} cancelled. Branch task/${taskId} kept.`);
	assert.equal(slotCount(h), 0);
	// No run starts after revocation.
	assert.equal(h.fake.runs.length, 1);
});

test("a steer during a run is delivered once and reported", async (t) => {
	const h = await harness(t);
	h.fake.control.script = async (run) => {
		run.emit({ type: "ready" });
		const message = (await run.next("steer")) as Extract<ToRunner, { type: "steer" }>;
		run.emit({ type: "steer_status", requestId: message.requestId, status: "submitted" });
		run.emit({ type: "steer_status", requestId: message.requestId, status: "delivered" });
		run.emit({
			type: "finished",
			outcome: "answered",
			answer: "ok",
			delivered: [message.requestId],
			unconsumed: [],
			answered: [],
		});
		run.exit(0);
	};
	const taskId = submitTask(h, "alpha", "task with steer");
	h.engine.kick();
	await waitFor(() => runsOf(h, taskId)[0]?.state === "running", { what: "running" });
	const { followupId, updateId } = steer(h, taskId, runsOf(h, taskId)[0]?.id as number, "also reject plus-addresses");
	h.engine.kick();
	await h.engine.idle();
	assert.equal(
		h.store.get<{ state: string }>("SELECT state FROM followups WHERE id = ?", followupId)?.state,
		"delivered",
	);
	const outcomes = h.store.all<{ text: string }>("SELECT text FROM outbox WHERE reply_to = ?", updateId + 100_000);
	assert.deepEqual(
		outcomes.map((row) => row.text),
		[`Follow-up delivered to Task ${taskId}.`],
	);
	assert.equal(taskRow(h, taskId).state, "review");
});

test("tool calls get the second-layer policy, run only in the run's sandbox, and are capped", async (t) => {
	const h = await harness(t, { limits: { toolResultBytes: 64 } });
	const results: Array<{ ok: boolean; text: string }> = [];
	h.fake.control.script = async (run) => {
		const calls: Array<[ToRunner["type"], string, Record<string, unknown>]> = [
			["tool_result", "write", { path: ".git/config", content: "x" }],
			["tool_result", "write", { path: "../escape.txt", content: "x" }],
			["tool_result", "read", { path: "/etc/passwd" }],
			["tool_result", "run_check", { operation: "deploy" }],
			["tool_result", "write", { path: "big.txt", content: `${"line\n".repeat(100)}` }],
			["tool_result", "read", { path: "big.txt" }],
			["tool_result", "run_check", { operation: "test" }],
		];
		let id = 0;
		for (const [, name, args] of calls) {
			run.emit({ type: "tool", id: ++id, name: name as "read", args });
			const result = (await run.next("tool_result")) as Extract<ToRunner, { type: "tool_result" }>;
			results.push(result.result);
		}
		run.emit({ type: "finished", outcome: "answered", answer: "ok", delivered: [], unconsumed: [], answered: [] });
		run.exit(0);
	};
	const taskId = submitTask(h, "alpha", "tools");
	h.engine.kick();
	await h.engine.idle();
	assert.equal(results.length, 7);
	for (const denied of results.slice(0, 4)) {
		assert.equal(denied.ok, false);
		assert.match(denied.text, /^denied: /);
	}
	assert.equal(results[4]?.ok, true);
	assert.equal(results[5]?.ok, true);
	assert.ok(Buffer.byteLength(results[5]?.text ?? "") <= 64);
	assert.match(results[5]?.text ?? "", /\[truncated\]$/);
	assert.equal(results[6]?.ok, true);
	assert.match(results[6]?.text ?? "", /^run_check test: passed/);
	assert.equal(existsSync(join(h.config.paths.taskDir, "worktrees", "escape.txt")), false);
	assert.equal(taskRow(h, taskId).state, "review");
});

test("the run deadline fails the task, closes nothing it lacks and archives the worktree", async (t) => {
	const h = await harness(t, { limits: { runDeadlineMs: 300 } });
	h.fake.control.script = holdScript();
	const taskId = submitTask(h, "alpha", "slow");
	h.engine.kick();
	await waitFor(() => taskRow(h, taskId).state === "failed" && taskRow(h, taskId).worktree_path === null, {
		what: "deadline",
	});
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).reason, "300 ms run deadline");
	assert.equal(h.fake.runs[0]?.keyStateAtAbort, "closed");
	assert.equal(slotCount(h), 0);
	assert.match(messages(h, "task_final")[0]?.text ?? "", /failed: 300 ms run deadline\. Branch task\/\d+ kept\./);
});

test("restart recovery: running run failed as interrupted, conversation quarantined, steer expired; no resume; a follow-up starts a fresh conversation", async (t) => {
	const h1 = await harness(t);
	h1.fake.control.script = holdScript();
	const taskId = submitTask(h1, "alpha", "original task text");
	h1.engine.kick();
	await waitFor(() => h1.fake.runs[0]?.received.some((m) => m.type === "tool_result"), { what: "tool result" });
	const [run1] = runsOf(h1, taskId);
	const { followupId } = steer(h1, taskId, run1?.id as number, "pending steer");
	// The Coordinator goes away mid-run: the DB still says running.
	await h1.engine.stop();
	assert.equal(runsOf(h1, taskId)[0]?.state, "running");
	const queuedOther = submitTask(h1, "beta", "queued elsewhere");

	const h2 = await harness(t, { store: h1.store, dir: h1.dir, world: h1.world });
	h2.fake.control.script = workScript("src/resume.js", "export const resumed = true;\n");
	await h2.engine.recover();
	const interrupted = runsOf(h2, taskId)[0] as RunRecord;
	assert.equal(interrupted.state, "failed");
	assert.equal(interrupted.reason, "interrupted by restart");
	const conversation = h2.store.get<{ quarantined: number; reusable: number }>(
		"SELECT * FROM conversations WHERE id = ?",
		interrupted.conversation_id as string,
	);
	assert.equal(conversation?.quarantined, 1);
	assert.equal(conversation?.reusable, 0);
	const followup = h2.store.get<{ state: string; reason: string }>("SELECT * FROM followups WHERE id = ?", followupId);
	assert.equal(followup?.state, "expired");
	assert.equal(followup?.reason, "expired (interrupted)");
	assert.ok(messages(h2, "followup_expired").some((m) => /interrupted by a restart/.test(m.text)));
	assert.equal(h2.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM run_keys WHERE state = 'open'")?.n, 0);
	assert.equal(slotCount(h2), 0);

	h2.engine.kick();
	await h2.engine.idle();
	// The interrupted task's work is pushed and it waits in review; the interrupted run is never resubmitted.
	const task = taskRow(h2, taskId);
	assert.equal(task.state, "review");
	assert.equal(task.reason, INTERRUPTED_NOTE);
	assert.equal(h2.world.files(h2.world.remote.get(`task/${taskId}`) as string).get("wip.txt"), "work in progress\n");
	assert.ok(task.pr_number);
	assert.ok(messages(h2, "task_review").some((m) => /was interrupted by restart/.test(m.text)));
	assert.deepEqual(
		h2.fake.runs.map((run) => run.start.taskId),
		[queuedOther],
	);

	// An authorized follow-up: a fresh conversation, parent = the quarantined one, seeded with text + follow-up + diff.
	followupRun(h2, taskId, "please continue");
	h2.engine.kick();
	await h2.engine.idle();
	const fresh = h2.fake.runs.find((run) => run.start.taskId === taskId) as FakeRun;
	assert.equal(fresh.start.fresh, true);
	assert.notEqual(fresh.start.conversationPath, h1.fake.runs[0]?.start.conversationPath);
	assert.match(fresh.start.input.content, /original task text/);
	assert.match(fresh.start.input.content, /please continue/);
	assert.match(fresh.start.input.content, /wip\.txt/);
	const run2 = runsOf(h2, taskId)[1] as RunRecord;
	assert.notEqual(run2.conversation_id, interrupted.conversation_id);
	const row = h2.store.get<{ parent_id: string }>(
		"SELECT parent_id FROM conversations WHERE id = ?",
		run2.conversation_id as string,
	);
	assert.equal(row?.parent_id, interrupted.conversation_id);
	assert.equal(taskRow(h2, taskId).state, "review");
	assert.equal(taskRow(h2, taskId).reason, null);
});

test("restart while a first run was starting and leftovers cannot be verified gone: queued again, its slot kept and nothing dispatched until the owner unfreezes; then it runs once", async (t) => {
	const h1 = await harness(t);
	const taskId = submitTask(h1, "alpha", "started before the restart");
	const [queued] = runsOf(h1, taskId);
	// The state a dispatch leaves before the worktree is created: slot reserved, run starting, task running.
	h1.store.tx(() => {
		h1.store.run(
			"INSERT INTO slots(kind, task_id, run_id, agent_id, acquired_at) VALUES ('run', ?, ?, 'alpha', ?)",
			taskId,
			queued?.id as number,
			Date.now(),
		);
		h1.store.run("UPDATE tasks SET generation = 1, state = 'running' WHERE id = ?", taskId);
		h1.store.run("UPDATE runs SET state = 'starting', generation = 1 WHERE id = ?", queued?.id as number);
	});
	await h1.engine.stop();

	const leftover = { on: true };
	const h2 = await harness(t, {
		store: h1.store,
		dir: h1.dir,
		world: h1.world,
		sandbox: (local) => ({
			...local,
			live: async (filter) => (leftover.on ? ["pi-durable-check-99-1"] : local.live(filter)),
		}),
	});
	h2.fake.control.script = workScript();
	await h2.engine.recover();
	assert.equal(h2.store.groupState(CHAT).state, "frozen");
	const [run] = runsOf(h2, taskId);
	assert.deepEqual([run?.id, run?.state, taskRow(h2, taskId).state], [queued?.id, "queued", "queued"]);
	assert.equal(slotCount(h2), 1, "the slot is held until the leftovers are verified gone");
	assert.equal(h2.store.getMeta(`restart_worktree:${taskId}`), "check");
	assert.ok(messages(h2, "task_requeued").some((m) => /queued again after a restart/.test(m.text)));
	h2.engine.kick();
	await h2.engine.idle();
	assert.equal(h2.fake.runs.length, 0, "nothing dispatches while frozen");
	assert.equal(h2.store.getMeta(`restart_worktree:${taskId}`), "check", "the worktree job waits for the unfreeze");

	leftover.on = false;
	h2.store.tx(() =>
		h2.store.run("UPDATE groups SET state = 'normal', reason = NULL, recheck_required = 1 WHERE chat_id = ?", CHAT),
	);
	h2.engine.kick();
	await h2.engine.idle();
	assert.equal(h2.fake.runs.length, 1, "it runs once");
	assert.equal(h2.fake.runs[0]?.start.runId, queued?.id);
	assert.equal(taskRow(h2, taskId).state, "review");
	assert.equal(runsOf(h2, taskId).length, 1);
	assert.equal(h2.store.getMeta(`restart_worktree:${taskId}`), undefined);
	assert.equal(h2.store.getMeta(`restart_returns:${queued?.id}`), undefined, "dropped once the run started");
	assert.equal(slotCount(h2), 0);
});

/** The state a dispatch leaves for a run that has not opened its run key yet: slot reserved, run starting. */
function markStarting(h: Harness, taskId: number, runId: number, agent: string): void {
	h.store.tx(() => {
		h.store.run(
			"INSERT INTO slots(kind, task_id, run_id, agent_id, acquired_at) VALUES ('run', ?, ?, ?, ?)",
			taskId,
			runId,
			agent,
			Date.now(),
		);
		h.store.run("UPDATE tasks SET generation = generation + 1, state = 'running' WHERE id = ?", taskId);
		h.store.run(
			"UPDATE runs SET state = 'starting', generation = (SELECT generation FROM tasks WHERE id = ?) WHERE id = ?",
			taskId,
			runId,
		);
	});
}

/** A first run that created its worktree and finished setup, then stopped before its run key. */
async function startedFirstRun(h: Harness, agent: string, text: string): Promise<{ taskId: number; runId: number }> {
	const taskId = submitTask(h, agent, text);
	const runId = runsOf(h, taskId)[0]?.id as number;
	const path = join(h.config.paths.taskDir, "worktrees", `task-${taskId}`);
	await h.world.git.createWorktree(`task/${taskId}`, path, h.world.state.main);
	h.store.tx(() => {
		h.store.run(
			"UPDATE tasks SET branch = ?, worktree_path = ?, base_commit = ?, head_commit = ? WHERE id = ?",
			`task/${taskId}`,
			path,
			h.world.state.main,
			h.world.state.main,
			taskId,
		);
		h.store.setMeta(`setup:${taskId}`, "done");
	});
	markStarting(h, taskId, runId, agent);
	return { taskId, runId };
}

test("a restart while a follow-up run starts after 3 returns fails the task and archives it like any failed task (work pushed, pull request closed, branch kept)", async (t) => {
	const h1 = await harness(t);
	const taskId = await runToReview(h1);
	const head = taskRow(h1, taskId).head_commit;
	const runId = followupRun(h1, taskId, "one more thing");
	markStarting(h1, taskId, runId, "alpha");
	h1.store.tx(() => h1.store.setMeta(`restart_returns:${runId}`, "3"));
	await h1.engine.stop();

	const h2 = await harness(t, { store: h1.store, dir: h1.dir, world: h1.world });
	await h2.engine.recover();
	const reason = "the Coordinator restarted 4 times before its run could start, so it is not queued again";
	assert.deepEqual(
		[runsOf(h2, taskId)[1]?.state, runsOf(h2, taskId)[1]?.reason, taskRow(h2, taskId).state],
		["failed", reason, "failed"],
	);
	assert.equal(h2.store.getMeta(`restart_worktree:${taskId}`), undefined, "a follow-up's worktree is not discarded");
	h2.engine.kick();
	await h2.engine.idle();
	const task = taskRow(h2, taskId);
	assert.deepEqual([task.worktree_path, task.archived, task.branch], [null, 1, `task/${taskId}`]);
	assert.equal(h2.world.remote.get(`task/${taskId}`), head, "the branch is kept on GitHub");
	assert.equal(h2.world.pulls.get(task.pr_number as number)?.state, "closed");
	assert.equal(count(h2.world.calls, "deleteBranch"), 0);
	assert.equal(h2.fake.runs.length, 0, "never resubmitted");
	const final = `Task ${taskId} failed: ${reason}. Pull request closed; branch task/${taskId} kept.`;
	assert.deepEqual(
		messages(h2, "task_final").map((m) => m.text),
		[`${final} Send a new /task for further work.`],
	);
	assert.equal(messages(h2, "task_requeued").length, 0);
	assert.equal(slotCount(h2), 0);
});

test("a cancel requested before a returned first run's worktree is reconciled: the worktree is discarded, not kept, and nothing is pushed; the other returned run keeps its pristine worktree", async (t) => {
	const h1 = await harness(t);
	// Staged with the engine stopped, so nothing dispatches the runs meanwhile.
	await h1.engine.stop();
	const kept = await startedFirstRun(h1, "alpha", "keep my worktree");
	const cancelled = await startedFirstRun(h1, "beta", "cancel me after the restart");

	const h2 = await harness(t, { store: h1.store, dir: h1.dir, world: h1.world });
	// Settled first (its sandbox check), so no tick runs the reconciliation before the cancel below is saved.
	await h2.engine.idle();
	await h2.engine.recover();
	for (const { taskId } of [kept, cancelled]) {
		assert.equal(taskRow(h2, taskId).state, "queued");
		assert.equal(h2.store.getMeta(`restart_worktree:${taskId}`), "check");
	}
	// Accepted while the reconciliation is pending (commands.ts sets the flag: the task still records a worktree).
	requestCancel(h2, cancelled.taskId);
	h2.engine.kick();
	await h2.engine.idle();

	const gone = taskRow(h2, cancelled.taskId);
	assert.deepEqual([gone.state, gone.worktree_path, gone.branch], ["cancelled", null, null]);
	assert.equal(existsSync(join(h2.config.paths.taskDir, "worktrees", `task-${cancelled.taskId}`)), false);
	assert.equal(h2.world.remote.get(`task/${cancelled.taskId}`), undefined, "nothing pushed for the cancelled task");
	assert.deepEqual(
		messages(h2, "task_final").map((m) => m.text),
		[`Task ${cancelled.taskId} cancelled.`],
	);
	assert.equal(runsOf(h2, cancelled.taskId)[0]?.state, "cancelled");
	// The other one kept its worktree at the recorded base and ran once.
	assert.equal(taskRow(h2, kept.taskId).state, "review");
	assert.equal(taskRow(h2, kept.taskId).base_commit, h2.world.root);
	assert.deepEqual(
		h2.fake.runs.map((run) => run.start.runId),
		[kept.runId],
	);
	assert.equal(count(h2.world.calls, "deleteBranch"), 1);
	assert.equal(slotCount(h2), 0);
});

test("the worktree reconciliation of an ended task removes leftovers no one records, and leaves a recorded branch to its archive", async (t) => {
	const h1 = await harness(t);
	// Staged with the engine stopped, so nothing dispatches the runs meanwhile.
	await h1.engine.stop();
	// Task A: recovery had forgotten its worktree (or never recorded it) when it was cancelled; the folder is left.
	const a = submitTask(h1, "alpha", "forgotten worktree");
	const leftover = join(h1.config.paths.taskDir, "worktrees", `task-${a}`);
	await h1.world.git.createWorktree(`task/${a}`, leftover, h1.world.root);
	// Task B: cancelled and archived, its branch kept.
	const b = submitTask(h1, "beta", "archived");
	h1.store.tx(() => {
		h1.store.run("UPDATE runs SET state = 'cancelled' WHERE task_id IN (?, ?)", a, b);
		h1.store.run("UPDATE tasks SET state = 'cancelled', reason = 'cancelled' WHERE id IN (?, ?)", a, b);
		h1.store.run("UPDATE tasks SET branch = ?, archived = 1 WHERE id = ?", `task/${b}`, b);
		h1.store.setMeta(`restart_worktree:${a}`, "check");
		h1.store.setMeta(`restart_worktree:${b}`, "check");
	});
	const h = await harness(t, { store: h1.store, dir: h1.dir, world: h1.world });
	await h.engine.recover();
	h.engine.kick();
	await h.engine.idle();
	assert.equal(existsSync(leftover), false, "the leftover folder is removed");
	assert.equal(count(h.world.calls, "deleteBranch"), 1, "only the unrecorded branch is deleted");
	assert.equal(h.store.getMeta(`restart_worktree:${a}`), undefined);
	assert.equal(h.store.getMeta(`restart_worktree:${b}`), undefined);
	assert.equal(taskRow(h, b).branch, `task/${b}`);
	assert.equal(h.store.groupState(CHAT).state, "normal");
});

test("restart mid-merge: main already contains the head → merged, no second merge", async (t) => {
	const h = await harness(t);
	const taskId = await runToReview(h);
	const approvalId = approve(h, taskId);
	const head = taskRow(h, taskId).head_commit as string;
	// GitHub merged, but the Coordinator died before saving it.
	const pr = await h.world.github.mergePullRequest(1, head, "Merge task");
	assert.ok(pr.merged);
	h.store.tx(() =>
		h.store.run(
			"INSERT INTO merge_intents(task_id, approval_id, head_commit, state, created_at) VALUES (?, ?, ?, 'pending', ?)",
			taskId,
			approvalId,
			head,
			Date.now(),
		),
	);
	const merges = count(h.world.calls, "mergePullRequest");
	await h.engine.recover();
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).state, "merged");
	assert.equal(taskRow(h, taskId).worktree_path, null);
	assert.equal(count(h.world.calls, "mergePullRequest"), merges);
	assert.equal(messages(h, "task_merged").length, 1);
});

test("merges run one at a time; main moved → combined, retested, back to review; re-approval merges", async (t) => {
	const h = await harness(t);
	const t1 = submitTask(h, "alpha", "first");
	h.fake.control.script = async (run) =>
		(run.start.taskId === t1 ? workScript("a.js", "a\n") : workScript("b.js", "b\n"))(run);
	const t2 = submitTask(h, "beta", "second");
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, t1).state, "review");
	assert.equal(taskRow(h, t2).state, "review");
	const a1 = approve(h, t1);
	const a2 = approve(h, t2);
	h.engine.kick();
	await h.engine.idle();
	assert.equal(h.world.maxInflight(), 1);
	assert.equal(taskRow(h, t1).state, "merged");
	assert.equal(taskRow(h, t1).worktree_path, null);
	assert.equal(h.store.get<{ state: string }>("SELECT state FROM approvals WHERE id = ?", a1)?.state, "consumed");
	assert.match(
		messages(h, "task_merged")[0]?.text ?? "",
		new RegExp(`^Task ${t1} merged into main \\([0-9a-f]{7}\\)\\.$`),
	);
	const second = taskRow(h, t2);
	assert.equal(second.state, "review");
	assert.equal(
		h.store.get<{ state: string; reason: string }>("SELECT * FROM approvals WHERE id = ?", a2)?.reason,
		"main moved",
	);
	assert.equal(second.posted_head, second.head_commit);
	assert.equal(second.tests_passed_head, second.head_commit);
	assert.equal(h.world.remote.get(`task/${t2}`), second.head_commit);
	assert.match(
		messages(h, "merge_main_moved")[0]?.text ?? "",
		/Main moved; Task \d+ was combined with the latest main and retested \(passed\)\. Head: [0-9a-f]{7}\..*\/approve/,
	);
	assert.deepEqual(
		h.world.calls.filter((call) => call === "mergePullRequest" || call === "mergeBase"),
		["mergePullRequest", "mergeBase"],
	);
	approve(h, t2);
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, t2).state, "merged");
	assert.equal(h.world.maxInflight(), 1);
	assert.equal(slotCount(h), 0);
	assert.equal(h.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM merge_intents WHERE state = 'pending'")?.n, 0);
});

test("stale approval: the PR head changed after approval → rejected, nothing merges; the later reminder points to it", async (t) => {
	let later = 0;
	const h = await harness(t, { now: () => Date.now() + later });
	const taskId = await runToReview(h);
	const approvalId = approve(h, taskId);
	const branch = `task/${taskId}`;
	const posted = taskRow(h, taskId).posted_head as string;
	const late = h.world.commitOn(posted, "late.txt", "late\n");
	h.world.remote.set(branch, late);
	const main = h.world.state.main;
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).state, "review");
	assert.equal(h.world.state.main, main);
	assert.equal(count(h.world.calls, "mergePullRequest"), 0);
	const approval = h.store.get<{ state: string; reason: string }>("SELECT * FROM approvals WHERE id = ?", approvalId);
	assert.equal(approval?.state, "invalidated");
	assert.equal(approval?.reason, "branch changed after approval");
	const text = messages(h, "merge_rejected")[0]?.text ?? "";
	assert.ok(text.startsWith(`Approval of Task ${taskId} rejected; nothing was merged.\n`), text);
	assert.ok(
		text.includes(
			`Why: branch ${branch} on GitHub is at ${late.slice(0, 7)}, but the approval was for ${posted.slice(0, 7)}, ` +
				"the head the bot posted. The branch changed outside the Coordinator.",
		),
		text,
	);
	assert.ok(text.includes(`\ngit push --force origin ${posted}:refs/heads/${branch}\n`), text);
	assert.ok(text.includes(`Then send /approve ${taskId} again to approve that head, or /cancel ${taskId}`), text);
	// A day later the task's one review reminder points back to that rejection; it does not offer a follow-up, which
	// would push onto the commit pushed outside the Coordinator, be refused, and freeze the group.
	assert.equal(messages(h, "review_reminder").length, 0);
	later = h.limits.reviewReminderMs + 120_000;
	await h.engine.idle();
	assert.equal(
		messages(h, "review_reminder")[0]?.text,
		`Reminder: Task ${taskId} is waiting for review. Pull request: ${taskRow(h, taskId).pr_url}. Its last approval ` +
			"was rejected because the branch changed after approval; see that message for what to do next.",
	);
	assert.equal(h.store.groupState(CHAT).state, "normal");
});

/** A commit pushed to the task branch outside the Coordinator after approval: the merge step rejects the approval. */
async function rejectedAfterForeignPush(h: Harness) {
	const taskId = await runToReview(h);
	approve(h, taskId);
	const branch = `task/${taskId}`;
	h.world.remote.set(branch, h.world.commitOn(taskRow(h, taskId).posted_head as string, "late.txt", "late\n"));
	h.engine.kick();
	await h.engine.idle();
	assert.match(messages(h, "merge_rejected")[0]?.text ?? "", /do not reply with a follow-up or send \/cancel/);
	return { taskId, branch };
}

for (const [what, act] of [
	["a follow-up run", (h: Harness, id: number) => void followupRun(h, id, "one more thing")],
	["/cancel", (h: Harness, id: number) => requestCancel(h, id)],
] as const) {
	test(`stale approval: ${what} before the branch is restored freezes the group, as the rejection warns`, async (t) => {
		const h = await harness(t);
		const { taskId, branch } = await rejectedAfterForeignPush(h);
		const foreign = h.world.remote.get(branch);
		act(h, taskId);
		h.engine.kick();
		await h.engine.idle();
		const group = h.store.groupState(CHAT);
		assert.equal(group.state, "frozen");
		assert.equal(group.reason, `GitHub rejected the push of ${branch} (the remote branch changed)`);
		assert.equal(h.world.remote.get(branch), foreign, "the commit pushed outside is never overwritten");
	});
}

/**
 * An earlier merge attempt combined the worktree with a newer main and pushed it, then was interrupted before it saved
 * the result (the approval stayed valid, the task merging); the next merge attempt rejects the approval.
 */
async function rejectedAfterInterruptedCombine(h: Harness) {
	const taskId = await runToReview(h);
	const approvalId = approve(h, taskId);
	const task = taskRow(h, taskId);
	const branch = task.branch as string;
	const posted = task.posted_head as string;
	h.world.advanceMain("CHANGELOG.md", "other work\n");
	const combined = await h.world.git.mergeBase(task.worktree_path as string);
	assert.equal(combined.conflict, false);
	await h.world.git.push(task.worktree_path as string, branch);
	const own = h.world.remote.get(branch) as string;
	assert.notEqual(own, posted);
	const main = h.world.state.main;
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).state, "review");
	assert.equal(h.world.state.main, main);
	assert.equal(count(h.world.calls, "mergePullRequest"), 0);
	assert.equal(
		h.store.get<{ state: string }>("SELECT * FROM approvals WHERE id = ?", approvalId)?.state,
		"invalidated",
	);
	const text = messages(h, "merge_rejected")[0]?.text ?? "";
	assert.ok(
		text.includes(`${own.slice(0, 7)} was pushed by the Coordinator itself: an earlier merge attempt combined`),
		text,
	);
	assert.doesNotMatch(text, /outside the Coordinator|git push --force/);
	return { taskId, task, own };
}

test("an interrupted combine with main left the Coordinator's own commit on GitHub → rejected; /cancel then works", async (t) => {
	const h = await harness(t);
	const { taskId, task } = await rejectedAfterInterruptedCombine(h);
	// The advice holds: /cancel pushes nothing foreign (GitHub has the worktree's own head), so nothing freezes.
	requestCancel(h, taskId);
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).state, "cancelled");
	assert.equal(h.store.groupState(CHAT).state, "normal");
	assert.equal(h.world.pulls.get(task.pr_number as number)?.state, "closed");
});

test("an interrupted combine with main → rejected; the advised follow-up run posts a new head, which then merges", async (t) => {
	const h = await harness(t);
	const { taskId, own } = await rejectedAfterInterruptedCombine(h);
	// The advice holds: the follow-up run works on the worktree, whose HEAD is GitHub's head, so its push is a
	// fast-forward and the review posts a new head; approving that head merges it.
	h.fake.control.script = workScript("src/followup.js", "export const followup = true;\n");
	followupRun(h, taskId, "finish it");
	h.engine.kick();
	await h.engine.idle();
	assert.equal(h.store.groupState(CHAT).state, "normal");
	const reviewed = taskRow(h, taskId);
	assert.equal(reviewed.state, "review");
	const head = reviewed.posted_head as string;
	assert.ok(head !== own && (await h.world.git.isAncestor(own, head)), "the new head builds on GitHub's head");
	assert.equal(h.world.remote.get(reviewed.branch as string), head);
	approve(h, taskId);
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).state, "merged");
	assert.ok(await h.world.git.isAncestor(head, h.world.state.main));
	assert.equal(h.store.groupState(CHAT).state, "normal");
});

test("the pull request was closed on GitHub → rejected with why; reopening it and approving again merges", async (t) => {
	const h = await harness(t);
	const taskId = await runToReview(h);
	approve(h, taskId);
	const task = taskRow(h, taskId);
	const pull = h.world.pulls.get(task.pr_number as number);
	assert.ok(pull !== undefined);
	Object.assign(pull, { state: "closed", frozenHead: h.world.remote.get(pull.head) });
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).state, "review");
	assert.equal(count(h.world.calls, "mergePullRequest"), 0);
	const text = messages(h, "merge_rejected")[0]?.text ?? "";
	assert.ok(text.startsWith(`Approval of Task ${taskId} rejected; nothing was merged.\n`), text);
	assert.ok(text.includes(`Why: the pull request of Task ${taskId} was closed on GitHub outside the Coordinator.`));
	assert.ok(text.includes(`Then reopen the pull request on GitHub and send /approve ${taskId} again`), text);
	assert.equal(
		h.store.get<{ reason: string }>("SELECT reason FROM approvals ORDER BY id DESC LIMIT 1")?.reason,
		"pull request closed",
	);
	Object.assign(pull, { state: "open", frozenHead: undefined });
	approve(h, taskId);
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).state, "merged");
	assert.ok(await h.world.git.isAncestor(task.posted_head as string, h.world.state.main));
});

test("the pull request was merged on GitHub at another head → the Coordinator merged nothing; /cancel closes it", async (t) => {
	const h = await harness(t);
	const taskId = await runToReview(h);
	approve(h, taskId);
	const task = taskRow(h, taskId);
	const branch = task.branch as string;
	const posted = task.posted_head as string;
	const foreign = h.world.commitOn(posted, "extra.txt", "extra\n");
	h.world.remote.set(branch, foreign);
	const outside = h.world.commitOn(h.world.state.main, "extra.txt", "extra\n");
	h.world.state.main = outside;
	const pull = h.world.pulls.get(task.pr_number as number);
	Object.assign(pull ?? {}, { state: "closed", merged: true, frozenHead: foreign, mergeCommitSha: outside });
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).state, "review");
	assert.equal(count(h.world.calls, "mergePullRequest"), 0);
	assert.equal(h.world.state.main, outside, "the Coordinator merged nothing");
	const text = messages(h, "merge_rejected")[0]?.text ?? "";
	assert.ok(text.startsWith(`Approval of Task ${taskId} rejected; the Coordinator merged nothing.\n`), text);
	assert.ok(text.includes(`at ${foreign.slice(0, 7)} instead of the approved head ${posted.slice(0, 7)}`), text);
	// The advice holds: with the branch back at the approved head, /cancel archives the task without freezing.
	h.world.remote.set(branch, posted);
	requestCancel(h, taskId);
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).state, "cancelled");
	assert.equal(h.store.groupState(CHAT).state, "normal");
});

test("main moved and the combined result fails its tests → the message says it cannot merge until they pass", async (t) => {
	let calls = 0;
	const h = await harness(t, {
		checks: {
			test: async () => (++calls === 1 ? { exitCode: 0, output: "ok" } : { exitCode: 1, output: "1 failing" }),
		},
	});
	const taskId = await runToReview(h);
	const posted = taskRow(h, taskId).posted_head as string;
	approve(h, taskId);
	h.world.advanceMain("CHANGELOG.md", "other work\n");
	h.engine.kick();
	await h.engine.idle();
	const task = taskRow(h, taskId);
	assert.equal(task.state, "review");
	assert.equal(task.tests_passed_head, null);
	assert.equal(
		messages(h, "merge_main_moved")[0]?.text,
		`Main moved; Task ${taskId} was combined with the latest main and retested (failed (failed)). Head: ` +
			`${(task.head_commit as string).slice(0, 7)}. Nothing was merged: the approval of ${posted.slice(0, 7)} does ` +
			"not cover this combined result, and it cannot merge until its tests pass. Reply to this message for a " +
			"follow-up to fix them, then approve the head the bot posts after it.",
	);
	// Approving it anyway is blocked by the failed tests, as the message says.
	approve(h, taskId);
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).state, "review");
	assert.equal(count(h.world.calls, "mergePullRequest"), 0);
	assert.match(messages(h, "merge_blocked")[0]?.text ?? "", /cannot merge: the tests did not pass/);
});

test("failed tests block a merge when main has not moved", async (t) => {
	const h = await harness(t, { checks: { test: async () => ({ exitCode: 1, output: "1 failing" }) } });
	const taskId = await runToReview(h);
	assert.equal(taskRow(h, taskId).tests_passed_head, null);
	assert.match(messages(h, "task_review")[0]?.text ?? "", /Tests: failed \(failed\)\./);
	approve(h, taskId);
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, taskId).state, "review");
	assert.equal(count(h.world.calls, "mergePullRequest"), 0);
	assert.match(messages(h, "merge_blocked")[0]?.text ?? "", /cannot merge: the tests did not pass/);
});

test("merge conflict: nothing merges, files listed, a conflict-fix run is admitted, then review again", async (t) => {
	const h = await harness(t);
	const taskId = await runToReview(h);
	const approvalId = approve(h, taskId);
	h.world.advanceMain("README.md", "# changed on main\n");
	h.world.state.conflictNext = ["README.md"];
	const main = h.world.state.main;
	h.fake.control.script = workScript("README.md", "# resolved\n", "Resolved the conflict.");
	h.engine.kick();
	await h.engine.idle();
	assert.equal(h.world.state.main, main);
	assert.equal(
		h.store.get<{ reason: string }>("SELECT reason FROM approvals WHERE id = ?", approvalId)?.reason,
		"merge conflict",
	);
	assert.match(
		messages(h, "merge_conflict")[0]?.text ?? "",
		/^Merge conflict in: README\.md\. Nothing was merged: Task \d+ could not be combined with the latest main, so the approval of [0-9a-f]{7} no longer applies\. A run of Task \d+ was admitted/,
	);
	const runs = runsOf(h, taskId);
	assert.equal(runs.length, 2);
	assert.equal(runs[1]?.kind, "conflict");
	assert.equal(runs[1]?.state, "finished");
	assert.match(h.fake.runs[1]?.start.input.content ?? "", /Conflicting files: README\.md/);
	const task = taskRow(h, taskId);
	assert.equal(task.state, "review");
	assert.equal(task.posted_head, task.head_commit);
	// The checkpoint concluded the merge: main is now an ancestor of the task head.
	assert.ok(await h.world.git.isAncestor(main, task.head_commit as string));
});

test("cancel in review closes the PR and archives the worktree", async (t) => {
	const h = await harness(t);
	const taskId = await runToReview(h);
	requestCancel(h, taskId);
	h.engine.kick();
	await h.engine.idle();
	const task = taskRow(h, taskId);
	assert.equal(task.state, "cancelled");
	assert.equal(task.worktree_path, null);
	assert.equal(h.world.pulls.get(1)?.state, "closed");
	assert.equal(
		messages(h, "task_final")[0]?.text,
		`Task ${taskId} cancelled. Pull request closed; branch task/${taskId} kept.`,
	);
});

test("frozen group: running task cancelled as 'group frozen', nothing dispatched or merged", async (t) => {
	const h = await harness(t);
	const reviewed = await runToReview(h, "beta", "in review");
	h.fake.control.script = holdScript();
	const running = submitTask(h, "alpha", "running");
	h.engine.kick();
	await waitFor(() => runsOf(h, running)[0]?.state === "running", { what: "running" });
	const queued = submitTask(h, "gamma", "queued");
	h.store.tx(() => h.store.freeze(CHAT, "test freeze"));
	h.engine.kick();
	await h.engine.idle();
	assert.equal(taskRow(h, running).state, "cancelled");
	assert.equal(taskRow(h, running).reason, "group frozen");
	assert.equal(taskRow(h, queued).state, "queued");
	assert.equal(taskRow(h, reviewed).state, "review");
	assert.equal(h.world.pulls.get(1)?.state, "open");
	assert.equal(h.fake.runs.length, 2);
	// The owner CLI unfreezes: recheck, then dispatch reopens.
	h.fake.control.script = workScript();
	h.store.tx(() =>
		h.store.run("UPDATE groups SET state = 'normal', reason = NULL, recheck_required = 1 WHERE chat_id = ?", CHAT),
	);
	h.engine.kick();
	await h.engine.idle();
	assert.equal(h.store.groupState(CHAT).recheck, false);
	assert.equal(taskRow(h, queued).state, "review");
});

// ---------------------------------------------------------------------------------------------------------------
// Coordinator wiring (smoke): fake Bot API object, in-memory git/GitHub, local sandbox, scripted runner.

function fakeTelegram(username = "engine_test_bot") {
	const updates: Update[] = [];
	const sent: SendMessageParams[] = [];
	let messageId = 70_000;
	let wake: (() => void) | undefined;
	const api: TelegramApi = {
		async getMe() {
			return { id: 1, username, canReadAllGroupMessages: false };
		},
		async getUpdates(offset, _timeoutSeconds, signal) {
			for (;;) {
				const batch = updates.filter((update) => update.update_id >= offset);
				if (batch.length > 0) return batch;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 50);
					wake = () => {
						clearTimeout(timer);
						resolve();
					};
					signal?.addEventListener("abort", () => wake?.(), { once: true });
				});
				if (signal?.aborted === true) throw new TelegramError("network", "aborted");
			}
		},
		async sendMessage(params) {
			sent.push(params);
			return { messageId: ++messageId };
		},
	};
	return {
		api,
		sent,
		push(text: string, from = USER): number {
			const updateId = nextUpdate++;
			updates.push({
				update_id: updateId,
				message: {
					message_id: updateId + 100_000,
					date: 1_790_000_000,
					chat: { id: CHAT, type: "supergroup", title: "team" },
					from: { id: from, is_bot: false, first_name: "U" },
					text,
				},
			} as unknown as Update);
			wake?.();
			return updateId;
		},
	};
}

test("startCoordinator wires recovery, relay, poller, engine and outbox; /task flows to review; stop releases the lock", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "coordinator-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const config = testConfig(dir);
	const world = createWorld();
	const telegram = fakeTelegram();
	const fake = createFakeLauncher(() => {});
	const limits: Limits = { ...DEMO_LIMITS, stopGraceMs: 300, checkDeadlineMs: 3000, minFreeDiskBytes: 0 };
	const deps = {
		telegram: telegram.api,
		github: world.github,
		git: world.git,
		sandbox: createLocalSandbox({ taskDir: config.paths.taskDir }),
		launcher: fake.launcher,
		limits,
		log: silentLogger,
		pollTimeoutSeconds: 1,
		retryDelayMs: 5,
	};
	const coordinator = await startCoordinator(config, deps);
	let stopped = false;
	t.after(async () => {
		if (!stopped) await coordinator.stop();
	});
	assert.match(coordinator.relayUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
	// A second Coordinator on the same data directory is refused while the first holds the lock.
	await assert.rejects(startCoordinator(config, deps), (error: Error) => error.name === "LockHeld");
	telegram.push("/task@engine_test_bot alpha add email validation");
	await waitFor(
		() => coordinator.store.get<{ state: string }>("SELECT state FROM tasks WHERE id = 1")?.state === "review",
		{ what: "task in review" },
	);
	await coordinator.idle();
	assert.equal(fake.runs.length, 1);
	assert.equal(fake.runs[0]?.start.model.relayBaseUrl, coordinator.relayUrl);
	const texts = telegram.sent.map((message) => message.text);
	assert.ok(
		texts.some((text) => /^Task 1 accepted for agent alpha\. Queue position 1\./.test(text)),
		texts.join("\n"),
	);
	assert.ok(
		texts.some((text) => /^Task 1 is ready for review \(run 1\)/.test(text)),
		texts.join("\n"),
	);
	assert.ok(telegram.sent.every((message) => message.chatId === CHAT));
	await coordinator.stop();
	stopped = true;
	// The lock is released: a restart works and recovery runs again on the same store.
	const again = await startCoordinator(config, deps);
	assert.equal(again.store.get<{ state: string }>("SELECT state FROM tasks WHERE id = 1")?.state, "review");
	await again.stop();
});

test("startCoordinator refuses a bot whose username does not match and releases the lock", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "coordinator-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const config = testConfig(dir);
	const world = createWorld();
	const deps = {
		telegram: fakeTelegram("someone_else_bot").api,
		github: world.github,
		git: world.git,
		sandbox: createLocalSandbox({ taskDir: config.paths.taskDir }),
		launcher: createFakeLauncher(() => {}).launcher,
		log: silentLogger,
	};
	await assert.rejects(startCoordinator(config, deps), (error: unknown) => error instanceof ConfigError);
	await assert.rejects(startCoordinator(config, deps), (error: unknown) => error instanceof ConfigError);
});
