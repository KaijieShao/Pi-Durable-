import type { JsonValue } from "@earendil-works/chord";
import { truncate } from "../format/escape.ts";

const MAX_HINT = 60;

/** Short activity line for a running tool, e.g. `bash: npm test`; arguments are summarized to one line. */
export function toolHint(name: string, args: JsonValue | undefined): string {
	const detail = summarizeArgs(args);
	const line = detail === undefined ? name : `${name}: ${detail}`;
	return truncate(line.replace(/\s+/g, " ").trim(), MAX_HINT);
}

function summarizeArgs(args: JsonValue | undefined): string | undefined {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
	for (const key of ["command", "path", "pattern", "url", "query", "task", "text"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value.split("\n")[0];
	}
	return undefined;
}
