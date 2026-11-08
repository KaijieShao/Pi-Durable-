#!/usr/bin/env node
/**
 * The isolated evaluator's launcher, in the trusted evaluator image (Architecture § Isolated evaluator; Capacity
 * § Evaluator: "grades the suites sequentially"; Evaluation § What's Graded: each module's hidden tests, the signup-flow
 * integration test, a baseline suite).
 *
 * Inside the evaluator container (the Coordinator starts it: src/coordinator/sandbox/evaluator.ts):
 *   node /opt/pi-eval/run-eval.mjs
 *     /eval/snapshot   the sealed snapshot of main, read-only
 *     /eval/hidden     the hidden tests, read-only
 *     /scratch         scratch space, the only writable place (the Coordinator wipes it afterwards)
 *     suites.json      next to this file: the image's fixed suite list (the grading rules)
 * Host runs (tests, RUN-LOCAL) pass --snapshot, --hidden, --scratch and --suites; the Coordinator never does.
 *
 * Suite list: {"version": 1, "suites": [{"name", "hidden", "argv", "timeoutMs"?, "each"?}, ...]}. `hidden` is a folder
 * of the hidden tests; `each` (with {name} in `name` and `hidden`) makes one suite per subfolder of that folder, in
 * name order. For each suite, one after another:
 *   - a fresh, writable copy of the snapshot at /scratch/run/project, the suite's hidden tests copied into it at
 *     hidden-tests/<last segment of hidden> (a hidden-tests/ the snapshot brought is removed first: that folder is the
 *     evaluator's); no *.test.js / .mjs / .cjs file there → the suite is "error" (a suite with nothing to run never
 *     passes);
 *   - its argv, with the "{tests}" element replaced by those test files, runs in the copy without a shell, with a fixed
 *     environment (HOME and TMPDIR in scratch, CI=1, nothing else), in its own process group, its output discarded;
 *   - bounded by its timeoutMs and by what is left of PI_EVAL_DEADLINE_MS; passed only on exit 0;
 *   - /scratch/run is removed before the next suite.
 * stdout: one JSON line per event (src/coordinator/sandbox/evaluator-output.ts): the plan, one per suite, done.
 * Exit codes: 0 every suite ran; 70 the launcher could not run (EX_SOFTWARE); 124 the overall deadline passed.
 * Refuses to run as root. Plain JavaScript, no dependencies, Node 18+.
 */
import { spawn } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_LAUNCHER = 70;
const EXIT_DEADLINE = 124;
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUITE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const TEST_FILE = /\.test\.(c|m)?js$/;

function fail(message) {
	process.stderr.write(`pi-eval: ${message}\n`);
	process.exit(EXIT_LAUNCHER);
}

function emit(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function options(argv) {
	const here = dirname(fileURLToPath(import.meta.url));
	const paths = {
		snapshot: "/eval/snapshot",
		hidden: "/eval/hidden",
		scratch: "/scratch",
		suites: join(here, "suites.json"),
	};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index]?.replace(/^--/, "");
		const value = argv[index + 1];
		if (key === undefined || !Object.hasOwn(paths, key) || value === undefined || !value.startsWith("/"))
			fail("usage: run-eval.mjs [--snapshot P --hidden P --scratch P --suites P] (absolute paths)");
		paths[key] = value;
	}
	return paths;
}

/** A relative folder of the hidden tests: no absolute path, no "..", no empty segment. */
function relativeFolder(value) {
	return (
		typeof value === "string" &&
		value !== "" &&
		!value.startsWith("/") &&
		!value.includes("\0") &&
		value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
	);
}

function validEntry(entry) {
	if (typeof entry !== "object" || entry === null) return false;
	const { name, hidden, argv, timeoutMs, each } = entry;
	const timeout =
		timeoutMs === undefined || (Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS);
	const args = Array.isArray(argv) && argv.length > 0 && argv.every((part) => typeof part === "string" && part !== "");
	const named = typeof name === "string" && SUITE.test(name.replace("{name}", "x"));
	const folder = typeof hidden === "string" && relativeFolder(hidden.replace("{name}", "x"));
	return named && folder && args && timeout && (each === undefined || relativeFolder(each));
}

function loadSuites(path) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fail("cannot read the suite list");
	}
	if (parsed?.version !== 1 || !Array.isArray(parsed.suites) || parsed.suites.length === 0) fail("invalid suite list");
	if (!parsed.suites.every(validEntry)) fail("invalid suite definition");
	return parsed.suites;
}

function subfolders(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && NAME.test(entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/** The suites in order; an "each" with no subfolder is one suite that cannot run ("error"). */
function expand(entries, hiddenRoot) {
	const suites = [];
	for (const entry of entries) {
		const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (entry.each === undefined) {
			suites.push({ name: entry.name, hidden: entry.hidden, argv: entry.argv, timeoutMs });
			continue;
		}
		const names = subfolders(join(hiddenRoot, entry.each));
		if (names.length === 0) suites.push({ name: entry.name.replace(/:?\{name\}/, ""), error: true });
		for (const name of names)
			suites.push({
				name: entry.name.replace("{name}", name),
				hidden: entry.hidden.replace("{name}", name),
				argv: entry.argv,
				timeoutMs,
			});
	}
	return suites;
}

/**
 * Copy a tree into a new, writable one (the snapshot's own files are read-only): directories 0755, files 0644 or 0755
 * (the executable bit kept), symlinks as they are (never followed). Contents are copied, not modes, so no chmod is
 * needed (some bind-mount file systems refuse it).
 */
function copyTree(source, target) {
	const stat = lstatSync(source);
	if (stat.isSymbolicLink()) return symlinkSync(readlinkSync(source), target);
	if (stat.isFile()) return writeFileSync(target, readFileSync(source), { mode: stat.mode & 0o111 ? 0o755 : 0o644 });
	if (!stat.isDirectory()) return undefined;
	mkdirSync(target, { recursive: true, mode: 0o755 });
	for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name));
	return undefined;
}

function testFiles(root, dir) {
	const found = [];
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && TEST_FILE.test(entry.name)) found.push(relative(root, full));
		}
	};
	walk(dir);
	return found.sort();
}

/** The suite's working copy: the snapshot, then its hidden tests; the test files to run (none → it cannot run). */
function prepare(paths, suite) {
	const run = join(paths.scratch, "run");
	rmSync(run, { recursive: true, force: true });
	const project = join(run, "project");
	for (const dir of [join(run, "home"), join(run, "tmp")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	copyTree(paths.snapshot, project);
	// hidden-tests/ is the evaluator's: whatever the graded snapshot put there (files, a symlink) is removed first, so
	// only the hidden tests are found and run there (a planted file must not turn an empty suite into a pass).
	const reserved = join(project, "hidden-tests");
	rmSync(reserved, { recursive: true, force: true });
	const source = join(paths.hidden, suite.hidden);
	if (!lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) return { run, project, tests: [] };
	const target = join(reserved, suite.hidden.split("/").at(-1));
	mkdirSync(reserved, { mode: 0o755 });
	copyTree(source, target);
	return { run, project, tests: testFiles(project, target) };
}

function killGroup(child) {
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// already gone
	}
}

/** A suite's outcome from how its command ended: passed only on exit 0 (no signal) within its bound. */
function ended(code, signal, timedOut) {
	const exitCode = signal === null ? code : 128 + (osConstants.signals[signal] ?? 0);
	if (timedOut) return { outcome: "timeout", exitCode };
	return { outcome: code === 0 && signal === null ? "passed" : "failed", exitCode };
}

/** Run one prepared suite; resolves with its outcome and exit code. */
function execute(suite, work, timeoutMs) {
	const argv = suite.argv.flatMap((part) => (part === "{tests}" ? work.tests : [part]));
	const env = {
		PATH: process.env.PATH || DEFAULT_PATH,
		HOME: join(work.run, "home"),
		TMPDIR: join(work.run, "tmp"),
		CI: "1",
		NO_COLOR: "1",
		PI_EVAL_SUITE: suite.name,
	};
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), {
			cwd: work.project,
			env,
			stdio: "ignore",
			shell: false,
			detached: true,
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child);
		}, timeoutMs);
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ outcome: "error", exitCode: undefined });
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			killGroup(child);
			resolve(ended(code, signal, timedOut));
		});
	});
}

async function grade(paths, suite, deadline) {
	const startedAt = Date.now();
	const report = (outcome, exitCode) =>
		emit({ type: "suite", name: suite.name, outcome, exitCode, durationMs: Date.now() - startedAt });
	if (suite.error === true) return report("error");
	let work;
	try {
		work = prepare(paths, suite);
	} catch {
		return report("error");
	}
	try {
		if (work.tests.length === 0) return report("error");
		const left = deadline - Date.now();
		const result = await execute(suite, work, Math.max(1, Math.min(suite.timeoutMs, left)));
		report(result.outcome, result.exitCode);
	} finally {
		rmSync(work.run, { recursive: true, force: true });
	}
}

async function main() {
	if (typeof process.getuid === "function" && process.getuid() === 0) fail("refusing to run as root");
	const paths = options(process.argv.slice(2));
	const suites = expand(loadSuites(paths.suites), paths.hidden);
	const limit = Number(process.env.PI_EVAL_DEADLINE_MS);
	const deadline = Date.now() + (Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_TIMEOUT_MS);
	emit({ type: "plan", suites: suites.map((suite) => suite.name) });
	for (const suite of suites) {
		if (Date.now() >= deadline) process.exit(EXIT_DEADLINE);
		await grade(paths, suite, deadline);
	}
	emit({ type: "done" });
	process.exit(Date.now() >= deadline ? EXIT_DEADLINE : 0);
}

main().catch(() => fail("unexpected failure"));
