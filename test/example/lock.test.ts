import assert from "node:assert/strict";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { acquireDataDirLock, LockHeld, type LockProbe } from "../../src/runtime/lock.ts";
import { tempDir } from "../helpers/agent.ts";

function probe(over: Partial<LockProbe> = {}): LockProbe {
	return { pid: 100, host: "h1", signal: () => undefined, startTime: () => "s100", now: Date.now, ...over };
}

const dead = () => {
	throw Object.assign(new Error("no such process"), { code: "ESRCH" });
};
const otherUser = () => {
	throw Object.assign(new Error("not permitted"), { code: "EPERM" });
};

test("lock: create, refuse a live owner, release only our own", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const lock = acquireDataDirLock(dir, probe());
		assert.equal(JSON.parse(readFileSync(lock.path, "utf8")).pid, 100);
		assert.throws(
			() => acquireDataDirLock(dir, probe({ pid: 200, startTime: (pid) => (pid === 100 ? "s100" : "s200") })),
			(error: unknown) => {
				assert.ok(error instanceof LockHeld);
				assert.match(error.message, /pid 100/);
				return true;
			},
		);
		lock.release();
		assert.equal(existsSync(lock.path), false);
	} finally {
		await cleanup();
	}
});

test("lock: a dead owner, a reused pid and an old garbage file are taken over", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		acquireDataDirLock(dir, probe());
		const second = acquireDataDirLock(dir, probe({ pid: 200, signal: dead }));
		assert.equal(JSON.parse(readFileSync(second.path, "utf8")).pid, 200);
		// pid 200 alive, but with another start time: the pid was reused.
		const third = acquireDataDirLock(
			dir,
			probe({ pid: 300, startTime: (pid) => (pid === 200 ? "different" : "s300") }),
		);
		assert.equal(JSON.parse(readFileSync(third.path, "utf8")).pid, 300);
		writeFileSync(third.path, "garbage");
		assert.throws(() => acquireDataDirLock(dir, probe({ pid: 400 })), LockHeld);
		const old = (Date.now() - 60_000) / 1000;
		utimesSync(third.path, old, old);
		const fourth = acquireDataDirLock(dir, probe({ pid: 400 }));
		assert.equal(JSON.parse(readFileSync(fourth.path, "utf8")).pid, 400);
	} finally {
		await cleanup();
	}
});

test("lock: another user's process and another host are refused", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		acquireDataDirLock(dir, probe());
		assert.throws(() => acquireDataDirLock(dir, probe({ pid: 200, signal: otherUser })), /another user/);
		assert.throws(() => acquireDataDirLock(dir, probe({ pid: 200, host: "h2", signal: dead })), /host h1/);
		assert.ok(existsSync(join(dir, "owner.lock")));
	} finally {
		await cleanup();
	}
});

test("lock: after a reboot, a stale owner's pid reused by another user's process is taken over", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		acquireDataDirLock(dir, probe({ pid: 4242, startTime: () => "1000" }));
		const lock = acquireDataDirLock(
			dir,
			probe({ pid: 100, signal: otherUser, startTime: (pid) => (pid === 4242 ? "55" : "s100") }),
		);
		assert.equal(JSON.parse(readFileSync(lock.path, "utf8")).pid, 100);
		// Same start time, or one that cannot be read: still another user's live process.
		acquireDataDirLock(dir, probe({ pid: 5000, signal: dead, startTime: () => "77" }));
		assert.throws(
			() => acquireDataDirLock(dir, probe({ pid: 100, signal: otherUser, startTime: () => "77" })),
			/another user/,
		);
		assert.throws(
			() => acquireDataDirLock(dir, probe({ pid: 100, signal: otherUser, startTime: () => undefined })),
			/another user/,
		);
	} finally {
		await cleanup();
	}
});

test("lock: two processes taking over the same stale lock at once end with exactly one owner", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		acquireDataDirLock(dir, probe({ pid: 1 }));
		let nested: unknown;
		const a = acquireDataDirLock(
			dir,
			probe({
				pid: 100,
				// While A judges the stale owner, B runs its whole acquire.
				signal: () => {
					if (nested === undefined) {
						try {
							nested = acquireDataDirLock(dir, probe({ pid: 200, signal: dead }));
						} catch (error) {
							nested = error;
						}
					}
					dead();
				},
			}),
		);
		const owner = JSON.parse(readFileSync(a.path, "utf8")).pid;
		assert.ok(nested instanceof LockHeld, "B must not also hold the lock");
		assert.equal(owner, 100);
		assert.equal(existsSync(join(dir, "owner.lock.takeover")), false, "takeover marker removed");
	} finally {
		await cleanup();
	}
});

test("lock: a takeover marker left by a crash is cleared once it is old", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		acquireDataDirLock(dir, probe({ pid: 1 }));
		const marker = join(dir, "owner.lock.takeover");
		writeFileSync(marker, "{}");
		assert.throws(() => acquireDataDirLock(dir, probe({ pid: 100, signal: dead })), /taking over/);
		const old = (Date.now() - 60_000) / 1000;
		utimesSync(marker, old, old);
		const lock = acquireDataDirLock(dir, probe({ pid: 100, signal: dead }));
		assert.equal(JSON.parse(readFileSync(lock.path, "utf8")).pid, 100);
	} finally {
		await cleanup();
	}
});
