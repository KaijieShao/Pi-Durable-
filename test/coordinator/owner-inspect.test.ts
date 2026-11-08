/**
 * Read-only inspection of a quarantined conversation (src/coordinator/owner/inspect.ts; Interfaces and Storage
 * § Recovery After a Restart: "Its conversation is quarantined and opened only read-only"). On real Pi Durable 1.5.0
 * stores (its own schema, created by its storage): a cleanly closed conversation is read immutable, a conversation
 * whose WAL still holds the last entries (its Pi process was killed) is read from a private copy; either way nothing
 * is written or created next to the conversation (every file's hash and mtime unchanged, no -wal or -shm appears), and
 * the copy is deleted. Untrusted text cannot drive the owner's terminal; the transcript is bounded; a symlink or a
 * missing file is refused.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { inspectConversation, removeScratchCopies, terminalSafe } from "../../src/coordinator/owner/inspect.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pd-inspect-")));
	roots.push(root);
	const conversations = join(root, "conversations");
	const scratch = join(root, "owner");
	mkdirSync(conversations, { recursive: true });
	mkdirSync(scratch, { mode: 0o700 });
	return { root, conversations, scratch, path: join(conversations, "c-1.sqlite") };
}

/** A Pi store with Pi Durable's own schema (its storage creates it), closed cleanly. */
async function piStore(path: string): Promise<void> {
	const storage = await openNodeSqliteStorage(path);
	await storage.close(BACKGROUND_CONTEXT);
}

const userEntry = (text: string) => ({ kind: "pi.user", model: [{ role: "user", content: text, timestamp: 1 }] });
const assistantEntry = {
	kind: "pi.assistant",
	model: [
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "look at index.js first" },
				{ type: "text", text: "I will add hello.js." },
				{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "hello.js", content: "x" } },
			],
			stopReason: "toolUse",
			timestamp: 2,
		},
	],
};
const toolEntry = {
	kind: "pi.tool-result",
	model: [
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "write",
			content: [{ type: "text", text: "Wrote hello.js" }],
			isError: false,
			timestamp: 3,
		},
	],
	data: { diagnostics: [] },
};

const INSERT = "INSERT INTO entries(id, conversation_id, head, commit_seq, record) VALUES (?, 1, NULL, ?, ?)";

function insertEntries(path: string, entries: readonly object[], first = 10): void {
	const db = new DatabaseSync(path);
	try {
		const insert = db.prepare(INSERT);
		entries.forEach((entry, index) => {
			insert.run(first + index, first + index, JSON.stringify(entry));
		});
	} finally {
		db.close();
	}
}

/** The conversation's files as they are: name → size, mtime and content hash. */
function snapshot(dir: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(dir)
			.sort()
			.map((name) => {
				const full = join(dir, name);
				const stats = statSync(full);
				const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
				return [name, `${stats.size} ${stats.mtimeMs} ${hash}`];
			}),
	);
}

test("a cleanly closed conversation is read immutable: the transcript is shown and nothing is written or created", async () => {
	const s = setup();
	await piStore(s.path);
	insertEntries(s.path, [userEntry("INSPECT-ME: add hello.js"), assistantEntry, toolEntry]);
	const before = snapshot(s.conversations);
	assert.deepEqual(Object.keys(before), ["c-1.sqlite"], "no -wal or -shm before");
	const inspection = await inspectConversation(s.path, s.scratch);
	assert.deepEqual(
		snapshot(s.conversations),
		before,
		"every file unchanged (hash, size, mtime), no -wal or -shm created",
	);
	assert.equal(inspection.source, "file");
	assert.deepEqual([inspection.entries, inspection.shown], [3, 3]);
	const text = inspection.text;
	assert.match(text, /^File: .*c-1\.sqlite \(\d+(\.\d)? KiB; opened read-only and immutable\)\n/);
	assert.match(text, /\nEntries: 3\n/);
	assert.match(text, /--- entry 10 \(Pi conversation 1\): pi\.user\n\[user\] INSPECT-ME: add hello\.js\n/);
	assert.match(text, /\[thinking\] look at index\.js first\n\[assistant\] I will add hello\.js\.\n/);
	assert.match(text, /\[tool call write\] \{"path":"hello\.js","content":"x"\}/);
	assert.match(text, /\[tool result write\] Wrote hello\.js/);
	assert.deepEqual(readdirSync(s.scratch), [], "no copy was needed");
});

/** Entries committed by a process that is then killed before it checkpoints: they exist only in the -wal file. */
function killedWriter(path: string, entries: readonly object[], first: number): void {
	const script = [
		'const { DatabaseSync } = require("node:sqlite");',
		`const db = new DatabaseSync(${JSON.stringify(path)});`,
		'db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");',
		`const insert = db.prepare(${JSON.stringify(INSERT)});`,
		`${JSON.stringify(entries)}.forEach((entry, i) => insert.run(${first} + i, ${first} + i, JSON.stringify(entry)));`,
		'process.kill(process.pid, "SIGKILL");',
	].join("\n");
	spawnSync(process.execPath, ["--no-warnings", "-e", script], { stdio: "ignore", timeout: 30_000 });
}

test("a conversation whose WAL holds the last entries (its Pi process was killed): read from a private copy, the files unchanged", async () => {
	const s = setup();
	await piStore(s.path);
	insertEntries(s.path, [userEntry("FIRST: before the crash")]);
	killedWriter(s.path, [userEntry("ONLY-IN-WAL: the last entry before the kill"), assistantEntry], 20);
	const before = snapshot(s.conversations);
	assert.ok(Number(before["c-1.sqlite-wal"]?.split(" ")[0]) > 0, "the WAL holds frames");
	const inspection = await inspectConversation(s.path, s.scratch);
	assert.deepEqual(snapshot(s.conversations), before, "the file, its WAL and its -shm unchanged");
	assert.equal(inspection.source, "copy");
	assert.equal(inspection.entries, 3);
	assert.match(inspection.text, /its WAL has content: read from a private copy, deleted again/);
	assert.match(inspection.text, /\[user\] FIRST: before the crash/);
	assert.match(inspection.text, /\[user\] ONLY-IN-WAL: the last entry before the kill/);
	assert.deepEqual(readdirSync(s.scratch), [], "the copy is deleted");
	// The immutable open alone would miss the WAL's entries: that is why the copy is read.
	const url = new URL(`file://${s.path}?mode=ro&immutable=1`);
	const immutable = new DatabaseSync(url, { readOnly: true });
	const seen = immutable.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
	immutable.close();
	assert.equal(seen.n, 1);
});

test("untrusted text cannot drive the terminal: control characters and bidi overrides escaped, secret shapes masked", async () => {
	assert.equal(terminalSafe("a\u001b[2Jb\rc\u202ed\te\nf"), "a\\u001b[2Jb\\u000dc\\u202ed\te\nf");
	assert.equal(terminalSafe("key sk-abcdefghijklmnopqrstuvwx"), "key sk-<redacted>");
	const s = setup();
	await piStore(s.path);
	insertEntries(s.path, [
		userEntry("clear \u001b[2J\u001b[H screen"),
		{ kind: "custom.note", data: { note: "\u0007bell" } },
	]);
	const { text } = await inspectConversation(s.path, s.scratch);
	assert.ok(!text.includes("\u001b") && !text.includes("\u0007"), "no raw escape reaches the terminal");
	assert.match(text, /\[user\] clear \\u001b\[2J\\u001b\[H screen/);
	assert.match(text, /--- entry 11 \(Pi conversation 1\): custom\.note\n\[data\] \{"note":"\\u0007bell"\}/);
});

test("the transcript is bounded; a symlink or a missing file is refused; leftover copies are removed", async () => {
	const s = setup();
	await piStore(s.path);
	insertEntries(
		s.path,
		Array.from({ length: 20 }, (_, i) => userEntry(`entry ${i} ${"x".repeat(500)}`)),
	);
	const cut = await inspectConversation(s.path, s.scratch, 2_000);
	assert.ok(cut.shown < 20 && cut.shown > 0, String(cut.shown));
	assert.match(cut.text, /\[truncated: entries from \d+ on \(\d+ of 20\) are not shown\]$/);
	const link = join(s.conversations, "link.sqlite");
	symlinkSync(s.path, link);
	await assert.rejects(inspectConversation(link, s.scratch), /the conversation's file is not a regular file/);
	await assert.rejects(inspectConversation(join(s.conversations, "none.sqlite"), s.scratch), /does not exist/);
	mkdirSync(join(s.scratch, "inspect-left"));
	mkdirSync(join(s.scratch, "other"));
	await removeScratchCopies(s.scratch);
	assert.deepEqual(readdirSync(s.scratch), ["other"]);
});
