/**
 * Read-only inspection of a quarantined conversation (Interfaces and Storage § Recovery After a Restart: "Its
 * conversation is quarantined and opened only read-only"; § Interfaces, Owner CLI: "read-only inspection of
 * quarantined conversations"). The conversation's Pi SQLite file is never opened for writing and nothing is created
 * next to it:
 *
 *   no -wal file, or an empty one: the main file is complete. It is opened with SQLite's `mode=ro&immutable=1`, which
 *     takes no lock and creates no -wal or -shm file (an ordinary read-only open creates both).
 *   a -wal file with content (the Pi process was killed before it checkpointed): the latest entries exist only in the
 *     WAL, which immutable mode ignores, and a read-only open would still write the -shm index. The file and its WAL
 *     are copied (only read) into a private scratch directory of the Coordinator (0700, in the owner socket's
 *     directory), the copy is read, and the scratch directory is deleted at once (and at the next start if a crash
 *     left it).
 *
 * Pi Durable's read-only Harness is not used: opening its storage runs its migrations in a write transaction and
 * checkpoints the WAL on close, both of which write the file. The entries are read with plain SQL from Pi Durable
 * 1.5.0's `entries` table (each row's `record` is an EntryRecord: its kind and the model messages it contributed).
 *
 * The transcript goes to the owner's terminal only, never to a log. Untrusted text (model output, tool output) has its
 * control characters (ESC, CR, ...) and bidirectional overrides escaped, so it cannot drive the terminal, and known
 * secret shapes masked (runtime/redact.ts). Bounded by INSPECT_MAX_BYTES.
 */
import { constants, type Stats } from "node:fs";
import { copyFile, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { redact } from "../../runtime/redact.ts";
import { formatBytes } from "../messages.ts";

/** The transcript text is cut after this many bytes (the response line stays well below RESPONSE_MAX_BYTES). */
export const INSPECT_MAX_BYTES = 4 * 1024 * 1024;
/** One part of one message is cut after this many characters. */
const PART_MAX_CHARS = 64 * 1024;
const SCRATCH_PREFIX = "inspect-";

export type Inspection = {
	readonly text: string;
	readonly entries: number;
	readonly shown: number;
	/** "file": the file itself, immutable; "copy": a private copy (its WAL had content). */
	readonly source: "file" | "copy";
};

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Remove scratch copies a crash left behind (at the Coordinator's start). */
export async function removeScratchCopies(scratchDir: string): Promise<void> {
	const names = await readdir(scratchDir).catch(() => [] as string[]);
	for (const name of names) {
		if (name.startsWith(SCRATCH_PREFIX)) await rm(join(scratchDir, name), { recursive: true, force: true });
	}
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: these are exactly the characters escaped
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** Untrusted text made safe for a terminal: control characters and bidi overrides escaped, secret shapes masked. */
export function terminalSafe(text: string): string {
	const masked = redact(text);
	const escaped = masked.replace(UNSAFE, (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);
	return escaped.length <= PART_MAX_CHARS ? escaped : `${escaped.slice(0, PART_MAX_CHARS)}… [cut]`;
}

type Part = {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	redacted?: unknown;
	name?: unknown;
	arguments?: unknown;
};
type Message = {
	role?: unknown;
	content?: unknown;
	toolName?: unknown;
	isError?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
	toolsAdded?: unknown;
	sections?: unknown;
};

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Part[])
		.map((part) => (part?.type === "image" ? "[image]" : typeof part?.text === "string" ? part.text : ""))
		.join("\n");
}

/** One part of an assistant message: its text, its thinking, or a tool call with its arguments. */
function partLine(part: Part | undefined): string | undefined {
	switch (part?.type) {
		case "text":
			return typeof part.text === "string" ? `[assistant] ${terminalSafe(part.text)}` : undefined;
		case "thinking":
			return part.redacted === true
				? "[thinking, redacted]"
				: `[thinking] ${terminalSafe(String(part.thinking ?? ""))}`;
		case "toolCall":
			return `[tool call ${terminalSafe(String(part.name ?? "?"))}] ${terminalSafe(JSON.stringify(part.arguments ?? {}))}`;
		default:
			return undefined;
	}
}

function assistantLines(message: Message): string[] {
	const parts = Array.isArray(message.content) ? (message.content as (Part | undefined)[]) : [];
	const lines = parts.map(partLine).filter((line): line is string => line !== undefined);
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		const detail = typeof message.errorMessage === "string" ? `: ${terminalSafe(message.errorMessage)}` : "";
		lines.push(`[assistant stopped: ${message.stopReason}${detail}]`);
	}
	return lines;
}

function toolNames(value: unknown): string {
	if (!Array.isArray(value)) return "";
	const names = value.map((tool: { name?: unknown }) => String(tool?.name ?? "?"));
	return names.length === 0 ? "" : ` (tools: ${terminalSafe(names.join(", "))})`;
}

/** The names of a system message's prompt sections (their text is the Coordinator's instructions and AGENTS.md). */
function sectionNames(value: unknown): string {
	if (typeof value !== "object" || value === null) return "";
	const names = Object.keys(value);
	return names.length === 0 ? "" : ` (sections: ${terminalSafe(names.join(", "))})`;
}

function messageLines(message: Message): string[] {
	switch (message.role) {
		case "system":
			return [
				`[system${sectionNames(message.sections)}${toolNames(message.toolsAdded)}] ${terminalSafe(textOf(message.content))}`,
			];
		case "user":
			return [`[user] ${terminalSafe(textOf(message.content))}`];
		case "assistant":
			return assistantLines(message);
		case "toolResult": {
			const name = terminalSafe(String(message.toolName ?? "?"));
			return [
				`[tool result ${name}${message.isError === true ? ", error" : ""}] ${terminalSafe(textOf(message.content))}`,
			];
		}
		default:
			return [`[${terminalSafe(String(message.role ?? "?"))}] ${terminalSafe(JSON.stringify(message))}`];
	}
}

type EntryRow = { id: number; conversation_id: number; record: string };
type EntryRecord = { kind?: unknown; model?: unknown; data?: unknown };

function entryLines(row: EntryRow): string[] {
	let record: EntryRecord;
	try {
		record = JSON.parse(row.record) as EntryRecord;
	} catch {
		return [`--- entry ${row.id}: unreadable record`];
	}
	const header = `--- entry ${row.id} (Pi conversation ${row.conversation_id}): ${terminalSafe(String(record.kind ?? "?"))}`;
	const messages = Array.isArray(record.model) ? (record.model as Message[]) : [];
	const body = messages.flatMap(messageLines);
	if (body.length === 0 && record.data !== undefined) body.push(`[data] ${terminalSafe(JSON.stringify(record.data))}`);
	return [header, ...body];
}

function countsBy(db: DatabaseSync, table: string, column: string): string {
	const rows = db
		.prepare(`SELECT ${column} AS value, COUNT(*) AS n FROM ${table} GROUP BY ${column} ORDER BY ${column}`)
		.all() as {
		value: string;
		n: number;
	}[];
	return rows.length === 0 ? "none" : rows.map((row) => `${row.n} ${row.value}`).join(", ");
}

function hasTable(db: DatabaseSync, name: string): boolean {
	return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** Render every entry of an open Pi store, bounded by `maxBytes`. */
function render(db: DatabaseSync, maxBytes: number): { lines: string[]; entries: number; shown: number } {
	if (!hasTable(db, "entries")) return { lines: ["The file holds no Pi conversation entries."], entries: 0, shown: 0 };
	const rows = db.prepare("SELECT id, conversation_id, record FROM entries ORDER BY id").all() as EntryRow[];
	const lines = [
		`Pi work at the interruption: tasks ${hasTable(db, "tasks") ? countsBy(db, "tasks", "status") : "none"}; ` +
			`submissions ${hasTable(db, "submissions") ? countsBy(db, "submissions", "status") : "none"}`,
		`Entries: ${rows.length}`,
	];
	let bytes = 0;
	let shown = 0;
	for (const row of rows) {
		const block = entryLines(row);
		const size = Buffer.byteLength(block.join("\n"));
		if (bytes + size > maxBytes) {
			lines.push(`[truncated: entries from ${row.id} on (${rows.length - shown} of ${rows.length}) are not shown]`);
			break;
		}
		bytes += size;
		shown++;
		lines.push(...block);
	}
	return { lines, entries: rows.length, shown };
}

function openImmutable(path: string): DatabaseSync {
	const url = pathToFileURL(path);
	url.searchParams.set("mode", "ro");
	url.searchParams.set("immutable", "1");
	return new DatabaseSync(url, { readOnly: true });
}

function readWith(db: DatabaseSync, maxBytes: number) {
	try {
		db.exec("PRAGMA query_only = ON");
		return render(db, maxBytes);
	} finally {
		db.close();
	}
}

/** A regular file (never a symlink) or nothing; anything else is refused. */
async function regularOrMissing(path: string, what: string): Promise<Stats | undefined> {
	const stats = await lstatOrUndefined(path);
	if (stats !== undefined && (stats.isSymbolicLink() || !stats.isFile()))
		throw new Error(`${what} is not a regular file`);
	return stats;
}

/**
 * The transcript of the conversation stored at `path` (a Pi SQLite file), read without writing anything next to it.
 * `scratchDir`: the Coordinator's private directory for the copy when the WAL has content.
 */
export async function inspectConversation(
	path: string,
	scratchDir: string,
	maxBytes: number = INSPECT_MAX_BYTES,
): Promise<Inspection> {
	const main = await regularOrMissing(path, "the conversation's file");
	if (main === undefined) throw new Error("the conversation's file does not exist (nothing was ever written to it)");
	const wal = await regularOrMissing(`${path}-wal`, "the conversation's -wal file");
	const sizes = `${formatBytes(main.size)}${wal === undefined ? "" : `, WAL ${formatBytes(wal.size)}`}`;
	if (wal === undefined || wal.size === 0) {
		const result = readWith(openImmutable(path), maxBytes);
		return finish(`File: ${path} (${sizes}; opened read-only and immutable)`, result, "file");
	}
	const scratch = await mkdtemp(join(scratchDir, SCRATCH_PREFIX));
	try {
		const copy = join(scratch, "conversation.sqlite");
		await copyFile(path, copy, constants.COPYFILE_EXCL);
		await copyFile(`${path}-wal`, `${copy}-wal`, constants.COPYFILE_EXCL);
		const result = readWith(new DatabaseSync(copy, { readOnly: true }), maxBytes);
		return finish(
			`File: ${path} (${sizes}; its WAL has content: read from a private copy, deleted again)`,
			result,
			"copy",
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

function finish(header: string, result: ReturnType<typeof render>, source: Inspection["source"]): Inspection {
	return { text: [header, ...result.lines].join("\n"), entries: result.entries, shown: result.shown, source };
}
