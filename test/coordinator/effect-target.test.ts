/**
 * The target of a file change seen from the Coordinator (src/coordinator/effect-target.ts; Agent Execution § Uncertain
 * Effects: "Intent (target, pre-hash, intended hash) is persisted before execution ... The target is inspected"):
 * states by content, absent, never following a symbolic link (final or parent), confined to the worktree (a path the
 * tool policy refuses is refused, a link to a file outside is hashed as a link, not as the file it points to); the
 * intended hash of a write and of an edit equals what the real confined file operation (deploy/docker/fsop.mjs, the
 * file the agent container runs) leaves on disk, and an edit fsop refuses intends no change; classification order;
 * an answer the file operation itself did not give (deadline, cancel, unreadable output) is marked uncertain.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	ABSENT,
	classifyTarget,
	contentHash,
	editedContent,
	inspectTarget,
	planFileChange,
	TargetUnreadable,
	targetState,
} from "../../src/coordinator/effect-target.ts";
import type { FsRequest } from "../../src/coordinator/ports.ts";
import { runFsop } from "../../src/coordinator/sandbox/limits-text.ts";

const FSOP = fileURLToPath(new URL("../../deploy/docker/fsop.mjs", import.meta.url));
const roots: string[] = [];

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace(): { worktree: string; outside: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pd-target-")));
	roots.push(root);
	const worktree = join(root, "worktree");
	const outside = join(root, "outside");
	mkdirSync(join(worktree, "src"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
	return { worktree, outside };
}

const sha = (text: string | Buffer): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** Run the real fsop.mjs (as the local sandbox does) on `worktree`. */
async function fsop(worktree: string, request: FsRequest) {
	return runFsop(process.execPath, [FSOP, worktree], request, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
}

test("a regular file is hashed by content; a missing one (or a missing parent) is absent", async () => {
	const { worktree } = workspace();
	writeFileSync(join(worktree, "src", "a.js"), "one\n");
	assert.equal(await targetState(worktree, "src/a.js"), sha("one\n"));
	assert.equal(await targetState(worktree, "./src//a.js"), sha("one\n"), "the same canonical target");
	assert.equal(await targetState(worktree, "src/missing.js"), ABSENT);
	assert.equal(await targetState(worktree, "nested/deeper/new.js"), ABSENT);
	mkdirSync(join(worktree, "dir"));
	assert.equal(await targetState(worktree, "dir"), "directory");
	writeFileSync(join(worktree, "plain"), "x");
	assert.equal(await targetState(worktree, "plain/under"), "blocked:not-a-directory");
	const inspected = await inspectTarget(worktree, "src/a.js", 1024);
	assert.equal(inspected.bytes?.toString("utf8"), "one\n", "the content when asked for, within the bound");
	assert.equal((await inspectTarget(worktree, "src/a.js", 2)).bytes, undefined, "over the bound: no content");
});

test("symbolic links are never followed: a link (to a file outside, or inside) is hashed as a link, a linked parent blocks", async () => {
	const { worktree, outside } = workspace();
	symlinkSync(join(outside, "secret.txt"), join(worktree, "escape.txt"));
	symlinkSync(outside, join(worktree, "out"));
	writeFileSync(join(worktree, "real.txt"), "real\n");
	symlinkSync("real.txt", join(worktree, "alias.txt"));
	const link = await targetState(worktree, "escape.txt");
	assert.match(link, /^symlink:[0-9a-f]{64}$/);
	assert.notEqual(link, sha("TOP SECRET\n"), "the outside file's content is never read");
	assert.equal(link, `symlink:${createHash("sha256").update(join(outside, "secret.txt")).digest("hex")}`);
	assert.notEqual(await targetState(worktree, "alias.txt"), sha("real\n"));
	assert.equal(await targetState(worktree, "out/secret.txt"), "blocked:symlink", "a linked parent is not walked");
	const inspected = await inspectTarget(worktree, "escape.txt", 1024);
	assert.equal(inspected.bytes, undefined, "no content through a link");
});

test("confined to the worktree: escapes, absolute paths and git data are refused; a missing worktree cannot be told", async () => {
	const { worktree, outside } = workspace();
	for (const path of [
		"../outside/secret.txt",
		"src/../../outside/secret.txt",
		"/etc/passwd",
		".git/config",
		"a/.GIT/x",
	]) {
		await assert.rejects(targetState(worktree, path), TargetUnreadable, path);
		await assert.rejects(planFileChange(worktree, { op: "write", path, content: "x" }), TargetUnreadable, path);
	}
	assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "TOP SECRET\n");
	await assert.rejects(targetState(join(worktree, "gone"), "a.txt"), /the worktree is missing/);
});

test("a write's intended hash is exactly what the confined file operation writes", async () => {
	const { worktree } = workspace();
	const cases: Array<{ path: string; content: string }> = [
		{ path: "new/dir/file.txt", content: "created\n" },
		{ path: "src/a.js", content: "ünïcødé ✓ \r\nline two" },
		{ path: "src/empty.txt", content: "" },
	];
	writeFileSync(join(worktree, "src", "a.js"), "before\n");
	for (const request of cases) {
		const plan = await planFileChange(worktree, { op: "write", ...request });
		const before = await targetState(worktree, request.path);
		assert.equal(plan.pre, before);
		assert.equal(plan.tool, "write");
		const response = await fsop(worktree, { op: "write", ...request });
		assert.equal(response.ok, true, JSON.stringify(response));
		assert.equal(await targetState(worktree, request.path), plan.intended, request.path);
		assert.equal(classifyTarget(plan.intended, plan.pre, plan.intended), "applied");
	}
	// A write fsop refuses (through a link, onto a directory) intends no change.
	symlinkSync("src/a.js", join(worktree, "link.js"));
	const refused = await planFileChange(worktree, { op: "write", path: "link.js", content: "x" });
	assert.equal(refused.intended, refused.pre);
	assert.equal((await fsop(worktree, { op: "write", path: "link.js", content: "x" })).ok, false);
	assert.equal(await targetState(worktree, "link.js"), refused.pre);
});

test("an edit's intended hash is exactly what the confined file operation leaves (BOM, CRLF, replaceAll); a refused edit intends no change", async () => {
	const { worktree } = workspace();
	const edits: Array<{ content: string | Buffer; edit: Omit<Extract<FsRequest, { op: "edit" }>, "op" | "path"> }> = [
		{ content: "const a = 1;\nconst b = 2;\n", edit: { oldText: "b = 2", newText: "b = 3" } },
		{ content: "x\r\ny\r\nx\r\n", edit: { oldText: "x", newText: "z", replaceAll: true } },
		{ content: Buffer.from("﻿hello world\n", "utf8"), edit: { oldText: "world", newText: "there" } },
		{ content: "keep\n", edit: { oldText: "keep", newText: "keep" } },
	];
	for (const [index, { content, edit }] of edits.entries()) {
		const path = `src/edit-${index}.txt`;
		writeFileSync(join(worktree, path), content);
		const plan = await planFileChange(worktree, { op: "edit", path, ...edit });
		assert.equal(plan.pre, sha(content));
		const response = await fsop(worktree, { op: "edit", path, ...edit });
		assert.equal(response.ok, true, JSON.stringify(response));
		assert.equal(await targetState(worktree, path), plan.intended, path);
	}
	const refusals: Array<{ content: string | Buffer; edit: { oldText: string; newText: string } }> = [
		{ content: "a a\n", edit: { oldText: "a", newText: "b" } },
		{ content: "nothing here\n", edit: { oldText: "missing", newText: "x" } },
		{ content: Buffer.from([0x61, 0x00, 0x62]), edit: { oldText: "a", newText: "c" } },
		{ content: Buffer.from([0xc3, 0x28]), edit: { oldText: "(", newText: ")" } },
	];
	for (const [index, { content, edit }] of refusals.entries()) {
		const path = `src/refused-${index}.txt`;
		writeFileSync(join(worktree, path), content);
		const plan = await planFileChange(worktree, { op: "edit", path, ...edit });
		assert.equal(plan.intended, plan.pre, `${path}: fsop refuses it, so no change is intended`);
		assert.equal((await fsop(worktree, { op: "edit", path, ...edit })).ok, false);
		assert.equal(await targetState(worktree, path), plan.pre);
	}
	const missing = await planFileChange(worktree, { op: "edit", path: "src/none.txt", oldText: "a", newText: "b" });
	assert.deepEqual([missing.pre, missing.intended], [ABSENT, ABSENT]);
	assert.equal(editedContent(Buffer.alloc(4 * 1024 * 1024 + 1, 0x61), { oldText: "a", newText: "b" }), undefined);
});

test("classification: as before → unchanged (also when nothing was to change), the intended result → applied, else unresolved", () => {
	const pre = contentHash(Buffer.from("before"));
	const intended = contentHash(Buffer.from("after"));
	assert.equal(classifyTarget(intended, pre, intended), "applied");
	assert.equal(classifyTarget(pre, pre, intended), "unchanged");
	assert.equal(classifyTarget(contentHash(Buffer.from("third")), pre, intended), "unresolved");
	assert.equal(classifyTarget(ABSENT, ABSENT, intended), "unchanged");
	assert.equal(classifyTarget(ABSENT, pre, intended), "unresolved", "a deleted file is neither");
	assert.equal(classifyTarget(pre, pre, pre), "unchanged");
});

test("an answer the file operation did not give is marked uncertain (its client killed, or no answer read); its own answers are not", async () => {
	const { worktree } = workspace();
	const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
	const request: FsRequest = { op: "write", path: "a.txt", content: "x" };
	const hung = await runFsop(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], request, { env, timeoutMs: 200 });
	assert.deepEqual(hung, { ok: false, code: "timeout", message: "file operation timed out", uncertain: true });
	const garbage = await runFsop(process.execPath, ["-e", "process.stdout.write('not json')"], request, { env });
	assert.deepEqual(garbage, { ok: false, code: "io", message: "file operation failed", uncertain: true });
	const cancel = new AbortController();
	const cancelled = runFsop(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], request, {
		env,
		signal: cancel.signal,
	});
	cancel.abort();
	const answer = await cancelled;
	assert.equal(answer.ok === false && answer.uncertain, true, "cancelled while running");
	// fsop.mjs answered (and ended): a definite refusal, not uncertain.
	const refused = await fsop(worktree, { op: "edit", path: "none.txt", oldText: "a", newText: "b" });
	assert.equal(refused.ok, false);
	assert.equal(refused.ok === false && refused.uncertain, undefined);
	assert.equal((await fsop(worktree, request)).ok, true);
});
