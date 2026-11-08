/**
 * LINUX DEPLOYMENT CHECK (opt-in): the watchdog's slice reaper against the real systemd and cgroup v2 (spec/deployment.md
 * § Deployment checks: "tests must show that the slice and label cleanup survives escape and restart"). A transient
 * unit named like a Pi unit, in a throw-away slice, runs a shell whose child escaped with `setsid` (another session
 * and process group: a process-group kill misses it). The reaper finds both through the slice's cgroup tree, kills
 * them and verifies the slice is empty.
 *
 * Needs root (it starts the unit and kills its processes, as the watchdog does with CAP_KILL):
 *
 *   sudo env PI_WATCHDOG_LINUX_TESTS=1 node --test --test-concurrency=1 test/watchdog/slice-linux.test.ts
 *
 * Skipped everywhere else (npm test on a Mac or as a normal user).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { unitName } from "../../src/coordinator/runner-systemd.ts";
import { deploymentId } from "../../src/runner/argv.ts";
import { sliceProcessReaper, sweep } from "../../src/watchdog/reapers.ts";
import { waitFor } from "../helpers/env.ts";

function skipReason(): string | false {
	if (process.platform !== "linux") return "Linux only (a deployment check)";
	if (process.env.PI_WATCHDOG_LINUX_TESTS !== "1") return "set PI_WATCHDOG_LINUX_TESTS=1 (and run as root) to run";
	if (process.getuid?.() !== 0) return "needs root: it starts a unit and kills its processes";
	return false;
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("the slice reaper kills a unit's processes in the real slice, a child that escaped with setsid too", {
	timeout: 60_000,
	skip: skipReason(),
}, async (t) => {
	const slice = `piwdtest${randomBytes(4).toString("hex")}.slice`;
	const deployment = deploymentId(`/tmp/pi-watchdog-linux-${slice}`);
	const unit = unitName(deployment, 1, 1);
	t.after(() => {
		spawnSync("systemctl", ["stop", unit], { stdio: "ignore" });
		spawnSync("systemctl", ["stop", slice], { stdio: "ignore" });
	});
	const started = spawnSync(
		"systemd-run",
		[
			`--unit=${unit}`,
			`--slice=${slice}`,
			"--collect",
			"--quiet",
			"--",
			"/bin/sh",
			"-c",
			"setsid sleep 600 & sleep 600",
		],
		{ encoding: "utf8" },
	);
	assert.equal(started.status, 0, started.stderr);
	const reaper = sliceProcessReaper({ slice, deployment, systemctl: "systemctl" });
	const pids = await waitFor(
		async () => {
			const listed = await reaper.list();
			return listed !== undefined && listed.length >= 2 ? listed.map(Number) : undefined;
		},
		{ what: "the unit's processes and the escaped sleep in the slice", timeoutMs: 20_000 },
	);
	const sessions = new Set(
		pids.map((pid) => spawnSync("ps", ["-o", "sid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()),
	);
	assert.ok(sessions.size >= 2, "one of them left the unit's session");
	const result = await sweep({ processes: [reaper], containers: [] });
	assert.equal(result.verified, true);
	assert.ok(result.processesKilled >= 2);
	await waitFor(() => pids.every((pid) => !alive(pid)), { what: "every process gone" });
	assert.deepEqual(await reaper.list(), []);
});
