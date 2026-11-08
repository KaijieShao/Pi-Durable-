/**
 * The watchdog core in process (src/watchdog/watchdog.ts; Architecture § Watchdog: "an independent stop path. It
 * terminates processes and containers and verifies they're gone. It enforces each run's 10-minute deadline
 * independently"; Deployment § Processes; Interfaces and Storage § Recovery After a Restart step 2), on a real
 * Coordinator database, with the production marker scan for Pi processes (stand-ins that never exit by themselves,
 * test/helpers/marked-process.ts) and the production Docker reaper against a docker CLI stand-in (its containers are
 * files: no real container is ever touched).
 *
 *   - a sweep request: every marked Pi process of this deployment and every managed container killed, verified,
 *     recorded (counts, requester); another deployment's process and an unmanaged container untouched; heartbeat;
 *   - an unverifiable stop (removal that does nothing, a daemon that cannot list): answered unverified, the group
 *     frozen with a required notice;
 *   - the deadline: only the overdue runs (by start, or by dispatch while still starting) lose their Pi process and
 *     their own task-and-generation containers; recorded once; also when the lock cannot be read; an unverified one
 *     freezes the run's own group, even with another chat id configured;
 *   - a pass that fails writes no heartbeat (a watchdog that cannot work must not look healthy);
 *   - one watchdog acts per database (two CLI processes): the other stands by and takes over when the first is gone;
 *   - a dead Coordinator (stale lock): its leftovers swept on the watchdog's own; never while a Coordinator is alive;
 *   - no database yet: the watchdog waits and creates nothing.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/coordinator/store.ts";
import { createStoreWatchdogLink } from "../../src/coordinator/watchdog-link.ts";
import { deploymentId } from "../../src/runner/argv.ts";
import { acquireDataDirLock } from "../../src/runtime/lock.ts";
import { createLogger, type Logger, silentLogger } from "../../src/runtime/log.ts";
import { HEARTBEAT_KEY, type SweepRow, UNVERIFIED_SWEEP, WATCHDOG_PID_KEY } from "../../src/watchdog/protocol.ts";
import { dockerContainerReaper, markerProcessReaper } from "../../src/watchdog/reapers.ts";
import { startWatchdog, type Watchdog } from "../../src/watchdog/watchdog.ts";
import { createDockerShim, type DockerShim } from "../helpers/docker-shim.ts";
import { sleep, waitFor } from "../helpers/env.ts";
import { markedProcess } from "../helpers/marked-process.ts";

const CHAT = -1009;

type Scene = {
	readonly dir: string;
	readonly dataDir: string;
	readonly deployment: string;
	readonly store: Store;
	readonly docker: DockerShim;
	start(options?: { runDeadlineMs?: number; deadlineGraceMs?: number; log?: Logger }): Watchdog;
	sweeps(): SweepRow[];
};

async function scene(t: TestContext, options: { coordinator: "alive" | "none" } = { coordinator: "alive" }) {
	// "none": no lock (a test may write one of its own).
	const dir = await mkdtemp(join(tmpdir(), "watchdog-test-"));
	const dataDir = join(dir, "data");
	await mkdir(dataDir, { recursive: true });
	// The "Coordinator": its database and, when alive, its data-dir lock (owned by this live process).
	const store = new Store(join(dataDir, "coordinator.sqlite"));
	const lock = options.coordinator === "alive" ? acquireDataDirLock(dataDir) : undefined;
	const docker = await createDockerShim(join(dir, "docker"));
	const deployment = deploymentId(dataDir);
	const watchdogs: Watchdog[] = [];
	t.after(async () => {
		await Promise.all(watchdogs.map((watchdog) => watchdog.stop()));
		lock?.release();
		store.close();
		await rm(dir, { recursive: true, force: true });
	});
	const result: Scene = {
		dir,
		dataDir,
		deployment,
		store,
		docker,
		start(timing = {}) {
			const watchdog = startWatchdog({
				dataDir,
				chatId: CHAT,
				reapers: {
					processes: [markerProcessReaper({ deployment })],
					containers: [dockerContainerReaper({ bin: docker.bin })],
				},
				log: silentLogger,
				intervalMs: 50,
				...timing,
			});
			watchdogs.push(watchdog);
			return watchdog;
		},
		sweeps: () => store.all<SweepRow>("SELECT * FROM watchdog_sweeps ORDER BY id"),
	};
	return result;
}

function insertRun(
	store: Store,
	run: {
		id: number;
		generation: number;
		state: string;
		startedAt: number | null;
		dispatchedAt: number | null;
		/** The task's group (default CHAT, the watchdog's configured one). */
		chatId?: number;
	},
): void {
	store.tx(() => {
		store.run(
			`INSERT INTO tasks(id, chat_id, creator_id, agent_id, text, update_id, state, generation, created_at, updated_at)
			 VALUES (?, ?, 7, 'alpha', 'work', ?, 'running', ?, 1, 1)`,
			run.id,
			run.chatId ?? CHAT,
			1000 + run.id,
			run.generation,
		);
		store.run(
			`INSERT INTO runs(id, task_id, kind, state, requested_by, request_id, input_text, generation, queued_at,
			   started_at, dispatched_at)
			 VALUES (?, ?, 'initial', ?, 7, ?, 'work', ?, 1, ?, ?)`,
			run.id,
			run.id,
			run.state,
			String(1000 + run.id),
			run.generation,
			run.startedAt,
			run.dispatchedAt,
		);
	});
}

test("a sweep request: every marked Pi process and managed container killed, verified both empty, recorded", {
	timeout: 60_000,
}, async (t) => {
	const s = await scene(t);
	const first = await markedProcess(t, s.dir, s.deployment, 5);
	const second = await markedProcess(t, s.dir, s.deployment, 6);
	const foreign = await markedProcess(t, s.dir, deploymentId(join(s.dir, "elsewhere")), 5);
	const agent = await s.docker.addContainer({ "pi-durable.task": 1, "pi-durable.generation": 1 });
	const check = await s.docker.addContainer({ "pi-durable.task": 2, "pi-durable.generation": 3 });
	const unmanaged = await s.docker.addContainer({ "pi-durable.managed": 0 });
	s.start();
	const link = createStoreWatchdogLink(s.store);
	const id = link.request("coordinator_start");
	await waitFor(() => link.answer(id).kind !== "pending", { what: "the answer", timeoutMs: 30_000 });
	assert.deepEqual(link.answer(id), { kind: "verified" });
	assert.equal(await first.exited, "SIGKILL", "killed by the watchdog: it never exits by itself");
	assert.equal(await second.exited, "SIGKILL");
	assert.ok(foreign.alive(), "another deployment's Pi process is never touched");
	assert.deepEqual(s.docker.containers(), [unmanaged], "every managed container gone, nothing else");
	assert.ok(![agent, check].some((id) => s.docker.containers().includes(id)));
	const [row] = s.sweeps();
	assert.ok(row !== undefined);
	assert.equal(row.reason, "coordinator_start");
	assert.equal(row.requester_pid, process.pid);
	assert.deepEqual(
		[row.verified, row.processes_killed, row.containers_killed, row.processes_left, row.containers_left, row.detail],
		[1, 2, 2, 0, 0, null],
	);
	assert.ok(row.started_at !== null && row.finished_at !== null && row.finished_at >= row.started_at);
	// Heartbeat: fresh, from this watchdog.
	assert.ok((link.heartbeatAgeMs() ?? Number.POSITIVE_INFINITY) < 5_000);
	assert.equal(s.store.getMeta(WATCHDOG_PID_KEY), String(process.pid));
	assert.equal(s.store.groupState(CHAT).state, "normal");
});

test("an unverifiable stop: the answer is unverified, the group frozen with a required notice", {
	timeout: 90_000,
}, async (t) => {
	const s = await scene(t);
	await s.docker.addContainer({ "pi-durable.task": 1, "pi-durable.generation": 1 });
	await s.docker.set("rm-misses", true);
	s.start();
	const link = createStoreWatchdogLink(s.store);
	const id = link.request("recheck");
	await waitFor(() => link.answer(id).kind !== "pending", { what: "the answer", timeoutMs: 60_000 });
	assert.deepEqual(link.answer(id), { kind: "unverified" });
	const [row] = s.sweeps();
	assert.deepEqual([row?.verified, row?.containers_left, row?.detail], [0, 1, "containers_left"]);
	assert.deepEqual(s.store.groupState(CHAT), { state: "frozen", reason: UNVERIFIED_SWEEP, recheck: false });
	const notices = s.store
		.all<{ priority: number; kind: string; text: string }>(
			"SELECT priority, kind, text FROM outbox WHERE chat_id = ?",
			CHAT,
		)
		.map((row) => ({ ...row }));
	assert.deepEqual(notices, [
		{
			priority: 0,
			kind: "group_frozen",
			text: `Group frozen: ${UNVERIFIED_SWEEP}. Only the owner CLI can unfreeze it.`,
		},
	]);

	// A daemon that cannot list at all: unverified as well (nothing can be confirmed); one notice only (frozen already).
	await s.docker.set("ps-fails", true);
	const again = link.request("recheck");
	await waitFor(() => link.answer(again).kind !== "pending", { what: "the second answer", timeoutMs: 30_000 });
	assert.deepEqual(link.answer(again), { kind: "unverified" });
	assert.deepEqual([s.sweeps()[1]?.containers_left, s.sweeps()[1]?.detail], [null, "containers_unlistable"]);
	assert.equal(s.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")?.n, 1);
});

test("the deadline: only overdue runs lose their Pi process and their own containers; recorded once", {
	timeout: 60_000,
}, async (t) => {
	const s = await scene(t);
	const now = Date.now();
	insertRun(s.store, { id: 1, generation: 1, state: "running", startedAt: now - 120_000, dispatchedAt: now - 121_000 });
	insertRun(s.store, { id: 2, generation: 1, state: "running", startedAt: now, dispatchedAt: now });
	// Still starting (no Pi process yet): its deadline counts from its dispatch.
	insertRun(s.store, { id: 3, generation: 2, state: "starting", startedAt: null, dispatchedAt: now - 120_000 });
	const overdue = await markedProcess(t, s.dir, s.deployment, 1);
	const current = await markedProcess(t, s.dir, s.deployment, 2);
	const overdueBox = await s.docker.addContainer({ "pi-durable.task": 1, "pi-durable.generation": 1 });
	const currentBox = await s.docker.addContainer({ "pi-durable.task": 2, "pi-durable.generation": 1 });
	const olderStart = await s.docker.addContainer({ "pi-durable.task": 1, "pi-durable.generation": 0 });
	const setupBox = await s.docker.addContainer({ "pi-durable.task": 3, "pi-durable.generation": 2 });
	const watchdog = s.start({ runDeadlineMs: 60_000, deadlineGraceMs: 1_000 });
	await waitFor(() => s.sweeps().length >= 2, { what: "two deadline records", timeoutMs: 30_000 });
	assert.equal(await overdue.exited, "SIGKILL");
	assert.ok(current.alive(), "a run within its deadline keeps its Pi process");
	assert.deepEqual(s.docker.containers(), [currentBox, olderStart].sort(), "only the overdue runs' own containers");
	assert.ok(!s.docker.containers().includes(overdueBox) && !s.docker.containers().includes(setupBox));
	const rows = s.sweeps().map((row) => ({
		reason: row.reason,
		run: row.run_id,
		task: row.task_id,
		generation: row.generation,
		verified: row.verified,
		processes: row.processes_killed,
		containers: row.containers_killed,
	}));
	assert.deepEqual(rows, [
		{ reason: "deadline", run: 1, task: 1, generation: 1, verified: 1, processes: 1, containers: 1 },
		{ reason: "deadline", run: 3, task: 3, generation: 2, verified: 1, processes: 0, containers: 1 },
	]);
	for (let pass = 0; pass < 5; pass++) await watchdog.nextLoop();
	assert.equal(s.sweeps().length, 2, "recorded once per run start");
	assert.equal(s.store.groupState(CHAT).state, "normal");
});

test("the deadline holds when the lock cannot be read (another host's): the overdue run is stopped, nothing else", {
	timeout: 60_000,
}, async (t) => {
	const s = await scene(t, { coordinator: "none" });
	// A lock the watchdog cannot judge (written on another host): never treated as a dead Coordinator.
	await writeFile(
		join(s.dataDir, "owner.lock"),
		`${JSON.stringify({ pid: process.pid, host: `${hostname()}-elsewhere`, startedAt: new Date().toISOString() })}\n`,
	);
	const now = Date.now();
	insertRun(s.store, { id: 1, generation: 1, state: "running", startedAt: now - 120_000, dispatchedAt: now - 121_000 });
	insertRun(s.store, { id: 2, generation: 1, state: "running", startedAt: now, dispatchedAt: now });
	const overdue = await markedProcess(t, s.dir, s.deployment, 1);
	const current = await markedProcess(t, s.dir, s.deployment, 2);
	const currentBox = await s.docker.addContainer({ "pi-durable.task": 2, "pi-durable.generation": 1 });
	const watchdog = s.start({ runDeadlineMs: 60_000, deadlineGraceMs: 1_000 });
	await waitFor(() => s.sweeps().length >= 1, { what: "the deadline record", timeoutMs: 30_000 });
	assert.equal(await overdue.exited, "SIGKILL");
	for (let pass = 0; pass < 3; pass++) await watchdog.nextLoop();
	assert.ok(current.alive(), "not a leftover sweep: a run within its deadline keeps its Pi process");
	assert.deepEqual(s.docker.containers(), [currentBox]);
	assert.deepEqual(
		s.sweeps().map((row) => [row.reason, row.run_id, row.verified]),
		[["deadline", 1, 1]],
	);
});

test("an unverified deadline stop freezes the run's own group, even if the watchdog was configured with another", {
	timeout: 60_000,
}, async (t) => {
	const s = await scene(t);
	const coordinatorGroup = CHAT - 1;
	const now = Date.now();
	insertRun(s.store, {
		id: 1,
		generation: 1,
		state: "running",
		startedAt: now - 120_000,
		dispatchedAt: now - 121_000,
		chatId: coordinatorGroup,
	});
	await s.docker.set("ps-fails", true);
	const lines: string[] = [];
	s.start({
		runDeadlineMs: 60_000,
		deadlineGraceMs: 1_000,
		log: createLogger({ level: "info", sink: (_level, line) => lines.push(line) }),
	});
	await waitFor(() => s.sweeps().length >= 1, { what: "the deadline record", timeoutMs: 30_000 });
	assert.deepEqual(
		s.sweeps().map((row) => [row.reason, row.verified, row.detail]),
		[["deadline", 0, "containers_unlistable"]],
	);
	assert.equal(s.store.groupState(coordinatorGroup).state, "frozen", "the group the run belongs to");
	assert.match(s.store.groupState(coordinatorGroup).reason ?? "", /could not verify that Task 1 was stopped/);
	assert.equal(s.store.groupState(CHAT).state, "normal", "not the configured chat nobody serves");
	assert.deepEqual(
		s.store.all<{ chat_id: number; kind: string }>("SELECT chat_id, kind FROM outbox").map((row) => ({ ...row })),
		[{ chat_id: coordinatorGroup, kind: "group_frozen" }],
	);
	assert.ok(
		lines.some((line) => /^error watchdog_group_mismatch /.test(line)),
		"the mismatch is logged",
	);
});

test("a pass that fails writes no heartbeat until passes work again", { timeout: 30_000 }, async (t) => {
	const s = await scene(t);
	const lines: string[] = [];
	const watchdog = s.start({ log: createLogger({ level: "info", sink: (_level, line) => lines.push(line) }) });
	await waitFor(() => s.store.getMeta(HEARTBEAT_KEY) !== undefined, { what: "the first heartbeat" });
	// Every pass fails from here on (the request table is gone).
	s.store.run("ALTER TABLE watchdog_sweeps RENAME TO watchdog_sweeps_away");
	await waitFor(() => lines.some((line) => line.startsWith("error watchdog_pass_failed")), { what: "a failed pass" });
	await watchdog.nextLoop();
	const last = s.store.getMeta(HEARTBEAT_KEY);
	// Longer than the heartbeat period (1 s): a healthy watchdog would have written one meanwhile.
	await sleep(1_500);
	await watchdog.nextLoop();
	assert.equal(s.store.getMeta(HEARTBEAT_KEY), last, "no heartbeat while every pass fails");
	s.store.run("ALTER TABLE watchdog_sweeps_away RENAME TO watchdog_sweeps");
	await waitFor(() => s.store.getMeta(HEARTBEAT_KEY) !== last, { what: "the heartbeat back" });
});

// Code-only Mac policy fixture: the real parser/CLI/reapers, without a Linux cgroup/systemd requirement.
const MAIN = fileURLToPath(new URL("../fixtures/watchdog-process-cli.mjs", import.meta.url));

type CliWatchdog = { readonly pid: number; readonly lines: string[]; kill(): Promise<void> };

/** Real CLI implementation in its own process, injected Mac policy, scene database and Docker stand-in. */
async function cliWatchdog(t: TestContext, s: Scene): Promise<CliWatchdog> {
	const child: ChildProcess = spawn(process.execPath, [MAIN, "watchdog"], {
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: s.dir,
			NODE_NO_WARNINGS: "1",
			PI_DATA_DIR: s.dataDir,
			TELEGRAM_GROUP_CHAT_ID: String(CHAT),
			DOCKER_BIN: s.docker.bin,
			PI_RUNNER_ISOLATION: "process",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const lines: string[] = [];
	const collect = (chunk: Buffer): void => {
		lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	const kill = async (): Promise<void> => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;
	};
	t.after(kill);
	await waitFor(() => lines.some((line) => line.startsWith("info watchdog_started")), { what: "a watchdog started" });
	return { pid: child.pid ?? 0, lines, kill };
}

const served = (watchdog: CliWatchdog, id: number): boolean =>
	watchdog.lines.some((line) => line.startsWith(`info watchdog_sweep request=${id} `));

test("one watchdog acts per database: a second one stands by, serves nothing, and takes over once the first is gone", {
	timeout: 60_000,
}, async (t) => {
	const s = await scene(t);
	const link = createStoreWatchdogLink(s.store);
	const first = await cliWatchdog(t, s);
	await waitFor(() => s.store.getMeta(WATCHDOG_PID_KEY) === String(first.pid), { what: "the first one leading" });
	const second = await cliWatchdog(t, s);
	await waitFor(() => second.lines.some((line) => line.startsWith("warn watchdog_standby ")), {
		what: "the second one standing by",
	});
	const id = link.request("coordinator_start");
	await waitFor(() => link.answer(id).kind !== "pending", { what: "the answer", timeoutMs: 30_000 });
	assert.deepEqual(link.answer(id), { kind: "verified" });
	assert.ok(served(first, id), "the leader served it");
	assert.ok(!served(second, id), "the one standing by did not sweep (it would kill runs dispatched after the answer)");
	assert.equal(s.store.getMeta(WATCHDOG_PID_KEY), String(first.pid), "the heartbeat stays the leader's");

	await first.kill();
	await waitFor(() => second.lines.some((line) => line.startsWith("info watchdog_leading")), {
		what: "the second taking over",
	});
	await waitFor(() => s.store.getMeta(WATCHDOG_PID_KEY) === String(second.pid), { what: "its heartbeat" });
	const next = link.request("recheck");
	await waitFor(() => link.answer(next).kind !== "pending", { what: "the next answer", timeoutMs: 30_000 });
	assert.ok(served(second, next), "now it serves the requests");
	assert.equal(s.sweeps().length, 2, "each request swept by one watchdog");
});

/** A pid that was just used and is now gone. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await new Promise((resolve) => child.once("exit", resolve));
	return child.pid ?? 999_999;
}

test("a dead Coordinator (stale lock): the watchdog sweeps its leftovers on its own; never a live one's", {
	timeout: 60_000,
}, async (t) => {
	const s = await scene(t, { coordinator: "none" });
	const pid = await deadPid();
	const lockFile = join(s.dataDir, "owner.lock");
	await writeFile(lockFile, `${JSON.stringify({ pid, host: hostname(), startedAt: new Date().toISOString() })}\n`);
	const leftover = await markedProcess(t, s.dir, s.deployment, 7);
	await s.docker.addContainer({ "pi-durable.task": 7, "pi-durable.generation": 1 });
	const watchdog = s.start();
	await waitFor(() => s.sweeps().length > 0, { what: "the coordinator_dead record", timeoutMs: 30_000 });
	assert.equal(await leftover.exited, "SIGKILL");
	assert.deepEqual(s.docker.containers(), []);
	const [row] = s.sweeps();
	assert.deepEqual(
		[row?.reason, row?.requester_pid, row?.verified, row?.processes_killed, row?.containers_killed],
		["coordinator_dead", pid, 1, 1, 1],
	);
	// Nothing left: no more records.
	for (let pass = 0; pass < 3; pass++) await watchdog.nextLoop();
	assert.equal(s.sweeps().length, 1);

	// A live Coordinator holds the lock (the stale one is taken over): its Pi processes are not the watchdog's to kill.
	const lock = acquireDataDirLock(s.dataDir);
	t.after(() => lock.release());
	const live = await markedProcess(t, s.dir, s.deployment, 8);
	for (let pass = 0; pass < 5; pass++) await watchdog.nextLoop();
	assert.ok(live.alive(), "a live Coordinator's Pi process survives");
	assert.equal(s.sweeps().length, 1);
});

test("before the Coordinator's database exists the watchdog waits, creates nothing, then opens it", {
	timeout: 30_000,
}, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "watchdog-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const docker = await createDockerShim(join(dir, "docker"));
	const watchdog = startWatchdog({
		dataDir: dir,
		chatId: CHAT,
		reapers: {
			processes: [markerProcessReaper({ deployment: deploymentId(dir) })],
			containers: [dockerContainerReaper({ bin: docker.bin })],
		},
		log: silentLogger,
		intervalMs: 50,
	});
	t.after(() => watchdog.stop());
	await watchdog.nextLoop();
	await watchdog.nextLoop();
	assert.equal(existsSync(join(dir, "coordinator.sqlite")), false, "the watchdog never creates the database");
	assert.deepEqual(await docker.calls(), [], "and reaps nothing before there is a Coordinator");
	const store = new Store(join(dir, "coordinator.sqlite"));
	t.after(() => store.close());
	assert.equal(createStoreWatchdogLink(store).heartbeatAgeMs(), undefined, "no heartbeat yet");
	await waitFor(() => store.getMeta(HEARTBEAT_KEY) !== undefined, { what: "the first heartbeat" });
});
