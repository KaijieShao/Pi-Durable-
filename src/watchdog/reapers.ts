/**
 * The watchdog's reapers (Deployment § Processes: on a Coordinator restart the watchdog "kills everything in the slice
 * and every labeled container" and "verifies both are empty"; Architecture § Watchdog: "It terminates processes and
 * containers and verifies they're gone").
 *
 *   Pi processes, systemd isolation (Linux)   every process in the Pi slice's control group, recursively (the slice's
 *                                             ControlGroup from systemctl, then cgroup.procs of it and every child
 *                                             cgroup under the cgroup v2 mount): SIGKILL each pid, list again, repeat
 *                                             until empty. A process cannot leave its cgroup, so one that escaped its
 *                                             session (setsid, double fork) is still listed and killed. The watchdog
 *                                             unit has CAP_KILL for the Pi user's processes and reads the cgroup tree
 *                                             read-only.
 *   Pi processes, process isolation (Mac)     `ps` for the runner's command line with this deployment's argv marker
 *                                             (src/runner/argv.ts), as the launcher finds them: SIGKILL the process
 *                                             group and the process. A child that left the group would escape this:
 *                                             the weaker local mode (docs/isolation.md).
 *   Containers                                every container labelled pi-durable.managed=1 (`docker ps -a` with the
 *                                             label filter), removed with `docker rm -f`, listed again until none is.
 *
 * A sweep verifies by listing everything again and requiring both lists empty, with a bounded retry; anything still
 * listed, or a list that cannot be read, means the stop is unverified. Scoped to one run (the deadline), the same
 * happens to that run's Pi process (its unit's cgroup, or the processes with its run marker) and the containers with
 * its task and generation labels.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { unitName } from "../coordinator/runner-systemd.ts";
import { LABEL_GENERATION, LABEL_MANAGED, LABEL_TASK, runDocker } from "../coordinator/sandbox/docker.ts";
import { markedProcesses } from "../runner/argv.ts";

/** One run (its Pi process and its containers), for the deadline; undefined everywhere means everything. */
export type Scope = { readonly runId: number; readonly taskId: number; readonly generation: number };

/** One kind of workload: list what is alive (ids as strings; undefined when it cannot be listed), kill a batch. */
export interface Reaper {
	readonly kind: "processes" | "containers";
	list(scope?: Scope): Promise<readonly string[] | undefined>;
	kill(items: readonly string[], scope?: Scope): Promise<void>;
}

export type Reapers = { readonly processes: readonly Reaper[]; readonly containers: readonly Reaper[] };

export type SweepResult = {
	readonly verified: boolean;
	readonly processesKilled: number;
	readonly containersKilled: number;
	/** Still listed at the end; null when the list could not be read. */
	readonly processesLeft: number | null;
	readonly containersLeft: number | null;
	/** A fixed word for the record, never free text. */
	readonly detail: string | null;
};

/** Kill rounds per reaper and pass, and passes of (processes, containers, verify both). */
const ROUNDS = 8;
const PASSES = 3;
const COMMAND_TIMEOUT_MS = 10_000;
const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Delay after the kills of round `round`: 50 ms, doubling, at most 500 ms. */
const roundDelay = (round: number): number => Math.min(50 * 2 ** round, 500);

async function safeList(reaper: Reaper, scope: Scope | undefined): Promise<readonly string[] | undefined> {
	try {
		return await reaper.list(scope);
	} catch {
		return undefined;
	}
}

async function safeKill(reaper: Reaper, items: readonly string[], scope: Scope | undefined): Promise<void> {
	try {
		await reaper.kill(items, scope);
	} catch {
		// What survives is listed again.
	}
}

type Tally = { readonly killed: Set<string>; left: number | null };
type Left = { readonly processes: number | null; readonly containers: number | null };

/** What the last list of a reaper left in the tally: its count, or null when it could not list. */
function settle(tally: Tally, alive: readonly string[] | undefined): void {
	if (alive === undefined) tally.left = null;
	else if (tally.left !== null) tally.left += alive.length;
}

/** Kill what the reaper lists, list again, repeat (bounded); counts every item seen alive into `tally.killed`. */
async function reapOne(reaper: Reaper, scope: Scope | undefined, tally: Tally, onProgress: () => void): Promise<void> {
	for (let round = 0; ; round++) {
		const alive = await safeList(reaper, scope);
		onProgress();
		if (alive === undefined || alive.length === 0 || round >= ROUNDS) {
			settle(tally, alive);
			return;
		}
		for (const item of alive) tally.killed.add(item);
		await safeKill(reaper, alive, scope);
		await sleep(roundDelay(round));
	}
}

async function reapAll(reapers: readonly Reaper[], scope: Scope | undefined, tally: Tally, onProgress: () => void) {
	tally.left = 0;
	for (const reaper of reapers) await reapOne(reaper, scope, tally, onProgress);
}

/** How many items all reapers list now; null if any cannot list. */
async function countAll(reapers: readonly Reaper[], scope: Scope | undefined): Promise<number | null> {
	let total = 0;
	for (const reaper of reapers) {
		const alive = await safeList(reaper, scope);
		if (alive === undefined) return null;
		total += alive.length;
	}
	return total;
}

function detailOf(left: Left): string | null {
	if (left.processes === null) return "processes_unlistable";
	if (left.containers === null) return "containers_unlistable";
	if (left.processes > 0) return "processes_left";
	return left.containers > 0 ? "containers_left" : null;
}

/** One pass: kill processes until none is listed, then containers; if both came out empty, list both again. */
async function sweepPass(
	reapers: Reapers,
	scope: Scope | undefined,
	tallies: { readonly processes: Tally; readonly containers: Tally },
	onProgress: () => void,
): Promise<Left> {
	await reapAll(reapers.processes, scope, tallies.processes, onProgress);
	await reapAll(reapers.containers, scope, tallies.containers, onProgress);
	if (tallies.processes.left !== 0 || tallies.containers.left !== 0)
		return { processes: tallies.processes.left, containers: tallies.containers.left };
	// Verify: both lists again, together, after both kinds were reaped (a process may have started a container).
	return { processes: await countAll(reapers.processes, scope), containers: await countAll(reapers.containers, scope) };
}

/**
 * Kill every Pi process and container in `scope` (everything when undefined) and verify both are gone: up to PASSES
 * passes (sweepPass); verified only when both final lists are empty. Never throws. `onProgress` is called between
 * steps (the heartbeat's liveness signal).
 */
export async function sweep(reapers: Reapers, scope?: Scope, onProgress: () => void = () => {}): Promise<SweepResult> {
	const tallies = {
		processes: { killed: new Set<string>(), left: 0 },
		containers: { killed: new Set<string>(), left: 0 },
	};
	let left: Left = { processes: null, containers: null };
	for (let pass = 0; pass < PASSES; pass++) {
		left = await sweepPass(reapers, scope, tallies, onProgress);
		const done = left.processes === 0 && left.containers === 0;
		if (done || left.processes === null || left.containers === null) break;
	}
	const verified = left.processes === 0 && left.containers === 0;
	return {
		verified,
		processesKilled: tallies.processes.killed.size,
		containersKilled: tallies.containers.killed.size,
		processesLeft: left.processes,
		containersLeft: left.containers,
		detail: verified ? null : detailOf(left),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Pi processes found by their argv markers (process isolation; also a second net under systemd isolation)

function run(command: string, args: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
	return new Promise((resolve) => {
		execFile(
			command,
			[...args],
			{
				encoding: "utf8",
				timeout: COMMAND_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
				env: { PATH: process.env.PATH ?? FALLBACK_PATH },
			},
			(error, stdout) => resolve({ ok: error === null, stdout: typeof stdout === "string" ? stdout : "" }),
		);
	});
}

function killQuietly(target: number): void {
	try {
		process.kill(target, "SIGKILL");
	} catch {
		// Gone already, or not ours (it stays listed and the sweep is unverified).
	}
}

/**
 * Pi processes of `deployment` by command line: the runner's entry plus this deployment's marker (and the run's, when
 * scoped), never this process. Kill = SIGKILL of the process group (a Pi process leads its own) and of the process.
 */
export function markerProcessReaper(options: { readonly deployment: string }): Reaper {
	const { deployment } = options;
	return {
		kind: "processes",
		async list(scope) {
			const listing = await run("ps", ["-A", "-ww", "-o", "pid=,command="]);
			if (!listing.ok) return undefined;
			return markedProcesses(listing.stdout, deployment, process.pid)
				.filter((found) => scope === undefined || found.runId === scope.runId)
				.map((found) => String(found.pid));
		},
		async kill(items) {
			for (const pid of items.map(Number).filter((value) => Number.isInteger(value) && value > 1)) {
				killQuietly(-pid);
				killQuietly(pid);
			}
		},
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Pi processes in the Pi slice's control group (systemd isolation)

export type SliceReaperOptions = {
	readonly slice: string;
	readonly deployment: string;
	/** SYSTEMCTL_BIN: an absolute path or a name looked up on PATH. */
	readonly systemctl: string;
	/** TEST ONLY (never from configuration): the cgroup mount; default /sys/fs/cgroup. */
	readonly cgroupRoot?: string;
	/** TEST ONLY: how one pid is killed; default SIGKILL. */
	readonly signal?: (pid: number) => void;
};

const CONTROL_GROUP = /^\/[\w.@:+/-]*$/;

/** systemd's path of a slice: dashes are its hierarchy, `a-b.slice` is `a.slice/a-b.slice`. */
export function slicePath(slice: string): string {
	const parts = slice.replace(/\.slice$/, "").split("-");
	return parts.map((_, index) => `${parts.slice(0, index + 1).join("-")}.slice`).join("/");
}

const exists = (path: string): Promise<boolean> =>
	stat(path).then(
		() => true,
		() => false,
	);

/** The cgroup v2 hierarchy systemd tracks units in: the mount itself, or `unified` on a hybrid host. */
async function unifiedRoot(root: string): Promise<string | undefined> {
	if (await exists(join(root, "cgroup.controllers"))) return root;
	const hybrid = join(root, "unified");
	return (await exists(join(hybrid, "cgroup.controllers"))) ? hybrid : undefined;
}

/** The slice's cgroup directory; null when the slice has none (nothing runs in it); undefined when unknown. */
async function sliceDirectory(options: SliceReaperOptions): Promise<string | null | undefined> {
	const shown = await run(options.systemctl, [
		"--no-ask-password",
		"show",
		"--property=ControlGroup",
		"--value",
		"--",
		options.slice,
	]);
	if (!shown.ok) return undefined;
	const value = shown.stdout.trim() || `/${slicePath(options.slice)}`;
	if (!CONTROL_GROUP.test(value) || value.split("/").includes("..")) return undefined;
	const root = await unifiedRoot(options.cgroupRoot ?? "/sys/fs/cgroup");
	if (root === undefined) return undefined;
	const dir = join(root, value);
	return (await exists(dir)) ? dir : null;
}

type CgroupListing = { readonly pids: readonly string[]; readonly children: readonly string[] } | "gone" | undefined;

async function readCgroup(dir: string): Promise<CgroupListing> {
	try {
		const procs = await readFile(join(dir, "cgroup.procs"), "utf8");
		const entries = await readdir(dir, { withFileTypes: true });
		return {
			pids: procs.split("\n").filter((line) => /^[1-9]\d*$/.test(line.trim())),
			children: entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name)),
		};
	} catch (error) {
		// A unit's cgroup disappears when the unit is collected: then nothing is left in it.
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : undefined;
	}
}

/** Every pid in `dir` and the cgroups below it; undefined when a part of the tree cannot be read. */
async function cgroupPids(dir: string): Promise<string[] | undefined> {
	const pids: string[] = [];
	const pending = [dir];
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		const listing = await readCgroup(next);
		if (listing === undefined) return undefined;
		if (listing === "gone") continue;
		pids.push(...listing.pids.map((pid) => pid.trim()));
		pending.push(...listing.children);
	}
	return pids;
}

/** Everything in the Pi slice (or, scoped, in the run's unit), by cgroup membership. */
export function sliceProcessReaper(options: SliceReaperOptions): Reaper {
	const signal = options.signal ?? ((pid: number) => process.kill(pid, "SIGKILL"));
	return {
		kind: "processes",
		async list(scope) {
			const slice = await sliceDirectory(options);
			if (slice === null || slice === undefined) return slice === null ? [] : undefined;
			const dir =
				scope === undefined ? slice : join(slice, unitName(options.deployment, scope.runId, scope.generation));
			return cgroupPids(dir);
		},
		async kill(items) {
			for (const pid of items.map(Number).filter((value) => Number.isInteger(value) && value > 1)) {
				try {
					signal(pid);
				} catch {
					// Gone already; a pid that cannot be killed stays listed and the sweep is unverified.
				}
			}
		},
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Containers labelled pi-durable.managed=1

function labelFilters(scope: Scope | undefined): string[] {
	const filters = ["--filter", `label=${LABEL_MANAGED}=1`];
	if (scope !== undefined) {
		filters.push("--filter", `label=${LABEL_TASK}=${scope.taskId}`);
		filters.push("--filter", `label=${LABEL_GENERATION}=${scope.generation}`);
	}
	return filters;
}

/** Every managed container (or, scoped, those of the run's task and generation), through the docker CLI. */
export function dockerContainerReaper(options: { readonly bin: string }): Reaper {
	return {
		kind: "containers",
		async list(scope) {
			const output = await runDocker(options.bin, ["ps", "-aq", "--no-trunc", ...labelFilters(scope)]);
			if (output.code !== 0) return undefined;
			return output.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => /^[0-9a-f]{12,64}$/.test(line));
		},
		async kill(items) {
			for (let index = 0; index < items.length; index += 32) {
				await runDocker(options.bin, ["rm", "-f", ...items.slice(index, index + 32)], { timeoutMs: 60_000 });
			}
		},
	};
}
