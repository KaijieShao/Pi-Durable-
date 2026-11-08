/**
 * The Coordinator's two disks (Capacity § Disk; Deployment § Disk and Data).
 *
 * - The boot disk holds PI_DATA_DIR: the Coordinator database, the outbox, Pi's conversation stores (and, on the VM,
 *   the logs). "When its free space runs low, new tasks are rejected with a reason": a /task is refused while the
 *   filesystem of PI_DATA_DIR has less than `bootMinFreeBytes` free (commands.ts). Follow-ups, /status, /cancel and
 *   /approve are not affected.
 * - The task disk holds PI_TASK_DIR: the git repository, one worktree per open task, check scratch space (and, on the
 *   VM, Docker's data). "If a new worktree would exceed it, the task stays queued and the bot says why": before a new
 *   worktree is created, its size is estimated (the checkout's files, each rounded up to 4 KiB blocks, plus
 *   `worktreeHeadroomBytes` for dependencies and build output). It is created only if at least `taskMinFreeBytes`
 *   stays free after it and, with a budget, the task disk's usage plus it stays within `taskBudgetBytes`
 *   (engine/task-disk.ts). Without a budget the task disk's own size is the budget: on the VM it is a disk of its
 *   own, sized by the stress test. The usage is the filesystem's when PI_TASK_DIR is a mount point (Docker's data
 *   included), else everything under PI_TASK_DIR.
 *
 * A measurement that fails counts as "no room" (fails closed). Only sizes are measured: no file is read.
 */
import { lstatSync, readdirSync, statfsSync, statSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CoordinatorConfig } from "./config.ts";
import type { Limits } from "./limits.ts";
import { bootDiskLow, bootDiskUnknown, type TaskDiskShortfall } from "./messages.ts";

export type { TaskDiskShortfall } from "./messages.ts";

/** A filesystem's sizes in bytes. */
export type DiskSpace = {
	/** What an unprivileged user may still write (statfs bavail). */
	readonly free: number;
	readonly size: number;
	/** In use: the size less every free block (root's reserve counts as free). */
	readonly used: number;
};

/**
 * How the disks are measured. Production: `systemDiskProbe`. Tests inject another one through
 * CoordinatorDeps.diskProbe (not reachable from the configuration).
 */
export type DiskProbe = {
	/**
	 * The filesystem holding `path`, or its nearest existing parent. Synchronous: commands read it before their
	 * transaction. Throws if it cannot be read.
	 */
	readonly space: (path: string) => DiskSpace;
	/** True if `path` is a mount point (its device differs from its parent's). */
	readonly isMountPoint: (path: string) => Promise<boolean>;
	/** Bytes taken by everything under `path`; throws if any of it cannot be listed. */
	readonly treeBytes: (path: string) => Promise<number>;
};

/** The effective disk limits: the configuration's, else DEMO_LIMITS'. */
export type DiskSettings = {
	readonly bootMinFreeBytes: number;
	readonly taskMinFreeBytes: number;
	readonly taskBudgetBytes: number | undefined;
	readonly worktreeHeadroomBytes: number;
};

export function diskSettings(config: CoordinatorConfig, limits: Limits): DiskSettings {
	const { disk } = config;
	return {
		bootMinFreeBytes: disk.bootMinFreeBytes ?? limits.minFreeDiskBytes,
		taskMinFreeBytes: disk.taskMinFreeBytes ?? limits.minFreeDiskBytes,
		taskBudgetBytes: disk.taskBudgetBytes,
		worktreeHeadroomBytes: disk.worktreeHeadroomBytes ?? limits.worktreeHeadroomBytes,
	};
}

/**
 * Meta key holding why new worktrees wait (taskDiskDetail()) while the engine holds them; read by /status and the
 * /task acknowledgement (commands.ts). Cleared when the hold is lifted and at every Coordinator start.
 */
export const TASK_DISK_WAIT_KEY = "task_disk_wait";

/** Meta key set once a first run was told why it waits for the task disk: the bot says it once per task. */
export function taskDiskToldKey(runId: number): string {
	return `wait_noted:disk:${runId}`;
}

/** A walk stops (and counts as unmeasurable) beyond this many entries. */
const MAX_TREE_ENTRIES = 2_000_000;

/** statfs of `path`, or of its nearest existing parent (a directory not created yet). */
export function statfsSpace(path: string): DiskSpace {
	let current = resolve(path);
	for (;;) {
		try {
			const stats = statfsSync(current);
			const block = Number(stats.bsize);
			const size = Number(stats.blocks) * block;
			return { free: Number(stats.bavail) * block, size, used: size - Number(stats.bfree) * block };
		} catch (error) {
			const parent = dirname(current);
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) throw error;
			current = parent;
		}
	}
}

export async function isMountPoint(path: string): Promise<boolean> {
	const target = resolve(path);
	return (await stat(target)).dev !== (await stat(dirname(target))).dev;
}

/** One entry's bytes: the larger of its apparent size and its allocated blocks (conservative for both). */
function entryBytes(stats: { size: number; blocks: number }): number {
	return Math.max(stats.size, stats.blocks * 512);
}

/** Bytes under `root` (symlinks are not followed); throws if a directory cannot be listed. */
export async function treeBytes(root: string): Promise<number> {
	let total = 0;
	let entries = 0;
	const pending = [resolve(root)];
	for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
		const names = await readdir(dir);
		entries += names.length;
		if (entries > MAX_TREE_ENTRIES) throw new Error("too many files to measure");
		const stats = await Promise.all(names.map((name) => lstat(join(dir, name))));
		stats.forEach((entry, index) => {
			total += entryBytes(entry);
			if (entry.isDirectory()) pending.push(join(dir, names[index] as string));
		});
	}
	return total;
}

/** treeBytes for the owner CLI (synchronous); undefined if `root` does not exist. */
export function treeBytesSync(root: string): number | undefined {
	let total = 0;
	let entries = 0;
	const pending = [resolve(root)];
	try {
		lstatSync(pending[0] as string);
	} catch {
		return undefined;
	}
	for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
		const names = readdirSync(dir);
		entries += names.length;
		if (entries > MAX_TREE_ENTRIES) throw new Error("too many files to measure");
		for (const name of names) {
			const entry = lstatSync(join(dir, name));
			total += entryBytes(entry);
			if (entry.isDirectory()) pending.push(join(dir, name));
		}
	}
	return total;
}

/** True if `path` is a mount point (synchronous, for the owner CLI); false if it cannot be read. */
export function isMountPointSync(path: string): boolean {
	try {
		const target = resolve(path);
		return statSync(target).dev !== statSync(dirname(target)).dev;
	} catch {
		return false;
	}
}

export const systemDiskProbe: DiskProbe = { space: statfsSpace, isMountPoint, treeBytes };

function finite(space: DiskSpace): boolean {
	return [space.free, space.size, space.used].every((value) => Number.isFinite(value) && value >= 0);
}

export type BootDiskCheck =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: "boot_disk_low" | "boot_disk_unknown"; readonly reason: string };

/** Capacity § Disk: new tasks are rejected while the boot disk is low (fail closed if it cannot be read). */
export function checkBootDisk(probe: DiskProbe, dataDir: string, minFree: number): BootDiskCheck {
	let space: DiskSpace;
	try {
		space = probe.space(dataDir);
	} catch {
		return { ok: false, code: "boot_disk_unknown", reason: bootDiskUnknown() };
	}
	if (!finite(space)) return { ok: false, code: "boot_disk_unknown", reason: bootDiskUnknown() };
	if (space.free < minFree) return { ok: false, code: "boot_disk_low", reason: bootDiskLow(space.free, minFree) };
	return { ok: true };
}

export type WorktreeRoom =
	| { readonly ok: true; readonly needed: number }
	| { readonly ok: false; readonly shortfall: TaskDiskShortfall };

export type TaskDiskInput = {
	readonly probe: DiskProbe;
	readonly taskDir: string;
	readonly settings: DiskSettings;
	/** The checkout's bytes (Git.checkoutBytes of the base the worktree starts from). */
	readonly checkoutBytes: () => Promise<number>;
};

export type WorktreeRoomInput = TaskDiskInput & {
	/** New worktrees already let through and still being created (with their setup): each is counted at this size. */
	readonly pending: number;
};

/** What one more worktree is decided on. */
export type TaskDiskMeasure = {
	/** The new worktree's estimate: its checkout plus the headroom. */
	readonly needed: number;
	/** The task disk's free space. */
	readonly free: number;
	/** The task disk's usage; measured only with a budget. */
	readonly used: number | undefined;
};

async function usage(probe: DiskProbe, taskDir: string, space: DiskSpace): Promise<number> {
	return (await probe.isMountPoint(taskDir)) ? space.used : probe.treeBytes(taskDir);
}

/** Measure the task disk for one more worktree; undefined if anything cannot be measured (fails closed). */
export async function measureTaskDisk(input: TaskDiskInput): Promise<TaskDiskMeasure | undefined> {
	const { probe, taskDir, settings } = input;
	try {
		const needed = (await input.checkoutBytes()) + settings.worktreeHeadroomBytes;
		const space = probe.space(taskDir);
		const used = settings.taskBudgetBytes === undefined ? undefined : await usage(probe, taskDir, space);
		if (!finite(space) || !Number.isFinite(needed) || (used !== undefined && !Number.isFinite(used))) return undefined;
		return { needed, free: space.free, used };
	} catch {
		return undefined;
	}
}

/**
 * Whether one more worktree fits, decided synchronously from a measurement: at least `taskMinFreeBytes` stays free
 * after it and the `pending` ones, and with a budget the task disk's usage plus them stays within it. The engine
 * decides and lets the worktree through in one synchronous step, so two concurrent checks never count on the same
 * room.
 */
export function worktreeRoom(
	measure: TaskDiskMeasure | undefined,
	settings: DiskSettings,
	pending: number,
): WorktreeRoom {
	if (measure === undefined) return { ok: false, shortfall: { kind: "unknown" } };
	const { needed } = measure;
	const reserved = needed * pending;
	const free = Math.max(0, measure.free - reserved);
	const floor = settings.taskMinFreeBytes;
	if (free - needed < floor) return { ok: false, shortfall: { kind: "floor", needed, free, floor } };
	const budget = settings.taskBudgetBytes;
	if (budget === undefined) return { ok: true, needed };
	if (measure.used === undefined) return { ok: false, shortfall: { kind: "unknown" } };
	const used = measure.used + reserved;
	if (used + needed > budget) return { ok: false, shortfall: { kind: "budget", needed, used, budget } };
	return { ok: true, needed };
}

/** measureTaskDisk, then worktreeRoom with `pending`. Any failed measurement is "unknown" (no room). */
export async function newWorktreeRoom(input: WorktreeRoomInput): Promise<WorktreeRoom> {
	return worktreeRoom(await measureTaskDisk(input), input.settings, input.pending);
}
