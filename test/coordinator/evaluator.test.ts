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
import { makeWritable, runLauncher } from "../helpers/evaluator.ts";
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
const plan = (...suites: string[]) => line({ type: "plan", suites });
const suite = (name: string, outcome: string, exitCode?: number) =>
	line({ type: "suite", name, outcome, exitCode, durationMs: 5 });
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
	// Forged or repeated lines change nothing: a suite outside the plan, a second result, junk.
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

const TEST = (body: string) =>
	`const { test } = require("node:test");\nconst assert = require("node:assert/strict");\n${body}\n`;

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

test("run-eval.mjs: the fixed suites one after another (one per module), in a fresh copy with the hidden tests; failing and empty suites; the snapshot untouched, scratch left empty", async () => {
	const dirs = evalDirs({
		"modules/greet/greet.test.js": TEST(
			'test("greets", () => assert.equal(require("../../lib/greet.js").greet("a"), "hi a"));',
		),
		"modules/broken/broken.test.js": TEST('test("fails", () => assert.equal(1, 2));'),
		"modules/empty/README.md": "no tests here\n",
		"integration/flow.test.mjs": 'import { test } from "node:test";\ntest("flow", () => {});\n',
		"baseline/version.test.js": TEST(
			'require("node:fs").writeFileSync("written-by-a-test.txt", "x");\ntest("version", () => assert.equal(require("../../index.js").version, 1));',
		),
	});
	chmodTree(dirs.snapshot);
	const before = await treeHash(dirs.snapshot);
	const result = await runLauncher(dirs);
	assert.equal(result.exitCode, 0, result.stderr);
	const out = events(result.stdout);
	assert.deepEqual(out[0], {
		type: "plan",
		suites: ["module:broken", "module:empty", "module:greet", "integration", "baseline"],
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
	assert.equal((await treeHash(dirs.snapshot)).hash, before.hash, "the snapshot is never written");
	assert.deepEqual(readdirSync(dirs.scratch), [], "each suite's copy is removed");
	const run = evaluatorRunOf(result.stdout, { ...clean, exitCode: result.exitCode });
	assert.equal(evaluationPassed(run), false);
});

test("run-eval.mjs: no module folder, a missing suite folder, a hanging suite (its bound), the overall deadline, bad arguments", async () => {
	const dirs = evalDirs({
		"integration/hang.test.js": TEST('test("hangs", () => new Promise(() => setInterval(() => {}, 1000)));'),
	});
	const suites = join(dirs.root, "suites.json");
	writeFileSync(
		suites,
		JSON.stringify({
			version: 1,
			suites: [
				{ name: "module:{name}", each: "modules", hidden: "modules/{name}", argv: ["node", "--test", "{tests}"] },
				{ name: "integration", hidden: "integration", argv: ["node", "--test", "{tests}"], timeoutMs: 1500 },
				{ name: "baseline", hidden: "baseline", argv: ["node", "--test", "{tests}"] },
			],
		}),
	);
	const started = Date.now();
	const result = await runLauncher({ ...dirs, suites });
	assert.equal(result.exitCode, 0, result.stderr);
	assert.ok(Date.now() - started < 20_000, "the hanging suite was stopped at its bound");
	assert.deepEqual(
		events(result.stdout)
			.slice(0, -1)
			.map((event) => (event.type === "plan" ? event.suites : [event.name, event.outcome])),
		[
			["module", "integration", "baseline"],
			["module", "error"],
			["integration", "timeout"],
			["baseline", "error"],
		],
	);
	// The overall deadline: exit 124 once it passed, the suite in progress timed out.
	const deadline = await runLauncher({ ...dirs, suites }, { deadlineMs: 800 });
	assert.equal(deadline.exitCode, 124);
	const cut = evaluatorRunOf(deadline.stdout, { ...clean, exitCode: deadline.exitCode });
	assert.equal(cut.end, "timeout");
	assert.deepEqual(
		cut.suites.map((s) => s.outcome),
		["error", "timeout", "not_run"],
	);
	// Bad arguments and a bad suite list never run anything.
	const bad = await runLauncher({ ...dirs, snapshot: "relative/path" });
	assert.equal(bad.exitCode, 70);
	writeFileSync(suites, JSON.stringify({ version: 1, suites: [{ name: "x", hidden: "../etc", argv: ["true"] }] }));
	const evil = await runLauncher({ ...dirs, suites });
	assert.equal(evil.exitCode, 70);
	assert.match(evil.stderr, /invalid suite definition/);
	assert.equal(evil.stdout, "");
});

test("run-eval.mjs: hidden-tests/ is the evaluator's: test files or a symlink the graded snapshot put there are removed, never run", async () => {
	const dirs = evalDirs({
		"modules/empty/README.md": "no tests here\n",
		"integration/flow.test.js": TEST('test("flow", () => assert.equal(require("../../index.js").version, 1));'),
		"baseline/version.test.js": TEST('test("version", () => {});'),
	});
	// The graded code plants a passing "hidden" test for the empty module and redirects another suite's folder.
	writeTree(dirs.snapshot, { "hidden-tests/empty/planted.test.js": TEST('test("planted", () => {});') });
	symlinkSync("../lib", join(dirs.snapshot, "hidden-tests", "integration"));
	chmodTree(dirs.snapshot);
	const result = await runLauncher(dirs);
	assert.equal(result.exitCode, 0, result.stderr);
	assert.deepEqual(
		events(result.stdout)
			.filter((event) => event.type === "suite")
			.map((event) => [event.name, event.outcome]),
		[
			["module:empty", "error"],
			["integration", "passed"],
			["baseline", "passed"],
		],
		"the planted test does not count: a module without hidden tests is an error",
	);
	assert.deepEqual(readdirSync(join(dirs.snapshot, "lib")), ["greet.js"], "nothing was written through the link");
	assert.deepEqual(readdirSync(dirs.scratch), []);
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
