/**
 * The watchdog through the whole stack (Deployment § Processes: "watchdog systemd unit — Independent stop path —
 * Separate unit; survives a Coordinator crash"; "On any Coordinator restart, the watchdog (still running): 1. kills
 * everything in the slice and every labeled container 2. verifies both are empty 3. only then lets admission reopen";
 * Architecture § Watchdog, § Fails closed; Interfaces and Storage § Recovery After a Restart step 2; Agent Execution
 * § Limits "Deadline: 10 minutes per run, enforced by the watchdog").
 *
 *   - Separate processes: the Coordinator in a child process and the watchdog as its own process through the CLI
 *     (`watchdog --env-file`, an env file with no secret). kill -9 of the Coordinator mid-run → the watchdog, still
 *     running, finds the stale lock and kills the leftover Pi process (a stand-in that never exits by itself) and the
 *     leftover container (a docker CLI stand-in: no real container), verifies, records. The restarted Coordinator
 *     asks for its own sweep, gets it verified, and only then dispatches the queued task.
 *   - No watchdog: commands are acknowledged and queued, nothing is dispatched, the group is told once; starting the
 *     watchdog reopens admission by itself; if the watchdog dies, no new run starts until it is back.
 *   - After the owner unfreezes the group, the recheck asks the watchdog for a sweep (reason recheck) and dispatch
 *     waits for its answer.
 *   - The deadline, independently: a run the Coordinator's own timer would not stop yet is stopped by the watchdog
 *     (its Pi process and its container), verified and recorded; the Coordinator then fails the task.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ownerUnfreeze } from "../../src/cli/owner.ts";
import { Store } from "../../src/coordinator/store.ts";
import { createStoreWatchdogLink } from "../../src/coordinator/watchdog-link.ts";
import { deploymentId } from "../../src/runner/argv.ts";
import type { SweepRow } from "../../src/watchdog/protocol.ts";
import { createDockerShim, type DockerShim } from "../helpers/docker-shim.ts";
import { sleep, waitFor } from "../helpers/env.ts";
import { markedProcess } from "../helpers/marked-process.ts";
import { GROUP, type Stack, scriptedAgent, startStack, USER1 } from "./harness.ts";

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const PAUSED = /^Task execution is paused: the watchdog \(the independent stop path\) is not answering/;

type RunRow = {
	id: number;
	task_id: number;
	state: string;
	reason: string | null;
	generation: number | null;
	dispatched_at: number | null;
};

const agent = scriptedAgent([
	{ when: /^HOLD:/, steps: [{ hang: true }] },
	{
		when: /./,
		steps: [
			{ toolCalls: [{ name: "write", args: { path: "note.txt", content: "written by the agent\n" } }] },
			{ text: "Wrote note.txt." },
		],
	},
]);

/** Rows of the Coordinator's database through a separate read-only connection (no Coordinator in this process). */
function readRows<T>(stack: Stack, sql: string, ...params: (number | string)[]): T[] {
	const db = new DatabaseSync(join(stack.config.paths.dataDir, "coordinator.sqlite"), { readOnly: true });
	try {
		return db.prepare(sql).all(...params) as T[];
	} finally {
		db.close();
	}
}

const sweeps = (stack: Stack): SweepRow[] => readRows<SweepRow>(stack, "SELECT * FROM watchdog_sweeps ORDER BY id");

type CliWatchdog = { readonly child: ChildProcess; readonly lines: string[]; kill(): Promise<void> };

/** The watchdog as its own process, through the CLI, with an env file of its own variables only (no secret at all). */
async function spawnWatchdog(t: TestContext, stack: Stack, docker: DockerShim): Promise<CliWatchdog> {
	const envFile = join(stack.dir, "watchdog.env");
	await writeFile(
		envFile,
		[
			`PI_DATA_DIR=${stack.config.paths.dataDir}`,
			`TELEGRAM_GROUP_CHAT_ID=${GROUP}`,
			`DOCKER_BIN=${docker.bin}`,
			"PI_RUNNER_ISOLATION=process",
			"LOG_LEVEL=info",
			"",
		].join("\n"),
	);
	const child = spawn(process.execPath, [MAIN, "watchdog", "--env-file", envFile], {
		cwd: stack.dir,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: stack.dir, NODE_NO_WARNINGS: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const lines: string[] = [];
	const collect = (chunk: Buffer): void => {
		lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
		if (process.env.E2E_LOG === "1") process.stderr.write(chunk);
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
	await waitFor(() => lines.some((line) => line.startsWith("info watchdog_started")), { what: "the watchdog started" });
	return { child, lines, kill };
}

/** The Coordinator in its own process (the harness's config and test deps; the local sandbox), so it can be SIGKILLed. */
function spawnCoordinator(stack: Stack): { child: ChildProcess; ready: Promise<void> } {
	const root = new URL("../../", import.meta.url);
	const modules = [
		"src/coordinator/coordinator.ts",
		"src/coordinator/runner-launcher.ts",
		"src/coordinator/sandbox/local.ts",
		"test/e2e/harness.ts",
		"src/runtime/log.ts",
	].map((path) => new URL(path, root).href);
	const program = `
		import { readFileSync } from "node:fs";
		const { modules, config, remoteUrl } = JSON.parse(readFileSync(0, "utf8"));
		const [coordinator, launcher, local, harness, log] = await Promise.all(modules.map((m) => import(m)));
		await coordinator.startCoordinator(config, {
			remoteUrl,
			sandbox: local.createLocalSandbox({ taskDir: config.paths.taskDir, checks: { test: harness.nodeTestCheck } }),
			launcher: launcher.createRunLauncher({
				dataDir: config.paths.dataDir,
				log: log.silentLogger,
				testEnv: { PI_RUNNER_TEST_FAST_RETRY: "1" },
			}),
			log: log.silentLogger,
			pollTimeoutSeconds: 1,
			retryDelayMs: 50,
		});
		process.stdout.write("ready\\n");
	`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
		cwd: stack.dir,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: stack.dir, NODE_NO_WARNINGS: "1" },
		stdio: ["pipe", "pipe", process.env.E2E_LOG === "1" ? "inherit" : "ignore"],
	});
	child.stdin?.end(JSON.stringify({ modules, config: stack.config, remoteUrl: stack.origin.bare }));
	const ready = new Promise<void>((resolve, reject) => {
		child.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.toString("utf8").includes("ready")) resolve();
		});
		child.once("exit", (code) => reject(new Error(`the Coordinator process exited early (${code})`)));
	});
	return { child, ready };
}

async function killProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGKILL");
	await exited;
}

test("kill -9 of the Coordinator mid-run: the watchdog, its own process, kills the leftover Pi process and container and records it; the restarted Coordinator dispatches only after its own verified sweep", {
	timeout: 180_000,
}, async (t) => {
	const stack = await startStack({ model: agent });
	t.after(() => stack.stop());
	const docker = await createDockerShim(join(stack.dir, "docker-shim"));
	// Hand the data directory over: the watchdog to its own process (the CLI), the Coordinator to another.
	await stack.coordinator.stop();
	await stack.watchdog.stop();
	const watchdog = await spawnWatchdog(t, stack, docker);
	const { child, ready } = spawnCoordinator(stack);
	t.after(() => killProcess(child));
	await ready;
	const childStart = sweeps(stack).filter(
		(row) => row.reason === "coordinator_start" && row.requester_pid === child.pid,
	);
	assert.deepEqual(
		childStart.map((row) => row.verified),
		[1],
		"the Coordinator process's recovery was answered by the watchdog process",
	);

	stack.sendCommand(USER1, "/task alpha HOLD: never answered");
	const run1 = await waitFor(() => readRows<RunRow>(stack, "SELECT * FROM runs WHERE state = 'running'")[0], {
		what: "run 1 running",
		timeoutMs: 30_000,
	});
	const queued = stack.sendCommand(USER1, "/task alpha AFTER: waits for the agent");
	await stack.waitForBotMessage((message) => message.replyTo === queued && /^Task 2 accepted/.test(message.text));
	// What the crash leaves behind: a Pi process that never exits by itself, and the run's container.
	const leftover = await markedProcess(t, stack.dir, deploymentId(stack.config.paths.dataDir), run1.id);
	const container = await docker.addContainer({
		"pi-durable.task": run1.task_id,
		"pi-durable.generation": run1.generation ?? 0,
	});

	await killProcess(child);
	const gone = await waitFor(() => sweeps(stack).find((row) => row.reason === "coordinator_dead"), {
		what: "the watchdog's own sweep after the crash",
		timeoutMs: 30_000,
	});
	assert.equal(await leftover.exited, "SIGKILL", "the watchdog killed it: it would never have exited");
	assert.ok(!docker.containers().includes(container), "the leftover container is gone");
	assert.deepEqual(docker.containers(), []);
	assert.equal(gone.verified, 1);
	assert.equal(gone.requester_pid, child.pid, "the dead Coordinator's pid, from its stale lock");
	assert.ok((gone.processes_killed ?? 0) >= 1);
	assert.equal(gone.containers_killed, 1);
	assert.ok(watchdog.lines.some((line) => /^warn watchdog_coordinator_gone pid=/.test(line)));
	assert.equal(watchdog.child.exitCode, null, "the watchdog survives the Coordinator's crash");
	assert.equal(readRows<{ state: string }>(stack, "SELECT state FROM groups")[0]?.state ?? "normal", "normal");

	// Restart: the Coordinator in this process again (the CLI watchdog is the only watchdog).
	await stack.restart();
	await stack.waitForBotMessage(/^Task 1 was interrupted by restart \(run 1\)/);
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/, { timeoutMs: 60_000 });
	const restartSweep = sweeps(stack).find(
		(row) => row.reason === "coordinator_start" && row.requester_pid === process.pid && row.id > gone.id,
	);
	assert.ok(restartSweep !== undefined, "the restarted Coordinator asked for its own sweep");
	assert.equal(restartSweep.verified, 1);
	const run2 = stack.runs<RunRow>().find((run) => run.task_id === 2);
	assert.ok(run2?.dispatched_at !== null && run2?.dispatched_at !== undefined);
	assert.ok(run2.dispatched_at >= (restartSweep.finished_at ?? Number.POSITIVE_INFINITY), "dispatched only after it");
	assert.equal(stack.runs().length, 2, "nothing resumed or admitted twice");
});

test("no watchdog: commands are queued, nothing dispatched, the group told once; the watchdog's start reopens admission; when it dies no new run starts until it is back", {
	timeout: 180_000,
}, async (t) => {
	const stack = await startStack({
		model: agent,
		watchdog: "none",
		// Test-only: 1 s for the watchdog's answer (30 s in production), 2 s heartbeat age (15 s).
		watchdogTimings: { answerTimeoutMs: 1_000, heartbeatMaxAgeMs: 2_000 },
	});
	t.after(() => stack.stop());
	await stack.waitForBotMessage(PAUSED);
	const first = stack.sendCommand(USER1, "/task alpha FIRST: no watchdog yet");
	await stack.waitForBotMessage((message) => message.replyTo === first && /^Task 1 accepted/.test(message.text));
	await sleep(2_000);
	await stack.coordinator.idle();
	assert.deepEqual(
		stack.runs<RunRow>().map((run) => run.state),
		["queued"],
	);
	assert.equal(stack.model.requests.length, 0, "nothing ran");
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal", "paused, not frozen");
	const [pending] = sweeps(stack);
	assert.deepEqual([pending?.reason, pending?.state], ["coordinator_start", "pending"]);

	// The watchdog starts (its own process): it answers the request the Coordinator stopped waiting for.
	const docker = await createDockerShim(join(stack.dir, "docker-shim"));
	const watchdog = await spawnWatchdog(t, stack, docker);
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/, { timeoutMs: 60_000 });
	const [answered] = sweeps(stack);
	assert.deepEqual([answered?.id, answered?.state, answered?.verified], [pending?.id, "done", 1]);
	const run1 = stack.runs<RunRow>()[0];
	assert.ok((run1?.dispatched_at ?? 0) >= (answered?.finished_at ?? Number.POSITIVE_INFINITY));

	// The watchdog dies: its heartbeat goes stale and no new run starts.
	await watchdog.kill();
	const link = createStoreWatchdogLink(stack.coordinator.store);
	await waitFor(() => (link.heartbeatAgeMs() ?? 0) > 2_000, { what: "a stale heartbeat" });
	const since = stack.lastBotMessageId();
	const second = stack.sendCommand(USER1, "/task alpha SECOND: the watchdog is gone");
	await stack.waitForBotMessage((message) => message.replyTo === second && /^Task 2 accepted/.test(message.text));
	await stack.waitForBotMessage(PAUSED, { since });
	await sleep(1_500);
	assert.equal(stack.runs<RunRow>().find((run) => run.task_id === 2)?.state, "queued");

	// Back: dispatch resumes (this Coordinator's sweep was verified; only the heartbeat was missing).
	await spawnWatchdog(t, stack, docker);
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/, { timeoutMs: 60_000 });
	assert.equal(stack.lastBotMessages(100).filter((message) => PAUSED.test(message.text)).length, 2, "once per outage");
	assert.equal(sweeps(stack).length, 1, "no new sweep was needed");
});

test("after the owner unfreezes the group, the recheck asks the watchdog for a sweep and dispatch waits for its answer", {
	timeout: 120_000,
}, async (t) => {
	const stack = await startStack({ model: agent });
	t.after(() => stack.stop());
	stack.coordinator.store.tx(() => stack.coordinator.store.freeze(GROUP, "a stop could not be confirmed (test)"));
	await stack.watchdog.stop();
	const owner = new Store(join(stack.config.paths.dataDir, "coordinator.sqlite"));
	try {
		assert.equal(ownerUnfreeze(owner, GROUP).ok, true);
	} finally {
		owner.close();
	}
	const command = stack.sendCommand(USER1, "/task alpha AFTER-UNFREEZE: add a file");
	await stack.waitForBotMessage((message) => message.replyTo === command && /^Task 1 accepted/.test(message.text));
	const recheck = await waitFor(() => sweeps(stack).find((row) => row.reason === "recheck"), { what: "a recheck" });
	assert.equal(recheck.state, "pending");
	await sleep(1_000);
	assert.equal(stack.runs<RunRow>()[0]?.state, "queued", "no dispatch before the watchdog answers");
	stack.watchdog.start();
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/, { timeoutMs: 60_000 });
	const answered = sweeps(stack).find((row) => row.id === recheck.id);
	assert.deepEqual([answered?.state, answered?.verified], ["done", 1]);
	assert.ok((stack.runs<RunRow>()[0]?.dispatched_at ?? 0) >= (answered?.finished_at ?? Number.POSITIVE_INFINITY));
	assert.equal(stack.coordinator.store.groupState(GROUP).recheck, false);
});

test("the watchdog enforces the run deadline on its own: it kills the run's Pi process and container, verifies, records", {
	timeout: 120_000,
}, async (t) => {
	// The Coordinator's own deadline is DEMO_LIMITS' 10 minutes; the watchdog's is 1 s (+ 0.5 s grace): here only the
	// watchdog can stop the run, as if the Coordinator's timer had not fired.
	const stack = await startStack({
		model: () => ({ hang: true }),
		watchdogRunDeadlineMs: 1_000,
		watchdogDeadlineGraceMs: 500,
	});
	t.after(() => stack.stop());
	stack.sendCommand(USER1, "/task alpha HOLD: never answered");
	const record = await waitFor(() => sweeps(stack).find((row) => row.reason === "deadline"), {
		what: "the watchdog's deadline record",
		timeoutMs: 30_000,
	});
	assert.deepEqual(
		[record.run_id, record.task_id, record.verified, record.processes_killed, record.containers_killed],
		[1, 1, 1, 1, 1],
		"the run's Pi process and its agent container, verified gone",
	);
	const failed = await stack.waitForBotMessage(/^Task 1 failed: /, { timeoutMs: 60_000 });
	assert.match(failed.text, /the Pi process exited unexpectedly/);
	assert.equal(stack.runs<RunRow>()[0]?.state, "failed");
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal");
});
