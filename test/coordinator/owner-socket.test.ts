/**
 * The owner socket (src/coordinator/owner/socket.ts, protocol.ts) and the CLI's client (src/cli/owner-client.ts):
 * owner only (its directory 0700, the socket and the token 0600, the token on every request: Node exposes no peer
 * credentials, so the token is the per-request check of "the Coordinator's own user"); a crashed process's socket is
 * replaced, anything else at the path refuses the start; removed on stop; one line-delimited JSON request and
 * response per connection, bounded in size and time; bad requests get their reason; the client refuses a directory
 * other users can reach, and says when nothing listens.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ownerRequest } from "../../src/cli/owner-client.ts";
import { ConfigError } from "../../src/config/shared.ts";
import {
	encodeRequest,
	type OwnerRequest,
	type OwnerResponse,
	ownerPaths,
	parseOwnerRequest,
	tokenMatches,
} from "../../src/coordinator/owner/protocol.ts";
import {
	type OwnerSocketOptions,
	privateDirProblem,
	socketProblem,
	startOwnerSocket,
} from "../../src/coordinator/owner/socket.ts";
import { createLogger, silentLogger } from "../../src/runtime/log.ts";
import { sleep, waitFor } from "../helpers/env.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A short data directory (a socket path has at most 103 bytes on macOS). */
function dataDir(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pdo-")));
	roots.push(root);
	const dir = join(root, "data");
	mkdirSync(dir, { mode: 0o700 });
	return dir;
}

type Seen = { readonly requests: OwnerRequest[] };

async function start(dir: string, options: Partial<OwnerSocketOptions> = {}) {
	const seen: Seen = { requests: [] };
	const owner = await startOwnerSocket({
		dataDir: dir,
		log: silentLogger,
		handle: async (request) => {
			seen.requests.push(request);
			return { ok: true, text: `answered ${request.command}` };
		},
		...options,
	});
	after(() => owner.close());
	return { owner, seen, paths: ownerPaths(dir) };
}

/** Send raw bytes on a fresh connection; resolve with everything the server sent before it closed. */
function raw(socketPath: string, data: string | undefined): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		const chunks: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNRESET" || error.code === "EPIPE") resolve(Buffer.concat(chunks).toString("utf8"));
			else reject(error);
		});
		socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
		if (data !== undefined) socket.once("connect", () => socket.write(data));
	});
}

function firstLine(text: string): OwnerResponse {
	return JSON.parse(text.split("\n")[0] ?? "") as OwnerResponse;
}

const mode = (path: string): number => lstatSync(path).mode & 0o777;

test("the owner socket is owner-only: its directory 0700, the socket and a fresh token 0600, owned by this user; both removed on stop", async () => {
	const dir = dataDir();
	// A looser directory left behind (e.g. created by hand) is tightened before anything is put in it.
	mkdirSync(join(dir, "owner"), { mode: 0o755 });
	chmodSync(join(dir, "owner"), 0o755);
	const { owner, paths } = await start(dir);
	const uid = process.getuid?.();
	assert.equal(mode(paths.dir), 0o700);
	assert.ok(lstatSync(paths.socket).isSocket());
	assert.equal(mode(paths.socket), 0o600);
	assert.equal(mode(paths.token), 0o600);
	for (const path of [paths.dir, paths.socket, paths.token]) assert.equal(lstatSync(path).uid, uid, path);
	assert.equal(privateDirProblem(lstatSync(paths.dir), uid), undefined);
	assert.equal(socketProblem(lstatSync(paths.socket), uid), undefined);
	const token = readFileSync(paths.token, "utf8");
	assert.match(token, /^[0-9a-f]{64}$/);
	await owner.close();
	assert.throws(() => lstatSync(paths.socket), /ENOENT/);
	assert.throws(() => lstatSync(paths.token), /ENOENT/);
	// The next start writes another token.
	const again = await start(dir);
	assert.notEqual(readFileSync(again.paths.token, "utf8"), token);
});

test("the peer check: the token on every request; without it, or with another one, the handler is never called", async () => {
	const dir = dataDir();
	const { paths, seen } = await start(dir);
	const other = "0".repeat(64);
	const refused = firstLine(await raw(paths.socket, encodeRequest(other, { command: "status" })));
	assert.deepEqual([refused.ok, refused.ok ? "" : refused.error], [false, "unauthorized"]);
	const missing = firstLine(await raw(paths.socket, `${JSON.stringify({ v: 1, command: "status" })}\n`));
	assert.deepEqual([missing.ok, missing.ok ? "" : missing.error], [false, "bad_request"]);
	assert.deepEqual(seen.requests, [], "nothing reached the handler");
	const token = readFileSync(paths.token, "utf8");
	const ok = firstLine(await raw(paths.socket, encodeRequest(token, { command: "status" })));
	assert.deepEqual(ok, { ok: true, text: "answered status" });
	assert.equal(tokenMatches(token, token), true);
	assert.equal(tokenMatches(other, token), false);
	assert.equal(tokenMatches(token.slice(1), token), false, "a different length never matches");
});

test("the peer check functions: another user's directory, a reachable one, a symlink, a socket not 0600", () => {
	const dir = dataDir();
	const uid = process.getuid?.() ?? 0;
	const owner = join(dir, "owner");
	mkdirSync(owner, { mode: 0o700 });
	assert.equal(privateDirProblem(lstatSync(owner), uid), undefined);
	assert.match(privateDirProblem(lstatSync(owner), uid + 1) ?? "", /^belongs to uid \d+, not to this user/);
	chmodSync(owner, 0o750);
	assert.match(privateDirProblem(lstatSync(owner), uid) ?? "", /can be reached by other users \(mode 750\)/);
	symlinkSync(owner, join(dir, "link"));
	assert.equal(privateDirProblem(lstatSync(join(dir, "link")), uid), "is not a directory");
	writeFileSync(join(dir, "file"), "");
	assert.equal(socketProblem(lstatSync(join(dir, "file")), uid), "is not a socket");
});

test("the CLI's client refuses a socket directory others can reach: no token is read or sent", async () => {
	const dir = dataDir();
	const { paths, seen } = await start(dir);
	chmodSync(paths.dir, 0o755);
	const result = await ownerRequest(dir, { command: "status" }, 5_000);
	assert.equal(result.kind, "denied");
	assert.match(
		result.kind === "denied" ? result.detail : "",
		/can be reached by other users \(mode 755\).*Coordinator's user/,
	);
	assert.deepEqual(seen.requests, []);
	chmodSync(paths.dir, 0o700);
	const answered = await ownerRequest(dir, { command: "failed-events" }, 5_000);
	assert.deepEqual(answered, { kind: "response", response: { ok: true, text: "answered failed-events" } });
});

test("the client without a Coordinator: no socket directory, or a socket nothing listens on, is 'not running'", async () => {
	const dir = dataDir();
	const none = await ownerRequest(dir, { command: "status" }, 5_000);
	assert.deepEqual(none.kind, "not_running");
	const { owner } = await start(dir);
	const paths = ownerPaths(dir);
	const token = readFileSync(paths.token, "utf8");
	await owner.close();
	// What a crash leaves: the directory and the token, a socket file without a listener.
	writeFileSync(paths.token, token, { mode: 0o600 });
	await staleSocket(paths.socket);
	const stale = await ownerRequest(dir, { command: "status" }, 5_000);
	assert.equal(stale.kind, "not_running");
});

/** A socket file whose process died without closing it (kill -9). */
async function staleSocket(path: string): Promise<void> {
	const script = `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.stdout.write("up"));`;
	const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
	child.kill("SIGKILL");
	await new Promise((resolve) => child.once("exit", resolve));
	assert.ok(lstatSync(path).isSocket(), "the socket file stays behind");
}

test("a crashed Coordinator's socket file is replaced; a live listener or a file that is not a socket refuses the start", async () => {
	const dir = dataDir();
	const paths = ownerPaths(dir);
	mkdirSync(paths.dir, { mode: 0o700 });
	await staleSocket(paths.socket);
	const { owner } = await start(dir);
	const answered = await ownerRequest(dir, { command: "status" }, 5_000);
	assert.equal(answered.kind, "response");
	await owner.close();

	const listener = createServer();
	await new Promise<void>((resolve) => listener.listen(paths.socket, resolve));
	await assert.rejects(start(dir), /another process is listening on the owner socket/);
	await new Promise((resolve) => listener.close(resolve));

	writeFileSync(paths.socket, "not a socket");
	await assert.rejects(start(dir), /exists and is not a socket; remove it by hand/);
	assert.equal(readFileSync(paths.socket, "utf8"), "not a socket", "never removed");
	rmSync(paths.socket);

	// A symlink where the directory should be is not followed (or chmod-ed).
	rmSync(paths.dir, { recursive: true });
	const elsewhere = join(dir, "elsewhere");
	mkdirSync(elsewhere, { mode: 0o755 });
	symlinkSync(elsewhere, paths.dir);
	await assert.rejects(start(dir), /the owner socket directory .* is not a directory/);
	assert.equal(statSync(elsewhere).mode & 0o777, 0o755);
});

test("bad requests get their reason: not JSON, not an object, another version, an unknown command, bad arguments", async () => {
	const dir = dataDir();
	const { paths, seen } = await start(dir);
	const token = readFileSync(paths.token, "utf8");
	const ask = async (line: string) => firstLine(await raw(paths.socket, `${line}\n`));
	const cases: [string, RegExp][] = [
		["not json", /not JSON/],
		["[1,2]", /not an object/],
		[JSON.stringify({ v: 2, token, command: "status" }), /unsupported protocol version/],
		[JSON.stringify({ v: 1, token, command: "freeze" }), /unknown command/],
		[JSON.stringify({ v: 1, token, command: "unfreeze" }), /unfreeze needs a group chat id/],
		[JSON.stringify({ v: 1, token, command: "unfreeze", group: "x" }), /unfreeze needs a group chat id/],
		[JSON.stringify({ v: 1, token, command: "resolve", intents: [] }), /resolve needs 1 to 100/],
		[JSON.stringify({ v: 1, token, command: "resolve", intents: [1, -2] }), /resolve needs 1 to 100/],
		[JSON.stringify({ v: 1, token, command: "conversations", task: 0 }), /task must be a task number/],
		[JSON.stringify({ v: 1, token, command: "inspect", conversation: "../../etc/passwd" }), /needs a conversation id/],
	];
	for (const [line, reason] of cases) {
		const response = await ask(line);
		assert.equal(response.ok, false, line);
		assert.equal(response.ok ? "" : response.error, "bad_request", line);
		assert.match(response.text, reason, line);
	}
	assert.deepEqual(seen.requests, []);
	assert.deepEqual(parseOwnerRequest(JSON.stringify({ v: 1, token, command: "resolve", intents: [3, 3, 4] })), {
		ok: true,
		token,
		request: { command: "resolve", intents: [3, 4] },
	});
	assert.deepEqual(parseOwnerRequest(JSON.stringify({ v: 1, token, command: "unfreeze", group: -1001 })), {
		ok: true,
		token,
		request: { command: "unfreeze", group: -1001 },
	});
});

test("limits: a request over the size limit is refused and the connection closed; an incomplete one times out; one request per connection", async () => {
	const dir = dataDir();
	const lines: string[] = [];
	const log = createLogger({ level: "debug", sink: (_level, line) => lines.push(line) });
	const { paths, seen } = await start(dir, { limits: { requestBytes: 1024, readTimeoutMs: 300 }, log });
	const token = readFileSync(paths.token, "utf8");
	const big = firstLine(await raw(paths.socket, "x".repeat(4096)));
	assert.deepEqual([big.ok, big.ok ? "" : big.error], [false, "too_large"]);
	assert.match(big.text, /at most 1024 bytes/);
	const started = Date.now();
	const slow = firstLine(await raw(paths.socket, `{"v":1,"token":"${token}"`));
	assert.deepEqual([slow.ok, slow.ok ? "" : slow.error], [false, "timeout"]);
	assert.ok(Date.now() - started >= 250, "it waited for the request first");
	const silent = firstLine(await raw(paths.socket, undefined));
	assert.equal(silent.ok ? "" : silent.error, "timeout");
	// Two requests on one connection: only the first is answered.
	const two = encodeRequest(token, { command: "status" }) + encodeRequest(token, { command: "failed-events" });
	const answer = await raw(paths.socket, two);
	assert.deepEqual(
		answer
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as OwnerResponse).text),
		["answered status"],
	);
	assert.deepEqual(seen.requests, [{ command: "status" }]);
	// Logs: the command and its outcome, never the token.
	await waitFor(() => lines.some((line) => line.includes("owner_request command=status")), { what: "the log line" });
	assert.ok(!lines.join("\n").includes(token), "the token is never logged");
});

/**
 * A client that sends `head` at once, then one space every `everyMs` (JSON allows trailing blanks) for `forMs`, then
 * the newline: resolves with the first line the server sent (or "") and how long after connecting it came.
 */
function trickle(
	socketPath: string,
	head: string,
	everyMs: number,
	forMs: number,
): Promise<{ text: string; afterMs: number }> {
	return new Promise((resolve) => {
		const started = Date.now();
		const socket = createConnection(socketPath);
		const chunks: Buffer[] = [];
		let timer: NodeJS.Timeout | undefined;
		let done = false;
		const finish = (): void => {
			if (done) return;
			done = true;
			clearInterval(timer);
			socket.destroy();
			resolve({ text: Buffer.concat(chunks).toString("utf8"), afterMs: Date.now() - started });
		};
		socket.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			if (chunk.includes(0x0a)) finish();
		});
		socket.on("error", finish);
		socket.on("close", finish);
		socket.once("connect", () => {
			socket.write(head);
			timer = setInterval(() => {
				if (Date.now() - started < forMs) socket.write(" ");
				else {
					clearInterval(timer);
					socket.write("\n");
				}
			}, everyMs);
		});
	});
}

test("the read timeout is absolute: a client that trickles bytes is refused at the limit; nothing of it reaches a command", async () => {
	const dir = dataDir();
	const { paths, seen } = await start(dir, { limits: { readTimeoutMs: 300 } });
	const token = readFileSync(paths.token, "utf8");
	// A complete request but its newline, then a blank every 50 ms (well inside 300 ms) for 1.5 s, then the newline.
	const head = encodeRequest(token, { command: "status" }).trimEnd();
	const answer = await trickle(paths.socket, head, 50, 1_500);
	const response = firstLine(answer.text);
	assert.deepEqual([response.ok, response.ok ? "" : response.error], [false, "timeout"]);
	assert.ok(answer.afterMs < 1_200, `refused at the limit, not after the trickle (${answer.afterMs} ms)`);
	await sleep(1_700);
	assert.deepEqual(seen.requests, [], "the request was never handled");
});

test("at most the configured number of connections; a request beyond it is not answered", async () => {
	const dir = dataDir();
	const { paths } = await start(dir, { limits: { maxConnections: 1, readTimeoutMs: 2_000 } });
	const held = createConnection(paths.socket);
	await new Promise<void>((resolve) => held.once("connect", () => resolve()));
	after(() => held.destroy());
	await waitFor(async () => (await ownerRequest(dir, { command: "status" }, 2_000)).kind === "failed", {
		what: "the refused connection",
	});
	held.destroy();
	await waitFor(async () => (await ownerRequest(dir, { command: "status" }, 2_000)).kind === "response", {
		what: "a free connection again",
	});
});

test("a data directory too long for a socket path refuses the start with a configuration error (exit 2)", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pdo-")));
	roots.push(root);
	const dir = join(root, "d".repeat(120));
	mkdirSync(dir, { recursive: true });
	await assert.rejects(
		startOwnerSocket({ dataDir: dir, log: silentLogger, handle: async () => ({ ok: true, text: "" }) }),
		(error: Error) => {
			assert.ok(error instanceof ConfigError);
			assert.match(
				error.message,
				/^PI_DATA_DIR: is too long for the owner socket \(at most \d+ bytes on this system\)/,
			);
			return true;
		},
	);
});
