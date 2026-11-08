/**
 * deploy/docker/fsop.mjs through the local test sandbox (the same file the agent container runs): confined
 * read / write / edit beneath the worktree root, no symlink following, no git data, bounded input and output.
 * Hardlinks are out of scope: fsop never creates links, a hardlink cannot cross the container's mounts, and the only
 * code that can create one inside a worktree is the trusted, checked-in setup script.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentSandbox, FsErrorCode, FsResponse, Sandbox } from "../../src/coordinator/ports.ts";
import { createLocalSandbox } from "../../src/coordinator/sandbox/local.ts";

const FSOP = fileURLToPath(new URL("../../deploy/docker/fsop.mjs", import.meta.url));

let base = "";
let taskDir = "";
let worktree = "";
let outside = "";
let sandbox: Sandbox;
let agent: AgentSandbox;

function expectOk(response: FsResponse): string {
	assert.equal(response.ok, true, response.ok ? "" : `${response.code}: ${response.message}`);
	return response.ok ? response.output : "";
}

function expectError(response: FsResponse, code: FsErrorCode): void {
	assert.equal(response.ok, false, `expected ${code}, got ok`);
	if (!response.ok) assert.equal(response.code, code, response.message);
}

function assertOutsideUntouched(): void {
	assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "TOP SECRET\n");
	assert.deepEqual(readdirSync(outside).sort(), ["secret.txt", "sub"]);
	assert.deepEqual(readdirSync(join(outside, "sub")), ["inner.txt"]);
}

before(async () => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "pd-fsop-")));
	taskDir = join(base, "tasks");
	worktree = join(taskDir, "worktrees", "task-1");
	outside = join(base, "outside");
	mkdirSync(worktree, { recursive: true });
	mkdirSync(join(outside, "sub"), { recursive: true });
	writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
	writeFileSync(join(outside, "sub", "inner.txt"), "inner\n");
	writeFileSync(join(worktree, ".git"), "gitdir: /nowhere/worktrees/task-1\n");
	mkdirSync(join(worktree, "a", ".git"), { recursive: true });
	writeFileSync(join(worktree, "a", ".git", "x"), "nested git data\n");
	writeFileSync(join(worktree, "src.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(worktree, "dup.txt"), "x = 1;\nx = 1;\n");
	mkdirSync(join(worktree, "dir"));
	symlinkSync(join(outside, "secret.txt"), join(worktree, "secret-link.txt"));
	symlinkSync(outside, join(worktree, "outside-dir"));
	mkdirSync(join(worktree, "nested"));
	symlinkSync(outside, join(worktree, "nested", "hop"));
	symlinkSync(join(outside, "created-through-link.txt"), join(worktree, "dangling.txt"));
	symlinkSync("src.txt", join(worktree, "inner-link.txt"));
	sandbox = createLocalSandbox({ taskDir });
	agent = await sandbox.startAgent({ taskId: 1, generation: 1, worktree, lifetimeMs: 60_000 });
});

after(async () => {
	await sandbox?.killAll();
	if (base !== "") rmSync(base, { recursive: true, force: true });
});

describe("fsop happy paths", () => {
	test("read returns numbered lines; offset and limit select a window", async () => {
		assert.equal(expectOk(await agent.fileOp({ op: "read", path: "src.txt" })), "1\tone\n2\ttwo\n3\tthree");
		const window = await agent.fileOp({ op: "read", path: "./src.txt", offset: 2, limit: 1 });
		assert.equal(expectOk(window), "2\ttwo\n[truncated: continue with offset=3]");
		assert.equal(window.ok && window.truncated, true);
		assert.match(expectOk(await agent.fileOp({ op: "read", path: "src.txt", offset: 9 })), /beyond the end/);
		expectError(await agent.fileOp({ op: "read", path: "src.txt", offset: 0 }), "invalid");
	});

	test("read output is bounded (many lines, one huge line)", async () => {
		writeFileSync(join(worktree, "big.txt"), "0123456789abcdefghij\n".repeat(100_000));
		const many = await agent.fileOp({ op: "read", path: "big.txt" });
		const manyText = expectOk(many);
		assert.equal(many.ok && many.truncated, true);
		assert.ok(Buffer.byteLength(manyText) <= 64 * 1024 + 100, `read output ${Buffer.byteLength(manyText)} bytes`);
		assert.match(manyText, /\[truncated: continue with offset=\d+\]$/);
		writeFileSync(join(worktree, "minified.js"), "x".repeat(5 * 1024 * 1024));
		const huge = await agent.fileOp({ op: "read", path: "minified.js" });
		assert.ok(Buffer.byteLength(expectOk(huge)) <= 64 * 1024 + 100);
		assert.equal(huge.ok && huge.truncated, true);
	});

	test("write creates a file and its parent directories inside the worktree, and overwrites", async () => {
		assert.match(
			expectOk(await agent.fileOp({ op: "write", path: "new/deep/file.txt", content: "hello\n" })),
			/Created/,
		);
		assert.equal(readFileSync(join(worktree, "new", "deep", "file.txt"), "utf8"), "hello\n");
		assert.match(expectOk(await agent.fileOp({ op: "write", path: "new/deep/file.txt", content: "bye" })), /Wrote/);
		assert.equal(readFileSync(join(worktree, "new", "deep", "file.txt"), "utf8"), "bye");
		expectOk(await agent.fileOp({ op: "write", path: "max.bin", content: "y".repeat(1024 * 1024) }));
		assert.equal(statSync(join(worktree, "max.bin")).size, 1024 * 1024);
	});

	test("edit replaces a unique oldText; a repeated one needs replaceAll", async () => {
		writeFileSync(join(worktree, "edit.txt"), "alpha beta gamma\n");
		const edited = await agent.fileOp({ op: "edit", path: "edit.txt", oldText: "beta", newText: "BETA$&" });
		assert.match(expectOk(edited), /replaced 1 occurrence/);
		assert.equal(readFileSync(join(worktree, "edit.txt"), "utf8"), "alpha BETA$& gamma\n");
		expectError(
			await agent.fileOp({ op: "edit", path: "dup.txt", oldText: "x = 1;", newText: "x = 2;" }),
			"not_unique",
		);
		assert.equal(readFileSync(join(worktree, "dup.txt"), "utf8"), "x = 1;\nx = 1;\n");
		const all = await agent.fileOp({
			op: "edit",
			path: "dup.txt",
			oldText: "x = 1;",
			newText: "x = 2;",
			replaceAll: true,
		});
		assert.match(expectOk(all), /replaced 2 occurrences/);
		assert.equal(readFileSync(join(worktree, "dup.txt"), "utf8"), "x = 2;\nx = 2;\n");
		expectError(await agent.fileOp({ op: "edit", path: "edit.txt", oldText: "zeta", newText: "z" }), "not_found");
		expectError(await agent.fileOp({ op: "edit", path: "edit.txt", oldText: "", newText: "z" }), "invalid");
		expectError(await agent.fileOp({ op: "edit", path: "missing.txt", oldText: "a", newText: "b" }), "not_found");
	});
});

describe("fsop confinement", () => {
	test("absolute paths, '..' and NUL are refused", async () => {
		expectError(await agent.fileOp({ op: "read", path: "/etc/passwd" }), "denied");
		expectError(await agent.fileOp({ op: "read", path: join(outside, "secret.txt") }), "denied");
		expectError(await agent.fileOp({ op: "read", path: "../../../outside/secret.txt" }), "denied");
		expectError(await agent.fileOp({ op: "read", path: "dir/../src.txt" }), "denied");
		expectError(await agent.fileOp({ op: "write", path: "../escape.txt", content: "x" }), "denied");
		expectError(await agent.fileOp({ op: "read", path: "src.txt\0.png" }), "denied");
		expectError(await agent.fileOp({ op: "write", path: "a\0b", content: "x" }), "denied");
		assert.equal(existsSync(join(taskDir, "worktrees", "escape.txt")), false);
		assertOutsideUntouched();
	});

	test("git data is refused anywhere in the path, in any spelling", async () => {
		for (const path of [".git", ".git/config", "a/.git/x", ".GIT/config", "a/.Git/x", ".git./config", "x/.git"]) {
			expectError(await agent.fileOp({ op: "read", path }), "denied");
			expectError(await agent.fileOp({ op: "write", path, content: "[core]\n" }), "denied");
		}
		expectError(await agent.fileOp({ op: "edit", path: "a/.git/x", oldText: "nested", newText: "n" }), "denied");
		assert.equal(readFileSync(join(worktree, ".git"), "utf8"), "gitdir: /nowhere/worktrees/task-1\n");
		assert.equal(readFileSync(join(worktree, "a", ".git", "x"), "utf8"), "nested git data\n");
	});

	test("a symlink is never followed: final component, directory in the middle, even inside the worktree", async () => {
		expectError(await agent.fileOp({ op: "read", path: "secret-link.txt" }), "denied");
		expectError(await agent.fileOp({ op: "write", path: "secret-link.txt", content: "pwned" }), "denied");
		expectError(await agent.fileOp({ op: "edit", path: "secret-link.txt", oldText: "TOP", newText: "X" }), "denied");
		expectError(await agent.fileOp({ op: "read", path: "outside-dir/secret.txt" }), "denied");
		expectError(await agent.fileOp({ op: "read", path: "outside-dir/sub/inner.txt" }), "denied");
		expectError(await agent.fileOp({ op: "write", path: "outside-dir/new.txt", content: "x" }), "denied");
		expectError(await agent.fileOp({ op: "write", path: "outside-dir/sub/deeper/new.txt", content: "x" }), "denied");
		expectError(await agent.fileOp({ op: "read", path: "nested/hop/secret.txt" }), "denied");
		expectError(
			await agent.fileOp({ op: "edit", path: "nested/hop/sub/inner.txt", oldText: "i", newText: "j" }),
			"denied",
		);
		expectError(await agent.fileOp({ op: "read", path: "inner-link.txt" }), "denied");
		assertOutsideUntouched();
	});

	test("writing through a dangling symlink creates nothing", async () => {
		expectError(await agent.fileOp({ op: "write", path: "dangling.txt", content: "landed" }), "denied");
		assert.equal(existsSync(join(outside, "created-through-link.txt")), false);
		assertOutsideUntouched();
	});

	test("oversize writes, directories and non-regular files are refused", async () => {
		const tooBig = "z".repeat(1024 * 1024 + 1);
		expectError(await agent.fileOp({ op: "write", path: "too-big.txt", content: tooBig }), "too_large");
		assert.equal(existsSync(join(worktree, "too-big.txt")), false);
		expectError(await agent.fileOp({ op: "read", path: "dir" }), "invalid");
		expectError(await agent.fileOp({ op: "write", path: "dir", content: "x" }), "invalid");
		expectError(await agent.fileOp({ op: "write", path: "src.txt/child", content: "x" }), "invalid");
		execFileSync("mkfifo", [join(worktree, "pipe")]);
		expectError(await agent.fileOp({ op: "read", path: "pipe" }), "denied");
		expectError(await agent.fileOp({ op: "write", path: "pipe", content: "x" }), "denied");
		expectError(await agent.fileOp({ op: "read", path: "" }), "invalid");
		expectError(await agent.fileOp({ op: "read", path: "." }), "invalid");
	});

	test("fsop.mjs itself rejects malformed requests and a bad root", () => {
		const run = (input: string, root = worktree) =>
			JSON.parse(spawnSync(process.execPath, [FSOP, root], { input, encoding: "utf8" }).stdout) as FsResponse;
		expectError(run("not json"), "invalid");
		expectError(run(JSON.stringify({ op: "delete", path: "src.txt" })), "invalid");
		expectError(run(JSON.stringify({ op: "write", path: "x.txt", content: 42 })), "invalid");
		expectError(run(JSON.stringify({ op: "read", path: "src.txt" }), "relative/root"), "unavailable");
		expectError(run(JSON.stringify({ op: "read", path: "src.txt" }), join(base, "missing")), "unavailable");
		const response = run(JSON.stringify({ op: "read", path: "src.txt" }));
		assert.equal(expectOk(response), "1\tone\n2\ttwo\n3\tthree");
	});
});

describe("local sandbox bookkeeping", () => {
	test("empty-git mask file exists, empty, mode 0444", () => {
		const info = statSync(join(taskDir, "empty-git"));
		assert.equal(info.isFile(), true);
		assert.equal(info.size, 0);
		assert.equal(info.mode & 0o777, 0o444);
	});

	test("live / stop / killAll track agents; a stopped agent refuses file operations", async () => {
		assert.match(agent.name, /^pd-t1-g1-[0-9a-f]{8}$/);
		assert.deepEqual(await sandbox.live({ taskId: 1, generation: 1 }), [agent.name]);
		const second = await sandbox.startAgent({ taskId: 2, generation: 7, worktree, lifetimeMs: 60_000 });
		assert.deepEqual(await sandbox.live({ taskId: 2 }), [second.name]);
		await second.stop();
		assert.deepEqual(await sandbox.live({ taskId: 2 }), []);
		expectError(await second.fileOp({ op: "read", path: "src.txt" }), "unavailable");
		const third = await sandbox.startAgent({ taskId: 3, generation: 1, worktree, lifetimeMs: 60_000 });
		await sandbox.killAll({ taskId: 3 });
		assert.deepEqual(await sandbox.live({ taskId: 3 }), []);
		expectError(await third.fileOp({ op: "read", path: "src.txt" }), "unavailable");
		assert.deepEqual(await sandbox.live({ taskId: 1 }), [agent.name]);
	});

	test("an agent ends by itself after its lifetime", async () => {
		const short = await sandbox.startAgent({ taskId: 4, generation: 1, worktree, lifetimeMs: 50 });
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.deepEqual(await sandbox.live({ taskId: 4 }), []);
		expectError(await short.fileOp({ op: "read", path: "src.txt" }), "unavailable");
	});

	test("runCheck: ops, default test passes, unknown op, writable only for setup, timeout, scratch removed", async () => {
		let seenWritable: boolean | undefined;
		const checks = createLocalSandbox({
			taskDir,
			checks: {
				lint: async () => ({ exitCode: 2, output: "lint failed\n" }),
				slow: () => new Promise(() => {}),
				setup: async (_worktree, writable) => {
					seenWritable = writable;
					return { exitCode: 0, output: "set up" };
				},
			},
		});
		assert.deepEqual([...checks.checkOps()].sort(), ["lint", "slow", "test"]);
		assert.deepEqual(await checks.available(), { ok: true });
		const spec = { taskId: 9, generation: 1, worktree, writable: false, timeoutMs: 5_000 };
		const passed = await checks.runCheck({ ...spec, op: "test" });
		assert.equal(passed.outcome, "passed");
		assert.equal(passed.exitCode, 0);
		const failed = await checks.runCheck({ ...spec, op: "lint" });
		assert.equal(failed.outcome, "failed");
		assert.equal(failed.exitCode, 2);
		assert.equal((await checks.runCheck({ ...spec, op: "deploy" })).outcome, "unknown_operation");
		assert.equal((await checks.runCheck({ ...spec, op: "../x" })).outcome, "unknown_operation");
		assert.equal((await checks.runCheck({ ...spec, op: "lint", writable: true })).outcome, "error");
		assert.equal((await checks.runCheck({ ...spec, op: "setup", writable: true })).outcome, "passed");
		assert.equal(seenWritable, true);
		const timeout = await checks.runCheck({ ...spec, op: "slow", timeoutMs: 100 });
		assert.equal(timeout.outcome, "timeout");
		assert.match(timeout.output, /\[timeout:/);
		const controller = new AbortController();
		const pending = checks.runCheck({ ...spec, op: "slow", signal: controller.signal });
		controller.abort();
		assert.equal((await pending).outcome, "error");
		assert.deepEqual(readdirSync(join(taskDir, "scratch")), []);
		assert.deepEqual(await checks.live({ taskId: 9 }), []);
	});
});
