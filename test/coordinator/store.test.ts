/**
 * The Store's schema versions (src/coordinator/store.ts): a new database is created at the current version; an
 * existing version-1 database (the schema as it shipped, SCHEMA_V1) upgrades to version 2 in place, keeping every row,
 * with the watchdog's table and runs.dispatched_at; a newer version is refused; the Coordinator and the watchdog may
 * open the same new file at once (one migrates, the other finds it done).
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

test("a new database is created at the current schema version, with the watchdog's table", async (t) => {
	const store = new Store(await tempDb(t));
	t.after(() => store.close());
	assert.equal(SCHEMA_VERSION, 2);
	assert.equal(store.getMeta("schema_version"), "2");
	assert.ok(columns(store, "watchdog_sweeps").includes("verified"));
	assert.ok(columns(store, "runs").includes("dispatched_at"));
});

test("an existing version-1 database upgrades to version 2 in place and keeps every row", async (t) => {
	const path = await tempDb(t);
	createV1(path);
	const store = new Store(path);
	assert.equal(store.getMeta("schema_version"), "2");
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
	for (const table of ["runs", "watchdog_sweeps", "tasks", "meta"])
		assert.deepEqual(columns(store, table), columns(fresh, table), table);
	// Opening it again changes nothing.
	store.close();
	const again = new Store(path);
	assert.equal(again.getMeta("schema_version"), "2");
	again.close();
});

test("a database of a newer schema version is refused, and left untouched", async (t) => {
	const path = await tempDb(t);
	createV1(path);
	const db = new DatabaseSync(path);
	db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
	db.close();
	assert.throws(() => new Store(path), /unsupported coordinator schema 3/);
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
	assert.equal(first.getMeta("schema_version"), "2");
	assert.equal(second.getMeta("schema_version"), "2");
	first.tx(() => first.setMeta("watchdog_heartbeat_at", "123"));
	assert.equal(second.getMeta("watchdog_heartbeat_at"), "123", "one file, two connections (WAL)");
});
