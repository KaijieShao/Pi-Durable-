/**
 * PI_STATE_GROUP: the Coordinator's database and lock file, shared with the watchdog's group so the watchdog can run
 * as its own user (Deployment § Processes: a separate unit; deploy/systemd/pi-durable-watchdog.service). The watchdog
 * reads and writes the database (sweep requests and answers, its heartbeat, a freeze) and reads the lock file (is the
 * Coordinator alive?); it never needs anything else of the Coordinator's.
 *
 *   coordinator.sqlite, -wal, -shm   group PI_STATE_GROUP, mode 0660 (SQLite gives a -wal or -shm it creates later
 *                                    the database file's mode; the watchdog's own files get its group)
 *   owner.lock                       group PI_STATE_GROUP, mode 0640
 *
 * Fails closed at startup: the group must exist, must not be root's, the Coordinator must be able to hand the files
 * to it (be a member), and under systemd isolation the Pi user must not be in it (the database holds raw task text).
 */
import { spawnSync } from "node:child_process";
import { chmod, chown } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError } from "../config/shared.ts";

const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin";

function command(name: string, args: readonly string[]): string | undefined {
	const result = spawnSync(name, [...args], {
		encoding: "utf8",
		timeout: 10_000,
		env: { PATH: process.env.PATH ?? FALLBACK_PATH },
	});
	return result.error === undefined && result.status === 0 ? result.stdout.trim() : undefined;
}

/** A gid as given, or a group name resolved with `getent group` (Linux). */
export function resolveGroup(group: string): number | undefined {
	if (/^\d+$/.test(group)) return Number(group);
	const gid = command("getent", ["group", group])?.split(":")[2];
	return gid !== undefined && /^\d+$/.test(gid) ? Number(gid) : undefined;
}

/** True if `user` exists and `gid` is among its groups (`id -G`). */
function userInGroup(user: string, gid: number): boolean {
	return command("id", ["-G", user])?.split(/\s+/).includes(String(gid)) === true;
}

const refuse = (message: string): ConfigError => new ConfigError([{ variable: "PI_STATE_GROUP", message }]);

async function share(path: string, gid: number, mode: number): Promise<void> {
	try {
		await chown(path, -1, gid);
		await chmod(path, mode);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return;
		if (code === "EPERM") throw refuse("the Coordinator cannot hand its files to this group (it is not a member)");
		throw error;
	}
}

/**
 * Share the database files and the lock file of `dataDir` with `group`. `piUser`: the Pi user under systemd isolation,
 * which must not be in the group. Throws ConfigError (exit 2) when the sharing would be unsafe or cannot be done.
 */
export async function shareState(dataDir: string, group: string, piUser: string | undefined): Promise<void> {
	const gid = resolveGroup(group);
	if (gid === undefined) throw refuse("the group does not exist (use its name on Linux, or its gid)");
	if (gid === 0) throw refuse("must not be root's group");
	if (piUser !== undefined && userInGroup(piUser, gid))
		throw refuse("the Pi user is a member: it must not read the Coordinator's database");
	const database = join(dataDir, "coordinator.sqlite");
	for (const path of [database, `${database}-wal`, `${database}-shm`]) await share(path, gid, 0o660);
	await share(join(dataDir, "owner.lock"), gid, 0o640);
}
