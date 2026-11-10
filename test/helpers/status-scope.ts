/** Explicit routing evidence for test-only task rows. Production never infers/backfills historic topics. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function statusScopeFile(database: string, repository: string, group: number, topic = 1): string {
	const path = join(database.substring(0, database.lastIndexOf("/")), "status-scopes.json");
	writeFileSync(
		path,
		JSON.stringify({ version: 1, database, periods: [{ firstTask: 1, lastTask: null, repository, group, topic }] }),
	);
	return path;
}
