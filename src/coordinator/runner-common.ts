/**
 * Pieces shared by the two Pi process launchers: runner-launcher.ts ("process" isolation: a forked child over Node
 * IPC) and runner-systemd.ts ("systemd" isolation: a transient unit over stdio frames). The Pi process's output is
 * never forwarded as text: only metadata notes with allowlisted primitive fields are logged, everything else counted.
 */
import type { Readable } from "node:stream";
import type { Logger } from "../runtime/log.ts";

/** PATH given to Pi processes when the Coordinator's own is unset. */
export const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin";

const NOTE_EVENT = /^[a-z][a-z0-9_]{0,47}$/;
const NOTE_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const NOTE_VALUE = /^[\w.:-]{0,64}$/;
/** Fields a note cannot set: the launcher's own, and the frame's type. */
const RESERVED_NOTE_KEYS: ReadonlySet<string> = new Set(["event", "runId", "taskId", "pid", "type", "unit"]);
/** At most this many metadata lines are logged per process; the rest are counted. */
export const MAX_NOTES = 200;

export type NoteFields = { event: string } & Record<string, string | number | boolean>;

export type OutputCounts = {
	/** Output lines that were not a metadata note (or past MAX_NOTES). */
	stdoutLines: number;
	notes: number;
	stderrBytes: number;
	stderrLines: number;
};

export function newOutputCounts(): OutputCounts {
	return { stdoutLines: 0, notes: 0, stderrBytes: 0, stderrLines: 0 };
}

/** TEST ONLY extra variables for the Pi process: only names starting with PI_RUNNER_TEST_ are accepted. */
export function checkTestEnv(testEnv: Readonly<Record<string, string>> | undefined): Record<string, string> {
	const checked: Record<string, string> = {};
	for (const [name, value] of Object.entries(testEnv ?? {})) {
		if (!/^PI_RUNNER_TEST_[A-Z0-9_]+$/.test(name))
			throw new Error(`testEnv: ${name} is not a PI_RUNNER_TEST_ variable`);
		if (!/^[\w.:-]{0,64}$/.test(value)) throw new Error(`testEnv: ${name} has an unsupported value`);
		checked[name] = value;
	}
	return checked;
}

/** A metadata note's fields, when `value` is one: an event name and allowlisted primitive values. */
export function noteFields(value: unknown): NoteFields | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.event !== "string" || !NOTE_EVENT.test(record.event)) return undefined;
	const fields: NoteFields = { event: record.event };
	for (const [key, field] of Object.entries(record)) {
		if (allowedNoteField(key, field)) fields[key] = field;
	}
	return fields;
}

/** A `@pi-runner {json}` line's fields (IPC transport), when it is one. */
export function parseNoteJson(json: string): NoteFields | undefined {
	try {
		return noteFields(JSON.parse(json));
	} catch {
		return undefined;
	}
}

/** Only short identifiers, numbers and booleans pass; the launcher's own fields cannot be overridden. */
function allowedNoteField(key: string, field: unknown): field is string | number | boolean {
	if (!NOTE_KEY.test(key) || RESERVED_NOTE_KEYS.has(key)) return false;
	if (typeof field === "number") return Number.isFinite(field);
	if (typeof field === "boolean") return true;
	return typeof field === "string" && NOTE_VALUE.test(field);
}

/** Log one note (within MAX_NOTES), else count it as an output line. */
export function logNote(
	log: Logger,
	meta: Readonly<Record<string, unknown>>,
	fields: NoteFields | undefined,
	counts: OutputCounts,
): void {
	if (fields === undefined || counts.notes >= MAX_NOTES) {
		counts.stdoutLines++;
		return;
	}
	counts.notes++;
	const { event, ...rest } = fields;
	log.info("runner_note", { ...meta, note: event, ...rest });
}

/** Count stderr bytes and lines; never keep or forward the text. */
export function drainStderr(stream: Readable | null, counts: OutputCounts): void {
	if (stream === null) return;
	stream.on("data", (chunk: Buffer) => {
		counts.stderrBytes += chunk.byteLength;
		for (const byte of chunk) if (byte === 0x0a) counts.stderrLines++;
	});
	stream.on("error", () => {});
}
