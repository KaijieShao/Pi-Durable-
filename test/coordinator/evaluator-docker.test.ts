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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEMO_LIMITS } from "../../src/coordinator/limits.ts";
import type { Evaluator } from "../../src/coordinator/ports.ts";
import { createDockerSandbox, runDocker } from "../../src/coordinator/sandbox/docker.ts";
import { createDockerEvaluator, LABEL_TRIAL } from "../../src/coordinator/sandbox/evaluator.ts";
import { evaluationPassed } from "../../src/coordinator/sandbox/evaluator-output.ts";
import { silentLogger } from "../../src/runtime/log.ts";
import { waitFor } from "../helpers/env.ts";
import { fullNodeProgram, makeWritable, nodeSuite } from "../helpers/evaluator.ts";

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

/** This trusted host-invoked probe does not import candidate code. Assertions also inspect Docker's own metadata. */
const PROBE = `const fs=require("node:fs"), os=require("node:os"), net=require("node:net");
const code=fn=>{try{fn();return "ok"}catch(e){return e.code}};
(async()=>{
 const network=await new Promise(resolve=>{const s=net.connect(80,"192.0.2.1");const done=v=>{s.destroy();resolve(v)};s.on("connect",()=>done("connected"));s.on("error",e=>done(e.code));setTimeout(()=>done("timeout"),1000)});
 console.log(JSON.stringify({uid:process.getuid(),interfaces:Object.keys(os.networkInterfaces()),network,
 snapshotSeen:fs.existsSync("/eval/snapshot/index.js"),snapshotContent:fs.existsSync("/eval/snapshot/index.js")?fs.readFileSync("/eval/snapshot/index.js","utf8"):null,hiddenSeen:fs.existsSync("/eval/hidden"),
 snapshotWrite:code(()=>fs.writeFileSync("/eval/snapshot/evil.txt","x")),hiddenWrite:code(()=>fs.writeFileSync("/eval/hidden/evil.txt","x")),
 rootWrite:code(()=>fs.writeFileSync("/etc/evil","x")),scratchWrite:code(()=>fs.writeFileSync("/scratch/ok.txt","x")),
 copied:fs.existsSync("/scratch/project/index.js"),dockerSocket:fs.existsSync("/var/run/docker.sock"),env:Object.keys(process.env)}));
})().catch(()=>process.exit(1));`;

const normalHidden = () => ({
	...nodeSuite("modules/greet", "greet.test.js", [
		{ id: "greets", name: "greets", body: 'assert.equal(await app.call("lib/greet.js","greet",["a"]),"hi a");' },
	]),
	...nodeSuite("integration", "flow.test.mjs", [
		{
			id: "flow",
			name: "flow",
			body: 'assert.equal(await app.evaluate(\'return (await importModule("lib/greet.js")).greet("b") && (await importModule("index.js")).version;\'),1);',
		},
	]),
	...nodeSuite("baseline", "version.test.cjs", [
		{ id: "version", name: "version", body: 'assert.equal(await app.call("index.js","version"),1);' },
	]),
});

function forgedObservation(id: number, payload: string, exit = false): string {
	return `const transport=process._getActiveHandles().find(h=>h.constructor.name==="Socket"&&h!==process.stdout&&h!==process.stderr&&h!==process.stdin);
	transport.write("\\u001ePDAPP3 "+JSON.stringify({id:${id},ok:true,payload:${payload}})+"\\n"${exit ? ",()=>process.exit(0)" : ""});exports.version=()=>new Promise(()=>{});`;
}

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
	const prepare = async (hidden: Record<string, string>, snapshotFiles: Record<string, string> = {}) => {
		const dir = mkdtempSync(join(base, "run-"));
		const snapshot = join(dir, "snapshot");
		writeTree(snapshot, {
			"index.js": "exports.version = 1;\n",
			"lib/greet.js": 'exports.greet = (n) => "hi " + n;\n',
			...snapshotFiles,
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

	const verifyRole = async (name: string, spec: { snapshot: string; hiddenTests: string; scratch: string }) => {
		const role = await inspect(name, '{{json (index .Config.Labels "pi-durable.eval-role")}}');
		assert.ok(role === "grader" || role === "app");
		const host = (await inspect(name, "{{json .HostConfig}}")) as Record<string, unknown>;
		assert.equal(host.NetworkMode, "none");
		assert.equal(host.ReadonlyRootfs, true);
		assert.deepEqual(host.CapDrop, ["ALL"]);
		assert.ok((host.SecurityOpt as string[]).includes("no-new-privileges"));
		assert.equal(host.PidMode, "");
		assert.equal(host.Memory, 1024 ** 3);
		assert.equal(host.MemorySwap, 1024 ** 3);
		assert.equal(host.NanoCpus, 1e9);
		assert.equal(host.PidsLimit, 256);
		assert.equal(await inspect(name, "{{json .Config.User}}"), user);
		const labels = (await inspect(name, "{{json .Config.Labels}}")) as Record<string, string>;
		assert.equal(labels["pi-durable.managed"], "1");
		assert.equal(labels["pi-durable.kind"], "evaluator");
		assert.equal(labels[LABEL_TRIAL], trialId);
		assert.equal(labels["pi-durable.task"], undefined);
		const mounts = (await inspect(name, "{{json .Mounts}}")) as {
			Source: string;
			Destination: string;
			RW: boolean;
		}[];
		assert.equal(mounts.length, 2, "only role-specific read-only source and its private scratch");
		const source =
			role === "app"
				? ["/eval/snapshot", realpathSync(spec.snapshot), false]
				: ["/eval/hidden", realpathSync(spec.hiddenTests), false];
		const mount = mounts.find((m) => m.Destination === source[0]);
		assert.deepEqual(mount && [mount.Destination, mount.Source, mount.RW], source);
		const scratch = mounts.find((m) => m.Destination === "/scratch");
		assert.ok(scratch?.RW);
		assert.ok(scratch.Source.startsWith(`${realpathSync(spec.scratch)}/`));
		const env = (await inspect(name, "{{json .Config.Env}}")) as string[];
		assert.ok(!env.some((e) => /^(OPENAI|GITHUB|TELEGRAM|GH|PI_RUN|DOCKER)_/.test(e)));
		const output = await runDocker("docker", ["exec", name, "node", "-e", PROBE]);
		assert.equal(output.code, 0);
		const facts = JSON.parse(output.stdout);
		assert.notEqual(facts.uid, 0);
		assert.deepEqual(facts.interfaces, ["lo"]);
		assert.notEqual(facts.network, "connected");
		assert.equal(facts.snapshotSeen, role === "app");
		if (role === "app") assert.equal(facts.snapshotContent, "exports.version = 1;\n");
		assert.equal(facts.hiddenSeen, role === "grader");
		assert.equal(facts.copied, role === "app");
		assert.equal(facts.dockerSocket, false);
		assert.equal(role === "app" ? facts.snapshotWrite : facts.hiddenWrite, "EROFS");
		assert.equal(facts.rootWrite, "EROFS");
		assert.equal(facts.scratchWrite, "ok");
		assert.ok(!facts.env.some((k: string) => /TOKEN|KEY|SECRET/.test(k)));
		return {
			cpus: Number(host.NanoCpus),
			memory: Number(host.Memory),
			pids: Number(host.PidsLimit),
			scratch: scratch.Source,
		};
	};

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

	test("grades native hidden tests externally; two disjoint containers preserve no network, aggregate 2 CPU/2 GiB/512 pids and read-only mounts; cleanup verified", {
		timeout: 180_000,
	}, async () => {
		const spec = await prepare({
			...normalHidden(),
			...nodeSuite("modules/probe", "probe.test.js", [
				{
					id: "probe",
					name: "probe",
					body: `
				assert.equal(await app.call("index.js","version"),1);
				const fs=require("node:fs"); fs.writeFileSync("/scratch/probe.json","ready");
				while(!fs.existsSync("/scratch/release")) await new Promise(r=>setTimeout(r,50));
			`,
				},
			]),
			...nodeSuite("modules/zbroken", "broken.test.js", [
				{ id: "fails", name: "fails", body: 'assert.equal(await app.call("index.js","version"),2);' },
			]),
		});
		const running = evaluator.run({ trial: trialId, ...spec, deadlineMs: 120_000 });
		const graderName = await waitFor(
			async () => {
				for (const name of await ours())
					if ((await inspect(name, '{{json (index .Config.Labels "pi-durable.eval-role")}}')) === "grader") return name;
				return undefined;
			},
			{ timeoutMs: 90_000, what: "trusted grader container" },
		);
		const graderMounts = (await inspect(graderName, "{{json .Mounts}}")) as {
			Source: string;
			Destination: string;
			RW: boolean;
		}[];
		const graderScratch = graderMounts.find((m) => m.Destination === "/scratch")?.Source;
		assert.ok(graderScratch);
		await waitFor(() => existsSync(join(graderScratch, "probe.json")), {
			timeoutMs: 90_000,
			what: "trusted hidden probe",
		});
		const names = await ours();
		assert.equal(names.length, 2, "one trusted grader plus one isolated app");
		let cpus = 0,
			memory = 0,
			pids = 0;
		const scratches: string[] = [];
		for (const name of names) {
			const role = await verifyRole(name, spec);
			cpus += role.cpus;
			memory += role.memory;
			pids += role.pids;
			scratches.push(role.scratch);
		}
		assert.equal(cpus, 2e9);
		assert.equal(memory, 2 * 1024 ** 3);
		assert.equal(pids, 512);
		assert.notEqual(scratches[0], scratches[1]);
		writeFileSync(join(graderScratch, "release"), "");
		const result = await running;
		assert.equal(result.kind === "ran" && result.end, "exited", JSON.stringify(result));
		assert.deepEqual(result.kind === "ran" ? result.suites.map((s) => `${s.name}=${s.outcome}`) : [], [
			"module:greet=passed",
			"module:probe=passed",
			"module:zbroken=failed",
			"integration=passed",
			"baseline=passed",
		]);
		assert.equal(evaluationPassed(result), false);
		assert.deepEqual(await ours(), []);
		assert.deepEqual(await evaluator.live(), []);
		assert.equal(await evaluator.wipeScratch(spec.scratch), true);
		assert.equal(existsSync(spec.scratch), false);
		const clean = await prepare(normalHidden());
		const passed = await evaluator.run({ trial: trialId, ...clean, deadlineMs: 120_000 });
		assert.equal(evaluationPassed(passed), true, JSON.stringify(passed));
		assert.equal(await evaluator.wipeScratch(clean.scratch), true);
		assert.deepEqual(await ours(), []);
	});

	test("real full-Node app: early exits, forged output/results, stale globals and swallowed transport failures cannot pass", {
		timeout: 180_000,
	}, async () => {
		const ordinary = 'assert.equal(await app.call("index.js","version"),1);';
		const attacks = [
			{ module: "index.js", source: "process.exit(0);", body: ordinary, transport: true },
			{
				module: "index.js",
				source:
					'require("node:fs").writeSync(1,\'{"type":"suite","name":"baseline","outcome":"passed"}\'); exports.version=2;',
				body: ordinary,
			},
			{
				module: "index.js",
				source:
					'require("node:test").test("forged passing result",()=>{}); exports.version={outcome:"passed",type:"suite"};',
				body: ordinary,
			},
			{
				module: "evil.mjs",
				source: 'Object.defineProperty(globalThis,"__observation",{get:()=>1,set:()=>{}}); export const version=2;',
				body: 'assert.equal(await app.call("evil.mjs","version"),1);',
			},
			{
				module: "index.js",
				source: "process.exit(0);",
				body: 'await assert.rejects(app.call("index.js","version"));',
				transport: true,
			},
			{
				module: "index.js",
				source: forgedObservation(1, 'require("node:v8").serialize(1).toString("base64")', true),
				body: ordinary,
				transport: true,
			},
			{
				module: "index.js",
				source: forgedObservation(1, JSON.stringify("AAAA")),
				body: 'await assert.rejects(app.call("index.js","version"));',
				transport: true,
			},
			{
				module: "index.js",
				source: forgedObservation(999, JSON.stringify("AAAA")),
				body: 'await assert.rejects(app.call("index.js","version"));',
				transport: true,
			},
		];
		for (const attack of attacks) {
			const hidden = {
				...nodeSuite("modules/attack", "attack.test.js", [{ id: "version", name: "version", body: attack.body }]),
				...nodeSuite("integration", "flow.test.js", [{ id: "flow", name: "flow", body: "assert.equal(1,1);" }]),
				...nodeSuite("baseline", "version.test.js", [{ id: "baseline", name: "baseline", body: "assert.equal(1,1);" }]),
			};
			const spec = await prepare(hidden, { [attack.module]: attack.source });
			const result = await evaluator.run({ trial: trialId, ...spec, deadlineMs: 30_000 });
			assert.equal(evaluationPassed(result), false, `${attack.source} ${JSON.stringify(result)}`);
			if (attack.transport) assert.equal(result.kind === "ran" && result.subjectFailed, true, attack.source);
			assert.deepEqual(await ours(), []);
			assert.equal(await evaluator.wipeScratch(spec.scratch), true);
		}
	});

	const incompleteNativeFixture = (spec: { hiddenTests: string }, source: string) => {
		const path = join(spec.hiddenTests, "modules/greet/greet.test.js");
		writeFileSync(path, source.startsWith("test") ? `const {test}=require("node:test");${source}` : source);
		if (source.startsWith("test"))
			writeFileSync(
				join(spec.hiddenTests, "modules/greet/expected.json"),
				JSON.stringify({
					version: 3,
					tests: [
						{ id: "greets", name: "greets", file: "greet.test.js" },
						{ id: "missing", name: "missing", file: "greet.test.js" },
					],
				}),
			);
	};

	test("real trusted Node runner: skipped/todo/only-missing tests and missing/truncated reports fail closed", {
		timeout: 180_000,
	}, async () => {
		for (const option of ["{skip:true}", "{todo:true}"]) {
			const spec = await prepare({
				...normalHidden(),
				...nodeSuite("modules/greet", "greet.test.js", [
					{ id: "greets", name: "greets", body: "assert.equal(1,1);", options: option },
				]),
			});
			assert.equal(
				evaluationPassed(await evaluator.run({ trial: trialId, ...spec, deadlineMs: 30_000 })),
				false,
				option,
			);
			assert.equal(await evaluator.wipeScratch(spec.scratch), true);
		}
		for (const source of ["process.exit(0);", 'test.only("greets",()=>{});']) {
			const spec = await prepare(normalHidden());
			incompleteNativeFixture(spec, source);
			assert.equal(
				evaluationPassed(await evaluator.run({ trial: trialId, ...spec, deadlineMs: 30_000 })),
				false,
				source,
			);
			assert.equal(await evaluator.wipeScratch(spec.scratch), true);
		}
		for (const manifest of ["", "{"]) {
			const spec = await prepare(normalHidden());
			writeFileSync(join(spec.hiddenTests, "modules/greet/expected.json"), manifest);
			assert.equal(evaluationPassed(await evaluator.run({ trial: trialId, ...spec, deadlineMs: 30_000 })), false);
			assert.equal(await evaluator.wipeScratch(spec.scratch), true);
		}
	});

	test("real full Node filesystem/async/ESM/child-process/native streams and V8 values remain usable; actual file proof rejects spoofing", {
		timeout: 180_000,
	}, async () => {
		const body = `const value=await app.evaluate(${JSON.stringify(fullNodeProgram)});
		 assert.deepEqual(value.data,Buffer.from("abc"));assert.deepEqual(value.map,new Map([["key",1]]));assert.equal(value.big,123n);assert.equal(value.child,"child");assert.equal(value.streamCallback,true);assert.equal(value.streamDrain,true);assert.equal((await app.readFile("proof.txt")).toString(),"real file");
		 assert.equal(await app.call("esm/value.js","version"),1);assert.equal(await app.call("receiver.js","value"),7);
		 await app.evaluate('require("node:fs").symlinkSync("/etc/passwd","unsafe");return true;');await assert.rejects(app.readFile("unsafe"));await assert.rejects(app.readFile("../outside"));
		 const result=await app.exec(["node","-e",${JSON.stringify('process.stdout.write("cli");process.stderr.write("err")')}]);assert.equal(result.stdout.toString(),"cli");assert.equal(result.stderr.toString(),"err");assert.equal(result.exitCode,0);
		`;
		const hidden = {
			...normalHidden(),
			...nodeSuite("modules/greet", "greet.test.js", [{ id: "full-node", name: "full Node", body }]),
		};
		const files = {
			"esm/package.json": '{"type":"module"}',
			"esm/value.js": "await new Promise(r=>setTimeout(r,5)); export const version=1;",
			"receiver.js": "exports.n=7;exports.value=function(){return this.n};",
		};
		const spec = await prepare(hidden, files);
		const result = await evaluator.run({ trial: trialId, ...spec, deadlineMs: 60_000 });
		assert.equal(evaluationPassed(result), true, JSON.stringify(result));
		assert.equal(await evaluator.wipeScratch(spec.scratch), true);
		const spoof = await prepare(
			{
				...normalHidden(),
				...nodeSuite("modules/greet", "greet.test.js", [
					{
						id: "proof",
						name: "proof",
						body: 'await app.call("index.js","version"); await app.evaluate(\'require("node:fs").writeFileSync("proof.txt","never written");return true;\'); assert.equal((await app.readFile("proof.txt")).toString(),"never written");',
					},
				]),
			},
			{ "index.js": 'require("node:fs").writeFileSync=()=>{};exports.version=1;' },
		);
		assert.equal(evaluationPassed(await evaluator.run({ trial: trialId, ...spoof, deadlineMs: 30_000 })), false);
		assert.equal(await evaluator.wipeScratch(spoof.scratch), true);
	});

	test("the deadline stops the container: the suite in progress timed out, the rest never ran", {
		timeout: 120_000,
	}, async () => {
		const spec = await prepare({
			...nodeSuite("modules/hang", "hang.test.js", [
				{ id: "hangs", name: "hangs", body: 'await app.evaluate("while(true){}");' },
			]),
			...nodeSuite("integration", "flow.test.js", [{ id: "flow", name: "flow", body: "assert.equal(1,1);" }]),
			...nodeSuite("baseline", "version.test.js", [{ id: "version", name: "version", body: "assert.equal(1,1);" }]),
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
