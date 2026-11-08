/**
 * The sealed snapshot and the evaluator without Docker (Architecture § Sealing, § Isolated evaluator; Evaluation
 * § What's Graded: "passed" comes only from the evaluator):
 *   - exportSnapshot: exactly the commit's files (no git data), read-only, renamed into place with a read-only manifest
 *     (commit, tree, content hash); a leftover partial copy is replaced; the content hash sees every change; the
 *     export refuses a target outside the task directory;
 *   - the launcher's output as the Coordinator reads it: only planned suites count, a missing one is not_run (timeout
 *     after the deadline), "passed" only if the launcher finished and every planned suite passed;
 *   - the evaluator image's launcher (deploy/docker/run-eval.mjs) on the host: the suites one after another in the
 *     fixed order, one per module, hidden tests copied into a fresh copy of the snapshot, a suite without test files
 *     is an error, a failing one failed, a hanging one timed out, the overall deadline, bad arguments; the snapshot
 *     itself is never written and the scratch space is left empty;
 *   - the local test evaluator: its deadline, the caller's abort, missing mount sources.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { exportSnapshot, removeTree, snapshotPaths, treeHash } from "../../src/coordinator/engine/snapshot.ts";
import { createGit, GitError } from "../../src/coordinator/git.ts";

import { evaluationPassed, evaluatorRunOf } from "../../src/coordinator/sandbox/evaluator-output.ts";
import { createLocalEvaluator } from "../../src/coordinator/sandbox/local.ts";
import { silentLogger } from "../../src/runtime/log.ts";
import { waitFor } from "../helpers/env.ts";
import { fullNodeProgram, makeWritable, nodeSuite, runLauncher } from "../helpers/evaluator.ts";
import { commitOnOrigin, createOriginRepo } from "../helpers/fake-github.ts";

const roots: string[] = [];
after(async () => {
	for (const dir of roots) {
		await makeWritable(dir);
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	roots.push(dir);
	return dir;
}

function writeTree(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

const mode = (path: string): number => lstatSync(path).mode & 0o777;
const author = { name: "Test", email: "t@example.invalid" };

// ---------------------------------------------------------------------------------------------------------------
// The snapshot

test("exportSnapshot: the commit's files only, read-only, with its manifest; a leftover partial copy is replaced; the hash sees every change", async () => {
	const root = tempDir("pd-snap-");
	const files = { "index.js": "module.exports = 1;\n", "lib/a.js": "exports.a = 1;\n", "bin/run.sh": "#!/bin/sh\n" };
	const { bare, mainSha } = await createOriginRepo(join(root, "origin"), files);
	const taskDir = join(root, "tasks");
	const git = createGit({ taskDir, remoteUrl: bare, baseBranch: "main", token: undefined, author, log: silentLogger });
	await git.ensureRepo();
	assert.equal(await git.fetchBase(), mainSha);
	// A partial copy left by an earlier attempt (a restart mid-export).
	const paths = snapshotPaths(taskDir, "t1", mainSha);
	mkdirSync(join(paths.partial, "stale"), { recursive: true });
	writeFileSync(join(paths.partial, "stale", "x"), "old");

	const snapshot = await exportSnapshot(git, taskDir, { trial: "t1", commit: mainSha });
	assert.equal(snapshot.path, join(taskDir, "snapshots", `t1-${mainSha.slice(0, 12)}`));
	assert.deepEqual(readdirSync(snapshot.path).sort(), ["bin", "index.js", "lib"], "no git data, no leftover");
	assert.equal(readFileSync(join(snapshot.path, "lib", "a.js"), "utf8"), files["lib/a.js"]);
	assert.equal(mode(snapshot.path), 0o555);
	assert.equal(mode(join(snapshot.path, "lib")), 0o555);
	assert.equal(mode(join(snapshot.path, "index.js")), 0o444);
	assert.throws(() => writeFileSync(join(snapshot.path, "new.txt"), "x"), /EACCES/);
	assert.throws(() => writeFileSync(join(snapshot.path, "index.js"), "x"), /EACCES/);
	assert.equal(lstatSync(paths.partial, { throwIfNoEntry: false }), undefined, "the partial copy is gone");
	const manifest = JSON.parse(readFileSync(snapshot.manifest, "utf8"));
	assert.equal(mode(snapshot.manifest), 0o444);
	assert.deepEqual(manifest, {
		trial: "t1",
		commit: mainSha,
		tree: await git.treeId(mainSha),
		hash: snapshot.hash,
		files: 3,
		bytes: Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
		path: snapshot.path,
	});
	assert.match(snapshot.hash, /^sha256:[0-9a-f]{64}$/);
	assert.equal((await treeHash(snapshot.path)).hash, snapshot.hash, "stable");

	// Another commit has another hash; a change of one byte or of the executable bit changes it too.
	const next = await commitOnOrigin(bare, "main", { "lib/a.js": "exports.a = 2;\n" });
	await git.fetchBase();
	const other = await exportSnapshot(git, taskDir, { trial: "t2", commit: next });
	assert.notEqual(other.hash, snapshot.hash);
	const copy = join(root, "copy");
	writeTree(copy, files);
	const before = (await treeHash(copy)).hash;
	writeFileSync(join(copy, "index.js"), "module.exports = 2;\n");
	assert.notEqual((await treeHash(copy)).hash, before);

	// The export never writes outside the task directory; a read-only snapshot can still be removed.
	mkdirSync(join(root, "elsewhere"));
	await assert.rejects(git.exportTree(mainSha, join(root, "elsewhere")), GitError);
	assert.equal(await removeTree(other.path), true);
	assert.equal(lstatSync(other.path, { throwIfNoEntry: false }), undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// The launcher's output

const line = (event: object): string => JSON.stringify(event);
const plan = (...suites: string[]) =>
	line({ type: "plan", version: 3, suites, expectedTests: Object.fromEntries(suites.map((name) => [name, ["test"]])) });
const suite = (name: string, outcome: string, exitCode?: number) =>
	line({
		type: "suite",
		name,
		outcome,
		exitCode,
		durationMs: 5,
		expectedTests: ["test"],
		executedTests: ["test"],
		passedTests: outcome === "passed" ? ["test"] : [],
	});
const clean = { exitCode: 0, timedOut: false, aborted: false, failed: false, durationMs: 10 };

test("the launcher's output: only planned suites count, a missing one is not_run (timeout at the deadline); passed only if all passed and it finished", () => {
	const all = [plan("module:a", "integration"), suite("module:a", "passed", 0), suite("integration", "passed", 0)];
	const ok = evaluatorRunOf([...all, line({ type: "done" })].join("\n"), clean);
	assert.equal(ok.end, "exited");
	assert.deepEqual(
		ok.suites.map((s) => [s.name, s.outcome, s.exitCode]),
		[
			["module:a", "passed", 0],
			["integration", "passed", 0],
		],
	);
	assert.equal(evaluationPassed(ok), true);
	assert.equal(
		evaluationPassed({ ...ok, suites: ok.suites.map((result) => ({ ...result, exitCode: 1 })) }),
		false,
		"the final decision itself rejects a nonzero exit, including trusted adapter results",
	);
	// Forged or repeated lines fail closed: a suite outside the plan, a second result, junk.
	const forged = [plan("module:a"), suite("module:a", "failed", 1), suite("module:a", "passed", 0)];
	forged.push(
		suite("integration", "passed", 0),
		"not json",
		line({ type: "plan", suites: ["x"] }),
		line({ type: "done" }),
	);
	const noisy = evaluatorRunOf(forged.join("\n"), clean);
	assert.deepEqual(
		noisy.suites.map((s) => s.outcome),
		["failed"],
	);
	assert.equal(evaluationPassed(noisy), false);
	// Not finished: no done line, a launcher exit code, a container limit, no plan at all.
	assert.equal(evaluatorRunOf(all.join("\n"), clean).end, "error");
	assert.equal(evaluatorRunOf([...all, line({ type: "done" })].join("\n"), { ...clean, exitCode: 70 }).end, "error");
	assert.equal(evaluatorRunOf([...all, line({ type: "done" })].join("\n"), { ...clean, failed: true }).end, "error");
	const empty = evaluatorRunOf(line({ type: "done" }), clean);
	assert.deepEqual([empty.end, empty.suites], ["error", []]);
	assert.equal(evaluationPassed(evaluatorRunOf([plan(), line({ type: "done" })].join("\n"), clean)), false);
	// The Coordinator's deadline: the suite in progress (no line) timed out, the rest never ran. At its own deadline
	// (exit 124) the launcher reported the suite in progress itself.
	const cut = [plan("module:a", "integration", "baseline"), suite("module:a", "passed", 0)].join("\n");
	const own = [cut, suite("integration", "timeout")].join("\n");
	for (const [stdout, end] of [
		[cut, { ...clean, exitCode: undefined, timedOut: true }],
		[own, { ...clean, exitCode: 124 }],
	] as const) {
		const run = evaluatorRunOf(stdout, end);
		assert.equal(run.end, "timeout");
		assert.deepEqual(
			run.suites.map((s) => s.outcome),
			["passed", "timeout", "not_run"],
		);
		assert.equal(evaluationPassed(run), false);
	}
	const aborted = evaluatorRunOf(cut, { ...clean, exitCode: undefined, aborted: true });
	assert.deepEqual([aborted.end, aborted.suites.map((s) => s.outcome)], ["aborted", ["passed", "not_run", "not_run"]]);
	assert.equal(evaluationPassed({ kind: "not_started", reason: "x" }), false);
});

// ---------------------------------------------------------------------------------------------------------------
// The launcher on the host

function evalDirs(hidden: Record<string, string>) {
	const root = tempDir("pd-eval-");
	const snapshot = join(root, "snapshot");
	writeTree(snapshot, { "index.js": "exports.version = 1;\n", "lib/greet.js": 'exports.greet = (n) => "hi " + n;\n' });
	const hiddenDir = join(root, "hidden");
	mkdirSync(hiddenDir);
	writeTree(hiddenDir, hidden);
	const scratch = join(root, "scratch");
	mkdirSync(scratch);
	return { root, snapshot, hidden: hiddenDir, scratch };
}

function events(stdout: string): Record<string, unknown>[] {
	return stdout
		.split("\n")
		.filter((text) => text !== "")
		.map((text) => JSON.parse(text) as Record<string, unknown>);
}

function normalHidden() {
	return {
		...nodeSuite("modules/greet", "greet.test.js", [
			{ id: "greets", name: "greets", body: 'assert.equal(await app.call("lib/greet.js", "greet", ["a"]), "hi a");' },
		]),
		...nodeSuite("integration", "flow.test.mjs", [
			{
				id: "flow",
				name: "flow",
				body: 'assert.equal(await app.evaluate(\'const m = await importModule("lib/greet.js"); const b = await importModule("index.js"); return m.greet("b") && b.version;\'), 1);',
			},
		]),
		...nodeSuite("baseline", "version.test.cjs", [
			{
				id: "version",
				name: "version",
				body: 'require("node:fs").writeFileSync("written-by-a-test.txt", "x"); assert.equal(await app.call("index.js", "version"), 1);',
			},
		]),
	};
}

function runOf(result: Awaited<ReturnType<typeof runLauncher>>) {
	return evaluatorRunOf(result.stdout, {
		...clean,
		exitCode: result.exitCode,
		failed: result.failed || result.subjectFailed,
	});
}

test("run-eval.mjs: native Node suites sequentially in fresh application processes; failing and empty suites; immutable snapshot and empty scratch", async () => {
	const dirs = evalDirs({
		...normalHidden(),
		...nodeSuite("modules/broken", "broken.test.js", [
			{ id: "fails", name: "fails", body: 'assert.equal(await app.call("index.js", "version"), 2);' },
		]),
		"modules/empty/README.md": "no hidden tests here\n",
	});
	chmodTree(dirs.snapshot);
	const before = await treeHash(dirs.snapshot);
	const result = await runLauncher(dirs);
	assert.equal(result.exitCode, 0, result.stderr);
	const out = events(result.stdout);
	assert.deepEqual(out[0], {
		type: "plan",
		version: 3,
		suites: ["module:broken", "module:empty", "module:greet", "integration", "baseline"],
		expectedTests: {
			"module:broken": ["fails"],
			"module:empty": [],
			"module:greet": ["greets"],
			integration: ["flow"],
			baseline: ["version"],
		},
	});
	assert.deepEqual(
		out.slice(1, -1).map((event) => [event.type, event.name, event.outcome, event.exitCode]),
		[
			["suite", "module:broken", "failed", 1],
			["suite", "module:empty", "error", undefined],
			["suite", "module:greet", "passed", 0],
			["suite", "integration", "passed", 0],
			["suite", "baseline", "passed", 0],
		],
	);
	assert.deepEqual(out.at(-1), { type: "done" });
	assert.equal((await treeHash(dirs.snapshot)).hash, before.hash);
	assert.deepEqual(readdirSync(dirs.scratch), []);
	assert.equal(evaluationPassed(runOf(result)), false);
});

test("run-eval.mjs: missing modules/suites, hanging native async test, overall deadline, bad arguments and unsafe argv", async () => {
	const dirs = evalDirs(
		nodeSuite("integration", "hang.test.js", [
			{ id: "hangs", name: "hangs", body: "await new Promise(() => setInterval(() => {}, 1000));" },
		]),
	);
	const suites = join(dirs.root, "suites.json");
	writeFileSync(
		suites,
		JSON.stringify({
			version: 3,
			suites: [
				{ name: "module:{name}", each: "modules", hidden: "modules/{name}" },
				{ name: "integration", hidden: "integration", timeoutMs: 1500 },
				{ name: "baseline", hidden: "baseline" },
			],
		}),
	);
	const started = Date.now(),
		result = await runLauncher({ ...dirs, suites });
	assert.equal(result.exitCode, 0);
	assert.ok(Date.now() - started < 20_000);
	assert.deepEqual(
		events(result.stdout)
			.slice(1, -1)
			.map((event) => [event.name, event.outcome]),
		[
			["module", "error"],
			["integration", "timeout"],
			["baseline", "error"],
		],
	);
	const deadline = await runLauncher({ ...dirs, suites }, { deadlineMs: 800 });
	assert.equal(deadline.exitCode, 124);
	assert.equal(runOf(deadline).end, "timeout");
	assert.deepEqual(
		runOf(deadline).suites.map((suite) => suite.outcome),
		["error", "timeout", "not_run"],
	);
	assert.equal((await runLauncher({ ...dirs, snapshot: "relative/path" })).exitCode, 70);
	writeFileSync(suites, JSON.stringify({ version: 3, suites: [{ name: "x", hidden: "../etc", argv: ["true"] }] }));
	const bad = await runLauncher({ ...dirs, suites });
	assert.equal(bad.exitCode, 70);
	assert.match(bad.stderr, /invalid.*trusted grading configuration/);
	assert.equal(bad.stdout, "");
});

test("run-eval.mjs: candidate-planted hidden files/symlinks never become trusted test definitions", async () => {
	const dirs = evalDirs({ ...normalHidden(), "modules/empty/README.md": "none\n" });
	writeTree(dirs.snapshot, { "hidden-tests/empty/planted.test.js": "process.exit(0);" });
	symlinkSync("../lib", join(dirs.snapshot, "hidden-tests", "integration"));
	chmodTree(dirs.snapshot);
	const result = await runLauncher(dirs);
	assert.deepEqual(
		runOf(result).suites.map((suite) => [suite.name, suite.outcome]),
		[
			["module:empty", "error"],
			["module:greet", "passed"],
			["integration", "passed"],
			["baseline", "passed"],
		],
	);
	assert.deepEqual(readdirSync(join(dirs.snapshot, "lib")), ["greet.js"]);
	assert.deepEqual(readdirSync(dirs.scratch), []);
});

test("trusted report protocol: missing, truncated, fabricated, duplicate, extra, skipped, todo and fewer-than-expected results fail closed", () => {
	const valid = [plan("baseline"), suite("baseline", "passed", 0), line({ type: "done" })];
	const fewer = line({
		type: "suite",
		name: "baseline",
		outcome: "passed",
		exitCode: 0,
		expectedTests: ["test"],
		executedTests: [],
		passedTests: [],
	});
	const invalid = [
		"",
		valid.slice(0, -1).join("\n"),
		valid.join("\n").slice(0, -3),
		[valid[0], fewer, valid[2]].join("\n"),
		[valid[0], valid[1], valid[1], valid[2]].join("\n"),
		[...valid, suite("extra", "passed", 0)].join("\n"),
		[valid[0], suite("baseline", "skipped", 0), valid[2]].join("\n"),
		[valid[0], suite("baseline", "todo", 0), valid[2]].join("\n"),
		line({ type: "done", outcome: "passed" }),
	];
	for (const stdout of invalid) assert.equal(evaluationPassed(evaluatorRunOf(stdout, clean)), false);
	assert.equal(evaluationPassed(evaluatorRunOf(valid.join("\n"), clean)), true);
});

test("transport failure cannot be converted to a pass by a hidden negative assertion", () => {
	const run = evaluatorRunOf(
		[plan("baseline"), suite("baseline", "passed", 0), line({ type: "done" })].join("\n"),
		clean,
	);
	assert.equal(evaluationPassed(run), true);
	assert.equal(evaluationPassed({ ...run, subjectFailed: true }), false);
});

test("hidden native tests: skip, todo, fewer definitions, missing/truncated manifests and unmanifested files fail closed", async () => {
	for (const options of ["{skip:true}", "{todo:true}"]) {
		const dirs = evalDirs({
			...normalHidden(),
			...nodeSuite("modules/greet", "greet.test.js", [
				{ id: "greets", name: "greets", body: "assert.equal(1, 1);", options },
			]),
		});
		assert.equal(evaluationPassed(runOf(await runLauncher(dirs))), false, options);
	}
	for (const manifest of [
		"",
		"{",
		JSON.stringify({
			version: 3,
			tests: [
				{ id: "greets", file: "greet.test.js", name: "greets" },
				{ id: "missing", file: "greet.test.js", name: "never ran" },
			],
		}),
	]) {
		const dirs = evalDirs({ ...normalHidden(), "modules/greet/expected.json": manifest });
		assert.equal(evaluationPassed(runOf(await runLauncher(dirs))), false);
	}
});

test("full Node values and async/file/child-process APIs remain available; file effects are inspected independently", async () => {
	const body = `const value=await app.evaluate(${JSON.stringify(fullNodeProgram)});
	assert.deepEqual(value.data,Buffer.from("abc"));assert.deepEqual(value.map,new Map([["key",1]]));assert.equal(value.big,123n);assert.equal(value.child,"child");assert.equal(value.streamCallback,true);assert.equal(value.streamDrain,true);
	assert.equal((await app.readFile("proof.txt")).toString(),"real file");`;
	const dirs = evalDirs({
		...normalHidden(),
		...nodeSuite("modules/greet", "greet.test.js", [{ id: "node-apis", name: "full Node APIs", body }]),
	});
	const result = await runLauncher(dirs);
	assert.equal(evaluationPassed(runOf(result)), true, result.stdout);
});

/** Read-only like a sealed snapshot: directories 0555, files 0444; symlinks untouched (never followed). */
function chmodTree(root: string): void {
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		const stat = lstatSync(path);
		if (stat.isDirectory()) chmodTree(path);
		else if (!stat.isSymbolicLink()) chmodSync(path, 0o444);
	}
	chmodSync(root, 0o555);
}

// ---------------------------------------------------------------------------------------------------------------
// The local test evaluator

test("the local test evaluator: its deadline and the caller's abort stop the runner; a missing mount source never starts", async () => {
	const dirs = evalDirs({});
	const hanging = createLocalEvaluator({
		run: (spec) =>
			new Promise((resolve) => spec.signal.addEventListener("abort", () => resolve({ exitCode: 1, stdout: "" }))),
	});
	const spec = {
		trial: "t",
		snapshot: dirs.snapshot,
		hiddenTests: dirs.hidden,
		scratch: dirs.scratch,
		deadlineMs: 200,
	};
	const timedOut = await hanging.run(spec);
	assert.deepEqual(timedOut.kind === "ran" ? timedOut.end : timedOut.kind, "timeout");
	const controller = new AbortController();
	const pending = hanging.run({ ...spec, deadlineMs: 60_000, signal: controller.signal });
	await waitFor(async () => (await hanging.live()).length === 1, { what: "one evaluator container while it runs" });
	controller.abort();
	const aborted = await pending;
	assert.deepEqual(aborted.kind === "ran" ? aborted.end : aborted.kind, "aborted");
	assert.deepEqual(await hanging.live(), []);
	const missing = await hanging.run({ ...spec, snapshot: join(dirs.root, "nope") });
	assert.equal(missing.kind, "not_started");
	const unavailable = createLocalEvaluator({ run: hanging.run as never, unavailable: "no image" });
	assert.deepEqual(await unavailable.available(), { ok: false, reason: "no image" });
	assert.equal(unavailable.facts(), undefined);
});

test("fresh full Node subject per suite: require cache, globals and pending timers cannot leak into the next suite", async () => {
	const dirs = evalDirs({
		...nodeSuite("modules/state", "state.test.js", [
			{
				id: "writes",
				name: "writes",
				body: 'await app.evaluate(\'globalThis.leak = true; require("node:fs").writeFileSync("index.js", "exports.version=99"); setInterval(()=>{},1000); return true;\');',
			},
		]),
		...nodeSuite("integration", "fresh.test.js", [
			{
				id: "fresh",
				name: "fresh",
				body: 'assert.equal(await app.evaluate(\'return globalThis.leak ?? null;\'), null); assert.equal(await app.call("index.js","version"),1);',
			},
		]),
		...nodeSuite("baseline", "version.test.js", [
			{ id: "version", name: "version", body: 'assert.equal(await app.call("index.js","version"),1);' },
		]),
	});
	assert.equal(evaluationPassed(runOf(await runLauncher(dirs))), true);
});

test("full native ESM, including .js package type module and top-level await, is supported", async () => {
	const dirs = evalDirs({
		...normalHidden(),
		...nodeSuite("modules/greet", "greet.test.js", [
			{ id: "esm", name: "esm", body: 'assert.equal(await app.call("esm/value.js", "version"),1);' },
		]),
	});
	writeTree(dirs.snapshot, {
		"esm/package.json": '{"type":"module"}',
		"esm/value.js": "await new Promise(r=>setTimeout(r,5)); export const version=1;",
	});
	assert.equal(evaluationPassed(runOf(await runLauncher(dirs))), true);
});

test("published package includes the full Node controller/client/application and trusted file observer", () => {
	const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
		files: string[];
		dependencies: Record<string, string>;
	};
	assert.ok(manifest.files.includes("deploy"));
	assert.equal(manifest.dependencies["quickjs-emscripten"], undefined);
	for (const name of ["run-eval.mjs", "eval-tests.mjs", "app-client.mjs", "eval-app.mjs", "inspect-eval-file.py"])
		assert.ok(readFileSync(new URL(`../../deploy/docker/${name}`, import.meta.url)).length > 0);
});

test("hidden module definitions never silently omit unsupported directories or symbolic aliases", async () => {
	const invalid = evalDirs(normalHidden());
	mkdirSync(join(invalid.hidden, "modules", "bad name"));
	const bad = await runLauncher(invalid);
	assert.equal(bad.exitCode, 70);
	assert.equal(evaluationPassed(runOf(bad)), false);
	const linked = evalDirs(normalHidden());
	symlinkSync("greet", join(linked.hidden, "modules", "alias"));
	const alias = await runLauncher(linked);
	assert.equal(alias.exitCode, 70);
	assert.equal(evaluationPassed(runOf(alias)), false);
	const valid = evalDirs(normalHidden());
	writeFileSync(join(valid.hidden, "modules", "README.md"), "module documentation");
	assert.equal(evaluationPassed(runOf(await runLauncher(valid))), true);
});
