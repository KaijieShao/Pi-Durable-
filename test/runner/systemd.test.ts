/**
 * The "systemd" isolation of Pi processes (Deployment § Processes, § Network, § Secrets) on any POSIX host: the REAL
 * systemd launcher (src/coordinator/runner-systemd.ts) and the REAL runner (src/runner/main.ts, stdio transport)
 * against FakeModel on 127.0.0.1, with stand-ins for systemd-run and systemctl (test/helpers/systemd-shims.ts) that
 * record their arguments, run the unit's command as this user and kill by pid.
 *
 * What this proves: the unit's arguments (name, slice, Pi user and group, the sandbox and limit properties, the
 * markers), that the run key is never in argv, the unit's environment or its properties but only in the first stdin
 * frame, that a whole run works over the stdio transport (tool call, steer, finished), that kill() goes through
 * `systemctl kill` and `exited` waits for the unit to be gone, that restart cleanup finds a unit again by run id and
 * generation, and that the launcher fails closed when systemd isolation is unusable. What it cannot prove here (no
 * other user, no slice, no IP filter on this host): test/runner/systemd-linux.test.ts, on Linux at deployment.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { RunLauncher, RunnerExit, RunnerHandle } from "../../src/coordinator/ports.ts";
import { defaultRunnerPath } from "../../src/coordinator/runner-launcher.ts";
import {
	createSystemdRunLauncher,
	type SystemdLauncherOptions,
	UNIT_RUNTIME_MARGIN_MS,
	unitName,
} from "../../src/coordinator/runner-systemd.ts";
import { deploymentId } from "../../src/runner/argv.ts";
import { encodeFrame } from "../../src/runner/frames.ts";
import type { FromRunner, RunnerStart, ToolResult } from "../../src/runner/protocol.ts";
import { silentLogger } from "../../src/runtime/log.ts";
import { sleep, waitFor } from "../helpers/env.ts";
import { FakeModel, type FakeRequest, type FakeStep } from "../helpers/fake-model.ts";
import { createSystemdShims, prepareSystemdLayout, type SystemdShims, testAccounts } from "../helpers/systemd-shims.ts";

const RUN_KEY = "systemd-run-key-0123456789abcdef";
const RECORDER = fileURLToPath(new URL("../fixtures/stdio-recorder.mjs", import.meta.url));
const SLICE = "pi-durable-runs.slice";
type Finished = Extract<FromRunner, { type: "finished" }>;
type ToolMessage = Extract<FromRunner, { type: "tool" }>;

let root: string;
let dataDir: string;
let shims: SystemdShims;
let launcher: RunLauncher;
const fake = new FakeModel();

function systemdLauncher(extra: Partial<SystemdLauncherOptions> = {}): RunLauncher {
	return createSystemdRunLauncher({
		dataDir,
		log: silentLogger,
		user: "pi-runner",
		group: "pi-durable",
		slice: SLICE,
		systemdRun: shims.systemdRun,
		systemctl: shims.systemctl,
		// TEST ONLY: the shims stand in for systemd on this host and hide no home directory; the Pi user and group are
		// resolved as if the host setup had created them.
		platform: "linux",
		protectedHomes: [],
		accounts: testAccounts(extra.dataDir ?? dataDir),
		testEnv: { PI_RUNNER_TEST_FAST_RETRY: "1" },
		...extra,
	});
}

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "pi-systemd-")));
	dataDir = join(root, "data");
	await prepareSystemdLayout(dataDir);
	shims = await createSystemdShims(join(root, "systemd"));
	await fake.start();
	launcher = systemdLauncher();
});

/** Every Pi process started here, killed at the end even if a test failed half-way (none may outlive the file). */
const started: { kill(): void }[] = [];

after(async () => {
	for (const child of started) child.kill();
	await fake.stop();
	await rm(root, { recursive: true, force: true });
});

let counter = 0;

type Run = {
	readonly start: RunnerStart;
	readonly generation: number;
	readonly unit: string;
	readonly handle: RunnerHandle;
	readonly messages: FromRunner[];
	readonly finished: Promise<Finished>;
	readonly worktree: string;
	waitFor(predicate: (message: FromRunner) => boolean, what: string): Promise<FromRunner>;
};

function startMessage(id: number, input: string): RunnerStart {
	return {
		type: "start",
		runId: id,
		taskId: 100 + id,
		conversationPath: join(dataDir, "conversations", `conv-${id}.sqlite`),
		fresh: true,
		model: { modelId: "gpt-4.1-mini", thinkingLevel: "off", relayBaseUrl: fake.url, codexGateway: false },
		input: { content: input, requestId: `u${id}` },
		steers: [],
		instructions: "You are agent alpha. Keep answers short.",
		limits: { maxRetries: 2, toolResultBytes: 16 * 1024, deadlineMs: 60_000 },
		checkOps: ["test"],
	};
}

/** Launch one run through `using`; tool calls are answered by `onTool` or executed in the run's worktree. */
async function launch(options: {
	input: string;
	using?: RunLauncher;
	generation?: number;
	onTool?: (message: ToolMessage, run: Run) => Promise<ToolResult | undefined> | ToolResult | undefined;
}): Promise<Run> {
	const id = ++counter;
	const generation = options.generation ?? 1;
	const worktree = join(root, `worktree-${id}`);
	await mkdir(worktree, { recursive: true });
	const start = startMessage(id, options.input);
	const messages: FromRunner[] = [];
	let resolveFinished!: (message: Finished) => void;
	const finished = new Promise<Finished>((resolve) => {
		resolveFinished = resolve;
	});
	let run: Run | undefined;
	const handle = (options.using ?? launcher).launch(
		start,
		RUN_KEY,
		(message) => {
			messages.push(message);
			if (message.type === "finished") resolveFinished(message);
			if (message.type !== "tool") return;
			void (async () => {
				const custom = run === undefined ? undefined : await options.onTool?.(message, run);
				handle.send({ type: "tool_result", id: message.id, result: custom ?? (await writeTool(worktree, message)) });
			})();
		},
		{ generation },
	);
	started.push(handle);
	run = {
		start,
		generation,
		unit: unitName(deploymentId(dataDir), id, generation),
		handle,
		messages,
		finished,
		worktree,
		waitFor: (predicate, what) =>
			waitFor(() => messages.find(predicate), { what, timeoutMs: 20_000 }) as Promise<FromRunner>,
	};
	return run;
}

async function writeTool(worktree: string, message: ToolMessage): Promise<ToolResult> {
	if (message.name !== "write") return { ok: true, text: `${message.name}: ok` };
	const file = join(worktree, String(message.args.path));
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, String(message.args.content));
	return { ok: true, text: `wrote ${String(message.args.path)}` };
}

function script(steps: (request: FakeRequest) => FakeStep | Promise<FakeStep>): void {
	fake.requests.length = 0;
	fake.script(steps);
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
		}),
	]);
}

/** The values of `--name=` arguments before "--". */
function options(args: readonly string[], name: string): string[] {
	const end = args.indexOf("--");
	return args
		.slice(0, end < 0 ? args.length : end)
		.filter((arg) => arg.startsWith(`--${name}=`))
		.map((arg) => arg.slice(name.length + 3));
}

const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** The pid the shims recorded for `unit` (its process), once it is there. */
async function unitPid(unit: string): Promise<number> {
	const text = await waitFor(() => readFile(join(shims.state, "units", `${unit}.pid`), "utf8").catch(() => ""), {
		what: `${unit} started`,
	});
	return Number(text.trim());
}

/** A stand-in unit named `unit` that sleeps (not a Pi process): what restart cleanup must find by its name. */
async function strayUnit(unit: string): Promise<number> {
	const child = spawn(shims.systemdRun, [`--unit=${unit}`, "--", "/bin/sleep", "300"], {
		detached: true,
		stdio: "ignore",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
	});
	child.unref();
	const pid = await unitPid(unit);
	started.push({ kill: () => (pidAlive(pid) ? process.kill(pid, "SIGKILL") : undefined) });
	return pid;
}

describe("systemd isolation of Pi processes (shims)", { timeout: 120_000 }, () => {
	it("starts one confined unit as the Pi user in the slice; the run key is only in the first stdin frame", async () => {
		process.env.PI_SYSTEMD_TEST_CANARY = "coordinator-environment";
		const recorder = systemdLauncher({ runnerPath: RECORDER });
		const run = await launch({ input: "record", using: recorder, generation: 3 });
		delete process.env.PI_SYSTEMD_TEST_CANARY;
		const finished = await within(run.finished, 20_000, "finished");
		assert.equal(finished.answer, "recorded");
		await within(run.handle.exited, 10_000, "exit");

		const calls = await shims.systemdRunCalls();
		const args = calls.at(-1) ?? [];
		const deployment = deploymentId(dataDir);
		const home = join(dataDir, "run-home");
		assert.equal(run.unit, `pi-run-${deployment}-r${run.start.runId}-g3.service`);
		assert.deepEqual(options(args, "unit"), [run.unit]);
		assert.deepEqual(options(args, "slice"), [SLICE]);
		assert.deepEqual(options(args, "uid"), ["pi-runner"]);
		assert.deepEqual(options(args, "gid"), ["pi-durable"]);
		assert.deepEqual(options(args, "working-directory"), [home]);
		for (const flag of ["--pipe", "--wait", "--collect", "--quiet", "--no-ask-password"])
			assert.ok(args.includes(flag), flag);
		assert.deepEqual(options(args, "setenv").sort(), [
			`HOME=${home}`,
			"NODE_NO_WARNINGS=1",
			"PATH=/usr/local/bin:/usr/bin:/bin",
			"PI_RUNNER_TEST_FAST_RETRY=1",
		]);
		const properties = options(args, "property");
		const deadlineSec = (run.start.limits.deadlineMs + UNIT_RUNTIME_MARGIN_MS) / 1000;
		for (const property of [
			"Type=exec",
			"NoNewPrivileges=yes",
			"CapabilityBoundingSet=",
			"PrivateTmp=yes",
			"PrivateDevices=yes",
			"ProtectSystem=strict",
			"ProtectHome=yes",
			`ReadWritePaths=${join(dataDir, "conversations")} ${home}`,
			"RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
			"IPAddressDeny=any",
			"IPAddressAllow=localhost",
			`RuntimeMaxSec=${deadlineSec}`,
			"TasksMax=64",
			"MemoryMax=512M",
			"KillMode=control-group",
			"UMask=0007",
		]) {
			assert.ok(properties.includes(property), property);
		}
		assert.deepEqual(args.slice(args.indexOf("--") + 1), [
			process.execPath,
			RECORDER,
			"--transport=stdio",
			"--conversation-access=group",
			`--pi-durable-deployment=${deployment}`,
			`--pi-durable-run=${run.start.runId}`,
		]);

		// The key: nowhere in systemd-run's or systemctl's arguments, the unit's environment or the process's argv...
		const everyArg = [...calls.flat(), ...(await shims.systemctlCalls()).flat()];
		assert.ok(!everyArg.some((arg) => arg.includes(RUN_KEY)), "the run key is not in any systemd argument");
		const recorded = JSON.parse(await readFile(join(home, "recorded.json"), "utf8")) as {
			argv: string[];
			env: Record<string, string>;
			cwd: string;
			lines: string[];
		};
		assert.ok(!recorded.argv.some((arg) => arg.includes(RUN_KEY)));
		assert.equal(recorded.env.OPENAI_API_KEY, undefined);
		assert.ok(!Object.values(recorded.env).some((value) => value.includes(RUN_KEY)), "not in the environment");
		assert.equal(recorded.env.PI_SYSTEMD_TEST_CANARY, undefined, "the Coordinator's environment is not inherited");
		assert.equal(await realpath(recorded.cwd), await realpath(home));
		// ...only in the first stdin frame, which is nothing but the key; the start message follows without it.
		assert.deepEqual(JSON.parse(recorded.lines[0] ?? ""), { type: "key", key: RUN_KEY });
		const startFrame = JSON.parse(recorded.lines[1] ?? "");
		assert.equal(startFrame.type, "start");
		assert.equal(startFrame.runId, run.start.runId);
		assert.ok(!(recorded.lines[1] ?? "").includes(RUN_KEY));
	});

	it("runs a whole run over the stdio transport: tool call, steer, finished; conversation files are 0660", async () => {
		const steerText = "STDIO-STEER: also add b.txt";
		script(({ index }) =>
			index === 0
				? { toolCalls: [{ name: "write", args: { path: "a.txt", content: "a" } }] }
				: { text: "Done with both." },
		);
		const run = await launch({
			input: "write a.txt",
			onTool: async (_message, self) => {
				self.handle.send({ type: "steer", requestId: "s1", content: steerText });
				await self.waitFor((m) => m.type === "steer_status" && m.requestId === "s1", "steer submitted");
				return undefined;
			},
		});
		const finished = await within(run.finished, 30_000, "finished");
		const exit: RunnerExit = await within(run.handle.exited, 15_000, "exit");
		assert.equal(finished.outcome, "answered");
		assert.equal(finished.answer, "Done with both.");
		assert.deepEqual(finished.delivered, ["s1"]);
		assert.equal(exit.code, 0);
		assert.ok(run.messages.some((message) => message.type === "ready"));
		assert.equal(await readFile(join(run.worktree, "a.txt"), "utf8"), "a");
		assert.equal(fake.requests.length, 2);
		assert.equal(fake.requests[0]?.auth, `Bearer ${RUN_KEY}`, "the key from the stdin frame reaches the relay");
		assert.match(JSON.stringify(fake.requests[1]?.body.input), /STDIO-STEER/);
		// Readable by the Pi user and, through the shared group, the Coordinator user only.
		assert.equal((await stat(run.start.conversationPath)).mode & 0o777, 0o660);
		assert.equal(launcher.isRunner({ runId: run.start.runId, generation: run.generation, pid: null }), false);
	});

	it("kill(): systemctl kill --signal=SIGKILL of the unit; exited resolves once the unit is gone", async () => {
		script(() => ({ hang: true }));
		const run = await launch({ input: "hang" });
		await fake.waitForRequests(1);
		const ref = { runId: run.start.runId, generation: run.generation, pid: run.handle.pid ?? null };
		assert.equal(launcher.isRunner(ref), true, "the unit is active");
		run.handle.kill();
		await within(run.handle.exited, 10_000, "exit after kill");
		const kills = (await shims.systemctlCalls()).filter((args) => args.includes("kill"));
		assert.ok(
			kills.some((args) => args.includes("--signal=SIGKILL") && args.at(-1) === run.unit),
			JSON.stringify(kills),
		);
		assert.equal(launcher.isRunner(ref), false, "the unit is reported gone");
		assert.equal(pidAlive(run.handle.pid ?? 0), false);
	});

	it("restart cleanup finds a leftover unit by run id and generation, kills it and verifies it gone", async () => {
		script(() => ({ hang: true }));
		const run = await launch({ input: "hang until the restart", generation: 7 });
		await fake.waitForRequests(1);
		// A new Coordinator (another launcher on the same data dir) knows only the run's row.
		const restarted = systemdLauncher();
		const ref = { runId: run.start.runId, generation: 7, pid: run.handle.pid ?? null };
		assert.equal(restarted.isRunner(ref), true);
		assert.equal(restarted.isRunner({ ...ref, generation: 6 }), false, "an earlier start of the run is not this unit");
		restarted.killRunner(ref);
		await waitFor(() => !restarted.isRunner(ref), { what: "unit gone", timeoutMs: 10_000 });
		await within(run.handle.exited, 10_000, "the old handle sees the exit");
		const kills = (await shims.systemctlCalls()).filter((args) => args.includes("kill") && args.at(-1) === run.unit);
		assert.equal(kills.length, 1);
		// When systemctl cannot tell, the unit counts as alive (recovery then freezes instead of assuming it gone).
		await shims.set("systemctl-broken", true);
		try {
			assert.equal(restarted.isRunner(ref), true);
		} finally {
			await shims.set("systemctl-broken", false);
		}
	});

	it("kill() closes stdin: a unit apart from its client that systemctl kill missed reads EOF, exits; exited waits", async () => {
		// Real systemd runs the unit apart from its systemd-run client, and a start still waiting (for polkit) is not
		// there yet when `systemctl kill` runs: only the closed stdin then stops the Pi process that starts later.
		script(() => ({ hang: true }));
		await shims.set("detached-unit", true);
		let pid = 0;
		try {
			const run = await launch({ input: "hang apart from the client" });
			pid = await unitPid(run.unit);
			await fake.waitForRequests(1);
			assert.notEqual(pid, run.handle.pid, "the unit's process is not its client");
			await shims.set("kill-misses", true);
			run.handle.kill();
			await within(run.handle.exited, 20_000, "exit once the unit is gone");
			assert.equal(pidAlive(pid), false, "the Pi process exited by itself");
			assert.equal(launcher.isRunner({ runId: run.start.runId, generation: run.generation, pid: null }), false);
		} finally {
			await shims.set("kill-misses", false);
			await shims.set("detached-unit", false);
			if (pid > 1 && pidAlive(pid)) process.kill(pid, "SIGKILL");
		}
	});

	it("restart cleanup lists every unit of this deployment (any run, any generation), never another deployment's", async () => {
		script(() => ({ hang: true }));
		const run = await launch({ input: "hang until the sweep", generation: 5 });
		await fake.waitForRequests(1);
		const deployment = deploymentId(dataDir);
		const elsewhere = deployment === "0123456789abcdef" ? "fedcba9876543210" : "0123456789abcdef";
		const stray = await strayUnit(unitName(deployment, 4242, 2));
		const foreign = await strayUnit(unitName(elsewhere, run.start.runId, 5));
		const restarted = systemdLauncher();
		const found = restarted.leftovers() ?? [];
		assert.deepEqual(
			found.map((ref) => `${ref.runId}/${ref.generation}`).sort(),
			[`${run.start.runId}/5`, "4242/2"].sort(),
		);
		for (const ref of found) restarted.killRunner(ref);
		await waitFor(() => restarted.leftovers()?.length === 0, { what: "no unit of this deployment", timeoutMs: 10_000 });
		await within(run.handle.exited, 10_000, "the old handle sees the exit");
		assert.equal(pidAlive(stray), false);
		assert.equal(pidAlive(foreign), true, "another deployment's unit is never touched");
		await shims.set("systemctl-broken", true);
		try {
			assert.equal(restarted.leftovers(), undefined, "cannot list: unknown, never 'none'");
		} finally {
			await shims.set("systemctl-broken", false);
		}
		// Not Linux: no systemd unit can exist, so there is nothing to list.
		assert.deepEqual(systemdLauncher({ platform: "darwin", systemctl: "/nonexistent/systemctl" }).leftovers(), []);
		process.kill(foreign, "SIGKILL");
	});

	it("a unit that cannot start: exited resolves, nothing reached the model", async () => {
		script(() => ({ text: "never" }));
		await shims.set("fail-start", true);
		try {
			const run = await launch({ input: "refused" });
			const exit = await within(run.handle.exited, 10_000, "exit");
			assert.equal(exit.code, 1);
			assert.equal(run.messages.length, 0);
			assert.equal(fake.requests.length, 0);
		} finally {
			await shims.set("fail-start", false);
		}
	});

	it("available(): ok with the host setup; fails closed when systemd isolation is unusable", async () => {
		assert.deepEqual(await launcher.available(), { ok: true });
		const reason = async (using: RunLauncher): Promise<string> => {
			const result = await using.available();
			assert.equal(result.ok, false);
			return result.ok ? "" : result.reason;
		};
		assert.match(await reason(systemdLauncher({ platform: "darwin" })), /needs Linux/);
		assert.match(await reason(systemdLauncher({ systemdRun: join(root, "missing", "systemd-run") })), /systemd-run/);
		assert.match(await reason(systemdLauncher({ systemctl: "pi-durable-no-such-systemctl" })), /systemctl/);
		// The production default (no protectedHomes override) refuses a runner under /home.
		const underHome = createSystemdRunLauncher({
			dataDir,
			log: silentLogger,
			user: "pi-runner",
			group: "pi-durable",
			slice: SLICE,
			systemdRun: shims.systemdRun,
			systemctl: shims.systemctl,
			platform: "linux",
			runnerPath: "/home/someone/app/src/runner/main.ts",
		});
		assert.match(await reason(underHome), /ProtectHome/);
		await shims.set("no-slice", true);
		try {
			assert.match(await reason(launcher), /slice is not installed/);
		} finally {
			await shims.set("no-slice", false);
		}
		const other = join(root, "data-plain");
		await mkdir(join(other, "conversations"), { recursive: true, mode: 0o700 });
		await mkdir(join(other, "run-home"), { recursive: true, mode: 0o700 });
		assert.match(await reason(systemdLauncher({ dataDir: other })), /conversations directory/);
		await prepareSystemdLayout(other);
		assert.deepEqual(await systemdLauncher({ dataDir: other }).available(), { ok: true });
		await rm(join(other, "run-home"), { recursive: true });
		assert.match(await reason(systemdLauncher({ dataDir: other })), /Pi home/);
		assert.equal(existsSync(join(other, "run-home")), false, "the check never creates the Pi home");
		// The Pi user and group as the host resolves them, not only by name.
		const accounts = testAccounts(dataDir);
		const resolving = (uid: number | undefined, gid: number | undefined) =>
			systemdLauncher({ accounts: { uid: () => uid, gid: () => gid } });
		const groupId = accounts.gid("pi-durable") ?? -1;
		assert.match(await reason(resolving(undefined, groupId)), /Pi user does not exist/);
		assert.match(await reason(resolving(0, groupId)), /root or the Coordinator's own user/, "uid 0 under any name");
		assert.match(await reason(resolving(process.getuid?.(), groupId)), /root or the Coordinator's own user/);
		assert.match(await reason(resolving(accounts.uid("pi-runner"), undefined)), /Pi group does not exist/);
		assert.match(await reason(resolving(accounts.uid("pi-runner"), 0)), /Pi group does not exist or is root's/);
		assert.match(
			await reason(resolving(accounts.uid("pi-runner"), groupId + 1)),
			/conversations directory does not belong to the Pi group/,
			"e.g. PI_RUNNER_GROUP=docker",
		);
		assert.deepEqual(await resolving(accounts.uid("pi-runner"), groupId).available(), { ok: true });
	});
});

describe("the runner's stdio transport (main.ts directly)", { timeout: 60_000 }, () => {
	/** Spawn the runner with the stdio transport; `frames` are written to its stdin. */
	function runner(args: string[], env: Record<string, string>, frames: object[]) {
		const child = spawn(process.execPath, [defaultRunnerPath(), "--transport=stdio", ...args], {
			cwd: root,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, NODE_NO_WARNINGS: "1", ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		started.push({ kill: () => child.kill("SIGKILL") });
		const out: string[] = [];
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => out.push(chunk));
		child.stderr.resume();
		for (const frame of frames) child.stdin.write(encodeFrame(frame));
		const code = new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
		return {
			child,
			code,
			frames: () =>
				out
					.join("")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line)),
		};
	}

	it("refuses to start without the key as its first frame", async () => {
		script(() => ({ text: "never" }));
		const started = runner([], {}, [startMessage(900, "no key first")]);
		assert.equal(await within(started.code, 15_000, "exit"), 1);
		assert.ok(started.frames().some((frame) => frame.type === "note" && frame.event === "runner_missing_key"));
		assert.ok(!started.frames().some((frame) => frame.type === "ready" || frame.type === "finished"));
		assert.equal(fake.requests.length, 0);
	});

	it("uses the key frame, never OPENAI_API_KEY from the environment; stdout carries only JSON frames", async () => {
		script(() => ({ text: "Hello over stdio." }));
		const start = { ...startMessage(901, "hello"), conversationPath: join(root, "direct-901.sqlite") };
		const started = runner([], { OPENAI_API_KEY: "env-key-must-be-ignored-000000" }, [
			{ type: "key", key: RUN_KEY },
			start,
		]);
		await waitFor(() => started.frames().some((frame) => frame.type === "finished"), { what: "finished" });
		started.child.stdin.end();
		assert.equal(await within(started.code, 15_000, "exit"), 0);
		const finished = started.frames().find((frame) => frame.type === "finished");
		assert.equal(finished.outcome, "answered");
		assert.equal(fake.requests[0]?.auth, `Bearer ${RUN_KEY}`);
		// Private by default (the fork path's mode), group-shared only with --conversation-access=group.
		assert.equal((await stat(start.conversationPath)).mode & 0o777, 0o600);
	});

	it("refuses a start whose run id differs from its --pi-durable-run marker", async () => {
		script(() => ({ text: "never" }));
		const start = { ...startMessage(902, "wrong run"), conversationPath: join(root, "direct-902.sqlite") };
		const started = runner(["--pi-durable-run=903"], {}, [{ type: "key", key: RUN_KEY }, start]);
		assert.equal(await within(started.code, 15_000, "exit"), 1);
		const finished = started.frames().find((frame) => frame.type === "finished");
		assert.equal(finished?.outcome, "failed");
		assert.match(finished?.reason ?? "", /run id does not match/);
		assert.equal(fake.requests.length, 0);
	});

	it("exits when its stdin closes (the Coordinator is gone)", async () => {
		script(() => ({ hang: true }));
		const start = { ...startMessage(904, "hang"), conversationPath: join(root, "direct-904.sqlite") };
		const started = runner([], {}, [{ type: "key", key: RUN_KEY }, start]);
		await fake.waitForRequests(1);
		started.child.stdin.end();
		assert.equal(await within(started.code, 15_000, "exit"), 1);
		assert.ok(started.frames().some((frame) => frame.type === "note" && frame.event === "runner_disconnected"));
		await sleep(50);
	});
});
