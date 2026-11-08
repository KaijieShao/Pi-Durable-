/**
 * Pi process isolation through the whole stack (Deployment § Processes "Pi processes run as their own unprivileged
 * user in a dedicated systemd slice", § Network "Pi gets only its run key"; Architecture § Fails closed).
 *
 *   - The production systemd launcher (PI_RUNNER_ISOLATION=systemd) with stand-ins for systemd-run and systemctl
 *     (test/helpers/systemd-shims.ts): /task → the run is one transient unit as the Pi user in the Pi slice, talking
 *     over stdio frames → review message and pull request; the run key never reaches any systemd argument.
 *   - Restart cleanup with that launcher: a unit of a run in progress that outlived its Coordinator is found by its
 *     run id and generation, killed through systemctl and verified gone before dispatch; if systemctl cannot tell,
 *     the group freezes instead.
 *   - Restart cleanup is deployment-wide (Deployment § Processes: "kills everything in the slice"): every other unit
 *     of this deployment (another run, another generation) is killed too, never another deployment's; in the
 *     process mode the same holds for Pi processes found by their argv markers, at restart and at the recheck after
 *     the owner unfreezes a group (a Pi process whose stop was never confirmed is not a run in progress any more).
 *   - Fail closed: systemd isolation selected but unusable → no dispatch at all, logged and posted once.
 *
 * Users, the slice and the IP filter themselves are not real here (stand-ins run the unit as this user): see
 * test/runner/systemd-linux.test.ts, on Linux at deployment. Limits are DEMO_LIMITS.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ownerUnfreeze } from "../../src/cli/owner.ts";
import { hashRunKey } from "../../src/coordinator/relay.ts";
import { defaultRunnerPath } from "../../src/coordinator/runner-launcher.ts";
import { unitName } from "../../src/coordinator/runner-systemd.ts";
import { Store } from "../../src/coordinator/store.ts";
import { deploymentId, runnerArgv } from "../../src/runner/argv.ts";
import { sleep, waitFor } from "../helpers/env.ts";
import { createSystemdShims } from "../helpers/systemd-shims.ts";
import { GROUP, type Stack, scriptedAgent, startStack, USER1 } from "./harness.ts";

const HELLO_JS = 'exports.hello = () => "hello";\n';
const agent = scriptedAgent([
	{
		when: /^ISOLATED:/,
		steps: [
			{ toolCalls: [{ name: "write", args: { path: "hello.js", content: HELLO_JS } }] },
			{ toolCalls: [{ name: "run_check", args: { operation: "test" } }] },
			{ text: "Added hello.js; the tests pass." },
		],
	},
]);

type RunRow = { id: number; task_id: number; state: string; generation: number | null; pid: number | null };
type TaskRow = { id: number; state: string; pr_number: number | null };

const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Arguments before "--" named `--name=`. */
const option = (args: readonly string[], name: string): string[] =>
	args
		.slice(0, args.indexOf("--"))
		.filter((arg) => arg.startsWith(`--${name}=`))
		.map((arg) => arg.slice(name.length + 3));

function shimsOf(stack: Stack) {
	const shims = stack.shims;
	assert.ok(shims !== undefined, "runner: systemd");
	return shims;
}

test("systemd isolation (stand-ins): /task runs as one transient unit of the Pi user in the slice, over stdio, to review", {
	timeout: 120_000,
}, async (t) => {
	const stack = await startStack({ model: agent, runner: "systemd" });
	t.after(() => stack.stop());
	const shims = shimsOf(stack);
	stack.sendCommand(USER1, "/task alpha ISOLATED: add hello.js");
	const review = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	assert.match(review.text, /Tests: passed\./);
	await stack.coordinator.idle();
	const [task] = stack.tasks<TaskRow>();
	assert.equal(task?.state, "review");
	assert.equal(task?.pr_number, 1);
	assert.equal(stack.github.pulls.size, 1);

	const [run] = stack.runs<RunRow>();
	assert.ok(run !== undefined && run.generation !== null);
	const unit = unitName(deploymentId(stack.config.paths.dataDir), run.id, run.generation);
	const calls = await shims.systemdRunCalls();
	assert.equal(calls.length, 1, "one unit per run");
	const args = calls[0] ?? [];
	assert.deepEqual(option(args, "unit"), [unit]);
	assert.deepEqual(option(args, "slice"), ["pi-durable-runs.slice"]);
	assert.deepEqual(option(args, "uid"), ["pi-runner"]);
	assert.deepEqual(option(args, "gid"), ["pi-durable"]);
	assert.ok(option(args, "property").includes("IPAddressDeny=any"));
	assert.ok(args.includes("--transport=stdio") && args.includes(`--pi-durable-run=${run.id}`));
	// No secret in any systemd argument: not the Coordinator's, and not the run key (only its hash is stored: no
	// key-shaped token of any argument hashes to it).
	const everyArg = [...calls.flat(), ...(await shims.systemctlCalls()).flat()].join("\n");
	for (const secret of [stack.config.model.openaiApiKey, stack.config.github.token, stack.config.telegram.botToken])
		assert.ok(!everyArg.includes(secret), "no Coordinator secret in any systemd argument");
	const keyHashes = new Set(
		stack.coordinator.store.all<{ key_hash: string }>("SELECT key_hash FROM run_keys").map((row) => row.key_hash),
	);
	assert.equal(keyHashes.size, 1);
	const tokens = new Set<string>();
	for (let start = 0; start + 43 <= everyArg.length; start++) tokens.add(everyArg.slice(start, start + 43));
	assert.ok(![...tokens].some((token) => keyHashes.has(hashRunKey(token))), "the run key is in no systemd argument");
	// The conversation is shared with the group only; the unit is gone after the run.
	const conversations = join(stack.config.paths.dataDir, "conversations");
	const conversation = stack.coordinator.store.get<{ path: string }>("SELECT path FROM conversations LIMIT 1");
	assert.ok(conversation !== undefined);
	assert.ok(conversation.path.startsWith(conversations));
	assert.equal((await stat(conversation.path)).mode & 0o777, 0o660);
	assert.equal((await stat(stack.config.paths.dataDir)).mode & 0o777, 0o710, "the data dir: traverse only");
	assert.equal(
		(await stat(join(stack.config.paths.dataDir, "coordinator.sqlite"))).mode & 0o777,
		0o600,
		"the Coordinator's database stays owner-only",
	);
	const pid = Number(await readFile(join(shims.state, "units", `${unit}.pid`), "utf8"));
	assert.ok(pid > 1 && !pidAlive(pid), "the unit's process is gone");
});

/** A stand-in "unit" named `unit` that is still running when the next Coordinator starts. */
function strayUnit(t: TestContext, stack: Stack, unit: string): number {
	const child = spawn(shimsOf(stack).systemdRun, [`--unit=${unit}`, "--", "/bin/sleep", "300"], {
		detached: true,
		stdio: "ignore",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
	});
	child.unref();
	const pid = child.pid ?? 0;
	t.after(() => {
		if (pidAlive(pid)) process.kill(-pid, "SIGKILL");
	});
	return pid;
}

/** A run held in its first model request; stop the Coordinator (the run stays 'running' in the database). */
async function stopMidRun(t: TestContext): Promise<{ stack: Stack; run: RunRow; unit: string }> {
	const stack = await startStack({ model: () => ({ hang: true }), runner: "systemd" });
	t.after(() => stack.stop());
	stack.sendCommand(USER1, "/task alpha HELD: never answered");
	await stack.model.waitForRequests(1, 30_000);
	const run = await waitFor(() => stack.runs<RunRow>().find((row) => row.state === "running"), { what: "running" });
	assert.ok(run.generation !== null);
	await stack.coordinator.stop();
	return { stack, run, unit: unitName(deploymentId(stack.config.paths.dataDir), run.id, run.generation) };
}

test("systemd isolation: restart cleanup kills every unit of this deployment that outlived its Coordinator, only those", {
	timeout: 120_000,
}, async (t) => {
	const { stack, run, unit } = await stopMidRun(t);
	const shims = shimsOf(stack);
	const deployment = deploymentId(stack.config.paths.dataDir);
	const elsewhere = deployment === "0123456789abcdef" ? "fedcba9876543210" : "0123456789abcdef";
	// The run's own unit; a unit of this deployment no run row knows (another run); one of another deployment.
	const units = [unit, unitName(deployment, run.id + 1000, 1), unitName(elsewhere, run.id, run.generation ?? 1)];
	const [stray, unrelated, foreign] = units.map((name) => strayUnit(t, stack, name));
	for (const name of units) {
		await waitFor(() => readFile(join(shims.state, "units", `${name}.pid`), "utf8").catch(() => ""), {
			what: `${name} started`,
		});
	}
	assert.ok([stray, unrelated, foreign].every((pid) => pid !== undefined && pidAlive(pid)));
	const since = stack.lastBotMessageId();
	const killsBefore = (await shims.systemctlCalls()).length;
	await stack.restart();
	await stack.waitForBotMessage(/^Task 1 was interrupted by restart \(run 1\)/, { since });
	await waitFor(() => !pidAlive(stray ?? 0), { what: "the stray unit's process gone", timeoutMs: 10_000 });
	await waitFor(() => !pidAlive(unrelated ?? 0), { what: "the unrelated unit's process gone", timeoutMs: 10_000 });
	assert.ok(pidAlive(foreign ?? 0), "another deployment's unit is never touched");
	const kills = (await shims.systemctlCalls())
		.slice(killsBefore)
		.filter((args) => args.includes("kill") && args.includes("--signal=SIGKILL"));
	assert.equal(kills.filter((args) => args.at(-1) === unit).length, 1, "recovery killed the run's unit via systemctl");
	assert.equal(kills.filter((args) => args.at(-1) === units[1]).length, 1, "and the other unit of this deployment");
	assert.equal(kills.filter((args) => args.at(-1) === units[2]).length, 0);
	assert.equal(stack.coordinator.store.groupState(stack.config.telegram.groupChatId).state, "normal");
	assert.ok(!stack.lastBotMessages(20).some((message) => /Group frozen/.test(message.text)));
});

/** A Pi process of `deployment` for `runId` that no run row knows (stdio transport, waiting for its key frame). */
async function markedPiProcess(t: TestContext, dir: string, deployment: string, runId: number): Promise<number> {
	const args = runnerArgv({ transport: "stdio", conversationAccess: "private", deployment, runId });
	const child = spawn(process.execPath, [defaultRunnerPath(), ...args], {
		cwd: dir,
		detached: true,
		stdio: ["pipe", "ignore", "ignore"],
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, NODE_NO_WARNINGS: "1" },
	});
	const pid = child.pid ?? 0;
	t.after(() => {
		if (pidAlive(pid)) process.kill(pid, "SIGKILL");
		child.stdin.destroy();
	});
	await waitFor(
		() =>
			spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.includes(
				`--pi-durable-run=${runId}`,
			),
		{ what: "the marked Pi process running" },
	);
	return pid;
}

test("process isolation: restart cleanup and the recheck after an unfreeze kill every marked Pi process of this deployment", {
	timeout: 120_000,
}, async (t) => {
	const stack = await startStack({ model: agent });
	t.after(() => stack.stop());
	const dir = stack.config.paths.dataDir;
	const deployment = deploymentId(dir);
	const stray = await markedPiProcess(t, dir, deployment, 999);
	const foreign = await markedPiProcess(t, dir, deploymentId(join(dir, "elsewhere")), 999);
	await stack.restart();
	await waitFor(() => !pidAlive(stray), { what: "the stray Pi process killed at restart", timeoutMs: 10_000 });
	assert.ok(pidAlive(foreign), "another deployment's Pi process is never touched");
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal");

	// A Pi process whose stop was never confirmed (its run is finalized, the group frozen): the owner's unfreeze
	// starts the recheck, which must kill and verify it too before dispatch reopens.
	stack.coordinator.store.freeze(GROUP, "the Pi process of Task 9 could not be confirmed stopped");
	const leftover = await markedPiProcess(t, dir, deployment, 998);
	const owner = new Store(join(dir, "coordinator.sqlite"));
	try {
		assert.equal(ownerUnfreeze(owner, GROUP).ok, true);
	} finally {
		owner.close();
	}
	await waitFor(() => !pidAlive(leftover), { what: "the leftover killed by the recheck", timeoutMs: 15_000 });
	await waitFor(() => !stack.coordinator.store.groupState(GROUP).recheck, { what: "recheck done", timeoutMs: 15_000 });
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal");
	assert.ok(pidAlive(foreign));
	// Dispatch reopened: a task runs to review.
	stack.sendCommand(USER1, "/task alpha ISOLATED: add hello.js");
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
});

test("systemd isolation: when systemctl cannot tell whether a unit is gone, restart cleanup freezes the group", {
	timeout: 120_000,
}, async (t) => {
	const { stack } = await stopMidRun(t);
	const since = stack.lastBotMessageId();
	await shimsOf(stack).set("systemctl-broken", true);
	await stack.restart();
	const frozen = await stack.waitForBotMessage(/^Group frozen: /, { since, timeoutMs: 30_000 });
	assert.match(frozen.text, /leftover Pi processes could not be verified stopped/);
	assert.equal(stack.coordinator.store.groupState(stack.config.telegram.groupChatId).state, "frozen");
});

test("fail closed: systemd isolation selected but unusable → nothing dispatched, logged and posted once", {
	timeout: 120_000,
}, async (t) => {
	// Production wiring: no launcher injected, the Coordinator builds the systemd launcher from its config. On this
	// host the check fails on the platform (not Linux) or on systemd-run (missing); either way it fails closed. The
	// systemctl stand-in still answers, so restart cleanup can verify that no unit of this deployment is left (if it
	// could not, the group would freeze instead: see the test above).
	const tools = await mkdtemp(join(tmpdir(), "pi-isolation-shims-"));
	t.after(() => rm(tools, { recursive: true, force: true }));
	const shims = await createSystemdShims(tools);
	const stack = await startStack({
		model: agent,
		runner: "config",
		env: {
			PI_RUNNER_ISOLATION: "systemd",
			SYSTEMD_RUN_BIN: "/nonexistent/pi-durable-test/systemd-run",
			SYSTEMCTL_BIN: shims.systemctl,
		},
	});
	t.after(() => stack.stop());
	const notice = /^Task execution is paused: Pi process isolation is unavailable, so no run starts\./;
	await stack.waitForBotMessage(notice);
	const command = stack.sendCommand(USER1, "/task alpha ISOLATED: add hello.js");
	await stack.waitForBotMessage((message) => message.replyTo === command && /accepted/.test(message.text));
	await sleep(2_500);
	await stack.coordinator.idle();
	assert.deepEqual(
		stack.runs<RunRow>().map((run) => run.state),
		["queued"],
		"the task waits in the queue",
	);
	assert.equal(stack.model.requests.length, 0, "no model request: nothing ran");
	assert.ok(!stack.lastBotMessages(20).some((message) => /started/.test(message.text)));
	assert.equal(stack.coordinator.store.groupState(GROUP).state, "normal", "paused, not frozen");
	assert.equal((await shims.systemdRunCalls()).length, 0, "no unit was ever started");
	// The data dir is prepared for the Pi group (traverse only); the database stays owner-only.
	assert.equal((await stat(stack.config.paths.dataDir)).mode & 0o777, 0o710);
	assert.equal((await stat(join(stack.config.paths.dataDir, "coordinator.sqlite"))).mode & 0o777, 0o600);
	// Once per outage: a restart while still unusable does not post it again.
	await stack.restart();
	await sleep(1_500);
	await stack.coordinator.idle();
	assert.equal(stack.lastBotMessages(50).filter((message) => notice.test(message.text)).length, 1);
	assert.equal(stack.model.requests.length, 0);
});
