/**
 * TEST ONLY: the systemd launcher (src/coordinator/runner-systemd.ts) against stand-ins for systemd-run and systemctl
 * (test/fixtures/systemd-run-shim.sh, systemctl-shim.sh), so the stdio transport, the unit's arguments and the kill
 * path run end to end on any POSIX host. The shims record their arguments, run the command after "--" as this user
 * (no other user, no slice, no IP filter: those are Linux-only checks, test/runner/systemd-linux.test.ts) and kill
 * by pid. Production code has no knob for any of this: tests point the launcher's binaries at two wrapper scripts.
 */
import { statSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Accounts } from "../../src/coordinator/runner-systemd.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

export type ShimFlag = "no-slice" | "systemctl-broken" | "fail-start" | "detached-unit" | "kill-misses";

export type SystemdShims = {
	/** Wrapper scripts to use as systemd-run and systemctl. */
	readonly systemdRun: string;
	readonly systemctl: string;
	/** The shims' state directory (argv logs, unit pids, failure switches). */
	readonly state: string;
	/** Every systemd-run call so far, one argument list each. */
	systemdRunCalls(): Promise<string[][]>;
	systemctlCalls(): Promise<string[][]>;
	/**
	 * Switches: `no-slice` (slice not installed), `systemctl-broken` (show and list-units fail), `fail-start` (start
	 * refused), `detached-unit` (the unit runs apart from its systemd-run client, as with real systemd),
	 * `kill-misses` (`systemctl kill` does nothing, as for a unit systemd had not created yet).
	 */
	set(flag: ShimFlag, on: boolean): Promise<void>;
};

/** Install the two wrappers in `dir`/bin with their state in `dir`/state. Paths must not contain quotes. */
export async function createSystemdShims(dir: string): Promise<SystemdShims> {
	const bin = join(dir, "bin");
	const state = join(dir, "state");
	await mkdir(bin, { recursive: true });
	await mkdir(join(state, "units"), { recursive: true });
	const wrap = async (name: string, fixture: string): Promise<string> => {
		const path = join(bin, name);
		if (`${path}${state}${FIXTURES}`.includes("'")) throw new Error("shim paths must not contain quotes");
		await writeFile(path, `#!/bin/sh\nexec /bin/sh '${join(FIXTURES, fixture)}' '${state}' "$@"\n`);
		await chmod(path, 0o755);
		return path;
	};
	const calls = async (file: string): Promise<string[][]> => {
		const text = await readFile(join(state, file), "utf8").catch(() => "");
		const all: string[][] = [];
		let current: string[] = [];
		for (const line of text.split("\n")) {
			if (line === "--END--") {
				all.push(current);
				current = [];
			} else if (line !== "") current.push(line);
		}
		return all;
	};
	return {
		systemdRun: await wrap("systemd-run", "systemd-run-shim.sh"),
		systemctl: await wrap("systemctl", "systemctl-shim.sh"),
		state,
		systemdRunCalls: () => calls("systemd-run.argv"),
		systemctlCalls: () => calls("systemctl.argv"),
		async set(flag, on) {
			const path = join(state, flag);
			if (on) await writeFile(path, "");
			else await rm(path, { force: true });
		},
	};
}

/**
 * The data directory layout of the one-time host setup (docs/isolation.md), as this user: the data dir traversable
 * by its group only (0710), conversations shared with the group (setgid 2770), the Pi home private (0700).
 */
export async function prepareSystemdLayout(dataDir: string): Promise<void> {
	await mkdir(dataDir, { recursive: true });
	await chmod(dataDir, 0o710);
	await mkdir(join(dataDir, "conversations"), { recursive: true });
	await chmod(join(dataDir, "conversations"), 0o2770);
	await mkdir(join(dataDir, "run-home"), { recursive: true });
	await chmod(join(dataDir, "run-home"), 0o700);
}

/**
 * TEST ONLY: the Pi user and group as if the host setup had created them on this host (where the stand-ins run the
 * unit as this user): `user` gets a uid that is neither root nor this user's, `group` is the group of the data dir's
 * conversations directory; any other name does not exist.
 */
export function testAccounts(dataDir: string, names = { user: "pi-runner", group: "pi-durable" }): Accounts {
	const other = process.getuid?.() === 54_321 ? 54_322 : 54_321;
	return {
		uid: (user) => (user === names.user ? other : undefined),
		gid: (group) => (group === names.group ? statSync(join(dataDir, "conversations")).gid : undefined),
	};
}
