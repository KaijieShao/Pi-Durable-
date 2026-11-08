/**
 * The disk measurements and checks (src/coordinator/disk.ts; Capacity § Disk): the system probe on a real temp
 * directory, the boot disk check behind /task, and whether one more worktree fits on the task disk.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	checkBootDisk,
	type DiskProbe,
	type DiskSettings,
	diskSettings,
	isMountPointSync,
	newWorktreeRoom,
	systemDiskProbe,
	treeBytesSync,
} from "../../src/coordinator/disk.ts";
import type { Ctx } from "../../src/coordinator/engine/context.ts";
import { measureNewWorktree, roomForNewWorktree } from "../../src/coordinator/engine/task-disk.ts";
import { DEMO_LIMITS } from "../../src/coordinator/limits.ts";
import { formatBytes, taskDiskDetail, taskDiskWait } from "../../src/coordinator/messages.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const roots: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pd-disk-"));
	roots.push(dir);
	return dir;
}

after(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

type ProbeState = { free: number; size: number; used: number; mount: boolean; tree: number; fail?: "space" | "tree" };

function probe(state: ProbeState): DiskProbe {
	return {
		space: () => {
			if (state.fail === "space") throw new Error("EIO");
			return { free: state.free, size: state.size, used: state.used };
		},
		isMountPoint: async () => state.mount,
		treeBytes: async () => {
			if (state.fail === "tree") throw new Error("EACCES");
			return state.tree;
		},
	};
}

const SETTINGS: DiskSettings = {
	bootMinFreeBytes: GiB,
	taskMinFreeBytes: GiB,
	taskBudgetBytes: undefined,
	worktreeHeadroomBytes: 512 * MiB,
};

test("system probe: statfs of a directory (or its nearest existing parent), a directory walk, no mount point", async () => {
	const dir = tempDir();
	const space = systemDiskProbe.space(dir);
	assert.ok(space.size > 0 && space.free > 0 && space.used > 0 && space.free <= space.size, JSON.stringify(space));
	const missing = systemDiskProbe.space(join(dir, "not", "created", "yet"));
	assert.equal(missing.size, space.size, "measured at the nearest existing parent");
	assert.equal(await systemDiskProbe.isMountPoint(dir), false);
	assert.equal(isMountPointSync(dir), false);
	assert.equal(isMountPointSync(join(dir, "missing")), false);

	mkdirSync(join(dir, "a", "b"), { recursive: true });
	writeFileSync(join(dir, "a", "one.bin"), Buffer.alloc(100_000, 1));
	writeFileSync(join(dir, "a", "b", "two.bin"), Buffer.alloc(30_000, 2));
	symlinkSync("/", join(dir, "a", "root-link"));
	const walked = await systemDiskProbe.treeBytes(dir);
	assert.ok(walked >= 130_000, `${walked} counts both files`);
	assert.ok(walked < 1024 * 1024, `${walked}: the symlink to / is not followed`);
	assert.equal(treeBytesSync(dir), walked, "the owner CLI's walk agrees");
	assert.equal(treeBytesSync(join(dir, "missing")), undefined);
	await assert.rejects(systemDiskProbe.treeBytes(join(dir, "missing")), /ENOENT/);
	assert.throws(() => systemDiskProbe.space("\0bad"));
});

test("disk settings: the configuration's values, else DEMO_LIMITS'", () => {
	const unset = { bootMinFreeBytes: undefined, taskMinFreeBytes: undefined, taskBudgetBytes: undefined };
	const config = { disk: { ...unset, worktreeHeadroomBytes: undefined } } as Parameters<typeof diskSettings>[0];
	assert.deepEqual(diskSettings(config, DEMO_LIMITS), {
		bootMinFreeBytes: GiB,
		taskMinFreeBytes: GiB,
		taskBudgetBytes: undefined,
		worktreeHeadroomBytes: GiB,
	});
	const set = {
		disk: { bootMinFreeBytes: 2, taskMinFreeBytes: 3, taskBudgetBytes: 4, worktreeHeadroomBytes: 0 },
	} as Parameters<typeof diskSettings>[0];
	assert.deepEqual(diskSettings(set, DEMO_LIMITS), {
		bootMinFreeBytes: 2,
		taskMinFreeBytes: 3,
		taskBudgetBytes: 4,
		worktreeHeadroomBytes: 0,
	});
});

test("boot disk check: below the floor rejects with free and required; unreadable or not a number fails closed", () => {
	const state: ProbeState = { free: 5 * GiB, size: 20 * GiB, used: 15 * GiB, mount: false, tree: 0 };
	assert.deepEqual(checkBootDisk(probe(state), "/data", GiB), { ok: true });
	state.free = GiB;
	assert.deepEqual(checkBootDisk(probe(state), "/data", GiB), { ok: true }, "exactly at the floor");
	state.free = GiB - 1;
	const low = checkBootDisk(probe(state), "/data", GiB);
	assert.equal(low.ok, false);
	assert.equal(!low.ok && low.code, "boot_disk_low");
	assert.match(!low.ok ? low.reason : "", /^the boot disk is low on free space: 1024\.0 MiB free, at least 1\.0 GiB/);
	state.fail = "space";
	const broken = checkBootDisk(probe(state), "/data", GiB);
	assert.equal(!broken.ok && broken.code, "boot_disk_unknown");
	state.fail = undefined;
	state.free = Number.NaN;
	assert.equal(checkBootDisk(probe(state), "/data", GiB).ok, false);
	state.free = -1;
	assert.equal(checkBootDisk(probe(state), "/data", GiB).ok, false);
});

test("a new worktree fits only if the free-space floor stays free after it (and after the pending ones)", async () => {
	const state: ProbeState = { free: 10 * GiB, size: 50 * GiB, used: 40 * GiB, mount: true, tree: 0 };
	const room = (pending = 0, checkout = 100 * MiB) =>
		newWorktreeRoom({
			probe: probe(state),
			taskDir: "/tasks",
			settings: SETTINGS,
			checkoutBytes: async () => checkout,
			pending,
		});
	assert.deepEqual(await room(), { ok: true, needed: 612 * MiB });
	state.free = GiB + 612 * MiB;
	assert.deepEqual(await room(), { ok: true, needed: 612 * MiB }, "exactly the floor stays free");
	state.free = GiB + 611 * MiB;
	assert.deepEqual(await room(), {
		ok: false,
		shortfall: { kind: "floor", needed: 612 * MiB, free: GiB + 611 * MiB, floor: GiB },
	});
	// Two worktrees already let through and still being created count at the same size.
	state.free = 2.5 * GiB;
	assert.equal((await room(0)).ok, true);
	assert.equal((await room(1)).ok, true);
	const pending = await room(2);
	assert.deepEqual(pending, {
		ok: false,
		shortfall: { kind: "floor", needed: 612 * MiB, free: 2.5 * GiB - 2 * 612 * MiB, floor: GiB },
	});
	// Unmeasurable: statfs fails, the checkout's size cannot be read, a number is not finite.
	state.fail = "space";
	assert.deepEqual(await room(), { ok: false, shortfall: { kind: "unknown" } });
	state.fail = undefined;
	await assert.doesNotReject(room());
	const noCheckout = await newWorktreeRoom({
		probe: probe(state),
		taskDir: "/tasks",
		settings: SETTINGS,
		checkoutBytes: async () => {
			throw new Error("git ls-tree failed");
		},
		pending: 0,
	});
	assert.deepEqual(noCheckout, { ok: false, shortfall: { kind: "unknown" } });
	state.free = Number.POSITIVE_INFINITY;
	assert.deepEqual(await room(), { ok: false, shortfall: { kind: "unknown" } });
});

test("a worktree that was being created when a measurement started still counts as pending if it finished meanwhile", async () => {
	// 2.5 GiB free, a 1 GiB floor, each new worktree 1 GiB (no files, 1 GiB headroom): one fits, two do not.
	const state: ProbeState = { free: 2.5 * GiB, size: 50 * GiB, used: 47.5 * GiB, mount: true, tree: 0 };
	const ctx = {
		creatingWorktrees: new Set([7]),
		diskProbe: probe(state),
		config: { paths: { taskDir: "/tasks" } },
		disk: { ...SETTINGS, worktreeHeadroomBytes: GiB },
	} as unknown as Ctx;
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const measuring = measureNewWorktree(ctx, async () => {
		await gate;
		return 0;
	});
	// Run 7's worktree finishes being created while this is measured: what was measured may not hold its files yet.
	ctx.creatingWorktrees.delete(7);
	release();
	const held = roomForNewWorktree(ctx, await measuring);
	assert.deepEqual(held, { ok: false, shortfall: { kind: "floor", needed: GiB, free: 1.5 * GiB, floor: GiB } });
	// Measured after it was created: only what the disk shows counts.
	assert.deepEqual(roomForNewWorktree(ctx, await measureNewWorktree(ctx, async () => 0)), { ok: true, needed: GiB });
	// One let through while this is measured counts too.
	const later = measureNewWorktree(ctx, async () => 0);
	ctx.creatingWorktrees.add(8);
	assert.equal(roomForNewWorktree(ctx, await later).ok, false);
});

test("with a budget: the task disk's usage (the filesystem's on a mount point, else a walk) plus it must fit", async () => {
	const state: ProbeState = { free: 100 * GiB, size: 200 * GiB, used: 18 * GiB, mount: true, tree: 2 * GiB };
	const settings: DiskSettings = { ...SETTINGS, taskBudgetBytes: 20 * GiB };
	const room = (pending = 0) =>
		newWorktreeRoom({
			probe: probe(state),
			taskDir: "/tasks",
			settings,
			checkoutBytes: async () => 512 * MiB,
			pending,
		});
	assert.deepEqual(await room(), { ok: true, needed: GiB }, "18 GiB used + 1 GiB fits in 20 GiB");
	state.used = 19 * GiB + 1;
	assert.deepEqual(await room(), {
		ok: false,
		shortfall: { kind: "budget", needed: GiB, used: 19 * GiB + 1, budget: 20 * GiB },
	});
	// Not a mount point: everything under the task directory is walked instead of the filesystem's usage.
	state.mount = false;
	assert.deepEqual(await room(), { ok: true, needed: GiB }, "2 GiB under PI_TASK_DIR");
	state.tree = 18 * GiB;
	assert.equal((await room(0)).ok, true);
	assert.deepEqual(await room(2), {
		ok: false,
		shortfall: { kind: "budget", needed: GiB, used: 20 * GiB, budget: 20 * GiB },
	});
	state.fail = "tree";
	assert.deepEqual(await room(), { ok: false, shortfall: { kind: "unknown" } }, "a walk that fails: fail closed");
	// The floor is checked first.
	state.fail = undefined;
	state.free = GiB;
	const floor = await room();
	assert.equal(!floor.ok && floor.shortfall.kind, "floor");
});

test("the bot's texts: sizes, the budget left, and what happens next; never a path or task text", () => {
	assert.deepEqual([0, 512, 2048, 5 * MiB + 1, 1.5 * GiB, 3 * 1024 ** 4].map(formatBytes), [
		"0 bytes",
		"512 bytes",
		"2 KiB",
		"5.0 MiB",
		"1.5 GiB",
		"3.0 TiB",
	]);
	assert.equal(formatBytes(-5), "0 bytes");
	assert.equal(
		taskDiskDetail({ kind: "floor", needed: 1.5 * GiB, free: 2 * GiB, floor: GiB }),
		"its new worktree needs about 1.5 GiB on the task disk, but only 2.0 GiB is free and 1.0 GiB must stay free",
	);
	assert.equal(
		taskDiskDetail({ kind: "budget", needed: GiB, used: 19.5 * GiB, budget: 20 * GiB }),
		"its new worktree needs about 1.0 GiB, but the task disk budget of 20.0 GiB has only 512.0 MiB left (19.5 GiB in use)",
	);
	assert.equal(
		taskDiskDetail({ kind: "budget", needed: GiB, used: 21 * GiB, budget: 20 * GiB }),
		"its new worktree needs about 1.0 GiB, but the task disk budget of 20.0 GiB has only 0 bytes left (21.0 GiB in use)",
	);
	assert.match(
		taskDiskWait({ kind: "unknown" }),
		/^the free space of the task disk or the size of its new worktree cannot be measured\. It starts by itself once there is room, for example when another task is merged or cancelled and its worktree is archived$/,
	);
});
