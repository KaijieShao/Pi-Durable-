/**
 * The disk part of `owner status` (Capacity § Disk; Deployment § Disk and Data): free space of the boot disk and the
 * task disk with the limits the Coordinator applies, and what each boot-disk budget holds now. Sizes and counts only.
 *
 * STUB(spec: capacity.md § Disk "separate budgets for retained trials, metadata-only logs, Pi's raw-content store and
 * the database, each with a retention rule"): the usage of each is reported here, but no budget size is set and no
 * retention rule deletes anything: conversations and the database grow until a trial reset (not built), logs follow
 * journald's own retention on the VM, and there are no retained trials (sealing is not built). The boot disk's
 * free-space floor (new tasks rejected) is the only boot-disk limit enforced.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorConfig } from "../coordinator/config.ts";
import {
	type DiskSettings,
	diskSettings,
	isMountPointSync,
	statfsSpace,
	TASK_DISK_WAIT_KEY,
	treeBytesSync,
} from "../coordinator/disk.ts";
import { DEMO_LIMITS } from "../coordinator/limits.ts";
import { formatBytes } from "../coordinator/messages.ts";
import type { Store } from "../coordinator/store.ts";

const UNMEASURED = "cannot be measured";

/** `measure()` formatted, or "cannot be measured" if it throws. */
function measured(measure: () => string): string {
	try {
		return measure();
	} catch {
		return UNMEASURED;
	}
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

function piStoreLine(store: Store, dataDir: string): string {
	const conversations = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations")?.n ?? 0;
	const dir = join(dataDir, "conversations");
	const size = measured(() => {
		const bytes = treeBytesSync(dir);
		const files = bytes === undefined ? 0 : readdirSync(dir).length;
		return `${formatBytes(bytes ?? 0)} in ${files} files`;
	});
	return (
		`  Pi raw-content store (conversations/): ${size}, ${conversations} conversations; no retention rule enforced ` +
		"yet (raw content is kept for the trial; trial reset is not built)"
	);
}

function taskLine(store: Store, taskDir: string, settings: DiskSettings): string {
	const mounted = isMountPointSync(taskDir);
	const space = measured(() => {
		const { free, size, used } = statfsSpace(taskDir);
		// A mount point: the filesystem's usage (Docker's data included); else what is under PI_TASK_DIR.
		const inUse = mounted ? formatBytes(used) : `${formatBytes(treeBytesSync(taskDir) ?? 0)} under PI_TASK_DIR`;
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

/** The disk lines of `owner status`. */
export function diskReport(store: Store, config: CoordinatorConfig): string[] {
	const settings = diskSettings(config, DEMO_LIMITS);
	const { dataDir, taskDir } = config.paths;
	const lines = [
		bootLine(dataDir, settings),
		databaseLine(dataDir),
		piStoreLine(store, dataDir),
		"  Metadata logs: stdout and stderr (journald on the VM, with its own retention); not on PI_DATA_DIR, not measured",
		"  Retained trials: none (sealing and trial reset are not built)",
		taskLine(store, taskDir, settings),
	];
	const held = store.getMeta(TASK_DISK_WAIT_KEY);
	if (held !== undefined) lines.push(`  New worktrees are held: ${held}`);
	return lines;
}
