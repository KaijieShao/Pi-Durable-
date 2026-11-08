/**
 * PI_STATE_GROUP (src/coordinator/state-share.ts, src/coordinator/config.ts): the Coordinator shares its database and
 * lock file with the watchdog's group (0660 / 0640) so the watchdog can run as its own user; unset, both stay
 * owner-only. Unsafe or impossible sharing refuses to start: unknown group, root's group, the Pi group.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ConfigError } from "../../src/config/shared.ts";
import { parseCoordinatorConfig } from "../../src/coordinator/config.ts";
import { shareState } from "../../src/coordinator/state-share.ts";

async function dataDir(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "state-share-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	for (const name of ["coordinator.sqlite", "coordinator.sqlite-wal", "owner.lock"])
		await writeFile(join(dir, name), "", { mode: 0o600 });
	return dir;
}

const BASE = {
	TELEGRAM_BOT_TOKEN: `123456789:${"s".repeat(35)}`,
	TELEGRAM_BOT_USERNAME: "state_share_bot",
	TELEGRAM_GROUP_CHAT_ID: "-100",
	TELEGRAM_OWNER_ID: "1",
	PI_AGENTS: "alpha",
	PI_MODEL: "gpt-4.1-mini",
	PI_THINKING: "off",
	OPENAI_API_KEY: "sk-not-real",
	PROJECT_TOKEN_CEILING: "1000",
	GITHUB_TOKEN: "ghp_not_real",
	GITHUB_REPO: "a/b",
};
const DEFAULTS = {
	cwd: "/",
	home: "/home/x",
	uid: 1000,
	gid: 1000,
	platform: "linux" as const,
	username: "pi-coordinator",
};

test("PI_STATE_GROUP is optional (owner-only by default) and never the Pi group or root", () => {
	assert.equal(parseCoordinatorConfig(BASE, DEFAULTS).paths.stateGroup, undefined);
	assert.equal(
		parseCoordinatorConfig({ ...BASE, PI_STATE_GROUP: "pi-watchdog" }, DEFAULTS).paths.stateGroup,
		"pi-watchdog",
	);
	for (const bad of ["pi-durable", "root", "bad group"]) {
		assert.throws(
			() => parseCoordinatorConfig({ ...BASE, PI_STATE_GROUP: bad }, DEFAULTS),
			(error: unknown) => error instanceof ConfigError && error.problems.some((p) => p.variable === "PI_STATE_GROUP"),
			bad,
		);
	}
});

test("shareState hands the database files (0660) and the lock (0640) to the group", async (t) => {
	const dir = await dataDir(t);
	const gid = process.getgid?.() ?? 0;
	if (gid === 0) return t.skip("runs as root");
	await shareState(dir, String(gid), undefined);
	for (const name of ["coordinator.sqlite", "coordinator.sqlite-wal"]) {
		const info = await stat(join(dir, name));
		assert.deepEqual([info.mode & 0o777, info.gid], [0o660, gid], name);
	}
	const lock = await stat(join(dir, "owner.lock"));
	assert.deepEqual([lock.mode & 0o777, lock.gid], [0o640, gid]);
});

test("shareState refuses an unknown group, root's group, and a group the Pi user is in", async (t) => {
	const dir = await dataDir(t);
	const refused = (error: unknown): boolean =>
		error instanceof ConfigError && error.problems[0]?.variable === "PI_STATE_GROUP";
	await assert.rejects(shareState(dir, "no-such-group-pi-durable-test", undefined), refused);
	await assert.rejects(shareState(dir, "0", undefined), refused);
	// The current user stands in for the Pi user: its own primary group is one of its groups.
	const me = process.env.USER ?? process.env.LOGNAME;
	const gid = process.getgid?.();
	if (me !== undefined && gid !== undefined && gid !== 0)
		await assert.rejects(shareState(dir, String(gid), me), refused);
	assert.equal((await stat(join(dir, "coordinator.sqlite"))).mode & 0o777, 0o600, "nothing changed when refused");
});
