/**
 * The isolated evaluator on a real Docker daemon (skipped when Docker or the images are unavailable; the images are
 * built offline with scripts/build-images.sh, as in test/coordinator/docker.test.ts, so `npm test` and the lead's
 * `E2E_DOCKER=1 npm test` both run it where Docker is up). Architecture § Isolated evaluator; Agent Execution
 * § Containers (Evaluator column) and § Protected files ("Hidden tests are mounted only in the evaluator container");
 * Capacity § Evaluator ("a single container with 2 vCPU and 2 GiB, and grades the suites sequentially").
 *
 *   - The real pi-durable-evaluator:demo image grades a tiny read-only snapshot with hidden tests (one module passing,
 *     one failing, the integration and baseline suites), one suite after another; per-suite outcomes; "passed" only
 *     when every suite passes (a second, all-passing run).
 *   - While a probe suite holds the container: `docker inspect` shows --network none, 2 vCPU, 2 GiB (no swap), a
 *     read-only root, all capabilities dropped, no-new-privileges, the non-root user, the managed / evaluator / trial
 *     labels, exactly three bind mounts (the snapshot and the hidden tests read-only, the scratch directory writable)
 *     and no credential variable; inside, no network interface but lo, the snapshot, the hidden tests and the root are
 *     read-only, scratch is writable.
 *   - The container is gone afterwards and the scratch directory is wiped.
 *   - Agent and check containers (the production Docker sandbox) never see the hidden tests: no mount of them, no
 *     /eval path, and the host path does not exist inside.
 *
 * Only containers this test creates are removed (by its unique trial label and task id).
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEMO_LIMITS } from "../../src/coordinator/limits.ts";
import type { Evaluator, EvaluatorRun } from "../../src/coordinator/ports.ts";
import { createDockerSandbox, runDocker } from "../../src/coordinator/sandbox/docker.ts";
import { createDockerEvaluator, LABEL_TRIAL } from "../../src/coordinator/sandbox/evaluator.ts";
import { evaluationPassed } from "../../src/coordinator/sandbox/evaluator-output.ts";
import { silentLogger } from "../../src/runtime/log.ts";
import { waitFor } from "../helpers/env.ts";
import { makeWritable } from "../helpers/evaluator.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const IMAGE = "pi-durable-evaluator:demo";

/** Reason to skip, or false when Docker is up and the images were built. */
function prepareDocker(): string | false {
	if (process.platform === "win32") return "Docker tests need a POSIX host";
	const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 20_000 });
	if (version.status !== 0) return "docker is not available";
	const build = spawnSync(join(ROOT, "scripts", "build-images.sh"), [], { timeout: 300_000, encoding: "utf8" });
	if (build.status !== 0) return `images cannot be built: ${String(build.stderr).split("\n")[0] ?? ""}`;
	return false;
}

const skip = prepareDocker();
const user = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.()}` : "1000:1000";
const trialId = `docker-test-${process.pid}-${Date.now()}`;
const taskId = 950_000 + Math.floor(Math.random() * 40_000);

function writeTree(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

const TEST = (body: string) =>
	`const { test } = require("node:test");\nconst assert = require("node:assert/strict");\n${body}\n`;

/**
 * The probe suite, inside the evaluator: what it can reach, written to /scratch/probe.json; then it holds the container
 * until the host writes /scratch/release (the host inspects the running container meanwhile).
 */
const PROBE = TEST(`const fs = require("fs"), os = require("os"), net = require("net");
const code = (fn) => { try { fn(); return "ok"; } catch (e) { return e.code; } };
test("probe", async () => {
	const network = await new Promise((resolve) => {
		const socket = net.connect(80, "192.0.2.1");
		const done = (value) => { socket.destroy(); resolve(value); };
		socket.on("connect", () => done("connected"));
		socket.on("error", (e) => done(e.code));
		setTimeout(() => done("timeout"), 3000);
	});
	const facts = {
		uid: process.getuid(),
		network,
		interfaces: Object.keys(os.networkInterfaces()),
		snapshotWrite: code(() => fs.writeFileSync("/eval/snapshot/evil.txt", "x")),
		hiddenWrite: code(() => fs.writeFileSync("/eval/hidden/evil.txt", "x")),
		rootWrite: code(() => fs.writeFileSync("/etc/evil", "x")),
		scratchWrite: code(() => fs.writeFileSync("/scratch/ok.txt", "x")),
		snapshotSeen: fs.readFileSync("/eval/snapshot/index.js", "utf8"),
		copied: process.cwd() !== "/eval/snapshot" && fs.existsSync("index.js") && fs.existsSync("hidden-tests/probe"),
		env: Object.keys(process.env).sort(),
	};
	fs.writeFileSync("/scratch/probe.json", JSON.stringify(facts));
	while (!fs.existsSync("/scratch/release")) await new Promise((r) => setTimeout(r, 100));
	assert.equal(facts.network === "connected", false);
});`);

describe("isolated evaluator on Docker", { skip }, () => {
	let base = "";
	let evaluator: Evaluator;

	const ours = async (): Promise<string[]> => {
		const listed = await runDocker("docker", [
			"ps",
			"-a",
			"--format",
			"{{.Names}}",
			"--filter",
			`label=${LABEL_TRIAL}=${trialId}`,
		]);
		return listed.stdout.split("\n").filter((line) => line.trim() !== "");
	};
	const inspect = async (name: string, format: string): Promise<unknown> => {
		const output = await runDocker("docker", ["container", "inspect", "--format", format, name]);
		assert.equal(output.code, 0, output.stderr);
		return JSON.parse(output.stdout);
	};

	/** A read-only snapshot, the hidden tests and a scratch directory, as the Coordinator prepares them. */
	const prepare = async (hidden: Record<string, string>) => {
		const dir = mkdtempSync(join(base, "run-"));
		const snapshot = join(dir, "snapshot");
		writeTree(snapshot, {
			"index.js": "exports.version = 1;\n",
			"lib/greet.js": 'exports.greet = (n) => "hi " + n;\n',
		});
		spawnSync("chmod", ["-R", "a-w", snapshot]);
		const hiddenDir = join(dir, "hidden");
		writeTree(hiddenDir, hidden);
		mkdirSync(join(dir, "scratch-root"));
		const scratch = await evaluator.createScratch(join(dir, "scratch-root"));
		return { snapshot, hiddenTests: hiddenDir, scratch };
	};

	before(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "pd-evaluator-")));
		evaluator = createDockerEvaluator({ bin: "docker", image: IMAGE, user, limits: DEMO_LIMITS, log: silentLogger });
	});

	after(async () => {
		for (const name of await ours().catch(() => [])) await runDocker("docker", ["rm", "-f", name]);
		if (base !== "") {
			await makeWritable(base);
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("available: the image is pinned by id and its fixed suite list hashed", async () => {
		assert.deepEqual(await evaluator.available(), { ok: true });
		const facts = evaluator.facts();
		assert.match(facts?.imageId ?? "", /^sha256:[0-9a-f]{64}$/);
		assert.match(facts?.suitesHash ?? "", /^sha256:[0-9a-f]{64}$/);
		const missing = createDockerEvaluator({
			bin: "docker",
			image: "pi-durable-evaluator:does-not-exist",
			user,
			limits: DEMO_LIMITS,
			log: silentLogger,
		});
		assert.equal((await missing.available()).ok, false);
		const root = createDockerEvaluator({
			bin: "docker",
			image: IMAGE,
			user: "0:0",
			limits: DEMO_LIMITS,
			log: silentLogger,
		});
		assert.equal((await root.available()).ok, false, "never as root");
	});

	test("grades the snapshot one suite after another in a container with no network, 2 vCPU / 2 GiB, read-only mounts and scratch; gone afterwards", {
		timeout: 180_000,
	}, async () => {
		const spec = await prepare({
			"modules/greet/greet.test.js": TEST(
				'test("greets", () => assert.equal(require("../../lib/greet.js").greet("a"), "hi a"));',
			),
			"modules/probe/probe.test.js": PROBE,
			"modules/zbroken/broken.test.js": TEST('test("fails", () => assert.equal(1, 2));'),
			"integration/flow.test.js": TEST('test("flow", () => assert.equal(require("../../index.js").version, 1));'),
			"baseline/version.test.js": TEST('test("version", () => assert.equal(require("../../index.js").version, 1));'),
		});
		const running = evaluator.run({ trial: trialId, ...spec, deadlineMs: 120_000 });
		const probeFile = join(spec.scratch, "probe.json");
		await waitFor(() => existsSync(probeFile), { timeoutMs: 90_000, what: "the probe suite" });
		const [name] = await ours();
		assert.ok(name !== undefined, "the evaluator container runs");
		const host = (await inspect(name, "{{json .HostConfig}}")) as Record<string, unknown>;
		assert.equal(host.NetworkMode, "none");
		assert.equal(host.NanoCpus, 2e9);
		assert.equal(host.Memory, 2 * 1024 ** 3);
		assert.equal(host.MemorySwap, 2 * 1024 ** 3);
		assert.equal(host.ReadonlyRootfs, true);
		assert.deepEqual(host.CapDrop, ["ALL"]);
		assert.ok((host.SecurityOpt as string[]).includes("no-new-privileges"));
		assert.equal(await inspect(name, "{{json .Config.User}}"), user);
		const labels = (await inspect(name, "{{json .Config.Labels}}")) as Record<string, string>;
		assert.equal(labels["pi-durable.managed"], "1");
		assert.equal(labels["pi-durable.kind"], "evaluator");
		assert.equal(labels[LABEL_TRIAL], trialId);
		assert.equal(labels["pi-durable.task"], undefined, "a run's scoped sweep never matches it");
		const mounts = (await inspect(name, "{{json .Mounts}}")) as { Source: string; Destination: string; RW: boolean }[];
		assert.deepEqual(mounts.map((mount) => [mount.Destination, mount.Source, mount.RW]).sort(), [
			["/eval/hidden", realpathSync(spec.hiddenTests), false],
			["/eval/snapshot", realpathSync(spec.snapshot), false],
			["/scratch", realpathSync(spec.scratch), true],
		]);
		const env = (await inspect(name, "{{json .Config.Env}}")) as string[];
		assert.ok(!env.some((entry) => /^(OPENAI|GITHUB|TELEGRAM|GH|PI_RUN|DOCKER)_/.test(entry)), env.join());
		const facts = JSON.parse(readFileSync(probeFile, "utf8"));
		assert.notEqual(facts.uid, 0);
		assert.deepEqual(facts.interfaces, ["lo"]);
		assert.notEqual(facts.network, "connected");
		assert.equal(facts.snapshotWrite, "EROFS");
		assert.equal(facts.hiddenWrite, "EROFS");
		assert.equal(facts.rootWrite, "EROFS");
		assert.equal(facts.scratchWrite, "ok");
		assert.equal(facts.snapshotSeen, "exports.version = 1;\n");
		assert.equal(facts.copied, true, "suites run in a copy of the snapshot");
		assert.ok(!facts.env.some((key: string) => /TOKEN|KEY|SECRET/.test(key)), facts.env.join());
		writeFileSync(join(spec.scratch, "release"), "");
		const result: EvaluatorRun = await running;
		assert.equal(result.kind, "ran");
		assert.equal(result.kind === "ran" && result.end, "exited");
		assert.deepEqual(result.kind === "ran" ? result.suites.map((suite) => `${suite.name}=${suite.outcome}`) : [], [
			"module:greet=passed",
			"module:probe=passed",
			"module:zbroken=failed",
			"integration=passed",
			"baseline=passed",
		]);
		assert.equal(evaluationPassed(result), false, "one suite failed");
		assert.deepEqual(await ours(), [], "the container is gone");
		assert.equal(await evaluator.wipeScratch(spec.scratch), true);
		assert.equal(existsSync(spec.scratch), false);

		// Every suite passing: passed.
		const clean = await prepare({
			"modules/greet/greet.test.js": TEST(
				'test("greets", () => assert.equal(require("../../lib/greet.js").greet("b"), "hi b"));',
			),
			"integration/flow.test.js": TEST('test("flow", () => {});'),
			"baseline/version.test.js": TEST('test("version", () => assert.equal(require("../../index.js").version, 1));'),
		});
		const passed = await evaluator.run({ trial: trialId, ...clean, deadlineMs: 120_000 });
		assert.equal(evaluationPassed(passed), true, JSON.stringify(passed));
		assert.equal(await evaluator.wipeScratch(clean.scratch), true);
		assert.deepEqual(await ours(), []);
	});

	test("the deadline stops the container: the suite in progress timed out, the rest never ran", {
		timeout: 120_000,
	}, async () => {
		const spec = await prepare({
			"modules/hang/hang.test.js": TEST('test("hangs", () => new Promise(() => setInterval(() => {}, 1000)));'),
			"integration/flow.test.js": TEST('test("flow", () => {});'),
			"baseline/version.test.js": TEST('test("version", () => {});'),
		});
		// Long enough for the container to start and print its plan on a loaded host; the hanging suite outlasts it.
		const result = await evaluator.run({ trial: trialId, ...spec, deadlineMs: 10_000 });
		assert.equal(result.kind === "ran" && result.end, "timeout");
		assert.deepEqual(result.kind === "ran" ? result.suites.map((suite) => suite.outcome) : [], [
			"timeout",
			"not_run",
			"not_run",
		]);
		await waitFor(async () => (await ours()).length === 0, { timeoutMs: 30_000, what: "the stopped container gone" });
		assert.equal(await evaluator.wipeScratch(spec.scratch), true);
	});

	test("agent and check containers never see the hidden tests: no mount, no /eval, the host path absent inside", {
		timeout: 120_000,
	}, async (t) => {
		const taskDir = join(base, "tasks");
		const hidden = join(base, "hidden-tests");
		writeTree(hidden, { "modules/m/secret.test.js": "// hidden\n" });
		const worktree = join(taskDir, "worktrees", "task-hidden");
		writeTree(worktree, {
			"package.json": JSON.stringify({ name: "probe", private: true, scripts: { test: "node probe.js" } }),
			"probe.js": `const fs = require("fs");
const mounts = fs.readFileSync("/proc/self/mountinfo", "utf8");
const seen = [fs.existsSync("/eval"), fs.existsSync(${JSON.stringify(hidden)}), mounts.includes("hidden-tests")];
console.log(JSON.stringify(seen));
process.exit(seen.some(Boolean) ? 1 : 0);
`,
		});
		writeFileSync(join(worktree, ".git"), `gitdir: ${join(taskDir, "repo.git", "worktrees", "task-hidden")}\n`);
		const sandbox = createDockerSandbox({
			bin: "docker",
			agentImage: "pi-durable-agent:demo",
			checkImage: "pi-durable-check:demo",
			user,
			taskDir,
			limits: { ...DEMO_LIMITS, stopGraceMs: 10_000 },
			log: silentLogger,
			setupScript: ".pi/setup.sh",
		});
		t.after(() => sandbox.killAll({ taskId }).catch(() => {}));
		assert.deepEqual(await sandbox.available(), { ok: true });
		const agent = await sandbox.startAgent({ taskId, generation: 1, worktree, lifetimeMs: 60_000 });
		const mounts = (await inspect(agent.name, "{{json .Mounts}}")) as { Source: string; Destination: string }[];
		assert.ok(
			mounts.every((mount) => !mount.Source.startsWith(realpathSync(hidden)) && !mount.Destination.startsWith("/eval")),
			JSON.stringify(mounts),
		);
		const inside = await runDocker("docker", [
			"exec",
			agent.name,
			"node",
			"-e",
			`console.log(require("fs").existsSync(${JSON.stringify(hidden)}) || require("fs").existsSync("/eval"))`,
		]);
		assert.equal(inside.stdout.trim(), "false");
		await agent.stop();
		const check = await sandbox.runCheck({
			taskId,
			generation: 1,
			worktree,
			op: "test",
			writable: false,
			timeoutMs: 60_000,
		});
		assert.equal(check.outcome, "passed", check.output);
		assert.match(check.output, /\[false,false,false\]/);
	});
});
