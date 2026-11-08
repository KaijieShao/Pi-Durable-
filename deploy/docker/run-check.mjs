#!/usr/bin/env node
/**
 * run_check launcher of the pinned check image (Agent Execution § Policy Hook rule 1: "The run_check launcher and its
 * operation list come from the pinned check image, outside the worktree, so a task can't change them").
 *
 * Usage (inside the check container, cwd /work): node /opt/pi-check/run-check.mjs <op>
 *   - the operation list is ops.json next to this file; an unknown op exits 64 (EX_USAGE) before anything runs;
 *   - "setup" runs `sh ./<PI_SETUP_SCRIPT>` only if that file exists in the worktree as a regular file; otherwise it
 *     prints "no setup script" and exits 0;
 *   - the argv runs without a shell, with a fixed environment (HOME=/scratch, TMPDIR=/scratch/tmp, npm cache in
 *     /scratch, no update notifier, CI=1);
 *   - PI_CHECK_DEADLINE_MS (optional) makes the launcher kill the operation and exit 124 by itself, so a check
 *     container ends even if the Coordinator is gone.
 * Exit codes: the operation's own code, 128+signal when it was killed by a signal; 64 and 124 are reserved for the
 * launcher (an operation exiting with 64 or 124 is reported as 1); 70 = the launcher could not run (EX_SOFTWARE).
 * Plain JavaScript, no dependencies, Node 18+.
 */
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_UNKNOWN_OPERATION = 64;
const EXIT_LAUNCHER = 70;
const EXIT_DEADLINE = 124;
const SCRATCH = "/scratch";
const OP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function exit(code, message, stream = process.stderr) {
	if (message !== undefined) stream.write(`pi-check: ${message}\n`);
	process.exit(code);
}

function loadOps() {
	const here = dirname(fileURLToPath(import.meta.url));
	try {
		const ops = JSON.parse(readFileSync(join(here, "ops.json"), "utf8"));
		if (typeof ops === "object" && ops !== null && !Array.isArray(ops)) return ops;
	} catch {
		// fall through
	}
	return exit(EXIT_LAUNCHER, "cannot read the operation list");
}

function operationArgv(ops, op) {
	if (typeof op !== "string" || !OP_NAME.test(op) || !Object.hasOwn(ops, op)) {
		return exit(EXIT_UNKNOWN_OPERATION, "unknown operation");
	}
	const argv = ops[op];
	if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string" && part !== "")) {
		return exit(EXIT_LAUNCHER, "invalid operation definition");
	}
	return argv;
}

/** The setup script path: relative, inside the worktree, no "..", no ".git", no NUL, not an option. */
function setupScriptPath(raw) {
	const value = raw === undefined || raw === "" ? ".pi/setup.sh" : raw;
	const segments = value.split("/").filter((segment) => segment !== "" && segment !== ".");
	const valid =
		!value.startsWith("/") &&
		!value.includes("\0") &&
		segments.length > 0 &&
		segments.every((segment) => segment !== ".." && segment.toLowerCase() !== ".git");
	if (!valid) return exit(2, "invalid setup script path");
	return segments.join("/");
}

function resolveSetup(argv) {
	const script = setupScriptPath(process.env.PI_SETUP_SCRIPT);
	let stat;
	try {
		stat = lstatSync(join(process.cwd(), script));
	} catch {
		return exit(0, "no setup script", process.stdout);
	}
	if (!stat.isFile()) return exit(2, "setup script is not a regular file");
	return argv.map((part) => (part === "{setupScript}" ? `./${script}` : part));
}

function prepareScratch() {
	try {
		mkdirSync(join(SCRATCH, "tmp"), { recursive: true, mode: 0o700 });
		mkdirSync(join(SCRATCH, "npm"), { recursive: true, mode: 0o700 });
	} catch {
		exit(EXIT_LAUNCHER, "scratch space is not available");
	}
}

function childEnv() {
	return {
		PATH: process.env.PATH || DEFAULT_PATH,
		HOME: SCRATCH,
		TMPDIR: join(SCRATCH, "tmp"),
		npm_config_cache: join(SCRATCH, "npm"),
		npm_config_update_notifier: "false",
		npm_config_fund: "false",
		npm_config_audit: "false",
		npm_config_offline: "true",
		NO_UPDATE_NOTIFIER: "1",
		CI: "1",
	};
}

function killGroup(child) {
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// already gone
	}
}

function exitCodeOf(code, signal) {
	if (signal !== null) return 128 + (osConstants.signals[signal] ?? 0);
	if (code === EXIT_UNKNOWN_OPERATION || code === EXIT_DEADLINE) return 1;
	return code ?? 1;
}

function run(argv) {
	const child = spawn(argv[0], argv.slice(1), {
		cwd: process.cwd(),
		env: childEnv(),
		stdio: ["ignore", "inherit", "inherit"],
		shell: false,
		detached: true,
	});
	const deadline = Number(process.env.PI_CHECK_DEADLINE_MS);
	if (Number.isSafeInteger(deadline) && deadline > 0) {
		setTimeout(() => {
			killGroup(child);
			exit(EXIT_DEADLINE, "deadline reached");
		}, deadline).unref();
	}
	child.on("error", (error) => {
		if (error.code === "EAGAIN")
			exit(1, "cannot start the operation: Resource temporarily unavailable (process limit)");
		if (error.code === "ENOENT") exit(127, `command not found: ${argv[0]}`);
		exit(1, `cannot start the operation (${typeof error.code === "string" ? error.code : "error"})`);
	});
	child.on("exit", (code, signal) => {
		killGroup(child);
		process.exit(exitCodeOf(code, signal));
	});
}

function main() {
	if (typeof process.getuid === "function" && process.getuid() === 0) exit(EXIT_LAUNCHER, "refusing to run as root");
	const ops = loadOps();
	const op = process.argv[2];
	let argv = operationArgv(ops, op);
	if (op === "setup") argv = resolveSetup(argv);
	prepareScratch();
	run(argv);
}

main();
