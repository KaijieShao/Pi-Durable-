import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	attachedRetentionInput,
	disposableImage,
	type RetainedBundle,
	type RetentionPolicy,
	retainBundles,
	retentionCandidate,
	retentionMounts,
} from "../../src/maintenance/retention.ts";

const now = 30 * 86400_000;
const detached = async () => ({ mounts: [], backingPaths: [] });
const bundle = (path: string): RetainedBundle => ({
	path,
	kind: "test-artifact",
	completedAt: 0,
	reportPreserved: true,
	pinned: false,
});
const policy = (root: string, bundles: readonly RetainedBundle[]): RetentionPolicy => ({
	roots: [root],
	protectedPaths: [join(root, "task-8"), join(root, "task-9")],
	retentionMs: {
		trial: 7 * 86400_000,
		"test-artifact": 7 * 86400_000,
		archive: 14 * 86400_000,
		"raw-trial-store": 86400_000,
	},
	bundles,
});

test("retention deletes only expired completed disposable bundles; Tasks 8/9, their ancestors, open/pinned/unknown content and remote refs remain", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pd-retention-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const name of ["task-8", "task-9", "old", "active", "pinned", "unknown"]) {
		await mkdir(join(root, name));
		await writeFile(join(root, name, "kept.txt"), name);
	}
	const bundles = [
		bundle(join(root, "task-8")),
		bundle(join(root, "task-9")),
		bundle(root),
		bundle(join(root, "old")),
		{ ...bundle(join(root, "active")), reportPreserved: false },
		{ ...bundle(join(root, "pinned")), pinned: true },
	];
	const config = policy(root, bundles);
	assert.equal(retentionCandidate(config, bundle(`${root}/../outside`), now), false);
	const dry = await retainBundles(config, now, false, detached);
	assert.deepEqual(
		dry.map((r) => r.outcome),
		["kept", "kept", "kept", "candidate", "kept", "kept"],
	);
	assert.equal((await retainBundles(config, now, true, detached))[3]?.outcome, "deleted");
	assert.equal((await retainBundles(config, now, true, detached))[3]?.outcome, "absent", "safe repeat");
	for (const name of ["task-8", "task-9", "active", "pinned", "unknown"])
		assert.equal(await readFile(join(root, name, "kept.txt"), "utf8"), name);
});

test("a symlink input fails closed instead of following it", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pd-links-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "old"));
	await symlink("/", join(root, "old", "outside"));
	assert.equal(
		(await retainBundles(policy(root, [bundle(join(root, "old"))]), now, true, detached))[0]?.outcome,
		"error",
	);
});

test("Docker retention keeps every configured/frozen/rollback image and all unknown images", () => {
	const image = { id: "sha256:old", createdAt: 0, disposable: true, tags: ["pi-durable-check:demo"], used: false };
	assert.equal(disposableImage(image, new Set(), now), true);
	assert.equal(disposableImage(image, new Set([image.id]), now), false);
	assert.equal(disposableImage(image, new Set(image.tags), now), false);
	assert.equal(disposableImage({ ...image, disposable: false }, new Set(), now), false);
	assert.equal(disposableImage({ ...image, used: true }, new Set(), now), false);
	assert.equal(disposableImage({ ...image, createdAt: now - 86400_000 }, new Set(), now), false);
});

test("mount inventory protects nested bind mounts, backing directories, escaped paths and attached loop files", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pd-attached-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "old"));
	await writeFile(join(root, "old", "kept.txt"), "kept");
	const p = policy(root, [bundle(join(root, "old"))]);
	for (const inventory of [
		{ mounts: [join(root, "old", "nested-bind")], backingPaths: [] },
		{ mounts: [], backingPaths: [join(root, "old", "loop.img")] },
		{ mounts: [], backingPaths: [root] },
	])
		assert.deepEqual((await retainBundles(p, now, true, async () => inventory))[0], {
			path: join(root, "old"),
			outcome: "kept",
			reason: "attached",
		});
	assert.equal(
		(
			await retainBundles(p, now, true, async () => {
				throw new Error("inventory unavailable");
			})
		)[0]?.outcome,
		"error",
	);
	assert.equal(await readFile(join(root, "old", "kept.txt"), "utf8"), "kept");
	const mounts = retentionMounts(
		"1 0 8:1 / / rw - ext4 /dev/sda rw\n2 1 8:2 / /mnt/tasks rw - ext4 /dev/sdb rw\n3 1 8:2 /trials/old /mnt/alias rw - ext4 /dev/sdb rw\n4 1 8:2 /trials/with\\040space /mnt/space rw - ext4 /dev/sdb rw\n",
	);
	assert.equal(attachedRetentionInput("/mnt/tasks/trials/old", mounts), true);
	assert.equal(attachedRetentionInput("/mnt/tasks/trials/old/child", mounts), true);
	assert.equal(attachedRetentionInput("/mnt/tasks/trials/with space", mounts), true);
	assert.equal(
		attachedRetentionInput("/mnt/tasks/trials/detached", mounts),
		false,
		"ordinary files below a filesystem mount remain eligible",
	);
});
