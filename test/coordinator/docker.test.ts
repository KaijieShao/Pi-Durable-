/**
 * The Docker sandbox against a real Docker daemon (skipped when Docker or the images are unavailable): hardened,
 * labelled agent containers over a temp worktree, the /work/.git mask, no network, read-only check containers with
 * scratch space, setup with a writable worktree, and named outcomes for the deadline and container limits.
 * The outcome mapping and the run-check launcher's exit codes are also tested without Docker.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEMO_LIMITS, type Limits } from "../../src/coordinator/limits.ts";
import type { Sandbox } from "../../src/coordinator/ports.ts";
import { createDockerSandbox, runDocker } from "../../src/coordinator/sandbox/docker.ts";
import {
	type CheckFacts,
	classifyCheck,
	OutputMonitor,
	TailBuffer,
} from "../../src/coordinator/sandbox/limits-text.ts";
import { silentLogger } from "../../src/runtime/log.ts";
import { waitFor } from "../helpers/env.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RUN_CHECK = join(ROOT, "deploy", "docker", "run-check.mjs");
const AGENT_IMAGE = "pi-durable-agent:demo";
const CHECK_IMAGE = "pi-durable-check:demo";

const NONE: CheckFacts = {
	spawnFailed: false,
	started: true,
	exitCode: 0,
	timedOut: false,
	aborted: false,
	outputLimited: false,
	oomKilled: false,
	processLimitSeen: false,
};

describe("check outcome mapping", () => {
	test("every limit maps to a named outcome; only a clean exit 0 is passed", () => {
		assert.equal(classifyCheck(NONE), "passed");
		assert.equal(classifyCheck({ ...NONE, exitCode: 1 }), "failed");
		assert.equal(classifyCheck({ ...NONE, exitCode: 64 }), "unknown_operation");
		assert.equal(classifyCheck({ ...NONE, exitCode: 124 }), "timeout");
		assert.equal(classifyCheck({ ...NONE, exitCode: undefined, timedOut: true }), "timeout");
		assert.equal(classifyCheck({ ...NONE, exitCode: 137, oomKilled: true }), "memory_limit");
		assert.equal(classifyCheck({ ...NONE, exitCode: 0, oomKilled: true }), "memory_limit");
		assert.equal(classifyCheck({ ...NONE, exitCode: undefined, outputLimited: true }), "output_limit");
		assert.equal(classifyCheck({ ...NONE, exitCode: 1, processLimitSeen: true }), "process_limit");
		assert.equal(classifyCheck({ ...NONE, exitCode: 0, processLimitSeen: true }), "passed");
		assert.equal(classifyCheck({ ...NONE, aborted: true }), "error");
		assert.equal(classifyCheck({ ...NONE, started: false, exitCode: 125 }), "error");
		assert.equal(classifyCheck({ ...NONE, spawnFailed: true }), "unavailable");
	});

	test("output keeps a marked tail; fork failures are recognised", () => {
		const tail = new TailBuffer(1024);
		for (let index = 0; index < 100; index++) tail.push(`line ${index} ${String.fromCodePoint(0xe9).repeat(20)}\n`);
		const text = tail.text();
		assert.equal(tail.truncated, true);
		assert.ok(Buffer.byteLength(text) <= 1024);
		assert.match(text, /^\[truncated: earlier output omitted, \d+ bytes in total\]\n/);
		assert.match(text, /line 99 /);
		assert.equal(text.includes(String.fromCodePoint(0xfffd)), false);
		const monitor = new OutputMonitor(16 * 1024, 4096);
		assert.equal(monitor.push(Buffer.from("sh: 1: Cannot fork\n")), false);
		assert.equal(monitor.processLimitSeen, true);
		assert.equal(monitor.push(Buffer.alloc(5000, 0x61)), true);
		const quiet = new OutputMonitor(16 * 1024);
		quiet.push(Buffer.from("Error: spawn /bin/sh EA"));
		quiet.push(Buffer.from("GAIN\n"));
		assert.equal(quiet.processLimitSeen, true);
	});
});

describe("run-check.mjs launcher", () => {
	const launch = (args: string[], env: Record<string, string> = {}, cwd = tmpdir()) =>
		spawnSync(process.execPath, [RUN_CHECK, ...args], { cwd, env: { PATH: process.env.PATH ?? "", ...env } });

	test("an unknown or missing operation exits 64 before anything runs", () => {
		assert.equal(launch(["deploy"]).status, 64);
		assert.equal(launch(["../test"]).status, 64);
		assert.equal(launch([]).status, 64);
		assert.match(String(launch(["constructor"]).stderr), /unknown operation/);
	});

	test("setup without a script passes; an invalid script path is refused", () => {
		const empty = mkdtempSync(join(tmpdir(), "pd-runcheck-"));
		try {
			const missing = launch(["setup"], {}, empty);
			assert.equal(missing.status, 0);
			assert.match(String(missing.stdout), /no setup script/);
			assert.equal(launch(["setup"], { PI_SETUP_SCRIPT: "../evil.sh" }, empty).status, 2);
			assert.equal(launch(["setup"], { PI_SETUP_SCRIPT: "/etc/evil.sh" }, empty).status, 2);
			assert.equal(launch(["setup"], { PI_SETUP_SCRIPT: ".git/hooks/x" }, empty).status, 2);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

/** Reason to skip the Docker suite, or false when Docker is up and the images were built. */
function prepareDocker(): string | false {
	if (process.platform === "win32") return "Docker sandbox tests need a POSIX host";
	const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 20_000 });
	if (version.status !== 0) return "docker is not available";
	const build = spawnSync(join(ROOT, "scripts", "build-images.sh"), [], { timeout: 180_000, encoding: "utf8" });
	if (build.status !== 0) return `images cannot be built: ${String(build.stderr).split("\n")[0] ?? ""}`;
	return false;
}

const skip = prepareDocker();
const user = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.()}` : "1000:1000";
const taskId = 900_000 + Math.floor(Math.random() * 90_000);

describe("docker sandbox", { skip }, () => {
	let base = "";
	let taskDir = "";
	let sandbox: Sandbox;

	const makeSandbox = (limits: Limits = DEMO_LIMITS): Sandbox =>
		createDockerSandbox({
			bin: "docker",
			agentImage: AGENT_IMAGE,
			checkImage: CHECK_IMAGE,
			user,
			taskDir,
			limits: { ...limits, stopGraceMs: 10_000 },
			log: silentLogger,
			setupScript: ".pi/setup.sh",
		});

	/** A worktree like git's: `.git` is a file pointing at the (unmounted) repository. */
	const makeWorktree = (name: string, files: Record<string, string>): string => {
		const path = join(taskDir, "worktrees", name);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, ".git"), `gitdir: ${join(taskDir, "repo.git", "worktrees", name)}\n`);
		for (const [file, content] of Object.entries(files)) {
			mkdirSync(dirname(join(path, file)), { recursive: true });
			writeFileSync(join(path, file), content);
		}
		return path;
	};

	const exec = async (name: string, script: string): Promise<Record<string, unknown>> => {
		const output = await runDocker("docker", ["exec", name, "node", "-e", script], { timeoutMs: 30_000 });
		assert.equal(output.code, 0, output.stderr);
		return JSON.parse(output.stdout) as Record<string, unknown>;
	};

	const inspect = async (name: string, format: string): Promise<unknown> => {
		const output = await runDocker("docker", ["container", "inspect", "--format", format, name]);
		assert.equal(output.code, 0, output.stderr);
		return JSON.parse(output.stdout);
	};

	before(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "pd-docker-")));
		taskDir = join(base, "tasks");
		sandbox = makeSandbox();
	});

	after(async () => {
		for (const id of [taskId, taskId + 1]) await sandbox?.killAll({ taskId: id }).catch(() => {});
		if (base !== "") rmSync(base, { recursive: true, force: true });
	});

	test("available: daemon, both images, operation list read from the check image", async () => {
		assert.deepEqual(await sandbox.available(), { ok: true });
		assert.deepEqual([...sandbox.checkOps()].sort(), ["build", "lint", "test"]);
		const missing = createDockerSandbox({
			bin: "docker",
			agentImage: "pi-durable-agent:does-not-exist",
			checkImage: CHECK_IMAGE,
			user,
			taskDir,
			limits: DEMO_LIMITS,
			log: silentLogger,
			setupScript: ".pi/setup.sh",
		});
		const result = await missing.available();
		assert.equal(result.ok, false);
		const rootUser = createDockerSandbox({
			bin: "docker",
			agentImage: AGENT_IMAGE,
			checkImage: CHECK_IMAGE,
			user: "0:0",
			taskDir,
			limits: DEMO_LIMITS,
			log: silentLogger,
			setupScript: ".pi/setup.sh",
		});
		assert.equal((await rootUser.available()).ok, false);
		const empty = readFileSync(join(taskDir, "empty-git"));
		assert.equal(empty.length, 0);
	});

	test("agent container: labelled, hardened, non-root, no network; /work/.git masked read-only", async (t) => {
		const worktree = makeWorktree("task-agent", { "README.md": "hello\n" });
		const agent = await sandbox.startAgent({ taskId, generation: 1, worktree, lifetimeMs: 120_000 });
		t.after(() => agent.stop().catch(() => {}));
		assert.match(agent.name, new RegExp(`^pd-t${taskId}-g1-[0-9a-f]{8}$`));
		const labels = (await inspect(agent.name, "{{json .Config.Labels}}")) as Record<string, string>;
		const ours = Object.fromEntries(Object.entries(labels).filter(([key]) => key.startsWith("pi-durable.")));
		assert.deepEqual(ours, {
			"pi-durable.managed": "1",
			"pi-durable.task": String(taskId),
			"pi-durable.generation": "1",
			"pi-durable.kind": "agent",
		});
		const host = (await inspect(agent.name, "{{json .HostConfig}}")) as Record<string, unknown>;
		assert.equal(host.NetworkMode, "none");
		assert.equal(host.ReadonlyRootfs, true);
		assert.deepEqual(host.CapDrop, ["ALL"]);
		assert.ok((host.SecurityOpt as string[]).includes("no-new-privileges"));
		assert.equal(host.Memory, 512 * 1024 * 1024);
		assert.equal(host.NanoCpus, 0.5e9);
		assert.equal(host.PidsLimit, 128);
		assert.equal(await inspect(agent.name, "{{json .Config.User}}"), user);

		const probe = await exec(
			agent.name,
			`const fs = require("fs"), os = require("os"), net = require("net");
			const code = (fn) => { try { fn(); return "ok"; } catch (e) { return e.code; } };
			const status = fs.readFileSync("/proc/self/status", "utf8");
			const socket = net.connect(80, "192.0.2.1");
			let finished = false;
			const done = (network) => { if (finished) return; finished = true; socket.destroy(); console.log(JSON.stringify({
				uid: process.getuid(), gid: process.getgid(), network,
				interfaces: Object.keys(os.networkInterfaces()),
				gitSize: fs.readFileSync("/work/.git").length,
				gitWrite: code(() => fs.writeFileSync("/work/.git", "gitdir: /tmp/evil")),
				gitMkdir: code(() => fs.mkdirSync("/work/.git/hooks")),
				rootWrite: code(() => fs.writeFileSync("/etc/evil", "x")),
				tmpWrite: code(() => fs.writeFileSync("/tmp/ok", "x")),
				capEff: /CapEff:\\s*(\\w+)/.exec(status)[1],
				noNewPrivs: /NoNewPrivs:\\s*(\\d)/.exec(status)[1],
			})); process.exit(0); };
			socket.on("connect", () => done("connected"));
			socket.on("error", (e) => done(e.code));
			setTimeout(() => done("timeout"), 3000);`,
		);
		const [uid, gid] = user.split(":").map(Number);
		assert.equal(probe.uid, uid);
		assert.equal(probe.gid, gid);
		assert.notEqual(probe.uid, 0);
		assert.deepEqual(probe.interfaces, ["lo"]);
		assert.notEqual(probe.network, "connected");
		assert.equal(probe.gitSize, 0);
		assert.equal(probe.gitWrite, "EROFS");
		assert.notEqual(probe.gitMkdir, "ok");
		assert.equal(probe.rootWrite, "EROFS");
		assert.equal(probe.tmpWrite, "ok");
		assert.equal(probe.capEff, "0000000000000000");
		assert.equal(probe.noNewPrivs, "1");

		const wrote = await agent.fileOp({ op: "write", path: "src/new.js", content: "export const x = 1;\n" });
		assert.equal(wrote.ok, true, wrote.ok ? "" : wrote.message);
		assert.equal(readFileSync(join(worktree, "src", "new.js"), "utf8"), "export const x = 1;\n");
		const read = await agent.fileOp({ op: "read", path: "README.md" });
		assert.deepEqual(read, { ok: true, output: "1\thello", truncated: false });
		const denied = await agent.fileOp({ op: "write", path: ".git/config", content: "[core]\n" });
		assert.equal(denied.ok === false && denied.code, "denied");
		assert.match(readFileSync(join(worktree, ".git"), "utf8"), /^gitdir: /);

		assert.deepEqual(await sandbox.live({ taskId, generation: 1 }), [agent.name]);
		await agent.stop();
		assert.deepEqual(await sandbox.live({ taskId, generation: 1 }), []);
		const after = await agent.fileOp({ op: "read", path: "README.md" });
		assert.equal(after.ok === false && after.code, "unavailable");
	});

	test("killAll removes every container of the filter and nothing else", async (t) => {
		t.after(() => sandbox.killAll({ taskId: taskId + 1 }).catch(() => {}));
		const worktree = makeWorktree("task-kill", {});
		await sandbox.startAgent({ taskId, generation: 2, worktree, lifetimeMs: 120_000 });
		await sandbox.startAgent({ taskId, generation: 3, worktree, lifetimeMs: 120_000 });
		const other = await sandbox.startAgent({ taskId: taskId + 1, generation: 1, worktree, lifetimeMs: 120_000 });
		assert.equal((await sandbox.live({ taskId, generation: 2 })).length, 1);
		assert.equal((await sandbox.live({ taskId, generation: 3 })).length, 1);
		await sandbox.killAll({ taskId });
		assert.deepEqual(await sandbox.live({ taskId }), []);
		assert.deepEqual(await sandbox.live({ taskId: taskId + 1 }), [other.name]);
		await sandbox.killAll({ taskId: taskId + 1 });
		assert.deepEqual(await sandbox.live({ taskId: taskId + 1 }), []);
	});

	test("an agent container ends by itself after its lifetime", async () => {
		const worktree = makeWorktree("task-lifetime", {});
		const agent = await sandbox.startAgent({ taskId, generation: 8, worktree, lifetimeMs: 1_000 });
		assert.deepEqual(await sandbox.live({ taskId, generation: 8 }), [agent.name]);
		await waitFor(async () => (await sandbox.live({ taskId, generation: 8 })).length === 0, {
			timeoutMs: 15_000,
			what: "agent container self-exit",
		});
		await agent.stop();
	});

	test("a worktree outside <taskDir>/worktrees is never mounted", async () => {
		const elsewhere = join(base, "elsewhere");
		mkdirSync(elsewhere, { recursive: true });
		await assert.rejects(sandbox.startAgent({ taskId, generation: 9, worktree: elsewhere, lifetimeMs: 10_000 }));
		const check = await sandbox.runCheck({
			taskId,
			generation: 9,
			worktree: elsewhere,
			op: "test",
			writable: false,
			timeoutMs: 10_000,
		});
		assert.equal(check.outcome, "error");
		assert.deepEqual(await sandbox.live({ taskId }), []);
	});

	test("run_check test: worktree read-only, scratch writable, then removed", async () => {
		const probe = `const fs = require("fs");
const problems = [];
try { fs.writeFileSync("/work/probe.txt", "x"); problems.push("worktree writable"); } catch (e) { if (e.code !== "EROFS") problems.push("worktree " + e.code); }
try { fs.writeFileSync("/work/.git", "x"); problems.push("git writable"); } catch {}
fs.writeFileSync(process.env.HOME + "/scratch-ok", "x");
fs.writeFileSync(require("os").tmpdir() + "/tmp-ok", "x");
if (process.env.HOME !== "/scratch" || process.env.CI !== "1") problems.push("env");
if (Object.keys(require("os").networkInterfaces()).join() !== "lo") problems.push("network");
if (process.getuid() === 0) problems.push("root");
console.log(problems.length === 0 ? "probe-ok" : "problems: " + problems.join(", "));
process.exit(problems.length === 0 ? 0 : 1);
`;
		const worktree = makeWorktree("task-check", {
			"package.json": JSON.stringify({
				name: "probe",
				version: "1.0.0",
				scripts: { test: "node probe.js", lint: "node -e \"console.error('lint broke'); process.exit(3)\"" },
			}),
			"probe.js": probe,
		});
		const spec = { taskId, generation: 4, worktree, writable: false, timeoutMs: 30_000 };
		const passed = await sandbox.runCheck({ ...spec, op: "test" });
		assert.equal(passed.outcome, "passed", passed.output);
		assert.equal(passed.exitCode, 0);
		assert.match(passed.output, /probe-ok/);
		assert.equal(existsSync(join(worktree, "probe.txt")), false);
		const failed = await sandbox.runCheck({ ...spec, op: "lint" });
		assert.equal(failed.outcome, "failed");
		assert.equal(failed.exitCode, 3);
		assert.match(failed.output, /lint broke/);
		assert.equal((await sandbox.runCheck({ ...spec, op: "deploy" })).outcome, "unknown_operation");
		assert.equal((await sandbox.runCheck({ ...spec, op: "test", writable: true })).outcome, "error");
		assert.deepEqual(readdirSync(join(taskDir, "scratch")), []);
		assert.deepEqual(await sandbox.live({ taskId }), []);
	});

	test("setup runs with the worktree writable; no script is a pass", async () => {
		const worktree = makeWorktree("task-setup", { ".pi/setup.sh": "echo fixture > fixture.txt\necho set-up\n" });
		const spec = { taskId, generation: 5, worktree, writable: true, timeoutMs: 30_000, op: "setup" };
		const setup = await sandbox.runCheck(spec);
		assert.equal(setup.outcome, "passed", setup.output);
		assert.equal(readFileSync(join(worktree, "fixture.txt"), "utf8"), "fixture\n");
		const bare = makeWorktree("task-setup-none", {});
		const none = await sandbox.runCheck({ ...spec, worktree: bare });
		assert.equal(none.outcome, "passed");
		assert.match(none.output, /no setup script/);
	});

	test("deadline: the check is reported as timeout once its container is verified gone", async () => {
		const worktree = makeWorktree("task-timeout", {
			"package.json": JSON.stringify({ scripts: { test: 'node -e "setTimeout(() => {}, 120000)"' } }),
		});
		const started = Date.now();
		const pending = sandbox.runCheck({
			taskId,
			generation: 6,
			worktree,
			op: "test",
			writable: false,
			timeoutMs: 4_000,
		});
		const [name] = await waitFor(async () => {
			const names = await sandbox.live({ taskId, generation: 6 });
			return names.length > 0 ? names : undefined;
		});
		assert.match(name ?? "", new RegExp(`^pd-c${taskId}-g6-[0-9a-f]{8}$`));
		const host = (await inspect(name ?? "", "{{json .HostConfig}}")) as Record<string, unknown>;
		assert.equal(host.NetworkMode, "none");
		assert.equal(host.ReadonlyRootfs, true);
		assert.equal(host.Init, true);
		assert.deepEqual(host.CapDrop, ["ALL"]);
		assert.equal(host.Memory, 1024 * 1024 * 1024);
		assert.equal(host.NanoCpus, 1e9);
		assert.equal(host.PidsLimit, 256);
		const mounts = (await inspect(name ?? "", "{{json .Mounts}}")) as { Destination: string; RW: boolean }[];
		const byDestination = Object.fromEntries(mounts.map((mount) => [mount.Destination, mount.RW]));
		assert.deepEqual(byDestination, { "/work": false, "/work/.git": false, "/scratch": true });
		const labels = (await inspect(name ?? "", "{{json .Config.Labels}}")) as Record<string, string>;
		assert.equal(labels["pi-durable.managed"], "1");
		assert.equal(labels["pi-durable.task"], String(taskId));
		assert.equal(labels["pi-durable.generation"], "6");
		assert.equal(labels["pi-durable.kind"], "check");
		const result = await pending;
		assert.equal(result.outcome, "timeout", result.output);
		assert.equal(result.exitCode, undefined);
		assert.match(result.output, /\[timeout:/);
		assert.ok(Date.now() - started < 20_000);
		assert.deepEqual(await sandbox.live({ taskId }), []);
	});

	test("memory, process and output limits come back as named outcomes", async () => {
		const small = makeSandbox({ ...DEMO_LIMITS, checkMemoryMiB: 160, checkPids: 64 });
		const worktree = makeWorktree("task-limits", {
			"package.json": JSON.stringify({
				scripts: { test: "node hog.js", lint: "node forks.js", build: "node flood.js" },
			}),
			"flood.js": 'const fs = require("fs"); const b = Buffer.alloc(65536, 0x79); for (;;) fs.writeSync(1, b);\n',
			"hog.js": "const keep = []; for (;;) keep.push(Buffer.alloc(16 * 1024 * 1024, 1));\n",
			"forks.js": `const { spawn } = require("child_process");
for (let i = 0; i < 200; i++) spawn("sleep", ["30"]).on("error", (e) => { console.error("spawn sleep " + e.code); process.exit(1); });
setTimeout(() => process.exit(0), 10000);
`,
		});
		const spec = { taskId, generation: 7, worktree, writable: false, timeoutMs: 30_000 };
		const memory = await small.runCheck({ ...spec, op: "test" });
		assert.equal(memory.outcome, "memory_limit", memory.output);
		const pids = await small.runCheck({ ...spec, op: "lint" });
		assert.equal(pids.outcome, "process_limit", pids.output);
		const flood = await small.runCheck({ ...spec, op: "build" });
		assert.equal(flood.outcome, "output_limit", flood.output.slice(-200));
		assert.equal(flood.truncated, true);
		assert.ok(Buffer.byteLength(flood.output) <= DEMO_LIMITS.toolResultBytes);
		assert.deepEqual(await small.live({ taskId }), []);
	});
});
