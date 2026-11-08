/**
 * The owner socket (Deployment § Processes: the coordinator unit runs the "Telegram poller, relay, outbox and owner
 * socket"; Interfaces and Storage § Interfaces, Owner CLI: "A local socket"). A Unix domain socket in the data
 * directory, owner only:
 *
 *   <PI_DATA_DIR>/owner/              mode 0700, the Coordinator's user; anything else (another owner, a symlink, not a
 *                                     directory) refuses the start. A looser mode is tightened first.
 *   <PI_DATA_DIR>/owner/owner.sock    the socket, mode 0600 (set right after bind, then verified; the 0700 directory
 *                                     covers the moment in between). Removed on stop.
 *   <PI_DATA_DIR>/owner/owner.token   32 random bytes (hex), new at every start, mode 0600, created exclusively and
 *                                     never through a symlink. Every request must carry it. Removed on stop.
 *
 * What is enforced: a client must be able to search the 0700 directory and connect to the 0600 socket (only the
 * Coordinator's user and root can), and must present the token it read from the 0600 file (the same users). Node
 * exposes no peer credentials (SO_PEERCRED, getpeereid) of a Unix socket, so the peer's uid itself is not read; the
 * token is the check every request passes (tokenMatches, constant time). On the VM the owner runs the CLI as the
 * Coordinator's user (`sudo -u pi-coordinator`).
 *
 * A socket file left by a Coordinator that crashed is replaced: the data directory's lock (runtime/lock.ts) is held
 * already, so nothing of this deployment can be listening; the file is removed only if it is a socket and nothing
 * answers on it. Limits: one request per connection, one line of at most REQUEST_MAX_BYTES that must arrive within
 * REQUEST_READ_TIMEOUT_MS, at most MAX_CONNECTIONS connections. Logs: the command, its outcome and its duration,
 * never the token or any text.
 */
import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rm, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { ConfigError } from "../../config/shared.ts";
import { errorSummary, type Logger } from "../../runtime/log.ts";
import {
	MAX_CONNECTIONS,
	maxSocketPathBytes,
	type OwnerPaths,
	type OwnerRequest,
	type OwnerResponse,
	ownerPaths,
	parseOwnerRequest,
	REQUEST_MAX_BYTES,
	REQUEST_READ_TIMEOUT_MS,
	tokenMatches,
} from "./protocol.ts";

export type OwnerHandler = (request: OwnerRequest) => Promise<OwnerResponse>;

export type OwnerSocketLimits = {
	readonly requestBytes: number;
	readonly readTimeoutMs: number;
	readonly maxConnections: number;
};

export type OwnerSocketOptions = {
	readonly dataDir: string;
	readonly handle: OwnerHandler;
	readonly log: Logger;
	/** Tests only: smaller limits (production: protocol.ts). */
	readonly limits?: Partial<OwnerSocketLimits>;
};

export type OwnerSocket = {
	readonly paths: OwnerPaths;
	/** Stop accepting, drop open connections, remove the socket and the token. */
	close(): Promise<void>;
};

/** Why `stats` (lstat of the owner directory) is not private to `uid`, or undefined. Also used by the CLI. */
export function privateDirProblem(stats: Stats, uid: number | undefined): string | undefined {
	if (stats.isSymbolicLink() || !stats.isDirectory()) return "is not a directory";
	if (uid !== undefined && stats.uid !== uid) return `belongs to uid ${stats.uid}, not to this user (uid ${uid})`;
	if ((stats.mode & 0o077) !== 0) return `can be reached by other users (mode ${(stats.mode & 0o777).toString(8)})`;
	return undefined;
}

/** Why `stats` (lstat of the socket after bind) is not the owner-only socket, or undefined. */
export function socketProblem(stats: Stats, uid: number | undefined): string | undefined {
	if (!stats.isSocket()) return "is not a socket";
	if (uid !== undefined && stats.uid !== uid) return `belongs to uid ${stats.uid}`;
	if ((stats.mode & 0o777) !== 0o600) return `has mode ${(stats.mode & 0o777).toString(8)}, not 600`;
	return undefined;
}

const ownUid = (): number | undefined => process.getuid?.();

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** The socket's directory: created 0700, or an existing one of ours tightened to 0700; anything else refuses. */
async function preparePrivateDir(dir: string): Promise<void> {
	await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	let stats = await lstat(dir);
	const unsafe = privateDirProblem(stats, ownUid());
	if (unsafe !== undefined && stats.isDirectory() && !stats.isSymbolicLink() && stats.uid === ownUid()) {
		await chmod(dir, 0o700);
		stats = await lstat(dir);
	}
	const problem = privateDirProblem(stats, ownUid());
	if (problem !== undefined) throw new Error(`the owner socket directory ${dir} ${problem}`);
}

/** True if something accepts connections on `path` (or cannot be told apart from it); false if nothing listens. */
function answers(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createConnection(path);
		const done = (alive: boolean): void => {
			probe.destroy();
			resolve(alive);
		};
		probe.once("connect", () => done(true));
		probe.once("error", (error: NodeJS.ErrnoException) =>
			done(error.code !== "ECONNREFUSED" && error.code !== "ENOENT"),
		);
		probe.setTimeout(1_000, () => done(true));
	});
}

/** A socket file a crashed Coordinator left behind is removed; anything else at the path refuses the start. */
async function clearStaleSocket(path: string): Promise<void> {
	const stats = await lstatOrUndefined(path);
	if (stats === undefined) return;
	if (!stats.isSocket()) throw new Error(`${path} exists and is not a socket; remove it by hand`);
	if (await answers(path)) throw new Error(`another process is listening on the owner socket ${path}`);
	await unlink(path);
}

/** A new token file, mode 0600, created exclusively (never through a symlink). */
async function writeToken(path: string, token: string): Promise<void> {
	await rm(path, { force: true });
	const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
	const handle = await open(path, flags, 0o600);
	try {
		await handle.writeFile(token, "utf8");
		await handle.chmod(0o600);
	} finally {
		await handle.close();
	}
}

function listen(server: Server, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const failed = (error: Error): void => reject(error);
		server.once("error", failed);
		server.listen(path, () => {
			server.off("error", failed);
			resolve();
		});
	});
}

type Connection = {
	readonly socket: Socket;
	readonly limits: OwnerSocketLimits;
	readonly token: string;
	readonly handle: OwnerHandler;
	readonly log: Logger;
};

/** Write the response line and close; the connection is dropped once it is flushed. */
function respond(socket: Socket, response: OwnerResponse): void {
	if (socket.destroyed) return;
	socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
}

async function answer(line: string, connection: Connection): Promise<OwnerResponse> {
	const parsed = parseOwnerRequest(line);
	if (!parsed.ok) return parsed;
	if (!tokenMatches(parsed.token, connection.token)) {
		connection.log.warn("owner_request_refused", { reason: "token" });
		return { ok: false, error: "unauthorized", text: "This socket answers only the owner CLI of this Coordinator." };
	}
	const started = Date.now();
	let response: OwnerResponse;
	try {
		response = await connection.handle(parsed.request);
	} catch (error) {
		connection.log.error("owner_request_failed", { command: parsed.request.command, error: errorSummary(error) });
		response = { ok: false, error: "failed", text: `owner ${parsed.request.command} failed: ${errorSummary(error)}` };
	}
	connection.log.info("owner_request", {
		command: parsed.request.command,
		ok: response.ok,
		error: response.ok ? undefined : response.error,
		ms: Date.now() - started,
	});
	return response;
}

/**
 * The first line of `socket`, handed to `onLine` once, if it arrives complete within readTimeoutMs of the connection
 * (an absolute bound: a client that trickles bytes gets no longer) and within requestBytes; otherwise the refusal is
 * answered and nothing of the connection reaches `onLine`, whatever arrives after it.
 */
function readFirstLine(socket: Socket, limits: OwnerSocketLimits, onLine: (line: string) => void): void {
	const chunks: Buffer[] = [];
	let size = 0;
	let timer: NodeJS.Timeout | undefined;
	const onData = (chunk: Buffer): void => {
		const end = chunk.indexOf(0x0a);
		const part = end < 0 ? chunk : chunk.subarray(0, end);
		size += part.length;
		chunks.push(part);
		if (size > limits.requestBytes) {
			refuse({ ok: false, error: "too_large", text: `A request is at most ${limits.requestBytes} bytes.` });
			return;
		}
		if (end < 0) return;
		// One request per connection: anything after the first line is not read.
		stop();
		socket.pause();
		onLine(Buffer.concat(chunks).toString("utf8"));
	};
	const stop = (): void => {
		clearTimeout(timer);
		socket.off("data", onData);
	};
	// The rest is drained (no listener, still flowing) until the refusal is flushed and the connection dropped.
	const refuse = (response: OwnerResponse): void => {
		stop();
		respond(socket, response);
	};
	timer = setTimeout(
		() => refuse({ ok: false, error: "timeout", text: `No complete request within ${limits.readTimeoutMs} ms.` }),
		limits.readTimeoutMs,
	);
	socket.once("close", () => clearTimeout(timer));
	socket.on("data", onData);
}

/** One request line per connection, bounded in size and time; then its response, then the connection closes. */
function serve(connection: Connection): void {
	const { socket, limits } = connection;
	socket.on("error", () => {});
	readFirstLine(socket, limits, (line) => {
		void answer(line, connection).then((response) => respond(socket, response));
	});
}

/** Bind the owner socket (see the module comment). Throws if it cannot be made owner-only. */
export async function startOwnerSocket(options: OwnerSocketOptions): Promise<OwnerSocket> {
	const paths = ownerPaths(options.dataDir);
	const max = maxSocketPathBytes();
	if (Buffer.byteLength(paths.socket) > max) {
		const room = max - (Buffer.byteLength(paths.socket) - Buffer.byteLength(options.dataDir));
		throw new ConfigError([
			{ variable: "PI_DATA_DIR", message: `is too long for the owner socket (at most ${room} bytes on this system)` },
		]);
	}
	await preparePrivateDir(paths.dir);
	await clearStaleSocket(paths.socket);
	const token = randomBytes(32).toString("hex");
	await writeToken(paths.token, token);
	const limits: OwnerSocketLimits = {
		requestBytes: options.limits?.requestBytes ?? REQUEST_MAX_BYTES,
		readTimeoutMs: options.limits?.readTimeoutMs ?? REQUEST_READ_TIMEOUT_MS,
		maxConnections: options.limits?.maxConnections ?? MAX_CONNECTIONS,
	};
	const sockets = new Set<Socket>();
	const server = createServer({ allowHalfOpen: false }, (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		serve({ socket, limits, token, handle: options.handle, log: options.log });
	});
	server.maxConnections = limits.maxConnections;
	let bound = false;
	const close = async (): Promise<void> => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		// Only a socket this server bound is removed (libuv unlinks it on close already; this covers a failed close).
		if (bound) await rm(paths.socket, { force: true });
		await rm(paths.token, { force: true });
	};
	try {
		await listen(server, paths.socket);
		bound = true;
		await chmod(paths.socket, 0o600);
		const problem = socketProblem(await lstat(paths.socket), ownUid());
		if (problem !== undefined) throw new Error(`the owner socket ${paths.socket} ${problem}`);
	} catch (error) {
		await close().catch(() => undefined);
		throw error;
	}
	options.log.info("owner_socket_listening", { path: paths.socket });
	return { paths, close };
}
