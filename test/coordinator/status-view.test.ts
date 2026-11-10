import "../helpers/env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { parseArgs } from "../../src/cli/args.ts";
import { ownerRequestOf } from "../../src/cli/owner.ts";
import { readScopeIndex, type StatusIdentity } from "../../src/coordinator/status-scope.ts";
import { parseStatusOptions, selectStatusTasks, statusView, taskSummary } from "../../src/coordinator/status-view.ts";
import { Store } from "../../src/coordinator/store.ts";

const GROUP = -10012345;
const REPO = "acme/demo";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pd-status-"));
	roots.push(dir);
	const database = join(dir, "coordinator.sqlite");
	const scopeFile = join(dir, "scopes.json");
	const identity: StatusIdentity = {
		repository: REPO,
		topicId: 124,
		databasePath: database,
		scopeFile,
		runtime: "running",
	};
	const store = new Store(database);
	const periods = [
		{ firstTask: 1, lastTask: 1, repository: "acme/old", group: GROUP, topic: 1 },
		{ firstTask: 2, lastTask: 2, repository: REPO, group: GROUP, topic: 124 },
		{ firstTask: 3, lastTask: 3, repository: REPO, group: GROUP, topic: 125 },
		{ firstTask: 4, lastTask: 6, repository: REPO, group: GROUP, topic: 124 },
		{ firstTask: 7, lastTask: 7, repository: REPO, group: -77, topic: 124 },
		{ firstTask: 9, lastTask: 11, repository: REPO, group: GROUP, topic: 124 },
	];
	const manifest = { version: 1, database, periods };
	writeFileSync(scopeFile, JSON.stringify(manifest));
	for (const [id, state, repo] of [
		[1, "merged", "acme/old"],
		[2, "merged", REPO],
		[3, "merged", REPO],
		[4, "review", REPO],
		[5, "failed", REPO],
		[6, "queued", null],
		[7, "merged", REPO],
		[8, "queued", null],
		[9, "cancelled", null],
		[10, "review", "acme/unrelated"],
		[11, "review", REPO],
	] as const) {
		seedTask(store, id, state, repo);
	}
	return { dir, store, identity, manifest };
}

function seedTask(store: Store, id: number, state: string, repo: string | null) {
	store.run(
		`INSERT INTO tasks(id,chat_id,creator_id,agent_id,text,update_id,state,created_at,updated_at,
			pr_number,pr_url,head_commit,posted_head,tests_passed_head,cancel_requested,reason)
			VALUES (?, ?, 1, 'alpha', ?, ?, ?, 1, ?, ?, ?, 'abc', 'abc', ?, ?, '401 invalid credentials')`,
		id,
		id === 7 ? -77 : GROUP,
		`Request ${id} \n add a button`,
		1000 + id,
		state,
		id,
		repo ? id : null,
		repo ? `https://github.com/${repo}/pull/${id}` : null,
		id === 11 ? null : "abc",
		id === 9 ? 1 : 0,
	);
}

const ids = (s: ReturnType<typeof fixture>, all = false, telegram = false) =>
	selectStatusTasks(s.store, GROUP, s.identity, { all }, { telegram })
		.tasks.map((t) => t.id)
		.sort((a, b) => a - b);

test("default scope requires verified repo AND topic; --all is explicit and Telegram never crosses groups", () => {
	const s = fixture();
	try {
		assert.deepEqual(ids(s), [2, 4, 5, 6, 9, 11]);
		assert.deepEqual(ids(s, true), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
		assert.deepEqual(ids(s, true, true), [1, 2, 3, 4, 5, 6, 8, 9, 10, 11]);
		const text = statusView(s.store, GROUP, s.identity).join("\n");
		assert.match(text, /succeeded 1 \/ failed 1 \/ open 3/);
		assert.match(text, /Completed:\nTask 4 · alpha · in review/);
		assert.ok(text.indexOf("Completed:") < text.indexOf("Open:"));
		assert.match(text, /pull\/2 · Request 2 add a button · PR #2 merged/);
		assert.match(text, /PR #4 open \(recorded\) · awaiting approval/);
		assert.match(text, /PR #11 open \(recorded\) · tests not passed at current head/);
		assert.match(text, /Task 9 · alpha · cancelled/);
		assert.doesNotMatch(text, /cancelling|401|Task 5 ·|Task 1 ·|Task 3 ·|Task 8 ·|Task 10 ·/);
		assert.match(text, /Older failures: 1 \(aggregated; records retained\)/);
		const all = statusView(s.store, GROUP, s.identity, { all: true, verbose: true }).join("\n");
		assert.match(all, /Task 8 .*scope unconfirmed/);
		assert.match(all, /topic 125/);
		assert.doesNotMatch(all, /401|invalid credentials/);
	} finally {
		s.store.close();
	}
});

test("older out-of-scope failures are a count only; unposted or cancelling review is not falsely ready", () => {
	const s = fixture();
	try {
		s.store.run("UPDATE tasks SET state='failed' WHERE id=1");
		s.store.run("UPDATE tasks SET posted_head=NULL WHERE id=4");
		const text = statusView(s.store, GROUP, s.identity).join("\n");
		assert.match(text, /Older failures: 1; 1 outside this scope\/unconfirmed/);
		assert.doesNotMatch(text, /Task 1 ·|401/);
		assert.match(text, /awaiting a fresh review message/);
		assert.ok(text.indexOf("Task 4 ·") > text.indexOf("Open:"));
		s.store.run("UPDATE tasks SET posted_head=head_commit,cancel_requested=1 WHERE id=4");
		const cancelling = statusView(s.store, GROUP, s.identity).join("\n");
		assert.ok(cancelling.indexOf("Task 4 ·") > cancelling.indexOf("Open:"));
	} finally {
		s.store.close();
	}
});

test("missing, invalid, overlapping and wrong-database routing evidence fails closed; --all keeps records discoverable", () => {
	const s = fixture();
	try {
		for (const invalid of [
			"bad-json",
			JSON.stringify({ ...s.manifest, database: "/other.sqlite" }),
			JSON.stringify({ ...s.manifest, periods: [s.manifest.periods[0], s.manifest.periods[0]] }),
			JSON.stringify({ ...s.manifest, periods: [{ ...s.manifest.periods[0], lastTask: 0 }] }),
		]) {
			writeFileSync(s.identity.scopeFile as string, invalid);
			assert.deepEqual(ids(s), []);
			assert.equal(ids(s, true).length, 11);
			assert.ok(readScopeIndex(s.identity).problem);
		}
		rmSync(s.identity.scopeFile as string);
		assert.deepEqual(ids(s), []);
		assert.match(statusView(s.store, GROUP, s.identity).join("\n"), /routing history unavailable/);
	} finally {
		s.store.close();
	}
});

function fingerprints(dir: string) {
	return Object.fromEntries(
		readdirSync(dir).map((name) => {
			const path = join(dir, name);
			const stat = statSync(path);
			return [name, `${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`];
		}),
	);
}

test("all display variants are read-only: tasks, schema, database bytes and routing file unchanged", () => {
	const s = fixture();
	const tasks = s.store.all("SELECT * FROM tasks ORDER BY id");
	s.store.close();
	const before = fingerprints(s.dir);
	const ro = new Store(s.identity.databasePath, Date.now, { readOnly: true });
	try {
		const schema = ro.get("PRAGMA user_version");
		for (const options of [{}, { all: true }, { verbose: true }, { all: true, verbose: true }]) {
			statusView(ro, GROUP, { ...s.identity, runtime: "offline" }, options);
			assert.deepEqual(ro.all("SELECT * FROM tasks ORDER BY id"), tasks);
			assert.deepEqual(ro.get("PRAGMA user_version"), schema);
		}
	} finally {
		ro.close();
	}
	const after = fingerprints(s.dir);
	for (const [name, fingerprint] of Object.entries(before)) assert.equal(after[name], fingerprint);
	// SQLite may create WAL/SHM reader lock files; no task/schema/database content is written.
	assert.deepEqual(
		Object.keys(after)
			.filter((name) => !(name in before))
			.sort(),
		["coordinator.sqlite-shm", "coordinator.sqlite-wal"],
	);
});

test("status switches are display-only, validated end to end and rejected on mutation commands", () => {
	assert.deepEqual(parseStatusOptions("--verbose 9 --all"), { verbose: true, task: 9, all: true });
	for (const bad of ["--all --all", "1 2", "0", "9007199254740999", "--unknown"])
		assert.equal(parseStatusOptions(bad), undefined);
	const parsed = parseArgs(["owner", "status", "--all", "--verbose"]);
	assert.deepEqual(parsed, { command: "owner", action: "status", all: true, verbose: true });
	assert.deepEqual(ownerRequestOf({ action: "status", all: true, verbose: true }, GROUP), {
		command: "status",
		all: true,
		verbose: true,
	});
	for (const args of [
		["owner", "unfreeze", "--all"],
		["owner", "resolve", "1", "--verbose"],
		["run", "--all"],
		["owner", "status", "--all", "--all"],
	]) {
		assert.equal(parseArgs(args).command, "invalid");
	}
});

test("one-line task summaries redact before clipping and strip terminal controls", () => {
	const secret = `github_pat_${"notReal".repeat(30)}`;
	assert.equal(taskSummary(`Add\nbutton\t${secret}\u001b\r`), "Add button <redacted>");
	assert.doesNotMatch(taskSummary("OPENAI_API_KEY=sk-test-secret-value change footer"), /sk-test-secret-value/);
	assert.ok(taskSummary("a".repeat(400)).length <= 108);
});

test("CLI hides only SQLite's ExperimentalWarning; unrelated warnings still appear", () => {
	const child = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		import './src/cli/warnings.ts';
		await import('node:sqlite');
		process.emitWarning('Another feature is experimental',{type:'ExperimentalWarning'});
		process.emitWarning('A real operational warning');
	`,
		],
		{ cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "", NODE_OPTIONS: "" } },
	);
	assert.equal(child.status, 0, child.stderr);
	assert.doesNotMatch(child.stderr, /SQLite is an experimental feature/);
	assert.match(child.stderr, /ExperimentalWarning: Another feature/);
	assert.match(child.stderr, /Warning: A real operational warning/);
});
