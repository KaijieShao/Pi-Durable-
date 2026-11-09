/**
 * The owner socket's commands as the Coordinator runs them (src/coordinator/owner/service.ts), on a real Store: status
 * says whether the Coordinator runs and reports the group metadata only; unfreeze is the engine's (the recovery checks)
 * and names the check that failed, for this Coordinator's group only and not while it starts; resolve records the
 * owner's resolution and unfreezes nothing; conversations lists the quarantined ones; inspect opens only a quarantined
 * conversation of this group stored in this data directory, and logs its size, never its content.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type CoordinatorConfig, parseCoordinatorConfig } from "../../src/coordinator/config.ts";
import type { Engine, UnfreezeOutcome } from "../../src/coordinator/engine.ts";
import type { OwnerRequest, OwnerResponse } from "../../src/coordinator/owner/protocol.ts";
import { ownerService } from "../../src/coordinator/owner/service.ts";
import { Store } from "../../src/coordinator/store.ts";
import { createLogger } from "../../src/runtime/log.ts";

const GROUP = -1001234567890;
const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function config(dataDir: string, topicId = 1): CoordinatorConfig {
	return parseCoordinatorConfig(
		{
			TELEGRAM_BOT_TOKEN: `123456789:${"A".repeat(35)}`,
			TELEGRAM_BOT_USERNAME: "owner_test_bot",
			TELEGRAM_GROUP_CHAT_ID: String(GROUP),
			TELEGRAM_GROUP_TOPIC_ID: String(topicId),
			TELEGRAM_OWNER_ID: "42",
			PI_AGENTS: "alpha",
			PI_MODEL: "gpt-test",
			OPENAI_API_KEY: "sk-test-not-real-0000000000",
			PROJECT_TOKEN_CEILING: "1000",
			GITHUB_TOKEN: "ghp_test_not_real",
			GITHUB_REPO: "acme/demo",
			PI_DATA_DIR: dataDir,
			PI_TASK_DIR: join(dataDir, "tasks"),
		},
		{ cwd: dataDir, home: dataDir, uid: 1000, gid: 1000 },
	);
}

function setup(engine?: Partial<Engine>, topicId = 1) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pd-owner-")));
	roots.push(root);
	const dataDir = join(root, "data");
	mkdirSync(join(dataDir, "owner"), { recursive: true, mode: 0o700 });
	mkdirSync(join(dataDir, "conversations"), { recursive: true });
	const store = new Store(join(dataDir, "coordinator.sqlite"));
	after(() => store.close());
	const lines: string[] = [];
	const log = createLogger({ level: "debug", sink: (_level, line) => lines.push(line) });
	const handle = ownerService({
		store,
		config: config(dataDir, topicId),
		log,
		engine: () => (engine === undefined ? undefined : (engine as Engine)),
		startedAt: Date.parse("2026-11-08T00:00:00Z"),
	});
	const ask = (request: OwnerRequest): Promise<OwnerResponse> => handle(request);
	return { dataDir, store, lines, ask };
}

function seedTask(store: Store, id: number, chatId = GROUP): void {
	store.tx(() =>
		store.run(
			`INSERT INTO tasks(id, chat_id, creator_id, agent_id, text, update_id, state, created_at, updated_at)
			 VALUES (?, ?, 1, 'alpha', 'SECRET TASK TEXT', ?, 'review', 1, 1)`,
			id,
			chatId,
			9000 + id,
		),
	);
}

function seedConversation(store: Store, id: string, taskId: number, path: string, quarantined: 0 | 1): void {
	store.tx(() =>
		store.run(
			"INSERT INTO conversations(id, task_id, path, quarantined, created_at) VALUES (?, ?, ?, ?, ?)",
			id,
			taskId,
			path,
			quarantined,
			Date.parse("2026-11-08T01:00:00Z"),
		),
	);
}

test("status: whether the Coordinator runs or still starts, then the group's metadata (no task text)", async () => {
	const starting = setup();
	seedTask(starting.store, 1);
	const status = await starting.ask({ command: "status" });
	assert.equal(status.ok, true);
	assert.match(
		status.text,
		/^Coordinator: starting \(recovery in progress\), pid \d+, since 2026-11-08T00:00:00\.000Z\nRepository: acme\/demo\nTelegram routing: group -1001234567890, topic 1 \(General\)\nDatabase: \/[^\n]+\/coordinator\.sqlite\nGroup -1001234567890: normal\n/,
	);
	assert.ok(status.text.includes(`Database: ${join(starting.dataDir, "coordinator.sqlite")}\n`));
	assert.ok(!status.text.includes("SECRET"));
	const running = setup({ unfreeze: async () => ({ kind: "not_frozen", state: "normal" }) });
	assert.match((await running.ask({ command: "status" })).text, /^Coordinator: running, pid \d+/);
});

test("live status reports the server's repository, forum topic and absolute database", async () => {
	const s = setup({ unfreeze: async () => ({ kind: "not_frozen", state: "normal" }) }, 124);
	const result = await s.ask({ command: "status" });
	assert.equal(result.ok, true);
	assert.ok(result.text.includes("Repository: acme/demo\nTelegram routing: group -1001234567890, topic 124\n"));
	assert.ok(result.text.includes(`Database: ${join(s.dataDir, "coordinator.sqlite")}\n`));
	assert.ok(!result.text.includes("(General)"));
	assert.ok(!result.text.includes("sk-test-not-real"));
	assert.ok(!result.text.includes("ghp_test_not_real"));
});

test("unfreeze: only this Coordinator's group, only once the engine runs; the outcome names every check and the failed one", async () => {
	const starting = setup();
	const early = await starting.ask({ command: "unfreeze", group: GROUP });
	assert.deepEqual([early.ok, early.ok ? "" : early.error], [false, "unavailable"]);
	assert.match(early.text, /still starting/);

	let outcome: UnfreezeOutcome = { kind: "not_frozen", state: "normal" };
	let calls = 0;
	const s = setup({
		unfreeze: async () => {
			calls++;
			return outcome;
		},
	});
	const other = await s.ask({ command: "unfreeze", group: -42 });
	assert.match(other.text, /^This Coordinator serves group -1001234567890 only, not -42\.$/);
	assert.equal(calls, 0, "another group's unfreeze never reaches the engine");
	assert.deepEqual(await s.ask({ command: "unfreeze", group: GROUP }), {
		ok: true,
		text: "Group -1001234567890 is not frozen; nothing changed.",
	});
	outcome = { kind: "not_frozen", state: "sealing" };
	assert.equal((await s.ask({ command: "unfreeze", group: GROUP })).ok, false);
	outcome = { kind: "in_progress" };
	const busy = await s.ask({ command: "unfreeze", group: GROUP });
	assert.equal(busy.ok ? "" : busy.error, "busy");
	outcome = {
		kind: "refused",
		reason: "the merge outcome of Task 1 on GitHub is unknown",
		checks: [
			{ name: "runs", ok: true, detail: "nothing of the group is running" },
			{ name: "watchdog", ok: false, detail: "the watchdog did not answer its sweep request within 30 s" },
		],
	};
	const refused = await s.ask({ command: "unfreeze", group: GROUP });
	assert.equal(refused.ok, false);
	assert.equal(
		refused.text,
		[
			'Group -1001234567890 stays frozen (frozen: the merge outcome of Task 1 on GitHub is unknown): the recovery check "watchdog" failed. Nothing was unfrozen.',
			"Recovery checks, in order (the ones after the failed check did not run):",
			"  ok     runs: nothing of the group is running",
			"  FAILED watchdog: the watchdog did not answer its sweep request within 30 s",
			"Resolve the cause, then run owner unfreeze again.",
		].join("\n"),
	);
	assert.equal(refused.checks?.length, 2);
	outcome = { kind: "unfrozen", reason: "test", jobs: 2, checks: [{ name: "relay", ok: true, detail: "running" }] };
	const unfrozen = await s.ask({ command: "unfreeze", group: GROUP });
	assert.equal(unfrozen.ok, true);
	assert.match(
		unfrozen.text,
		/^Group -1001234567890 unfrozen \(it was frozen: test\)\. Every recovery check passed:\n {2}ok {5}relay: running\nDispatch reopens for admitted work after the 2 recovery jobs it found/,
	);
	assert.equal(calls, 5);
});

test("resolve: the owner's resolution of this group's unresolved change; anything else is reported, nothing unfreezes", async () => {
	const s = setup();
	seedTask(s.store, 1);
	seedTask(s.store, 2, -77);
	s.store.tx(() => {
		s.store.freeze(GROUP, "the outcome of a file change of Task 1 could not be reconciled (a.js)");
		for (const [task, state] of [
			[1, "unresolved"],
			[1, "applied"],
			[2, "unresolved"],
		] as const) {
			s.store.run(
				"INSERT INTO effect_intents(run_id, task_id, tool, path, state, created_at) VALUES (1, ?, 'write', 'a.js', ?, 1)",
				task,
				state,
			);
		}
	});
	const partly = await s.ask({ command: "resolve", intents: [1, 2, 3, 9] });
	assert.equal(partly.ok, false);
	assert.equal(
		partly.text,
		[
			"Recorded what could be resolved:",
			"  change 1 (Task 1, a.js): resolved, accepted as it is in the worktree",
			"  change 2 (Task 1, a.js): applied, not unresolved; unchanged",
			"  change 3: no such file change in this group",
			"  change 9: no such file change in this group",
			"The group stays as it is: owner unfreeze repeats the recovery checks, then reopens dispatch.",
		].join("\n"),
	);
	const states = s.store.all<{ state: string }>("SELECT state FROM effect_intents ORDER BY id").map((row) => row.state);
	assert.deepEqual(states, ["resolved", "applied", "unresolved"], "another group's change is untouched");
	assert.equal(s.store.groupState(GROUP).state, "frozen");
	assert.ok(s.lines.some((line) => line === "info owner_effect_resolved intent=1 task=1"));
});

async function piConversation(path: string, text: string): Promise<void> {
	const storage = await openNodeSqliteStorage(path);
	await storage.close(BACKGROUND_CONTEXT);
	const db = new DatabaseSync(path);
	db.prepare("INSERT INTO entries(id, conversation_id, head, commit_seq, record) VALUES (2, 1, NULL, 1, ?)").run(
		JSON.stringify({ kind: "pi.user", model: [{ role: "user", content: text, timestamp: 1 }] }),
	);
	db.close();
}

test("conversations and inspect: only a quarantined conversation of this group, stored here, read-only; the log gets its size only", async () => {
	const s = setup();
	seedTask(s.store, 1);
	seedTask(s.store, 2, -77);
	const quarantined = join(s.dataDir, "conversations", "c-quarantined.sqlite");
	await piConversation(quarantined, "RAW TRANSCRIPT CONTENT");
	seedConversation(s.store, "c-quarantined", 1, quarantined, 1);
	seedConversation(s.store, "c-live", 1, join(s.dataDir, "conversations", "c-live.sqlite"), 0);
	seedConversation(s.store, "c-other", 2, join(s.dataDir, "conversations", "c-other.sqlite"), 1);
	seedConversation(s.store, "c-moved", 1, "/elsewhere/c-moved.sqlite", 1);
	s.store.tx(() =>
		s.store.run(
			`INSERT INTO runs(task_id, kind, state, reason, requested_by, request_id, input_text, conversation_id, queued_at)
			 VALUES (1, 'initial', 'failed', 'interrupted by restart', 1, '9001', 'SECRET', 'c-quarantined', 1)`,
		),
	);
	const list = await s.ask({ command: "conversations" });
	assert.equal(list.ok, true);
	assert.match(
		list.text,
		/^Quarantined conversations: 2 \(never written again; owner inspect <id> opens one read-only\)\n/,
	);
	assert.match(
		list.text,
		/\n {2}c-quarantined Task 1: run 1 failed \(interrupted by restart\); created 2026-11-08T01:00:00\.000Z; \d+(\.\d)? KiB/,
	);
	assert.match(list.text, /\n {2}c-moved Task 1: no run; created .*; file missing/);
	assert.ok(!list.text.includes("c-other") && !list.text.includes("c-live"), list.text);
	assert.equal((await s.ask({ command: "conversations", task: 2 })).text, "No quarantined conversations of Task 2.");

	for (const [id, reason] of [
		["c-none", /^No conversation c-none in this group/],
		["c-other", /^No conversation c-other in this group/],
		["c-live", /^Conversation c-live is not quarantined; only quarantined conversations can be inspected\.$/],
		["c-moved", /^Conversation c-moved is not stored in this data directory\.$/],
	] as const) {
		const refused = await s.ask({ command: "inspect", conversation: id });
		assert.equal(refused.ok, false, id);
		assert.match(refused.text, reason);
	}
	const inspected = await s.ask({ command: "inspect", conversation: "c-quarantined" });
	assert.equal(inspected.ok, true);
	assert.match(
		inspected.text,
		/^Conversation c-quarantined of Task 1 \(quarantined; read-only, nothing was written\)\nFile: /,
	);
	assert.match(inspected.text, /\[user\] RAW TRANSCRIPT CONTENT/);
	const logged = s.lines.join("\n");
	assert.match(logged, /info owner_inspect conversation=c-quarantined task=1 entries=1 source=file/);
	assert.ok(!logged.includes("RAW TRANSCRIPT CONTENT"), "never the content");
});
