/**
 * The watchdog's reapers (src/watchdog/reapers.ts; Deployment § Processes "kills everything in the slice and every
 * labeled container, verifies both are empty"; § Deployment checks "the slice and label cleanup survives escape and
 * restart").
 *
 *   - the slice reaper reads the Pi slice's cgroup tree (here a stand-in tree and systemctl): every pid of every unit
 *     below it, killed and listed again until empty, including a process that left its session (not in the killed
 *     process's group: only cgroup membership finds it) and one forked while the first was being killed; scoped to a
 *     run, only that unit's cgroup; it fails closed (cannot tell) when systemctl or the cgroup tree cannot be read;
 *   - the marker reaper finds this deployment's Pi processes by command line (run-scoped too), never another's;
 *   - the Docker reaper lists and removes by label (task and generation when scoped) and cannot list → unknown;
 *   - a sweep repeats until both kinds are empty, counts what it killed, and calls a stop unverified when something
 *     survives every round or cannot be listed.
 * The real slice (cgroup v2, a unit with an escaped child) is checked on Linux at deployment: slice-linux.test.ts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { unitName } from "../../src/coordinator/runner-systemd.ts";
import { deploymentId } from "../../src/runner/argv.ts";
import {
	dockerContainerReaper,
	markerProcessReaper,
	type Reaper,
	slicePath,
	sliceProcessReaper,
	sweep,
} from "../../src/watchdog/reapers.ts";
import { createDockerShim } from "../helpers/docker-shim.ts";
import { markedProcess } from "../helpers/marked-process.ts";

const SLICE = "pi-durable-runs.slice";

async function tempDir(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "reapers-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** A process that never exits by itself, in its own session (as an escaped double-forked child would be). */
function sleeper(t: TestContext): { pid: number; exited: Promise<NodeJS.Signals | null> } {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { detached: true, stdio: "ignore" });
	let gone = false;
	const exited = new Promise<NodeJS.Signals | null>((resolve) =>
		child.once("exit", (_code, signal) => {
			gone = true;
			resolve(signal);
		}),
	);
	t.after(() => {
		if (!gone) child.kill("SIGKILL");
	});
	return { pid: child.pid ?? 0, exited };
}

type Tree = { readonly root: string; readonly slice: string; readonly systemctl: string; readonly state: string };

/** A cgroup v2 stand-in (a marker file, the slice's directory) and a systemctl stand-in that shows its ControlGroup. */
async function cgroupTree(dir: string): Promise<Tree> {
	const root = join(dir, "cgroup");
	const slice = join(root, slicePath(SLICE));
	await mkdir(slice, { recursive: true });
	await writeFile(join(root, "cgroup.controllers"), "cpu memory pids\n");
	await writeFile(join(slice, "cgroup.procs"), "");
	const state = join(dir, "systemctl-state");
	await mkdir(state, { recursive: true });
	const systemctl = join(dir, "systemctl");
	await writeFile(
		systemctl,
		[
			"#!/bin/sh",
			`if [ -e '${state}/broken' ]; then echo broken >&2; exit 1; fi`,
			`if [ -e '${state}/empty' ]; then echo; exit 0; fi`,
			`echo '/${slicePath(SLICE)}'`,
			"",
		].join("\n"),
	);
	await chmod(systemctl, 0o755);
	return { root, slice, systemctl, state };
}

async function unitCgroup(tree: Tree, unit: string, pids: readonly number[]): Promise<string> {
	const dir = join(tree.slice, unit);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "cgroup.procs"), pids.map((pid) => `${pid}\n`).join(""));
	return dir;
}

/** The kernel's part, played by the stand-in: a killed process leaves its cgroup (synchronously, as the kernel does). */
function removePid(file: string, pid: number): void {
	const text = existsSync(file) ? readFileSync(file, "utf8") : "";
	const kept = text.split("\n").filter((line) => line !== "" && line !== String(pid));
	writeFileSync(file, kept.map((line) => `${line}\n`).join(""));
}

test("slicePath: dashes are the slice hierarchy", () => {
	assert.equal(slicePath("pi-durable-runs.slice"), "pi.slice/pi-durable.slice/pi-durable-runs.slice");
	assert.equal(slicePath("system.slice"), "system.slice");
});

test("the slice reaper kills every process in the Pi slice by cgroup membership, an escaped one too, until empty", {
	timeout: 30_000,
}, async (t) => {
	const dir = await tempDir(t);
	const tree = await cgroupTree(dir);
	const deployment = deploymentId(join(dir, "data"));
	const leader = sleeper(t);
	// Left its session and process group (setsid / double fork): a process-group kill of the leader misses it.
	const escaped = sleeper(t);
	const otherRun = sleeper(t);
	// Forked by the leader as it was being killed: in the cgroup only after the first round.
	const forked = sleeper(t);
	const unit1 = await unitCgroup(tree, unitName(deployment, 1, 1), [leader.pid, escaped.pid]);
	const unit2 = await unitCgroup(tree, unitName(deployment, 2, 4), [otherRun.pid]);
	// A sub-cgroup of a unit (delegated): its processes are in the slice as well.
	const nested = await unitCgroup(tree, join(unitName(deployment, 2, 4), "payload"), []);
	const killed: number[] = [];
	// A killed pid leaves its cgroup; killing the leader adds `forked` (it forked as it was being killed).
	const signal = (pid: number): void => {
		killed.push(pid);
		for (const unit of [unit1, unit2, nested]) removePid(join(unit, "cgroup.procs"), pid);
		if (pid === leader.pid) writeFileSync(join(nested, "cgroup.procs"), `${forked.pid}\n`);
		process.kill(pid, "SIGKILL");
	};
	const reaper = sliceProcessReaper({
		slice: SLICE,
		deployment,
		systemctl: tree.systemctl,
		cgroupRoot: tree.root,
		signal,
	});
	assert.deepEqual(
		(await reaper.list({ runId: 2, taskId: 2, generation: 4 }))?.map(Number),
		[otherRun.pid],
		"scoped to a run: that unit's cgroup (and below) only",
	);
	const result = await sweep({ processes: [reaper], containers: [] });
	assert.equal(result.verified, true);
	assert.equal(result.processesKilled, 4, "the leader, the escaped process, the other run's, the late fork");
	for (const each of [leader, escaped, otherRun, forked]) assert.equal(await each.exited, "SIGKILL");
	assert.deepEqual(await reaper.list(), []);
	assert.ok(killed.includes(forked.pid), "the process forked during the kill was found in a later round");
});

test("the slice reaper fails closed: systemctl or the cgroup tree unreadable → cannot tell; an inactive slice → empty", async (t) => {
	const dir = await tempDir(t);
	const tree = await cgroupTree(dir);
	const deployment = deploymentId(join(dir, "data"));
	const reaper = sliceProcessReaper({ slice: SLICE, deployment, systemctl: tree.systemctl, cgroupRoot: tree.root });
	assert.deepEqual(await reaper.list(), []);
	await writeFile(join(tree.state, "broken"), "");
	assert.equal(await reaper.list(), undefined, "systemctl cannot tell");
	await rm(join(tree.state, "broken"));
	// The slice has no cgroup (no unit ever started, or all collected): nothing runs in it.
	await writeFile(join(tree.state, "empty"), "");
	await rm(tree.slice, { recursive: true });
	assert.deepEqual(await reaper.list(), []);
	await rm(join(tree.state, "empty"));
	// No cgroup v2 hierarchy where it should be: cannot tell.
	await rm(join(tree.root, "cgroup.controllers"));
	assert.equal(await reaper.list(), undefined);
	const missing = sliceProcessReaper({
		slice: SLICE,
		deployment,
		systemctl: join(dir, "no-systemctl"),
		cgroupRoot: tree.root,
	});
	assert.equal(await missing.list(), undefined, "no systemctl at all");
});

test("the marker reaper: this deployment's Pi processes by command line, scoped to a run, never another's", {
	timeout: 30_000,
}, async (t) => {
	const dir = await tempDir(t);
	const deployment = deploymentId(join(dir, "data"));
	const run3 = await markedProcess(t, dir, deployment, 3);
	const run4 = await markedProcess(t, dir, deployment, 4);
	const foreign = await markedProcess(t, dir, deploymentId(join(dir, "other")), 3);
	const reaper = markerProcessReaper({ deployment });
	assert.deepEqual((await reaper.list())?.map(Number).sort(), [run3.pid, run4.pid].sort());
	assert.deepEqual((await reaper.list({ runId: 3, taskId: 1, generation: 1 }))?.map(Number), [run3.pid]);
	const result = await sweep({ processes: [reaper], containers: [] }, { runId: 3, taskId: 1, generation: 1 });
	assert.deepEqual([result.verified, result.processesKilled], [true, 1]);
	assert.equal(await run3.exited, "SIGKILL");
	assert.ok(run4.alive() && foreign.alive());
});

test("the Docker reaper: managed containers by label (task and generation when scoped); unlistable → unknown", async (t) => {
	const dir = await tempDir(t);
	const docker = await createDockerShim(dir);
	const a = await docker.addContainer({ "pi-durable.task": 1, "pi-durable.generation": 1 });
	const b = await docker.addContainer({ "pi-durable.task": 1, "pi-durable.generation": 2 });
	const c = await docker.addContainer({ "pi-durable.task": 2, "pi-durable.generation": 1 });
	const other = await docker.addContainer({ "pi-durable.managed": 0 });
	const reaper = dockerContainerReaper({ bin: docker.bin });
	assert.deepEqual([...((await reaper.list()) ?? [])].sort(), [a, b, c].sort());
	assert.deepEqual(await reaper.list({ runId: 9, taskId: 1, generation: 2 }), [b]);
	await reaper.kill([b]);
	assert.deepEqual(docker.containers(), [a, c, other].sort());
	assert.ok(
		(await docker.calls()).some((call) => call === `rm -f ${b}`),
		"docker rm -f by id",
	);
	await docker.set("ps-fails", true);
	assert.equal(await reaper.list(), undefined);
});

/** An in-memory reaper: `alive` items; `respawn` adds items as kills happen (an escape attempt). */
function memoryReaper(kind: Reaper["kind"], alive: Set<string>, respawn: string[] = [], immortal = false): Reaper {
	return {
		kind,
		list: async () => [...alive],
		kill: async (items) => {
			if (!immortal) for (const item of items) alive.delete(item);
			const next = respawn.shift();
			if (next !== undefined) alive.add(next);
		},
	};
}

test("a sweep repeats until both kinds are empty and counts every item; survivors or a failed list → unverified", async () => {
	const processes = new Set(["10", "11"]);
	const containers = new Set(["c1"]);
	const respawning = memoryReaper("processes", processes, ["12", "13"]);
	const ok = await sweep({ processes: [respawning], containers: [memoryReaper("containers", containers)] });
	assert.deepEqual(ok, {
		verified: true,
		processesKilled: 4,
		containersKilled: 1,
		processesLeft: 0,
		containersLeft: 0,
		detail: null,
	});

	const immortal = await sweep({
		processes: [memoryReaper("processes", new Set(["20"]), [], true)],
		containers: [memoryReaper("containers", new Set())],
	});
	assert.deepEqual([immortal.verified, immortal.processesLeft, immortal.detail], [false, 1, "processes_left"]);

	const blind: Reaper = { kind: "containers", list: async () => undefined, kill: async () => {} };
	const unlistable = await sweep({ processes: [], containers: [blind] });
	assert.deepEqual(
		[unlistable.verified, unlistable.containersLeft, unlistable.detail],
		[false, null, "containers_unlistable"],
	);
});
