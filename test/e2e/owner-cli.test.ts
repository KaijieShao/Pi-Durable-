/**
 * The owner CLI through the whole stack (Interfaces and Storage § Interfaces, Owner CLI: "A local socket for status,
 * frozen-group resolution, failed events and read-only inspection of quarantined conversations"; § Recovery After a
 * Restart: "Its conversation is quarantined and opened only read-only"; Deployment § Processes: the coordinator unit
 * runs the "owner socket"). The real Coordinator and the production CLI client (stack.owner):
 *
 *   - The socket of the running Coordinator is owner-only (directory 0700, socket and token 0600), answers status,
 *     failed-events and conversations, and is gone once the Coordinator stops: the CLI then says it is not running
 *     (exit 3) and shows the labelled read-only status; an unfreeze is refused. A socket file a crashed process left is
 *     replaced at the next start.
 *   - A run interrupted by a restart: its conversation (written by the real Pi runner) is quarantined; `owner
 *     conversations` lists it and `owner inspect` prints its transcript while every file of it stays unchanged (hash,
 *     size, mtime) and no -wal or -shm file appears.
 *   (Unfreeze over the socket: test/e2e/durability.test.ts, watchdog.test.ts, uncertain-edits.test.ts, isolation.test.ts.)
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { ownerPaths } from "../../src/coordinator/owner/protocol.ts";
import { GROUP, scriptedAgent, startStack, USER1 } from "./harness.ts";

const mode = (path: string): number => lstatSync(path).mode & 0o777;

/** A socket file whose process died without closing it (kill -9). */
async function staleSocket(path: string): Promise<void> {
	const script = `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.stdout.write("up"));`;
	const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
	child.kill("SIGKILL");
	await new Promise((resolve) => child.once("exit", resolve));
}

test("the running Coordinator's owner socket: owner-only, answers the CLI, gone on stop (the CLI says so); a stale socket is replaced", {
	timeout: 120_000,
}, async (t) => {
	const stack = await startStack();
	t.after(() => stack.stop());
	const paths = ownerPaths(stack.config.paths.dataDir);
	assert.deepEqual([mode(paths.dir), mode(paths.socket), mode(paths.token)], [0o700, 0o600, 0o600]);
	assert.ok(lstatSync(paths.socket).isSocket());
	const uid = process.getuid?.();
	for (const path of [paths.dir, paths.socket, paths.token]) assert.equal(lstatSync(path).uid, uid);

	const status = await stack.owner("status");
	assert.equal(status.code, 0, status.stderr);
	assert.match(
		status.stdout,
		new RegExp(
			`^Coordinator: live · acme/demo · group ${GROUP}, topic 1 · slots 0/2 · succeeded 0 / failed 0 / open 0\\nCompleted:`,
		),
	);
	assert.ok(status.stdout.includes(`Database: ${stack.config.paths.dataDir}/coordinator.sqlite`));
	assert.match(status.stdout, /\nWatchdog: last heartbeat \d+ s ago/);
	assert.match(status.stdout, /\nBoot disk \(PI_DATA_DIR\): /);
	assert.deepEqual(await stack.owner("failed-events"), { code: 0, stdout: "No failed events.\n", stderr: "" });
	assert.deepEqual(await stack.owner("conversations"), {
		code: 0,
		stdout: "No quarantined conversations.\n",
		stderr: "",
	});
	assert.deepEqual(await stack.owner("unfreeze"), {
		code: 0,
		stdout: `Group ${GROUP} is not frozen; nothing changed.\n`,
		stderr: "",
	});
	const other = await stack.owner("unfreeze", "-42");
	assert.equal(other.code, 1);
	assert.equal(other.stderr, `This Coordinator serves group ${GROUP} only, not -42.\n`);

	// Stopped: the socket and the token are gone; the CLI says the Coordinator is not running (exit 3).
	await stack.coordinator.stop();
	assert.throws(() => lstatSync(paths.socket), /ENOENT/);
	assert.throws(() => lstatSync(paths.token), /ENOENT/);
	const down = await stack.owner("status");
	assert.equal(down.code, 3);
	assert.equal(down.stderr, "");
	assert.match(down.stdout, /^Coordinator: not running \(read-only snapshot\) · acme\/demo/);
	assert.equal(down.stdout.split("\n").filter((line) => line.includes("not running")).length, 1);
	assert.ok(down.stdout.includes(`Database: ${stack.config.paths.dataDir}/coordinator.sqlite`));
	const unfreeze = await stack.owner("unfreeze");
	assert.equal(unfreeze.code, 3);
	assert.match(unfreeze.stderr, /An unfreeze needs the running Coordinator/);

	// A crash leaves a socket file nothing listens on: the next start replaces it.
	await staleSocket(paths.socket);
	assert.ok(lstatSync(paths.socket).isSocket());
	await stack.restart();
	assert.equal(mode(paths.socket), 0o600);
	const again = await stack.owner("status");
	assert.equal(again.code, 0, again.stderr);
});

const INSPECT_TASK = "INSPECT-ME: write inspect.txt";

/** A conversation's files (the database and any -wal / -shm): name → size, mtime and content hash. */
function conversationFiles(path: string): Record<string, string> {
	const dir = dirname(path);
	const base = path.slice(dir.length + 1);
	return Object.fromEntries(
		readdirSync(dir)
			.filter((name) => name.startsWith(base))
			.sort()
			.map((name) => {
				const full = `${dir}/${name}`;
				const stats = statSync(full);
				return [
					name,
					`${stats.size} ${stats.mtimeMs} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`,
				];
			}),
	);
}

test("a run interrupted by a restart: its conversation is quarantined; owner inspect prints its transcript and writes nothing", {
	timeout: 180_000,
}, async (t) => {
	const stack = await startStack({
		model: scriptedAgent([
			{
				when: /^INSPECT-ME/,
				steps: [
					{ toolCalls: [{ name: "write", args: { path: "inspect.txt", content: "inspected\n" } }] },
					{ hang: true },
				],
			},
		]),
	});
	t.after(() => stack.stop());
	stack.sendCommand(USER1, `/task alpha ${INSPECT_TASK}`);
	// The run wrote inspect.txt and waits on its second model call: the restart interrupts it.
	await stack.model.waitForRequests(2, 30_000);
	const since = stack.lastBotMessageId();
	await stack.restart();
	await stack.waitForBotMessage(/^Task 1 was interrupted by restart \(run 1\)/, { since });
	await stack.coordinator.idle();
	const [conversation] = stack.coordinator.store.all<{ id: string; path: string; quarantined: number }>(
		"SELECT id, path, quarantined FROM conversations ORDER BY created_at",
	);
	assert.equal(conversation?.quarantined, 1);
	const id = conversation?.id ?? "";

	const list = await stack.owner("conversations");
	assert.equal(list.code, 0, list.stderr);
	assert.match(
		list.stdout,
		/^Quarantined conversations: 1 \(never written again; owner inspect <id> opens one read-only\)\n/,
	);
	assert.ok(list.stdout.includes(`  ${id} Task 1: run 1 failed (interrupted by restart); created `), list.stdout);
	assert.equal(
		(await stack.owner("conversations", "1")).stdout,
		list.stdout.replace("conversations: 1", "conversations of Task 1: 1"),
	);
	assert.equal((await stack.owner("conversations", "2")).stdout, "No quarantined conversations of Task 2.\n");
	const status = await stack.owner("status");
	assert.match(
		status.stdout,
		/\nQuarantined conversations: 1 \(read-only: owner conversations, owner inspect <id>\)\n/,
	);

	const before = conversationFiles(conversation?.path ?? "");
	assert.ok(Object.keys(before).length > 0);
	const inspected = await stack.owner("inspect", id);
	assert.equal(inspected.code, 0, inspected.stderr);
	assert.deepEqual(
		conversationFiles(conversation?.path ?? ""),
		before,
		"nothing written or created: hash, size, mtime",
	);
	const text = inspected.stdout;
	assert.ok(
		text.startsWith(`Conversation ${id} of Task 1 (quarantined; read-only, nothing was written)\nFile: `),
		text,
	);
	assert.match(text, /\nEntries: \d+\n/);
	assert.ok(text.includes(`[user] ${INSPECT_TASK}`), "the task's input, raw, to the owner's terminal only");
	assert.match(text, /\[tool call write\] \{"path":"inspect\.txt","content":"inspected\\n"\}/);
	assert.match(text, /\[tool result write\] /);
	assert.equal(
		readdirSync(ownerPaths(stack.config.paths.dataDir).dir).sort().join(","),
		"owner.sock,owner.token",
		"no copy left",
	);
	const unknown = await stack.owner("inspect", "no-such-conversation");
	assert.equal(unknown.code, 1);
	assert.match(unknown.stderr, /^No conversation no-such-conversation in this group/);
});
