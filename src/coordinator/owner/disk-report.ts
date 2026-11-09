/**
 * The disk part of `owner status` (Capacity § Disk; Deployment § Disk and Data): free space of the boot disk and the
 * task disk with the limits the Coordinator applies, and what each boot-disk budget holds now. Sizes and counts only.
 *
 * STUB(spec: capacity.md § Disk "separate budgets for retained trials, metadata-only logs, Pi's raw-content store and
 * the database, each with a retention rule"): the usage of each is reported here, but no budget size is set and no
 * retention rule deletes anything: conversations and the database grow until a trial reset (not built), logs follow
 * journald's own retention on the VM, and the sealed snapshots of trial evaluations (on the task disk,
 * engine/snapshot.ts) are kept. The boot disk's free-space floor (new tasks rejected) is the only boot-disk limit
 * enforced.
 *
 * The folders are walked asynchronously (treeBytes): `owner status` runs inside the Coordinator, whose event loop (the
 * poller, the relay, the runs) must not stall while a task folder that is not a mount point is measured.
 */
import { statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CoordinatorConfig } from "../config.ts";
import {
	type DiskSettings,
	diskSettings,
	EXECUTION_DISK_WAIT_KEY,
	isMountPoint,
	statfsSpace,
	TASK_DISK_WAIT_KEY,
	treeBytes,
} from "../disk.ts";
import { SNAPSHOTS_DIR } from "../engine/snapshot.ts";
import { DEMO_LIMITS } from "../limits.ts";
import { formatBytes } from "../messages.ts";
import type { Store } from "../store.ts";

const UNMEASURED = "cannot be measured";

/** `measure()` formatted, or "cannot be measured" if it throws. */
function measured(measure: () => string): string {
	try {
		return measure();
	} catch {
		return UNMEASURED;
	}
}

/** `measure()` formatted, or "cannot be measured" if it fails. */
async function measuredAsync(measure: () => Promise<string>): Promise<string> {
	try {
		return await measure();
	} catch {
		return UNMEASURED;
	}
}

/** The names in `dir`, or undefined if it does not exist; other errors throw. */
async function namesIn(dir: string): Promise<string[] | undefined> {
	try {
		return await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Bytes under `dir` (0 if it does not exist). */
async function bytesUnder(dir: string): Promise<number> {
	return (await namesIn(dir)) === undefined ? 0 : treeBytes(dir);
}

function fileBytes(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function bootLine(dataDir: string, settings: DiskSettings): string {
	const space = measured(() => {
		const { free, size } = statfsSpace(dataDir);
		return `${formatBytes(free)} free of ${formatBytes(size)}`;
	});
	const floor = formatBytes(settings.bootMinFreeBytes);
	return `Boot disk (PI_DATA_DIR): ${space}; new tasks are rejected below ${floor} free`;
}

function databaseLine(dataDir: string): string {
	const db = join(dataDir, "coordinator.sqlite");
	const bytes = fileBytes(db) + fileBytes(`${db}-wal`) + fileBytes(`${db}-shm`);
	return `  Database (coordinator.sqlite with its WAL): ${formatBytes(bytes)}; no retention rule enforced yet`;
}

async function piStoreLine(store: Store, dataDir: string): Promise<string> {
	const conversations = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations")?.n ?? 0;
	const dir = join(dataDir, "conversations");
	const size = await measuredAsync(async () => {
		const names = await namesIn(dir);
		const bytes = names === undefined ? 0 : await treeBytes(dir);
		return `${formatBytes(bytes)} in ${names?.length ?? 0} files`;
	});
	return (
		`  Pi raw-content store (conversations/): ${size}, ${conversations} conversations; no retention rule enforced ` +
		"yet (raw content is kept for the trial; trial reset is not built)"
	);
}

async function taskLine(store: Store, taskDir: string, settings: DiskSettings): Promise<string> {
	const mounted = await isMountPoint(taskDir).catch(() => false);
	const space = await measuredAsync(async () => {
		const { free, size, used } = statfsSpace(taskDir);
		// A mount point: the filesystem's usage (Docker's data included); else what is under PI_TASK_DIR.
		const inUse = mounted ? formatBytes(used) : `${formatBytes(await bytesUnder(taskDir))} under PI_TASK_DIR`;
		return `${formatBytes(free)} free of ${formatBytes(size)}, ${inUse} in use`;
	});
	const worktrees = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE worktree_path IS NOT NULL")?.n ?? 0;
	const budget =
		settings.taskBudgetBytes === undefined ? "none (the disk's own size)" : formatBytes(settings.taskBudgetBytes);
	return (
		`Task disk (PI_TASK_DIR${mounted ? ", a mount point" : ", not a mount point"}): ${space}; ${worktrees} worktrees; ` +
		`budget ${budget}; a new worktree needs its files + ${formatBytes(settings.worktreeHeadroomBytes)} headroom and ` +
		`${formatBytes(settings.taskMinFreeBytes)} must stay free`
	);
}

/** The retained trials: the sealed snapshots on the task disk (kept: no retention rule). */
async function snapshotsLine(store: Store, taskDir: string): Promise<string> {
	const evaluations =
		store.get<{ n: number }>("SELECT COUNT(*) AS n FROM evaluations WHERE snapshot_path IS NOT NULL")?.n ?? 0;
	const size = await measuredAsync(async () => formatBytes(await bytesUnder(join(taskDir, SNAPSHOTS_DIR))));
	return (
		`  Retained trials (PI_TASK_DIR/${SNAPSHOTS_DIR}): ${evaluations} sealed snapshot${evaluations === 1 ? "" : "s"}, ` +
		`${size}; kept, no retention rule enforced yet (trial reset is not built)`
	);
}

/** What the disk lines need: the Coordinator's configuration, or the owner CLI's (no secrets). */
export type DiskReportConfig = {
	readonly paths: { readonly dataDir: string; readonly taskDir: string };
	readonly disk: CoordinatorConfig["disk"];
};

/** The disk lines of `owner status`. */
export async function diskReport(store: Store, config: DiskReportConfig): Promise<string[]> {
	const settings = diskSettings(config, DEMO_LIMITS);
	const { dataDir, taskDir } = config.paths;
	const lines = [
		bootLine(dataDir, settings),
		databaseLine(dataDir),
		await piStoreLine(store, dataDir),
		"  Metadata logs: stdout and stderr (journald on the VM, with its own retention); not on PI_DATA_DIR, not measured",
		await taskLine(store, taskDir, settings),
		await snapshotsLine(store, taskDir),
	];
	const held = store.getMeta(TASK_DISK_WAIT_KEY);
	if (held !== undefined) lines.push(`  New worktrees are held: ${held}`);
	const pressure = store.getMeta(EXECUTION_DISK_WAIT_KEY)?.split("|").slice(1).join("|");
	if (pressure !== undefined) lines.push(`  All execution is held: ${pressure}`);
	return lines;
}
