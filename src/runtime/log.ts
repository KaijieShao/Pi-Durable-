import { redact } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
	debug(event: string, fields?: LogFields): void;
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
}

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (level: LogLevel, line: string) => void;

const defaultSink: LogSink = (level, line) => {
	const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
	stream.write(`${line}\n`);
};

/** One line per event: `level event key=value ...`; every string is redacted. */
export function createLogger(options: { level?: LogLevel; sink?: LogSink } = {}): Logger {
	const threshold = rank[options.level ?? "info"];
	const sink = options.sink ?? defaultSink;
	const emit = (level: LogLevel) => (event: string, fields?: LogFields) => {
		if (rank[level] < threshold) return;
		sink(level, redact(formatLine(level, event, fields)));
	};
	return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export function formatLine(level: LogLevel, event: string, fields?: LogFields): string {
	const parts = [level, event];
	for (const [key, value] of Object.entries(fields ?? {})) {
		if (value === undefined) continue;
		parts.push(`${key}=${formatValue(value)}`);
	}
	return parts.join(" ");
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return /^[\w./:@+-]+$/.test(value) ? value : JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value instanceof Error) return JSON.stringify(errorSummary(value));
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return JSON.stringify(String(value));
	}
}

/** First line of an error message, without causes or stacks (they may carry URLs with secrets). */
export function errorSummary(error: unknown): string {
	const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return redact(message.split("\n")[0] ?? "").slice(0, 300);
}

/** A logger that drops everything; for tests and library users who log elsewhere. */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
