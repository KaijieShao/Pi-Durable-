/**
 * The owner CLI's side of the owner socket (src/coordinator/owner/protocol.ts): checks that the socket's directory is
 * private to this user before it reads the token or connects (a socket someone else could have put there gets no
 * token), sends one request line and reads one response line, bounded in size and time.
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createConnection } from "node:net";
import {
	encodeRequest,
	type OwnerRequest,
	type OwnerResponse,
	ownerPaths,
	parseOwnerResponse,
	RESPONSE_MAX_BYTES,
} from "../coordinator/owner/protocol.ts";
import { privateDirProblem } from "../coordinator/owner/socket.ts";

export type ClientResult =
	| { readonly kind: "response"; readonly response: OwnerResponse }
	/** No Coordinator listens: no socket directory, no token, no socket, or nothing accepts on it. */
	| { readonly kind: "not_running"; readonly detail: string }
	/** This user may not use the socket (another user's, or not private). */
	| { readonly kind: "denied"; readonly detail: string }
	| { readonly kind: "failed"; readonly detail: string };

const RUN_AS = "run the owner CLI as the Coordinator's user (on the VM: sudo -u pi-coordinator …)";

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

async function readToken(path: string): Promise<string> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		return (await handle.readFile("utf8")).trim();
	} finally {
		await handle.close();
	}
}

/** The token, or why the socket cannot be used. */
async function prepare(dataDir: string): Promise<{ token: string } | ClientResult> {
	const paths = ownerPaths(dataDir);
	try {
		const problem = privateDirProblem(await lstat(paths.dir), process.getuid?.());
		if (problem !== undefined) return { kind: "denied", detail: `${paths.dir} ${problem}; ${RUN_AS}` };
		return { token: await readToken(paths.token) };
	} catch (error) {
		if (codeOf(error) === "ENOENT") return { kind: "not_running", detail: `no owner socket at ${paths.socket}` };
		if (codeOf(error) === "EACCES") return { kind: "denied", detail: `${paths.dir} cannot be opened; ${RUN_AS}` };
		return { kind: "failed", detail: `${paths.dir} cannot be read (${codeOf(error) ?? "error"})` };
	}
}

/** Connection errors that mean nothing is listening. */
const NOT_LISTENING = new Set(["ENOENT", "ECONNREFUSED"]);

/** What a connection error means for the owner. */
function connectionFailed(error: NodeJS.ErrnoException, socketPath: string): ClientResult {
	if (NOT_LISTENING.has(error.code ?? "")) return { kind: "not_running", detail: `nothing listens on ${socketPath}` };
	if (error.code === "EACCES") return { kind: "denied", detail: `${socketPath}: permission denied; ${RUN_AS}` };
	return { kind: "failed", detail: `the owner socket failed (${error.code ?? "error"})` };
}

type Collected = { readonly line: string } | { readonly tooLarge: true } | undefined;

/** Collects the bytes before the first newline: undefined until it arrives, then the line (or that it is too large). */
function lineCollector(limit: number): (chunk: Buffer) => Collected {
	const chunks: Buffer[] = [];
	let size = 0;
	return (chunk) => {
		const end = chunk.indexOf(0x0a);
		const part = end < 0 ? chunk : chunk.subarray(0, end);
		size += part.length;
		if (size > limit) return { tooLarge: true };
		chunks.push(part);
		return end < 0 ? undefined : { line: Buffer.concat(chunks).toString("utf8") };
	};
}

function answerOf(collected: Exclude<Collected, undefined>): ClientResult {
	if (!("line" in collected)) return { kind: "failed", detail: "the answer is too large" };
	const response = parseOwnerResponse(collected.line);
	return response === undefined
		? { kind: "failed", detail: "the answer is not readable" }
		: { kind: "response", response };
}

function exchange(socketPath: string, line: string, timeoutMs: number): Promise<ClientResult> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		const collect = lineCollector(RESPONSE_MAX_BYTES);
		let settled = false;
		const done = (result: ClientResult): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(timeoutMs, () =>
			done({ kind: "failed", detail: `the Coordinator did not answer within ${Math.round(timeoutMs / 1000)} s` }),
		);
		socket.once("connect", () => socket.write(line));
		socket.on("error", (error: NodeJS.ErrnoException) => done(connectionFailed(error, socketPath)));
		socket.on("data", (chunk: Buffer) => {
			const collected = collect(chunk);
			if (collected !== undefined) done(answerOf(collected));
		});
		socket.on("end", () => done({ kind: "failed", detail: "the Coordinator closed the connection without an answer" }));
	});
}

/** Send `request` to the Coordinator of `dataDir` and wait for its answer (at most `timeoutMs`). */
export async function ownerRequest(dataDir: string, request: OwnerRequest, timeoutMs: number): Promise<ClientResult> {
	const prepared = await prepare(dataDir);
	if (!("token" in prepared)) return prepared;
	return exchange(ownerPaths(dataDir).socket, encodeRequest(prepared.token, request), timeoutMs);
}
