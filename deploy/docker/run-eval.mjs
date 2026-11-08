#!/usr/bin/env node
/** Trusted full-Node controller. No snapshot mount, candidate import or app output enters this process. */
import { fork } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";

const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUITE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const TEST = /\.test\.(?:[cm]?js)$/;
const pending = new Map();
let nextId = 0;
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const fail = () => {
	process.stderr.write("pi-eval: invalid or unavailable trusted grading configuration\n");
	process.exit(70);
};

createInterface({ input: process.stdin }).on("line", (line) => {
	try {
		const message = JSON.parse(line);
		const reply = pending.get(message.id);
		if (reply === undefined || message.type !== "rpc_result") return;
		pending.delete(message.id);
		reply(message);
	} catch {
		fail();
	}
});

function request(op, payload) {
	return new Promise((resolve) => {
		const id = ++nextId;
		pending.set(id, resolve);
		emit({ type: "rpc", id, op, payload });
	});
}

function options(argv) {
	const paths = { hidden: "/eval/hidden", scratch: "/scratch", suites: join(HERE, "suites.json") };
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index]?.replace(/^--/, ""),
			value = argv[index + 1];
		if (!Object.hasOwn(paths, key) || typeof value !== "string" || !value.startsWith("/")) fail();
		paths[key] = value;
	}
	return paths;
}

function relativePath(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
	);
}

function validSuite(entry) {
	if (!SUITE.test(entry.name?.replace("{name}", "x")) || !relativePath(entry.hidden?.replace("{name}", "x")))
		return false;
	if (Object.hasOwn(entry, "argv") || (entry.each !== undefined && !relativePath(entry.each))) return false;
	return entry.timeoutMs === undefined || (Number.isSafeInteger(entry.timeoutMs) && entry.timeoutMs > 0);
}
function loadSuites(path) {
	const config = JSON.parse(readFileSync(path, "utf8"));
	if (config.version !== 3 || !Array.isArray(config.suites) || config.suites.length === 0) fail();
	if (!config.suites.every(validSuite)) fail();
	return config.suites;
}

function subfolders(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const names = [];
	for (const entry of entries) {
		if (entry.isFile() && ["README.md", ".DS_Store"].includes(entry.name)) continue;
		if (!entry.isDirectory() || !NAME.test(entry.name)) throw new Error("unsupported module definition");
		names.push(entry.name);
	}
	return names.sort();
}

function expand(entries, hidden) {
	return entries.flatMap((entry) => {
		if (entry.each === undefined) return [entry];
		const names = subfolders(join(hidden, entry.each));
		if (names.length === 0) return [{ name: entry.name.replace(/:?\{name\}/, ""), error: true }];
		return names.map((name) => ({
			...entry,
			name: entry.name.replace("{name}", name),
			hidden: entry.hidden.replace("{name}", name),
		}));
	});
}

function testFiles(root) {
	const found = [];
	const entryAt = (entry, dir, prefix) => {
		if (entry.isSymbolicLink()) throw new Error("hidden symlink");
		const path = prefix + entry.name;
		if (entry.isDirectory()) return walk(join(dir, entry.name), `${path}/`);
		if (entry.isFile() && TEST.test(path)) found.push(path);
		return undefined;
	};
	const walk = (dir, prefix) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) entryAt(entry, dir, prefix);
	};
	walk(root, "");
	return found.sort();
}
function validExpected(test) {
	return (
		NAME.test(test.id) &&
		relativePath(test.file) &&
		TEST.test(test.file) &&
		typeof test.name === "string" &&
		test.name.length > 0 &&
		!Object.hasOwn(test, "skip") &&
		!Object.hasOwn(test, "todo")
	);
}
function manifestTests(manifest) {
	if (
		manifest.version !== 3 ||
		!Array.isArray(manifest.tests) ||
		manifest.tests.length === 0 ||
		manifest.tests.length > 4096
	)
		throw new Error("invalid manifest");
	const tests = manifest.tests;
	if (!tests.every(validExpected) || new Set(tests.map((test) => test.id)).size !== tests.length)
		throw new Error("invalid expected test");
	return tests;
}
function planned(paths, suite) {
	try {
		if (suite.error) throw new Error("missing modules");
		const root = join(paths.hidden, suite.hidden);
		if (!lstatSync(root).isDirectory()) throw new Error("hidden directory missing");
		const manifest = join(root, "expected.json");
		if (!lstatSync(manifest).isFile()) throw new Error("manifest is not a regular file");
		const tests = manifestTests(JSON.parse(readFileSync(manifest, "utf8")));
		const files = testFiles(root),
			declared = [...new Set(tests.map((test) => test.file))].sort();
		if (JSON.stringify(files) !== JSON.stringify(declared)) throw new Error("unplanned or missing test file");
		return { ...suite, root, tests, files: files.map((file) => join(root, file)) };
	} catch {
		return { ...suite, error: true, tests: [] };
	}
}

function kill(child) {
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		/* already gone */
	}
}

function outcomeOf(code, signal, timedOut, infrastructureFailed, report) {
	if (timedOut) return "timeout";
	return code === 0 && signal === null && report?.complete === true && !infrastructureFailed ? "passed" : "failed";
}
function executionResult(code, signal, timedOut, infrastructureFailed, report) {
	return {
		outcome: outcomeOf(code, signal, timedOut, infrastructureFailed, report),
		exitCode: code ?? undefined,
		executedTests: report?.executedTests ?? [],
		passedTests: report?.passedTests ?? [],
	};
}
function relay(child, message) {
	void request(message.op, message.payload).then((reply) => {
		if (child.connected) child.send({ ...reply, kind: "rpc_result", id: message.id });
	});
}
function execute(paths, suite, timeoutMs) {
	return new Promise((resolve) => {
		const work = join(paths.scratch, "run");
		rmSync(work, { recursive: true, force: true });
		mkdirSync(work, { recursive: true });
		const child = fork(
			join(HERE, "eval-tests.mjs"),
			[JSON.stringify({ root: suite.root, tests: suite.tests, files: suite.files })],
			{
				cwd: work,
				detached: true,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				env: {
					PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
					HOME: work,
					TMPDIR: work,
					CI: "1",
					NODE_NO_WARNINGS: "1",
					PI_EVAL_CLIENT_PATH: join(HERE, "app-client.mjs"),
				},
			},
		);
		let report,
			timedOut = false,
			infrastructureFailed = false;
		const timer = setTimeout(() => {
			timedOut = true;
			kill(child);
		}, timeoutMs);
		child.on("message", (message) => {
			switch (message?.kind) {
				case "infrastructure_failure":
					infrastructureFailed = true;
					void request("subject_failure", serialize(null).toString("base64"));
					return;
				case "test_result":
					report = report === undefined ? message : { complete: false };
					return;
				case "rpc":
					relay(child, message);
					return;
				default:
					infrastructureFailed = true;
			}
		});
		child.on("error", () => resolve({ outcome: "error", executedTests: [], passedTests: [] }));
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			kill(child);
			resolve(executionResult(code, signal, timedOut, infrastructureFailed, report));
		});
	});
}

async function grade(paths, suite, deadline) {
	const started = Date.now();
	let result = { outcome: "error", executedTests: [], passedTests: [] };
	if (!suite.error) {
		const reset = await request("reset", serialize(null).toString("base64"));
		if (reset.ok === true)
			result = await execute(paths, suite, Math.max(1, Math.min(suite.timeoutMs ?? 600000, deadline - Date.now())));
	}
	rmSync(join(paths.scratch, "run"), { recursive: true, force: true });
	emit({
		type: "suite",
		name: suite.name,
		...result,
		expectedTests: suite.tests.map((test) => test.id),
		durationMs: Date.now() - started,
	});
}

async function main() {
	if (process.getuid?.() === 0) fail();
	const paths = options(process.argv.slice(2));
	const suites = expand(loadSuites(paths.suites), paths.hidden).map((suite) => planned(paths, suite));
	if (suites.length > 256 || new Set(suites.map((suite) => suite.name)).size !== suites.length) fail();
	const limit = Number(process.env.PI_EVAL_DEADLINE_MS),
		deadline = Date.now() + (limit > 0 ? limit : 30 * 60_000);
	emit({
		type: "plan",
		version: 3,
		suites: suites.map((suite) => suite.name),
		expectedTests: Object.fromEntries(suites.map((suite) => [suite.name, suite.tests.map((test) => test.id)])),
	});
	for (const suite of suites) {
		if (Date.now() >= deadline) process.exit(124);
		await grade(paths, suite, deadline);
	}
	emit({ type: "done" });
	process.exit(Date.now() >= deadline ? 124 : 0);
}
main().catch(fail);
