/**
 * The owner socket's protocol (Interfaces and Storage § Interfaces, Owner CLI: "A local socket for status, frozen-group
 * resolution, failed events and read-only inspection of quarantined conversations"; Architecture § Owner CLI: "Local
 * operator control"). One connection carries one request and one response, each a single line of JSON:
 *
 *   request   {"v":1,"token":"<hex>","command":"status"}
 *             {"v":1,"token":"<hex>","command":"unfreeze","group":-100123}
 *             {"v":1,"token":"<hex>","command":"resolve","intents":[7]}
 *             {"v":1,"token":"<hex>","command":"failed-events"}
 *             {"v":1,"token":"<hex>","command":"conversations","task":12}      (task optional)
 *             {"v":1,"token":"<hex>","command":"inspect","conversation":"<uuid>"}
 *             {"v":1,"token":"<hex>","command":"seal","group":-100123,"trial":"t1","tasks":[3,4]}  (trial, tasks optional)
 *   response  {"ok":true,"text":"..."}  or  {"ok":false,"error":"<code>","text":"..."}
 *
 * Who may connect (src/coordinator/owner/socket.ts): the socket lives in its own directory, mode 0700, owned by the
 * Coordinator's user, and is itself 0600; every request carries the token the Coordinator writes at each start to a
 * 0600 file in that directory. Node exposes no peer credentials (SO_PEERCRED / getpeereid) of a Unix socket, so a
 * client is accepted when it could open the directory and read the token: the Coordinator's own user (or root).
 */
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

/** `<PI_DATA_DIR>/owner`: the socket and the token, nothing else. */
export const OWNER_DIR = "owner";
export const OWNER_SOCKET = "owner.sock";
export const OWNER_TOKEN = "owner.token";
export const PROTOCOL_VERSION = 1;

/** A request line longer than this (without its newline) is refused and the connection closed. */
export const REQUEST_MAX_BYTES = 64 * 1024;
/** A response line longer than this is refused by the client (a transcript is cut well below it). */
export const RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
/** The whole request line must arrive within this time after connecting. */
export const REQUEST_READ_TIMEOUT_MS = 5_000;
/** At most this many connections at a time; more are refused by the server. */
export const MAX_CONNECTIONS = 8;

/** The longest socket path the platform accepts (sun_path minus its terminating NUL). */
export function maxSocketPathBytes(platform: NodeJS.Platform = process.platform): number {
	return platform === "linux" ? 107 : 103;
}

export type OwnerPaths = { readonly dir: string; readonly socket: string; readonly token: string };

export function ownerPaths(dataDir: string): OwnerPaths {
	const dir = join(dataDir, OWNER_DIR);
	return { dir, socket: join(dir, OWNER_SOCKET), token: join(dir, OWNER_TOKEN) };
}

export type OwnerRequest =
	| { readonly command: "status" }
	| { readonly command: "unfreeze"; readonly group: number }
	| { readonly command: "resolve"; readonly intents: readonly number[] }
	| { readonly command: "failed-events" }
	| { readonly command: "conversations"; readonly task?: number }
	| { readonly command: "inspect"; readonly conversation: string }
	| {
			readonly command: "seal";
			readonly group: number;
			/** The trial id; the Coordinator picks trial-<n> when absent. */
			readonly trial?: string;
			/** The trial's tasks; absent: every task of the group since the last evaluation. */
			readonly tasks?: readonly number[];
	  };

export type OwnerCommandName = OwnerRequest["command"];

/** One recovery check of an unfreeze, as the owner sees it. */
export type CheckReport = { readonly name: string; readonly ok: boolean; readonly detail: string };

export type OwnerResponse =
	| { readonly ok: true; readonly text: string; readonly checks?: readonly CheckReport[] }
	| {
			readonly ok: false;
			/** bad_request, too_large, timeout, unauthorized, busy, refused, failed, unavailable */
			readonly error: string;
			readonly text: string;
			readonly checks?: readonly CheckReport[];
	  };

export type ParsedRequest =
	| { readonly ok: true; readonly token: string; readonly request: OwnerRequest }
	| { readonly ok: false; readonly error: "bad_request"; readonly text: string };

/** A conversation id as the Coordinator creates them (randomUUID), or a test's short id. */
const CONVERSATION_ID = /^[A-Za-z0-9-]{1,64}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const MAX_INTENTS = 100;
/** A trial id (src/coordinator/evaluation.ts TRIAL_ID). */
const TRIAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TRIAL_TASKS = 100;

const bad = (text: string): ParsedRequest => ({ ok: false, error: "bad_request", text });

function isId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isChatId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value !== 0;
}

type Fields = Readonly<Record<string, unknown>>;

/** The command's own fields, validated; a string is the problem. */
function commandOf(fields: Fields): OwnerRequest | string {
	switch (fields.command) {
		case "status":
		case "failed-events":
			return { command: fields.command };
		case "unfreeze":
			return isChatId(fields.group) ? { command: "unfreeze", group: fields.group } : "unfreeze needs a group chat id";
		case "resolve":
			return intentsOf(fields.intents);
		case "conversations":
			if (fields.task === undefined) return { command: "conversations" };
			return isId(fields.task) ? { command: "conversations", task: fields.task } : "task must be a task number";
		case "inspect":
			return typeof fields.conversation === "string" && CONVERSATION_ID.test(fields.conversation)
				? { command: "inspect", conversation: fields.conversation }
				: "inspect needs a conversation id";
		case "seal":
			return sealOf(fields);
		default:
			return "unknown command";
	}
}

function sealOf(fields: Fields): OwnerRequest | string {
	if (!isChatId(fields.group)) return "seal needs a group chat id";
	const { trial, tasks } = fields;
	if (trial !== undefined && (typeof trial !== "string" || !TRIAL.test(trial)))
		return "a trial id is letters, digits, '.', '_' or '-' (at most 64, starting with a letter or digit)";
	const taskList = Array.isArray(tasks) && tasks.length > 0 && tasks.length <= MAX_TRIAL_TASKS && tasks.every(isId);
	if (tasks !== undefined && !taskList) return `tasks must be 1 to ${MAX_TRIAL_TASKS} task numbers`;
	return {
		command: "seal",
		group: fields.group,
		...(trial === undefined ? {} : { trial: trial as string }),
		...(tasks === undefined ? {} : { tasks: [...new Set(tasks as number[])] }),
	};
}

function intentsOf(value: unknown): OwnerRequest | string {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INTENTS || !value.every(isId))
		return `resolve needs 1 to ${MAX_INTENTS} file change numbers`;
	return { command: "resolve", intents: [...new Set(value as number[])] };
}

/** Parse and validate one request line (without its newline). Never throws. */
export function parseOwnerRequest(line: string): ParsedRequest {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return bad("the request is not JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("the request is not an object");
	const fields = value as Fields;
	if (fields.v !== PROTOCOL_VERSION)
		return bad(`unsupported protocol version (this Coordinator speaks ${PROTOCOL_VERSION})`);
	if (typeof fields.token !== "string") return bad("the request carries no token");
	const request = commandOf(fields);
	if (typeof request === "string") return bad(request);
	return { ok: true, token: fields.token, request };
}

/** Constant-time comparison of a request's token with the Coordinator's (both 64 hex digits). */
export function tokenMatches(given: string, expected: string): boolean {
	if (!TOKEN.test(given) || !TOKEN.test(expected)) return false;
	return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
}

/** A request as the client sends it (one line, newline included). */
export function encodeRequest(token: string, request: OwnerRequest): string {
	return `${JSON.stringify({ v: PROTOCOL_VERSION, token, ...request })}\n`;
}

/** Parse a response line; undefined if it is not one. */
export function parseOwnerResponse(line: string): OwnerResponse | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const fields = value as Fields;
	if (typeof fields.ok !== "boolean" || typeof fields.text !== "string") return undefined;
	if (!fields.ok && typeof fields.error !== "string") return undefined;
	return value as OwnerResponse;
}
