#!/usr/bin/env node
/**
 * Confined file operations for one task worktree (Agent Execution § Policy Hook, rule 2: "no following symlinks, and
 * they stay beneath the worktree root").
 *
 * Usage: node fsop.mjs <root>   with one JSON request on stdin; one JSON response line on stdout:
 *   {"op":"read","path":"src/a.js","offset":1,"limit":2000}
 *   {"op":"write","path":"src/a.js","content":"..."}
 *   {"op":"edit","path":"src/a.js","oldText":"...","newText":"...","replaceAll":false}
 * → {"ok":true,"output":"...","truncated":false} | {"ok":false,"code":"denied","message":"..."}
 *
 * Runs inside the agent container (root = /work) and, for tests only, on the host through the local sandbox.
 * Plain JavaScript, no dependencies, Node 18+. Rules:
 *   - the path is relative: absolute paths, NUL bytes and any ".." segment are refused;
 *   - any ".git" segment is refused (case-insensitive, ignoring the characters HFS+ ignores and trailing dots/spaces);
 *   - every component is checked with lstat: symbolic links are never followed (intermediate or final), the final
 *     component must be a regular file; the file is opened with O_NOFOLLOW and the opened descriptor is verified to
 *     be the checked path (/proc/self/fd where available, else a second lstat walk plus a device/inode match);
 *   - read returns numbered lines (offset 1-based, limit default 2000), at most 64 KiB of output;
 *   - write accepts at most 1 MiB and creates missing parent directories inside the root;
 *   - edit needs `oldText` to occur exactly once unless `replaceAll` is true.
 * Error messages name only the relative path, never a host path.
 * STUB(spec: agent-execution.md § Uncertain Effects): no persisted edit/write intent (target, pre-hash, intended
 * hash) and no reconciliation; an interrupted edit or write is reported as failed and the run fails with it.
 */
import { constants, promises as fsp } from "node:fs";
import { join } from "node:path";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_EDIT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_READ_OUTPUT_BYTES = 64 * 1024;
const MAX_READ_SCAN_BYTES = 64 * 1024 * 1024;
const DEFAULT_READ_LINES = 2000;
const MAX_PATH_CHARS = 4096;
const SELF_TIMEOUT_MS = 25_000;
const READ_CHUNK = 64 * 1024;
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const O_NOCTTY = constants.O_NOCTTY ?? 0;

class FsError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

const fail = (code, message) => new FsError(code, message);

/** HFS+ ignores these code points in file names; git refuses ".git" spelled with them (CVE-2014-9390). */
const IGNORABLE = new RegExp(
	`[${[
		[0x200c, 0x200f],
		[0x202a, 0x202e],
		[0x206a, 0x206f],
		[0xfeff, 0xfeff],
	]
		.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`)
		.join("")}]`,
	"g",
);

function isGitSegment(segment) {
	const folded = segment
		.normalize("NFKC")
		.replace(IGNORABLE, "")
		.toLowerCase()
		.replace(/[. ]+$/, "");
	return folded === ".git";
}

function checkPathString(path) {
	if (typeof path !== "string" || path.length === 0) throw fail("invalid", "path must be a non-empty string");
	if (path.length > MAX_PATH_CHARS) throw fail("invalid", "path is too long");
	if (path.includes("\0")) throw fail("denied", "path contains a NUL byte");
	if (path.startsWith("/")) throw fail("denied", "absolute paths are not allowed; use a path relative to the worktree");
}

function checkSegment(segment) {
	if (segment === "..") throw fail("denied", "path escapes the worktree ('..' is not allowed)");
	if (isGitSegment(segment)) throw fail("denied", "git data is not accessible");
	if (Buffer.byteLength(segment) > 255) throw fail("invalid", "a path component is too long");
}

/** Validate a request path and split it into segments; throws FsError. */
function parsePath(path) {
	checkPathString(path);
	const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
	if (segments.length === 0) throw fail("invalid", "path names the worktree root, not a file");
	for (const segment of segments) checkSegment(segment);
	return segments;
}

function display(segments) {
	return segments.join("/");
}

function mapError(error, segments) {
	if (error instanceof FsError) return error;
	const name = display(segments);
	switch (error?.code) {
		case "ENOENT":
			return fail("not_found", `${name}: no such file`);
		case "ELOOP":
			return fail("denied", `${name}: symbolic links are not followed`);
		case "ENOTDIR":
			return fail("invalid", `${name}: a parent component is not a directory`);
		case "EISDIR":
			return fail("invalid", `${name}: is a directory`);
		case "EACCES":
		case "EPERM":
		case "EROFS":
			return fail("denied", `${name}: permission denied`);
		case "ENOSPC":
		case "EDQUOT":
			return fail("io", `${name}: no space left on the task disk`);
		case "EFBIG":
			return fail("too_large", `${name}: file too large`);
		case "ENAMETOOLONG":
			return fail("invalid", `${name}: path is too long`);
		default:
			return fail("io", `${name}: file operation failed (${typeof error?.code === "string" ? error.code : "error"})`);
	}
}

async function lstatOrUndefined(path) {
	try {
		return await fsp.lstat(path);
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

/** One parent directory: must be a real directory (no symlink); created (mode 0755) if missing and `create`. */
async function checkDirectory(path, segments, create) {
	let stat = await lstatOrUndefined(path);
	if (stat === undefined && create) {
		await fsp.mkdir(path, { mode: 0o755 }).catch((error) => {
			if (error?.code !== "EEXIST") throw error;
		});
		stat = await fsp.lstat(path);
	}
	if (stat === undefined) throw fail("not_found", `${display(segments)}: no such file`);
	if (stat.isSymbolicLink()) throw fail("denied", `${display(segments)}: symbolic links are not followed`);
	if (!stat.isDirectory()) throw fail("invalid", `${display(segments)}: a parent component is not a directory`);
}

/**
 * Walk the parent directories of `segments` under `root` with lstat: each must be a real directory (no symlink).
 * With `create`, missing directories are created. Returns the target path and its lstat (or undefined).
 */
async function walk(root, segments, create) {
	let current = root;
	for (const segment of segments.slice(0, -1)) {
		current = join(current, segment);
		await checkDirectory(current, segments, create);
	}
	const target = join(current, segments[segments.length - 1]);
	const stat = await lstatOrUndefined(target);
	if (stat !== undefined) checkTargetStat(stat, segments);
	return { target, stat };
}

function checkTargetStat(stat, segments) {
	if (stat.isSymbolicLink()) throw fail("denied", `${display(segments)}: symbolic links are not followed`);
	if (stat.isDirectory()) throw fail("invalid", `${display(segments)}: is a directory`);
	if (!stat.isFile()) throw fail("denied", `${display(segments)}: not a regular file`);
}

async function procPath(handle) {
	try {
		return await fsp.readlink(`/proc/self/fd/${handle.fd}`);
	} catch {
		return undefined;
	}
}

/**
 * The opened descriptor must be the regular file at `target`, reached without any symlink: either procfs names
 * exactly `target`, or a second lstat walk (no symlink anywhere) ends at the same device and inode. The second form
 * covers hosts without procfs (macOS, local test sandbox) and Docker Desktop's file sharing, where procfs reports a
 * newly created file under the VM's share path instead of /work.
 */
async function verifyOpened(handle, root, segments, target) {
	const stat = await handle.stat();
	if (!stat.isFile()) throw fail("denied", `${display(segments)}: not a regular file`);
	if ((await procPath(handle)) === target) return stat;
	const again = await walk(root, segments, false);
	if (again.stat === undefined || again.stat.ino !== stat.ino || again.stat.dev !== stat.dev) {
		throw fail("denied", `${display(segments)}: path changed while it was opened`);
	}
	return stat;
}

async function openVerified(root, segments, target, flags, mode) {
	const handle = await fsp.open(target, flags | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY, mode);
	try {
		const stat = await verifyOpened(handle, root, segments, target);
		return { handle, stat };
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
}

function positiveInteger(value, name, fallback) {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw fail("invalid", `${name} must be a positive integer`);
	}
	return value;
}

/** Numbered lines `offset..offset+limit-1`, bounded to MAX_READ_OUTPUT_BYTES. */
async function readOp(root, request) {
	const segments = parsePath(request.path);
	const offset = positiveInteger(request.offset, "offset", 1);
	const limit = positiveInteger(request.limit, "limit", DEFAULT_READ_LINES);
	const { target, stat } = await walk(root, segments, false);
	if (stat === undefined) throw fail("not_found", `${display(segments)}: no such file`);
	const { handle } = await openVerified(root, segments, target, constants.O_RDONLY);
	try {
		return await readLines(handle, segments, offset, limit);
	} finally {
		await handle.close().catch(() => {});
	}
}

/**
 * Splits decoded text into numbered lines without keeping lines before `offset` and without holding more than
 * MAX_READ_OUTPUT_BYTES characters of a line in range (a minified file can be one huge line).
 */
class LineCollector {
	constructor(offset, limit) {
		this.offset = offset;
		this.limit = limit;
		this.lineNo = 0;
		this.lines = [];
		this.bytes = 0;
		this.truncated = false;
		this.pending = "";
		this.partial = false;
	}

	/** Feed decoded text; returns true once nothing more is needed. */
	feed(text) {
		let start = 0;
		for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
			this.append(text.slice(start, newline));
			start = newline + 1;
			if (this.endLine()) return true;
		}
		this.append(text.slice(start));
		if (!this.inRange() || this.pending.length < MAX_READ_OUTPUT_BYTES) return false;
		this.endLine();
		return true;
	}

	/** End of file: an unterminated last line still counts. */
	finish() {
		if (this.partial) this.endLine();
	}

	inRange() {
		return this.lineNo + 1 >= this.offset;
	}

	append(part) {
		if (part === "") return;
		this.partial = true;
		if (this.inRange()) this.pending += part.slice(0, MAX_READ_OUTPUT_BYTES);
	}

	endLine() {
		this.lineNo++;
		const line = this.pending;
		this.pending = "";
		this.partial = false;
		if (this.lineNo < this.offset) return false;
		if (this.lines.length >= this.limit) {
			this.truncated = true;
			return true;
		}
		const entry = `${this.lineNo}\t${line.endsWith("\r") ? line.slice(0, -1) : line}`;
		const size = Buffer.byteLength(entry) + 1;
		if (this.bytes + size > MAX_READ_OUTPUT_BYTES) {
			const room = MAX_READ_OUTPUT_BYTES - this.bytes - 1;
			if (room > 16) this.lines.push(cutUtf8(entry, room));
			this.truncated = true;
			return true;
		}
		this.lines.push(entry);
		this.bytes += size;
		return false;
	}
}

function cutUtf8(text, maxBytes) {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	let cut = bytes.subarray(0, maxBytes).toString("utf8");
	while (cut.endsWith(REPLACEMENT_CHARACTER)) cut = cut.slice(0, -1);
	return cut;
}

/** Read one chunk at `position` and feed it; returns true at the end of the file or once enough was collected. */
async function feedChunk(handle, buffer, position, collector, decoder, segments) {
	const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
	const bytes = buffer.subarray(0, bytesRead);
	if (position === 0 && bytes.includes(0)) throw fail("invalid", `${display(segments)}: binary file`);
	if (bytesRead > 0) return { done: collector.feed(decoder.decode(bytes, { stream: true })), bytesRead };
	if (!collector.feed(decoder.decode())) collector.finish();
	return { done: true, bytesRead };
}

async function readLines(handle, segments, offset, limit) {
	const collector = new LineCollector(offset, limit);
	const decoder = new TextDecoder("utf-8");
	const buffer = Buffer.alloc(READ_CHUNK);
	for (let position = 0; ; ) {
		const { done, bytesRead } = await feedChunk(handle, buffer, position, collector, decoder, segments);
		if (done) break;
		position += bytesRead;
		if (position > MAX_READ_SCAN_BYTES) throw fail("too_large", `${display(segments)}: file too large to read`);
	}
	return formatRead(collector, segments, offset);
}

function formatRead(collector, segments, offset) {
	if (collector.lines.length === 0 && !collector.truncated) {
		const output =
			collector.lineNo === 0
				? `[${display(segments)} is empty]`
				: `[offset ${offset} is beyond the end of ${display(segments)} (${collector.lineNo} lines)]`;
		return { ok: true, output, truncated: false };
	}
	let output = collector.lines.join("\n");
	if (collector.truncated) {
		const next = offset + collector.lines.length;
		output += `\n[truncated: continue with offset=${next}]`;
	}
	return { ok: true, output, truncated: collector.truncated };
}

async function writeOp(root, request) {
	const segments = parsePath(request.path);
	if (typeof request.content !== "string") throw fail("invalid", "content must be a string");
	const data = Buffer.from(request.content, "utf8");
	if (data.length > MAX_WRITE_BYTES) throw fail("too_large", `content exceeds ${MAX_WRITE_BYTES} bytes`);
	const { target, stat } = await walk(root, segments, true);
	const { handle } = await openVerified(root, segments, target, constants.O_WRONLY | constants.O_CREAT, 0o644);
	try {
		await handle.truncate(0);
		await writeAll(handle, data);
	} finally {
		await handle.close().catch(() => {});
	}
	const verb = stat === undefined ? "Created" : "Wrote";
	return { ok: true, output: `${verb} ${display(segments)} (${data.length} bytes).`, truncated: false };
}

async function writeAll(handle, data) {
	let offset = 0;
	while (offset < data.length) {
		const { bytesWritten } = await handle.write(data, offset, data.length - offset, offset);
		offset += bytesWritten;
	}
}

function countOccurrences(text, needle) {
	let count = 0;
	for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) count++;
	return count;
}

function checkEditRequest(request) {
	const { oldText, newText, replaceAll } = request;
	if (typeof oldText !== "string" || oldText.length === 0) throw fail("invalid", "oldText must be a non-empty string");
	if (typeof newText !== "string") throw fail("invalid", "newText must be a string");
	if (replaceAll !== undefined && typeof replaceAll !== "boolean")
		throw fail("invalid", "replaceAll must be a boolean");
}

/** The edited text and the number of replacements; refuses a missing or (without replaceAll) repeated oldText. */
function applyEdit(text, request, segments) {
	const count = countOccurrences(text, request.oldText);
	if (count === 0) throw fail("not_found", `${display(segments)}: oldText not found`);
	if (count > 1 && request.replaceAll !== true) {
		throw fail("not_unique", `${display(segments)}: oldText occurs ${count} times; add context or set replaceAll`);
	}
	const data = Buffer.from(text.split(request.oldText).join(request.newText), "utf8");
	if (data.length > MAX_EDIT_FILE_BYTES) throw fail("too_large", `${display(segments)}: result too large`);
	return { data, count };
}

async function editOp(root, request) {
	const segments = parsePath(request.path);
	checkEditRequest(request);
	const { target, stat } = await walk(root, segments, false);
	if (stat === undefined) throw fail("not_found", `${display(segments)}: no such file`);
	const opened = await openVerified(root, segments, target, constants.O_RDWR);
	try {
		if (opened.stat.size > MAX_EDIT_FILE_BYTES) throw fail("too_large", `${display(segments)}: file too large to edit`);
		const text = decodeText(await readAllBytes(opened.handle, opened.stat.size), segments);
		const { data, count } = applyEdit(text, request, segments);
		await opened.handle.truncate(0);
		await writeAll(opened.handle, data);
		const noun = count === 1 ? "occurrence" : "occurrences";
		return { ok: true, output: `Edited ${display(segments)}: replaced ${count} ${noun}.`, truncated: false };
	} finally {
		await opened.handle.close().catch(() => {});
	}
}

async function readAllBytes(handle, size) {
	const buffer = Buffer.alloc(Math.min(size, MAX_EDIT_FILE_BYTES) + 1);
	let length = 0;
	for (;;) {
		const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
		if (bytesRead === 0) break;
		length += bytesRead;
		if (length >= buffer.length) throw fail("too_large", "file too large to edit");
	}
	return buffer.subarray(0, length);
}

function decodeText(bytes, segments) {
	if (bytes.includes(0)) throw fail("invalid", `${display(segments)}: binary file`);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw fail("invalid", `${display(segments)}: not UTF-8 text`);
	}
}

async function readRequest() {
	const chunks = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > MAX_REQUEST_BYTES) throw fail("too_large", "request too large");
		chunks.push(chunk);
	}
	let request;
	try {
		request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw fail("invalid", "request is not valid JSON");
	}
	if (typeof request !== "object" || request === null || Array.isArray(request)) {
		throw fail("invalid", "request must be a JSON object");
	}
	return request;
}

async function resolveRoot(argument) {
	if (typeof argument !== "string" || !argument.startsWith("/")) throw fail("unavailable", "root must be absolute");
	const root = await fsp.realpath(argument);
	const stat = await fsp.stat(root);
	if (!stat.isDirectory()) throw fail("unavailable", "root is not a directory");
	return root;
}

const OPS = { read: readOp, write: writeOp, edit: editOp };

async function main() {
	let root;
	try {
		root = await resolveRoot(process.argv[2]);
	} catch (error) {
		return error instanceof FsError ? error : fail("unavailable", "worktree is not available");
	}
	const request = await readRequest();
	const op = Object.hasOwn(OPS, request.op) ? OPS[request.op] : undefined;
	if (op === undefined) throw fail("invalid", "op must be read, write or edit");
	try {
		return await op(root, request);
	} catch (error) {
		throw mapError(error, typeof request.path === "string" ? request.path.split("/").filter(Boolean) : []);
	}
}

let responded = false;

function respond(response, exitCode) {
	if (responded) return;
	responded = true;
	const body = response instanceof FsError ? { ok: false, code: response.code, message: response.message } : response;
	process.stdout.write(`${JSON.stringify(body)}\n`, () => process.exit(exitCode));
}

const timer = setTimeout(() => respond(fail("timeout", "file operation timed out"), 124), SELF_TIMEOUT_MS);
timer.unref();

main().then(
	(response) => respond(response, 0),
	(error) => respond(error instanceof FsError ? error : fail("io", "file operation failed"), 0),
);
