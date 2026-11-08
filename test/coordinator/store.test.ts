/**
 * The Store's schema versions (src/coordinator/store.ts): a new database is created at the current version; an
 * existing version-1 database (the schema as it shipped, SCHEMA_V1) upgrades to the current version in place, keeping
 * every row, with the watchdog's table and runs.dispatched_at (version 2), the effect ledger (version 3) and the
 * evaluations of sealed trials (version 4); version-2 and version-3 databases upgrade the same way; a newer version is
 * refused; the Coordinator and the watchdog may open the same new file at once (one migrates, the other finds it done).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { SCHEMA_V1, SCHEMA_VERSION, Store } from "../../src/coordinator/store.ts";

async function tempDb(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "store-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return join(dir, "coordinator.sqlite");
}

/** A database exactly as version-1 code left it: its schema, its version, and a task with a running run. */
function createV1(path: string): void {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(SCHEMA_V1);
	db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '1')").run();
	db.prepare("INSERT INTO meta(key, value) VALUES ('telegram_offset', '42')").run();
	db.prepare(
		`INSERT INTO tasks(chat_id, creator_id, agent_id, text, update_id, state, generation, created_at, updated_at)
		 VALUES (-100, 7, 'alpha', 'add a test', 1000, 'running', 1, 1, 1)`,
	).run();
	db.prepare(
		`INSERT INTO runs(task_id, kind, state, requested_by, request_id, input_text, generation, pid, queued_at, started_at)
		 VALUES (1, 'initial', 'running', 7, '1000', 'add a test', 1, 4242, 1, 2)`,
	).run();
	db.close();
}

const columns = (store: Store, table: string): string[] =>
	store.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((row) => row.name);

test("a new database is created at the current schema version, with the watchdog's table and the effect ledger", async (t) => {
	const store = new Store(await tempDb(t));
	t.after(() => store.close());
	assert.equal(SCHEMA_VERSION, 4);
	assert.equal(store.getMeta("schema_version"), "4");
	assert.ok(columns(store, "watchdog_sweeps").includes("verified"));
	assert.ok(columns(store, "runs").includes("dispatched_at"));
	assert.deepEqual(columns(store, "effect_intents"), [
		"id",
		"run_id",
		"task_id",
		"tool",
		"path",
		"operation",
		"pre_hash",
		"intended_hash",
		"state",
		"observed_hash",
		"reconciled",
		"resolution",
		"created_at",
		"settled_at",
	]);
	assert.ok(columns(store, "evaluations").includes("snapshot_hash"));
});

test("an existing version-1 database upgrades to the current version in place and keeps every row", async (t) => {
	const path = await tempDb(t);
	createV1(path);
	const store = new Store(path);
	assert.equal(store.getMeta("schema_version"), "4");
	assert.equal(store.getMeta("telegram_offset"), "42", "meta kept");
	const run = store.get<{ state: string; pid: number; dispatched_at: number | null }>(
		"SELECT state, pid, dispatched_at FROM runs WHERE id = 1",
	);
	assert.deepEqual({ ...run }, { state: "running", pid: 4242, dispatched_at: null }, "runs kept, the new column empty");
	assert.equal(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks")?.n, 1);
	// The new table works like on a fresh database (CHECK constraints included).
	store.tx(() =>
		store.run("INSERT INTO watchdog_sweeps(reason, state, requested_at) VALUES ('coordinator_start', 'pending', 1)"),
	);
	assert.throws(() =>
		store.run("INSERT INTO watchdog_sweeps(reason, state, requested_at) VALUES ('anything', 'pending', 1)"),
	);
	// The upgraded schema is the fresh one.
	const fresh = new Store(join(path, "..", "fresh.sqlite"));
	t.after(() => fresh.close());
	for (const table of ["runs", "watchdog_sweeps", "effect_intents", "evaluations", "groups", "tasks", "meta"])
		assert.deepEqual(columns(store, table), columns(fresh, table), table);
	// Opening it again changes nothing.
	store.close();
	const again = new Store(path);
	assert.equal(again.getMeta("schema_version"), "4");
	again.close();
});

test("a version-2 database upgrades to the current version in place: the effect ledger is added, every row kept", async (t) => {
	const path = await tempDb(t);
	createV1(path);
	// Version 2 exactly as it shipped: version 1 plus the watchdog's migration (applied by the version-2 code).
	const db = new DatabaseSync(path);
	db.exec(`CREATE TABLE watchdog_sweeps (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  reason TEXT NOT NULL CHECK (reason IN ('coordinator_start','recheck','coordinator_dead','deadline')),
	  state TEXT NOT NULL CHECK (state IN ('pending','done')),
	  requester_pid INTEGER, run_id INTEGER, task_id INTEGER, generation INTEGER,
	  verified INTEGER CHECK (verified IN (0, 1)), processes_killed INTEGER, containers_killed INTEGER,
	  processes_left INTEGER, containers_left INTEGER, detail TEXT,
	  requested_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
	ALTER TABLE runs ADD COLUMN dispatched_at INTEGER;`);
	db.prepare("UPDATE runs SET dispatched_at = 5 WHERE id = 1").run();
	db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
	db.close();
	const store = new Store(path);
	t.after(() => store.close());
	assert.equal(store.getMeta("schema_version"), "4");
	const run = store.get<{ state: string; dispatched_at: number }>("SELECT state, dispatched_at FROM runs WHERE id = 1");
	assert.deepEqual({ ...run }, { state: "running", dispatched_at: 5 }, "the running run is kept as it was");
	assert.equal(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM effect_intents")?.n, 0);
	store.tx(() =>
		store.run(
			`INSERT INTO effect_intents(run_id, task_id, tool, path, pre_hash, intended_hash, state, created_at)
			 VALUES (1, 1, 'write', 'a.txt', 'absent', 'sha256:00', 'pending', 1)`,
		),
	);
	assert.throws(
		() =>
			store.run(
				"INSERT INTO effect_intents(run_id, task_id, tool, state, created_at) VALUES (1, 1, 'shell', 'pending', 1)",
			),
		/CHECK constraint failed/,
	);
	assert.throws(
		() =>
			store.run(
				"INSERT INTO effect_intents(run_id, task_id, tool, state, created_at) VALUES (1, 1, 'edit', 'maybe', 1)",
			),
		/CHECK constraint failed/,
	);
});

test("a version-3 database upgrades to version 4 in place: the evaluations table is added, every row kept", async (t) => {
	const path = await tempDb(t);
	// Version 3 exactly as it shipped: a fresh version-3 database is a version-4 one without the evaluations table.
	const fresh = new Store(path);
	fresh.tx(() => {
		fresh.run("DROP TABLE evaluations");
		fresh.setMeta("schema_version", "3");
		fresh.run(
			"INSERT INTO groups(chat_id, state, reason, recheck_required, updated_at) VALUES (-100, 'frozen', 'x', 0, 1)",
		);
	});
	fresh.close();
	const store = new Store(path);
	t.after(() => store.close());
	assert.equal(store.getMeta("schema_version"), "4");
	assert.equal(store.groupState(-100).state, "frozen", "rows kept");
	store.tx(() =>
		store.run(
			`INSERT INTO evaluations(chat_id, trial, state, tasks, last_task_id, requested_at)
			 VALUES (-100, 't1', 'sealing', '[1]', 1, 1)`,
		),
	);
	assert.throws(
		() =>
			store.run(
				"INSERT INTO evaluations(chat_id, trial, state, tasks, last_task_id, requested_at) VALUES (-100, 't2', 'grading', '[]', 0, 1)",
			),
		/CHECK constraint failed/,
	);
	assert.throws(
		() =>
			store.run(
				"INSERT INTO evaluations(chat_id, trial, state, tasks, last_task_id, requested_at) VALUES (-100, 't1', 'done', '[]', 0, 1)",
			),
		/UNIQUE constraint failed/,
		"a trial is evaluated once",
	);
});

test("a database of a newer schema version is refused, and left untouched", async (t) => {
	const path = await tempDb(t);
	createV1(path);
	const db = new DatabaseSync(path);
	const newer = String(SCHEMA_VERSION + 1);
	db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(newer);
	db.close();
	assert.throws(() => new Store(path), new RegExp(`unsupported coordinator schema ${newer}`));
	const check = new DatabaseSync(path, { readOnly: true });
	const tables = check.prepare("SELECT name FROM sqlite_master WHERE name = 'watchdog_sweeps'").all();
	check.close();
	assert.equal(tables.length, 0);
});

test("two connections opening the same new file (Coordinator and watchdog) both get the current schema", async (t) => {
	const path = await tempDb(t);
	const first = new Store(path);
	const second = new Store(path);
	t.after(() => {
		first.close();
		second.close();
	});
	assert.equal(first.getMeta("schema_version"), "4");
	assert.equal(second.getMeta("schema_version"), "4");
	first.tx(() => first.setMeta("watchdog_heartbeat_at", "123"));
	assert.equal(second.getMeta("watchdog_heartbeat_at"), "123", "one file, two connections (WAL)");
});
