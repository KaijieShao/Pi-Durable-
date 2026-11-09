import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	disposableImage,
	type RetainedBundle,
	type RetentionPolicy,
	retainBundles,
	retentionCandidate,
} from "../../src/maintenance/retention.ts";

const now = 30 * 86400_000;
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
	const dry = await retainBundles(config, now, false);
	assert.deepEqual(
		dry.map((r) => r.outcome),
		["kept", "kept", "kept", "candidate", "kept", "kept"],
	);
	assert.equal((await retainBundles(config, now, true))[3]?.outcome, "deleted");
	assert.equal((await retainBundles(config, now, true))[3]?.outcome, "absent", "safe repeat");
	for (const name of ["task-8", "task-9", "active", "pinned", "unknown"])
		assert.equal(await readFile(join(root, name, "kept.txt"), "utf8"), name);
});

test("a symlink or mounted input fails closed instead of following it", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pd-links-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "old"));
	await symlink("/", join(root, "old", "outside"));
	assert.equal((await retainBundles(policy(root, [bundle(join(root, "old"))]), now, true))[0]?.outcome, "error");
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
