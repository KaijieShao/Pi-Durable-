import { readFileSync } from "node:fs";

/** Start time of `pid` in clock ticks since boot (Linux `/proc/<pid>/stat` field 22); undefined elsewhere. */
export function processStartTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name (field 2) may contain spaces and parentheses; fields after it are plain.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[19];
	} catch {
		return undefined;
	}
}
