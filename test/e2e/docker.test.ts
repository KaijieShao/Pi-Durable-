/**
 * Write safety and isolation on the REAL Docker sandbox, end to end (Architecture § Policy hooks and containers,
 * § Isolation; Agent Execution § Tool Surface, § Policy Hook, § Containers; Evaluation, Fault Track row "Write
 * safety"). The full stack of harness.ts with no sandbox injected: the Coordinator builds its production Docker
 * sandbox from the config (createDockerSandbox, pi-durable-agent:demo / pi-durable-check:demo, this user's uid:gid).
 *
 *   /task → the agent's write lands in the task worktree and on the PR branch; while the run is held in a tool round,
 *   `docker inspect` of the agent container: exactly the task worktree bind-mounted (plus the read-only .git mask),
 *   no network, non-root user, read-only root, task id and generation labels, no other worktree or repo.git; tool
 *   calls aiming outside the worktree ("../x", "/etc/x", ".git/config", another worktree, symlinks planted in the
 *   worktree pointing outside, at another worktree, at /etc/passwd or inside it) are denied and nothing is written
 *   anywhere; run_check(test) runs in a separate check container (inspected while held) with the worktree read-only,
 *   and a probe test inside it shows read-only worktree and root, writable scratch, no network, non-root user;
 *   after the run no managed container of the task is left (verified gone).
 *
 * The suite is skipped (with the reason) when Docker or the demo images are unavailable; missing images are built
 * with scripts/build-images.sh. Test-only scoping, see scopedDocker(): every container of this stack carries one extra
 * label and every `docker ps` of this stack is filtered by it, so the Coordinator's restart recovery (which kills every
 * pi-durable.managed=1 container on the daemon, as it should on the dedicated VM) cannot kill other test runs'
 * containers on a shared developer machine. Limits are DEMO_LIMITS.
 *
 * Also, without Docker: the production wiring. startCoordinator without a sandbox dependency builds the Docker sandbox
 * from its config (a fake docker CLI records what it is asked), and a run whose agent container cannot start never
 * reaches the model (no host fallback); `owner seal` uses the Docker evaluator built from the config, which is not
 * probed at startup and refuses the seal while its image is missing (the real evaluator image:
 * test/coordinator/evaluator-docker.test.ts).
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	LABEL_GENERATION,
	LABEL_KIND,
	LABEL_MANAGED,
	LABEL_TASK,
	runDocker,
} from "../../src/coordinator/sandbox/docker.ts";
import { waitFor } from "../helpers/env.ts";
import { originGit } from "../helpers/fake-github.ts";
import { type FakeStep, type FakeToolCall, type RecordedRequest, toolResults } from "../helpers/fake-model.ts";
import { agentPosition, type Stack, scriptedAgent, startStack, USER1, USER2 } from "./harness.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const AGENT_IMAGE = "pi-durable-agent:demo";
const CHECK_IMAGE = "pi-durable-check:demo";
const SCOPE_LABEL = "pi-durable.e2e-scope";
const HELLO = "hello from the agent container\n";
const PEER_NOTE = "peer work in progress\n";
const SYMLINK_DENIED = /denied: .*symbolic links are not followed/;

// ---------------------------------------------------------------------------------------------------------------
// Docker availability and test-only plumbing

function firstLine(text: string | null | undefined): string {
	return (
		String(text ?? "")
			.split("\n")
			.find((line) => line.trim() !== "") ?? ""
	)
		.trim()
		.slice(0, 200);
}

/** Absolute path of the docker CLI, or undefined. */
function dockerPath(): string | undefined {
	const found = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8", timeout: 10_000 });
	const path = String(found.stdout ?? "").trim();
	return found.status === 0 && path.startsWith("/") && !path.includes("'") ? path : undefined;
}

/** Why the Docker suite cannot run, or false; builds the demo images when they are missing. */
function dockerSkipReason(docker: string | undefined): string | false {
	if (process.platform === "win32") return "the Docker sandbox needs a POSIX host";
	if (docker === undefined) return "docker is not installed (no docker CLI on PATH)";
	const version = spawnSync(docker, ["version", "--format", "{{.Server.Version}}"], {
		timeout: 20_000,
		stdio: "ignore",
	});
	if (version.status !== 0) return "the Docker daemon is not reachable";
	const images = spawnSync(docker, ["image", "inspect", AGENT_IMAGE, CHECK_IMAGE], {
		timeout: 30_000,
		stdio: "ignore",
	});
	if (images.status === 0) return false;
	const build = spawnSync(join(ROOT, "scripts", "build-images.sh"), [], { timeout: 300_000, encoding: "utf8" });
	if (build.status === 0) return false;
	return `the demo images are missing and scripts/build-images.sh failed: ${firstLine(build.stderr)}`;
}

const DOCKER = dockerPath();
const DOCKER_SKIP = dockerSkipReason(DOCKER);

/** uid:gid the stack's containers run as (harness.ts: this process's ids, never root). */
function hostUser(): string {
	const uid = process.getuid?.() ?? 65534;
	const gid = process.getgid?.() ?? 65534;
	return uid === 0 || gid === 0 ? "65534:65534" : `${uid}:${gid}`;
}

/**
 * DOCKER_BIN for one stack: the real docker CLI, except that `docker run` adds the label `<SCOPE_LABEL>=<scope>` and
 * `docker ps` filters by it. Test-only: recovery's "kill every managed container" then only sees this stack's
 * containers (other runs share the daemon). Everything else passes through unchanged; `exec` keeps stdin, the exit
 * code and signals, so the sandbox's own deadlines and kills behave as in production.
 */
async function scopedDocker(dir: string, docker: string, scope: string): Promise<string> {
	const bin = join(dir, "docker-scoped");
	const label = `${SCOPE_LABEL}=${scope}`;
	const script = [
		"#!/bin/sh",
		'case "$1" in',
		`run) shift; exec '${docker}' run --label '${label}' "$@" ;;`,
		`ps) shift; exec '${docker}' ps --filter 'label=${label}' "$@" ;;`,
		`*) exec '${docker}' "$@" ;;`,
		"esac",
		"",
	].join("\n");
	await writeFile(bin, script, { mode: 0o700 });
	return bin;
}

type Docker = {
	readonly bin: string;
	readonly scope: string;
};

async function docker(d: Docker, args: readonly string[]): Promise<{ code: number | null; stdout: string }> {
	const output = await runDocker(d.bin, args, { timeoutMs: 30_000 });
	return { code: output.code, stdout: output.stdout };
}

/** Names of this stack's containers (running or not) for a task, optionally of one kind. */
async function containersOf(d: Docker, taskId: number, kind?: "agent" | "check"): Promise<string[]> {
	const filters = ["--filter", `label=${SCOPE_LABEL}=${d.scope}`, "--filter", `label=${LABEL_TASK}=${taskId}`];
	if (kind !== undefined) filters.push("--filter", `label=${LABEL_KIND}=${kind}`);
	const output = await docker(d, ["ps", "-a", "--no-trunc", "--format", "{{.Names}}", ...filters]);
	assert.equal(output.code, 0, "docker ps");
	return output.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

/** Safety net after a test: remove whatever of this stack's containers is left (never other runs' containers). */
async function removeScoped(d: Docker): Promise<void> {
	const listed = await docker(d, ["ps", "-aq", "--no-trunc", "--filter", `label=${SCOPE_LABEL}=${d.scope}`]);
	const ids = listed.stdout.split("\n").filter((line) => /^[0-9a-f]{12,64}$/.test(line.trim()));
	if (ids.length > 0) await docker(d, ["rm", "-f", ...ids.map((id) => id.trim())]);
}

type Mount = { Type: string; Source: string; Destination: string; RW: boolean };
type Inspected = {
	Id: string;
	Image: string;
	Config: { User: string; Labels: Record<string, string>; Env: string[] | null };
	HostConfig: {
		NetworkMode: string;
		ReadonlyRootfs: boolean;
		Privileged: boolean;
		CapDrop: string[] | null;
		SecurityOpt: string[] | null;
		Tmpfs: Record<string, string> | null;
	};
	Mounts: Mount[];
	NetworkSettings: { Networks: Record<string, unknown> | null };
	State: { Running: boolean };
};

async function inspectContainer(d: Docker, name: string): Promise<Inspected> {
	const output = await docker(d, ["container", "inspect", name]);
	assert.equal(output.code, 0, `docker container inspect ${name}`);
	const [info] = JSON.parse(output.stdout) as Inspected[];
	assert.ok(info !== undefined);
	return info;
}

async function imageId(d: Docker, image: string): Promise<string> {
	const output = await docker(d, ["image", "inspect", "--format", "{{.Id}}", image]);
	assert.equal(output.code, 0, `docker image inspect ${image}`);
	return output.stdout.trim();
}

/** Run a node script in a live container (verification only) and parse the JSON it prints. */
async function execJson<T>(d: Docker, name: string, script: string): Promise<T> {
	const output = await docker(d, ["exec", name, "node", "-e", script]);
	assert.equal(output.code, 0, `docker exec ${name}`);
	return JSON.parse(output.stdout) as T;
}

const mountsOf = (info: Inspected) =>
	info.Mounts.map((mount) => ({
		type: mount.Type,
		source: mount.Source,
		destination: mount.Destination,
		rw: mount.RW,
	})).sort((a, b) => a.destination.localeCompare(b.destination));

type Expected = {
	readonly kind: "agent" | "check";
	readonly taskId: number;
	readonly generation: number;
	readonly image: string;
	readonly secrets: readonly string[];
};

/** The hardening every agent and check container has (Agent Execution § Agent and check enforcement). */
function assertHardened(info: Inspected, expected: Expected): void {
	assert.equal(info.State.Running, true, `the ${expected.kind} container is running`);
	assert.equal(info.Image, expected.image, `the ${expected.kind} container runs the pinned image`);
	assert.equal(info.HostConfig.NetworkMode, "none");
	assert.deepEqual(Object.keys(info.NetworkSettings.Networks ?? {}), ["none"]);
	assert.equal(info.HostConfig.ReadonlyRootfs, true, "read-only root file system");
	assert.equal(info.HostConfig.Privileged, false);
	assert.ok(info.HostConfig.CapDrop?.includes("ALL"), "all capabilities dropped");
	assert.ok(info.HostConfig.SecurityOpt?.includes("no-new-privileges"), "no privilege escalation");
	assert.ok(Object.hasOwn(info.HostConfig.Tmpfs ?? {}, "/tmp"), "/tmp is a private tmpfs");
	assert.equal(info.Config.User, hostUser());
	assert.notEqual(info.Config.User.split(":")[0], "0", "non-root user");
	const { [SCOPE_LABEL]: _scope, ...labels } = info.Config.Labels;
	assert.deepEqual(
		Object.fromEntries(Object.entries(labels).filter(([key]) => key.startsWith("pi-durable."))),
		{
			[LABEL_MANAGED]: "1",
			[LABEL_TASK]: String(expected.taskId),
			[LABEL_GENERATION]: String(expected.generation),
			[LABEL_KIND]: expected.kind,
		},
		"labels carry the task id and generation",
	);
	const env = info.Config.Env ?? [];
	assert.ok(!env.some((entry) => expected.secrets.some((secret) => entry.includes(secret))), "no credentials inside");
	assert.ok(!env.some((entry) => /^(OPENAI|GITHUB|TELEGRAM|GH)_/.test(entry)), "no credential variables inside");
}

// ---------------------------------------------------------------------------------------------------------------
// The scripted agents

type Gate = { readonly promise: Promise<void>; open(): void };

function gate(): Gate {
	let open: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open: () => open() };
}

type Attempt = { readonly call: FakeToolCall; readonly denied: RegExp };

/** Tool calls aiming outside the task worktree, one per tool round, with the denial each must get. */
function outOfScopeAttempts(tag: string, peerTask: number): Attempt[] {
	const write = (path: string): FakeToolCall => ({ name: "write", args: { path, content: "escaped\n" } });
	return [
		// Textual escapes: blocked by the policy hook before anything reaches a container.
		{ call: write(`../x-${tag}`), denied: /blocked.*must not contain '\.\.'/is },
		{ call: write(`/etc/pi-e2e-${tag}`), denied: /blocked.*absolute paths are not allowed/is },
		{ call: write(".git/config"), denied: /blocked.*git data/is },
		{
			call: { name: "edit", args: { path: ".git/config", oldText: "[core]", newText: "[core]\n\thooksPath = /tmp" } },
			denied: /blocked.*git data/is,
		},
		{ call: write(`../task-${peerTask}/peer.txt`), denied: /blocked.*must not contain '\.\.'/is },
		// Symlinks planted in the worktree: refused by the confined file operation inside the agent container.
		{ call: write(`link-out/pwned-${tag}.txt`), denied: SYMLINK_DENIED },
		{ call: write(`link-tmp/pwned-${tag}.txt`), denied: SYMLINK_DENIED },
		{ call: write("link-peer/peer.txt"), denied: SYMLINK_DENIED },
		{ call: write("link-file"), denied: SYMLINK_DENIED },
		{
			call: { name: "edit", args: { path: "link-file", oldText: "canary", newText: "pwned" } },
			denied: SYMLINK_DENIED,
		},
		{ call: { name: "read", args: { path: "link-passwd" } }, denied: SYMLINK_DENIED },
		{ call: write("link-in"), denied: SYMLINK_DENIED },
	];
}

/** A test file run by run_check inside the check container; it reports what the container allows. */
function probeTestFile(relayPort: number): string {
	return [
		'const assert = require("node:assert/strict");',
		'const fs = require("node:fs");',
		'const net = require("node:net");',
		'const os = require("node:os");',
		'const { test } = require("node:test");',
		"",
		"const attempt = (work) => {",
		"\ttry {",
		"\t\twork();",
		'\t\treturn "ok";',
		"\t} catch (error) {",
		'\t\treturn error.code || "error";',
		"\t}",
		"};",
		"const connect = (host, port) =>",
		"\tnew Promise((resolve) => {",
		"\t\tconst socket = net.connect({ host, port });",
		"\t\tlet timer;",
		"\t\tconst finish = (result) => {",
		"\t\t\tclearTimeout(timer);",
		"\t\t\tsocket.destroy();",
		"\t\t\tresolve(result);",
		"\t\t};",
		'\t\ttimer = setTimeout(() => finish("timeout"), 3000);',
		'\t\tsocket.once("connect", () => finish("connected"));',
		'\t\tsocket.once("error", (error) => finish(error.code || "error"));',
		"\t});",
		"",
		'test("probe: held while the host inspects this check container", async () => {',
		'\tfs.writeFileSync("/scratch/probe-ready", "ready\\n");',
		"\tconst deadline = Date.now() + 45000;",
		'\twhile (fs.existsSync("/work/.probe-hold") && Date.now() < deadline) {',
		"\t\tawait new Promise((resolve) => setTimeout(resolve, 50));",
		"\t}",
		'\tassert.equal(fs.existsSync("/work/.probe-hold"), false, "the host never released the hold");',
		"});",
		"",
		'test("probe: the worktree is read-only and shows no git data", () => {',
		'\tassert.equal(attempt(() => fs.writeFileSync("/work/probe-write.txt", "x")), "EROFS");',
		'\tassert.equal(attempt(() => fs.appendFileSync("/work/index.js", "x")), "EROFS");',
		'\tassert.equal(fs.readFileSync("/work/.git", "utf8"), "");',
		'\tassert.notEqual(attempt(() => fs.writeFileSync("/work/.git", "gitdir: /x")), "ok");',
		"});",
		"",
		'test("probe: read-only root file system, writable scratch", () => {',
		'\tassert.notEqual(attempt(() => fs.writeFileSync("/probe-root.txt", "x")), "ok");',
		'\tassert.notEqual(attempt(() => fs.writeFileSync("/etc/probe-etc.txt", "x")), "ok");',
		'\tassert.equal(attempt(() => fs.writeFileSync("/scratch/probe-scratch.txt", "x")), "ok");',
		"});",
		"",
		'test("probe: unprivileged user", () => {',
		"\tassert.notEqual(process.getuid(), 0);",
		"\tassert.notEqual(process.geteuid(), 0);",
		"});",
		"",
		'test("probe: no network", async () => {',
		'\tassert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);',
		'\tassert.notEqual(await connect("192.0.2.1", 80), "connected");',
		`\tassert.notEqual(await connect("127.0.0.1", ${relayPort}), "connected");`,
		"});",
		"",
	].join("\n");
}

type Gates = { readonly a: Gate; readonly b: Gate };

/** Task 1 (peer): one write, then an answer. Task 2 (probe): the write-safety walk, held at two tool rounds. */
function agents(tag: string, gates: Gates, relayPort: () => number) {
	const attempts = outOfScopeAttempts(tag, 1);
	const [first, ...rest] = attempts.map((attempt): FakeStep => ({ toolCalls: [attempt.call] }));
	assert.ok(first !== undefined);
	const probeWrite = (): FakeStep => ({
		toolCalls: [{ name: "write", args: { path: "test/sandbox-probe.test.js", content: probeTestFile(relayPort()) } }],
	});
	const steps: (FakeStep | Promise<FakeStep>)[] = [
		{ toolCalls: [{ name: "write", args: { path: "hello.txt", content: HELLO } }] },
		// Held until the host inspected the agent container and planted the symlinks.
		gates.a.promise.then(() => first),
		...rest,
		// Held until the host checked that nothing was written outside and removed the symlinks again.
		gates.b.promise.then(probeWrite),
		{ toolCalls: [{ name: "run_check", args: { operation: "test" } }] },
		{ text: "Probe finished: every write stayed in the worktree." },
	];
	return {
		attempts,
		handler: scriptedAgent([
			{
				when: /^write the peer note/,
				steps: [
					{ toolCalls: [{ name: "write", args: { path: "peer.txt", content: PEER_NOTE } }] },
					{ text: "peer done" },
				],
			},
			{ when: /^probe the sandbox/, steps },
		]),
	};
}

function requestsFor(stack: Stack, input: RegExp): RecordedRequest[] {
	return stack.model.requests.filter((request) => input.test(agentPosition(request).input));
}

// ---------------------------------------------------------------------------------------------------------------
// The scenario, step by step

type Scene = {
	readonly stack: Stack;
	readonly d: Docker;
	readonly tag: string;
	/** Outside every worktree and the task directory: symlink targets on the host. */
	readonly outside: string;
	readonly worktree: string;
	readonly peerWorktree: string;
	readonly taskDirReal: string;
	readonly secrets: readonly string[];
};

type TaskRow = { id: number; state: string; worktree_path: string | null; head_commit: string | null; branch: string };

function generationOf(stack: Stack, taskId: number): number {
	const row = stack.runs<{ task_id: number; generation: number }>().find((run) => run.task_id === taskId);
	assert.ok(row !== undefined && Number.isInteger(row.generation) && row.generation > 0, "the run has a generation");
	return row.generation;
}

/** Gate A: the agent container while the run is in progress. Returns its name. */
async function inspectAgentContainer(scene: Scene): Promise<string> {
	const { stack, d } = scene;
	const names = await containersOf(d, 2, "agent");
	assert.equal(names.length, 1, "one agent container for the running task");
	const [name] = names;
	assert.ok(name !== undefined);
	const info = await inspectContainer(d, name);
	const generation = generationOf(stack, 2);
	assertHardened(info, {
		kind: "agent",
		taskId: 2,
		generation,
		image: await imageId(d, AGENT_IMAGE),
		secrets: scene.secrets,
	});
	// Exactly the task worktree read-write and the empty read-only file over its .git; nothing else of the project.
	assert.deepEqual(mountsOf(info), [
		{ type: "bind", source: await realpath(scene.worktree), destination: "/work", rw: true },
		{ type: "bind", source: join(scene.taskDirReal, "empty-git"), destination: "/work/.git", rw: false },
	]);
	for (const mount of info.Mounts) {
		assert.ok(!mount.Source.startsWith(join(scene.taskDirReal, "repo.git")), "repo.git is not mounted");
		assert.ok(!mount.Source.startsWith(await realpath(scene.peerWorktree)), "the peer's worktree is not mounted");
	}
	// Inside: the agent's write is there, the peer's work and git data are not.
	const view = await execJson<{ work: string[]; git: string; peer: boolean }>(
		d,
		name,
		'const fs = require("fs"); console.log(JSON.stringify({ work: fs.readdirSync("/work").sort(), ' +
			'git: fs.readFileSync("/work/.git", "utf8"), peer: fs.existsSync("/work/peer.txt") }))',
	);
	assert.ok(view.work.includes("hello.txt"), view.work.join(","));
	assert.equal(view.git, "", "git data is masked by an empty file");
	assert.equal(view.peer, false, "the peer's unfinished work is not visible");
	return name;
}

type Snapshot = Readonly<Record<string, string>>;

/** Contents that must not change: the peer worktree, the outside directory, git data. */
async function snapshot(scene: Scene): Promise<Snapshot> {
	const read = (path: string) => readFile(path, "utf8");
	return {
		peerListing: (await readdir(scene.peerWorktree)).sort().join(","),
		peerNote: await read(join(scene.peerWorktree, "peer.txt")),
		outsideListing: (await readdir(scene.outside)).sort().join(","),
		outsideCanary: await read(join(scene.outside, "canary.txt")),
		gitfile: await read(join(scene.worktree, ".git")),
		repoConfig: await read(join(scene.taskDirReal, "repo.git", "config")),
		hello: await read(join(scene.worktree, "hello.txt")),
	};
}

/** Symlinks planted in the worktree (as a checked-out repository or a peer could): out, /tmp, peer, files, inside. */
async function plantSymlinks(scene: Scene, agent: string): Promise<void> {
	await execJson(
		scene.d,
		agent,
		`require("fs").writeFileSync("/tmp/canary-${scene.tag}", "canary\\n"); console.log("{}")`,
	);
	const at = (name: string) => join(scene.worktree, name);
	await symlink(scene.outside, at("link-out"));
	await symlink("/tmp", at("link-tmp"));
	await symlink(`../task-1`, at("link-peer"));
	await symlink(`/tmp/canary-${scene.tag}`, at("link-file"));
	await symlink("/etc/passwd", at("link-passwd"));
	await symlink("hello.txt", at("link-in"));
}

const LINKS = ["link-out", "link-tmp", "link-peer", "link-file", "link-passwd", "link-in"];

/** Gate B: every out-of-scope call was denied, and nothing was written outside the worktree, host or container. */
async function assertNothingEscaped(scene: Scene, agent: string, attempts: readonly Attempt[], before: Snapshot) {
	const { stack, tag } = scene;
	const held = requestsFor(stack, /^probe the sandbox/)[attempts.length + 1];
	assert.ok(held !== undefined);
	const results = toolResults(held.body);
	assert.equal(results.length, attempts.length + 1, "one result per tool round");
	assert.doesNotMatch(results[0]?.output ?? "", /denied|blocked/i, "the in-scope write succeeded");
	attempts.forEach((attempt, index) => {
		const output = results[index + 1]?.output ?? "";
		assert.match(output, attempt.denied, `${attempt.call.name} ${String(attempt.call.args.path)}: ${output}`);
	});
	assert.doesNotMatch(results.at(-2)?.output ?? "", /root:x?:0:0/, "the symlinked /etc/passwd was not read");
	assert.deepEqual(await snapshot(scene), before, "peer worktree, outside files and git data unchanged");
	assert.equal(existsSync(join(scene.taskDirReal, "worktrees", `x-${tag}`)), false);
	assert.equal(existsSync(`/tmp/pwned-${tag}.txt`), false);
	assert.equal(existsSync(`/etc/pi-e2e-${tag}`), false);
	const inside = await execJson<{ tmp: string[]; canary: string; etc: boolean; root: boolean }>(
		scene.d,
		agent,
		'const fs = require("fs"); console.log(JSON.stringify({ tmp: fs.readdirSync("/tmp"), ' +
			`canary: fs.readFileSync("/tmp/canary-${tag}", "utf8"), etc: fs.existsSync("/etc/pi-e2e-${tag}"), ` +
			`root: fs.existsSync("/x-${tag}") }))`,
	);
	assert.equal(inside.canary, "canary\n", "the symlinked file in the container's /tmp is unchanged");
	assert.ok(!inside.tmp.includes(`pwned-${tag}.txt`), "nothing written through the /tmp symlink");
	assert.equal(inside.etc, false);
	assert.equal(inside.root, false);
}

/** Wait until the probe test runs inside a check container (it marks its scratch), then return that scratch. */
async function waitForProbe(scene: Scene): Promise<string> {
	const scratchRoot = join(scene.taskDirReal, "scratch");
	return waitFor(
		async () => {
			for (const entry of await readdir(scratchRoot).catch(() => [])) {
				if (existsSync(join(scratchRoot, entry, "probe-ready"))) return join(scratchRoot, entry);
			}
			return undefined;
		},
		{ what: "the probe test running in the check container", timeoutMs: 60_000 },
	);
}

/** The run_check container, held by the probe: separate from the agent container, worktree read-only, scratch. */
async function inspectCheckContainer(scene: Scene, agent: string, scratch: string): Promise<string> {
	const { d } = scene;
	const names = await containersOf(d, 2, "check");
	assert.equal(names.length, 1, "one check container");
	const [name] = names;
	assert.ok(name !== undefined && name !== agent);
	const info = await inspectContainer(d, name);
	const agentInfo = await inspectContainer(d, agent);
	assert.notEqual(info.Id, agentInfo.Id, "run_check runs in a separate container");
	assert.equal(agentInfo.State.Running, true, "the agent container is still up meanwhile");
	assertHardened(info, {
		kind: "check",
		taskId: 2,
		generation: generationOf(scene.stack, 2),
		image: await imageId(d, CHECK_IMAGE),
		secrets: scene.secrets,
	});
	assert.deepEqual(mountsOf(info), [
		{ type: "bind", source: scratch, destination: "/scratch", rw: true },
		{ type: "bind", source: await realpath(scene.worktree), destination: "/work", rw: false },
		{ type: "bind", source: join(scene.taskDirReal, "empty-git"), destination: "/work/.git", rw: false },
	]);
	return name;
}

/** After the run: the work is on the PR branch, the planted links and markers are not, every container is gone. */
async function assertAfterRun(scene: Scene, containers: readonly string[]): Promise<void> {
	const { stack, d } = scene;
	await stack.coordinator.idle();
	assert.deepEqual(await containersOf(d, 2), [], "no managed container of the task is left");
	assert.deepEqual(await containersOf(d, 1), [], "nor of the peer task");
	for (const name of containers) {
		assert.notEqual((await docker(d, ["container", "inspect", name])).code, 0, `${name} is gone`);
	}
	const git = async (args: string[]) => (await originGit(stack.origin.bare, args)).stdout;
	assert.equal(await git(["show", "refs/heads/task/2:hello.txt"]), HELLO, "the agent's write is on the PR branch");
	const files = (await git(["ls-tree", "-r", "--name-only", "refs/heads/task/2"])).trim().split("\n");
	assert.ok(files.includes("test/sandbox-probe.test.js"), files.join(","));
	for (const name of [...LINKS, ".probe-hold", "probe-write.txt"]) assert.ok(!files.includes(name), name);
	assert.ok(!files.some((file) => file.includes(scene.tag)), files.join(","));
	assert.equal(existsSync(join(scene.worktree, "probe-write.txt")), false, "the check could not write the worktree");
	assert.equal(await readFile(join(scene.peerWorktree, "peer.txt"), "utf8"), PEER_NOTE);
	assert.equal(stack.github.pulls.size, 2);
}

async function sceneFor(stack: Stack, d: Docker, tag: string, outside: string): Promise<Scene> {
	const tasks = stack.tasks<TaskRow>();
	const peer = tasks.find((task) => task.id === 1)?.worktree_path;
	const worktree = tasks.find((task) => task.id === 2)?.worktree_path;
	assert.ok(peer !== null && peer !== undefined && worktree !== null && worktree !== undefined);
	return {
		stack,
		d,
		tag,
		outside,
		worktree,
		peerWorktree: peer,
		taskDirReal: await realpath(stack.config.paths.taskDir),
		secrets: [stack.config.model.openaiApiKey, stack.config.github.token, stack.config.telegram.botToken],
	};
}

async function writeSafetyOnDocker(t: TestContext, dockerBin: string): Promise<void> {
	const tag = randomBytes(4).toString("hex");
	const base = await realpath(await mkdtemp(join(tmpdir(), "pi-e2e-docker-")));
	const outside = join(base, "outside");
	await mkdir(outside);
	await writeFile(join(outside, "canary.txt"), "outside canary\n");
	const d: Docker = { bin: await scopedDocker(base, dockerBin, tag), scope: tag };
	const gates: Gates = { a: gate(), b: gate() };
	let relayPort = 0;
	const { attempts, handler } = agents(tag, gates, () => relayPort);
	const stack = await startStack({ sandbox: "docker", env: { DOCKER_BIN: d.bin }, model: handler });
	t.after(async () => {
		gates.a.open();
		gates.b.open();
		await stack.stop();
		await removeScoped(d);
		await rm(base, { recursive: true, force: true });
	});
	relayPort = Number(new URL(stack.coordinator.relayUrl).port);

	// A peer task first: its worktree (unfinished, in review) exists next to the probe task's.
	stack.sendCommand(USER1, "/task alpha write the peer note in peer.txt");
	const peerReview = await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	assert.match(peerReview.text, /Tests: passed\./);

	// The probe task: its first write lands, then the model holds the next tool round.
	stack.sendCommand(USER2, "/task beta probe the sandbox boundaries");
	await waitFor(() => requestsFor(stack, /^probe the sandbox/).length >= 2, {
		what: "the probe agent holding its second tool round",
		timeoutMs: 60_000,
	});
	const scene = await sceneFor(stack, d, tag, outside);
	assert.equal(await readFile(join(scene.worktree, "hello.txt"), "utf8"), HELLO, "the write is in the task worktree");
	const agent = await inspectAgentContainer(scene);

	// Out-of-scope calls, with symlinks planted in the worktree meanwhile.
	await plantSymlinks(scene, agent);
	const before = await snapshot(scene);
	gates.a.open();
	await waitFor(() => requestsFor(stack, /^probe the sandbox/).length >= attempts.length + 2, {
		what: "every out-of-scope call answered",
		timeoutMs: 60_000,
	});
	await assertNothingEscaped(scene, agent, attempts, before);
	for (const link of LINKS) await unlink(join(scene.worktree, link));

	// run_check(test): the probe test holds the check container until the host inspected it.
	await writeFile(join(scene.worktree, ".probe-hold"), "");
	gates.b.open();
	const scratch = await waitForProbe(scene);
	const check = await inspectCheckContainer(scene, agent, scratch);
	await unlink(join(scene.worktree, ".probe-hold"));

	const review = await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/, { since: peerReview.id });
	assert.match(review.text, /Tests: passed\./);
	assert.match(review.text, /Test files changed: test\/sandbox-probe\.test\.js\./);
	const last = requestsFor(stack, /^probe the sandbox/).at(-1);
	const checkResult = toolResults(last?.body).at(-1)?.output ?? "";
	assert.match(checkResult, /^run_check test: passed/, checkResult.slice(0, 2000));
	for (const name of ["read-only and shows no git data", "writable scratch", "unprivileged user", "no network"]) {
		assert.ok(checkResult.includes(name), `probe "${name}" ran in the check container`);
	}
	await assertAfterRun(scene, [agent, check]);
}

// ---------------------------------------------------------------------------------------------------------------
// Production wiring without Docker: a fake docker CLI records what the Coordinator's default sandbox asks of it

type FakeDocker = {
	readonly bin: string;
	readonly calls: () => string[][];
	readonly agentId: string;
	readonly checkId: string;
};

/** A docker CLI stand-in: answers the startup probe (daemon, both images, operation list), starts no container. */
async function fakeDocker(dir: string): Promise<FakeDocker> {
	const log = join(dir, "docker-argv.log");
	const agentId = `sha256:${"a".repeat(64)}`;
	const checkId = `sha256:${"c".repeat(64)}`;
	const ops = JSON.stringify(JSON.parse(readFileSync(join(ROOT, "deploy", "docker", "ops.json"), "utf8")));
	assert.ok(!`${log}${ops}`.includes("'"));
	const script = [
		"#!/bin/sh",
		`{ for arg in "$@"; do printf '%s\\037' "$arg"; done; printf '\\n'; } >> '${log}'`,
		'case "$1 $2" in',
		'"version "*) echo 29.0.0-fake ;;',
		`"image inspect") case "$5" in ${AGENT_IMAGE}) echo '${agentId}' ;; ${CHECK_IMAGE}) echo '${checkId}' ;; *) echo "Error: No such image: $5" >&2; exit 1 ;; esac ;;`,
		'"ps "*|"rm "*) ;;',
		'"container inspect") echo "Error: No such container" >&2; exit 1 ;;',
		`"run "*) case "$*" in *" cat /opt/pi-check/ops.json") printf '%s' '${ops}' ;; *) echo "fake docker: no containers here" >&2; exit 125 ;; esac ;;`,
		'*) echo "fake docker: unsupported" >&2; exit 1 ;;',
		"esac",
		"",
	].join("\n");
	const bin = join(dir, "docker-fake");
	await writeFile(bin, script);
	await chmod(bin, 0o700);
	const calls = (): string[][] =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter((line) => line !== "")
					.map((line) => line.split("\x1f").slice(0, -1))
			: [];
	return { bin, calls, agentId, checkId };
}

const hasPair = (args: readonly string[], flag: string, value: string): boolean =>
	args.some((arg, index) => arg === flag && args[index + 1] === value);

/** The hardening flags of createDockerSandbox, as passed to `docker run`. */
function assertHardenedArgv(args: readonly string[]): void {
	assert.ok(hasPair(args, "--network", "none"), args.join(" "));
	assert.ok(args.includes("--read-only"));
	assert.ok(hasPair(args, "--cap-drop", "ALL"));
	assert.ok(hasPair(args, "--security-opt", "no-new-privileges"));
	assert.ok(hasPair(args, "--pull", "never"));
	assert.ok(hasPair(args, "--user", hostUser()));
	assert.ok(hasPair(args, "--label", `${LABEL_MANAGED}=1`));
}

async function productionWiring(t: TestContext): Promise<void> {
	const base = await realpath(await mkdtemp(join(tmpdir(), "pi-e2e-wiring-")));
	const fake = await fakeDocker(base);
	// No sandbox dependency: startCoordinator builds the Docker sandbox from the config (DOCKER_BIN, images, user), and
	// no evaluator dependency: the Docker evaluator too (EVALUATOR_IMAGE).
	const stack = await startStack({
		sandbox: "docker",
		env: { DOCKER_BIN: fake.bin },
		hiddenTests: { "baseline/version.test.js": "// hidden\n" },
	});
	t.after(async () => {
		await stack.stop();
		await rm(base, { recursive: true, force: true });
	});
	await stack.coordinator.idle();
	const startup = fake.calls();
	assert.deepEqual(startup[0], ["version", "--format", "{{.Server.Version}}"], "fails closed: the daemon is probed");
	for (const image of [AGENT_IMAGE, CHECK_IMAGE]) {
		assert.ok(
			startup.some((args) => args.join(" ") === `image inspect --format {{.Id}} ${image}`),
			image,
		);
	}
	const probe = startup.find((args) => args[0] === "run" && args.at(-1) === "/opt/pi-check/ops.json");
	assert.ok(probe !== undefined, "the operation list is read from the pinned check image");
	assertHardenedArgv(probe);
	assert.deepEqual(probe.slice(-3), [fake.checkId, "cat", "/opt/pi-check/ops.json"], "images are pinned by ID");
	assert.ok(
		startup.some((args) => args[0] === "ps" && hasPair(args, "--filter", `label=${LABEL_MANAGED}=1`)),
		"recovery lists the managed containers",
	);
	assert.ok(
		!stack.lastBotMessages(50).some((message) => /enforcement is unavailable/.test(message.text)),
		"the sandbox was available",
	);

	// A task: its run asks Docker for the agent container; that fails here, and nothing runs on the host instead.
	stack.sendCommand(USER1, "/task alpha write hello.txt");
	const failed = await stack.waitForBotMessage(/^Task 1 failed/);
	assert.match(failed.text, /the agent container could not be started/);
	await stack.coordinator.idle();
	const agentRun = fake.calls().find((args) => args[0] === "run" && args[1] === "-d");
	assert.ok(agentRun !== undefined, "the agent container was requested from Docker");
	assertHardenedArgv(agentRun);
	const taskDir = await realpath(stack.config.paths.taskDir);
	assert.ok(hasPair(agentRun, "--mount", `type=bind,src=${join(taskDir, "worktrees", "task-1")},dst=/work`));
	assert.ok(hasPair(agentRun, "--mount", `type=bind,src=${join(taskDir, "empty-git")},dst=/work/.git,readonly`));
	assert.equal(agentRun.filter((arg) => arg === "--mount").length, 2, "only the worktree and the .git mask");
	assert.ok(hasPair(agentRun, "--label", `${LABEL_TASK}=1`));
	assert.ok(agentRun.includes(fake.agentId), "the agent image is pinned by ID");
	assert.equal(stack.model.requests.length, 0, "no host fallback: the model was never called");

	// The trial harness uses the Docker evaluator built from the config; it is not probed at startup. Its image is
	// missing here: the seal is refused and nothing changes (fails closed), no evaluator container is asked for.
	assert.ok(!startup.some((args) => args.includes("pi-durable-evaluator:demo")), "not probed at startup");
	const seal = await stack.owner("seal", "--trial", "w1");
	assert.equal(seal.code, 1);
	assert.match(
		seal.stderr,
		/refused: the evaluator is not available: evaluator image pi-durable-evaluator:demo is missing \(build it with scripts\/build-images\.sh\)/,
	);
	const evaluatorCalls = fake.calls().filter((args) => args.includes("pi-durable-evaluator:demo"));
	assert.deepEqual(
		evaluatorCalls.map((args) => args.slice(0, 2)),
		[["image", "inspect"]],
	);
	assert.equal(stack.coordinator.store.groupState(stack.config.telegram.groupChatId).state, "normal");
	assert.equal(stack.coordinator.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM evaluations")?.n, 0);
}

test(
	"production wiring: without a sandbox dependency the Coordinator uses the Docker sandbox, never the host; and the Docker evaluator",
	{
		timeout: 60_000,
		skip: process.platform === "win32" ? "needs a POSIX shell for the fake docker CLI" : false,
	},
	(t) => productionWiring(t),
);

test("write safety on the real Docker sandbox: one worktree mounted, out-of-scope writes denied, read-only checks, containers gone", {
	timeout: 240_000,
	skip: DOCKER_SKIP,
}, (t) => {
	assert.ok(DOCKER !== undefined);
	return writeSafetyOnDocker(t, DOCKER);
});
