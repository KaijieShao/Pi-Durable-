/** TEST ONLY benign local fixtures. Same-uid host subprocesses are NOT an adversarial isolation boundary. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EvaluationProcess, runEvaluationPair } from "../../src/coordinator/sandbox/evaluator-broker.ts";
import type { LocalEvaluatorRunner } from "../../src/coordinator/sandbox/local.ts";

export const RUN_EVAL = fileURLToPath(new URL("../../deploy/docker/run-eval.mjs", import.meta.url));
export const SUITES = fileURLToPath(new URL("../../deploy/docker/suites.json", import.meta.url));
const PROXY = fileURLToPath(new URL("../../deploy/docker/eval-proxy.mjs", import.meta.url));
const APP = fileURLToPath(new URL("../../deploy/docker/eval-app.mjs", import.meta.url));

async function stopLocalChild(child: ReturnType<typeof spawn> | undefined): Promise<void> {
	if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	try {
		if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
	await closed;
}
async function stopLocalRole(
	child: ReturnType<typeof spawn>,
	transport: ReturnType<typeof spawn> | undefined,
	scratch: string,
	socket: string,
): Promise<boolean> {
	await Promise.all([stopLocalChild(child), stopLocalChild(transport)]);
	await rm(scratch, { recursive: true, force: true });
	await rm(socket, { force: true });
	return (await lstat(scratch).catch(() => undefined)) === undefined;
}
export async function runLauncher(
	paths: { snapshot: string; hidden: string; scratch: string; suites?: string },
	options: { signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; subjectFailed: boolean; failed: boolean }> {
	if (![paths.snapshot, paths.hidden, paths.scratch].every(isAbsolute))
		return { exitCode: 70, stdout: "", stderr: "invalid absolute path", subjectFailed: false, failed: true };
	let stderr = "";
	let sequence = 0;
	const localPath = process.env.PATH ?? "/usr/bin:/bin";
	const deadline = String(options.deadlineMs ?? 60_000);
	const suites = paths.suites ?? SUITES;
	const launch = async (role: "grader" | "app"): Promise<EvaluationProcess> => {
		const scratch = join(paths.scratch, `${role}-${++sequence}`);
		await mkdir(scratch, { mode: 0o700 });
		const socket = `/tmp/pi-eval-${randomBytes(8).toString("hex")}.sock`;
		const args =
			role === "grader"
				? [RUN_EVAL, "--hidden", paths.hidden, "--scratch", scratch, "--suites", suites]
				: [APP, paths.snapshot, scratch, socket];
		const child = spawn(process.execPath, args, {
			cwd: scratch,
			env: {
				PATH: localPath,
				NODE_NO_WARNINGS: "1",
				PI_EVAL_DEADLINE_MS: deadline,
			},
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		const transport =
			role === "app"
				? spawn(process.execPath, [PROXY, socket], {
						env: { PATH: localPath },
						stdio: ["pipe", "pipe", "pipe"],
						detached: true,
					})
				: undefined;
		if (role === "grader")
			child.stderr.on("data", (chunk) => {
				stderr = (stderr + chunk.toString("utf8")).slice(0, 16384);
			});
		let stopped: Promise<boolean> | undefined;
		const stop = (): Promise<boolean> => {
			stopped ??= stopLocalRole(child, transport, scratch, socket);
			return stopped;
		};
		return { child, scratch, stop, transport };
	};
	const result = await runEvaluationPair({
		grader: await launch("grader"),
		launchSubject: () => launch("app"),
		deadlineMs: options.deadlineMs ?? 60_000,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	return {
		exitCode: result.timedOut ? 124 : (result.exitCode ?? 1),
		stdout: result.stdout,
		stderr,
		subjectFailed: result.subjectFailed,
		failed: result.failed,
	};
}

export const hostLauncher: LocalEvaluatorRunner = async (spec) =>
	runLauncher(
		{ snapshot: spec.snapshot, hidden: spec.hiddenTests, scratch: spec.scratch },
		{ signal: spec.signal, deadlineMs: spec.deadlineMs },
	);

/** chmod every directory under `path` to 0700 (read-only snapshots), so the tree can be removed. */
export async function makeWritable(path: string): Promise<void> {
	const stat = await lstat(path).catch(() => undefined);
	if (stat === undefined || !stat.isDirectory()) return;
	await chmod(path, 0o700);
	for (const name of await readdir(path)) await makeWritable(join(path, name));
}

export type NodeHiddenTest = { id: string; name: string; body: string; options?: string };

/** Independent manifest plus native Node tests. Bodies keep trusted assertions outside the observed application. */
export function nodeSuite(folder: string, file: string, tests: readonly NodeHiddenTest[]): Record<string, string> {
	const prefix = file.endsWith(".mjs")
		? 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);\n'
		: "";
	const source =
		prefix +
		'const { test } = require("node:test");\nconst assert = require("node:assert/strict");\nconst { app } = require(process.env.PI_EVAL_CLIENT_PATH);\n' +
		tests
			.map((test) => `test(${JSON.stringify(test.name)}, ${test.options ?? "{}"}, async () => { ${test.body} });`)
			.join("\n") +
		"\n";
	return {
		[`${folder}/${file}`]: source,
		[`${folder}/expected.json`]: JSON.stringify({
			version: 3,
			tests: tests.map(({ id, name }) => ({ id, file, name })),
		}),
	};
}

/** A full native Node positive fixture, shared by host smoke tests and the real isolated Docker boundary test. */
export const fullNodeProgram = `
const fs=require("node:fs/promises");await fs.writeFile("proof.txt","real file");
console.log("normal console output");require("node:fs").writeSync(1,"raw stdout without newline");
await new Promise((resolve,reject)=>process.stdout.write("native callback",error=>error?reject(error):resolve()));
if(!process.stdout.write("x".repeat(128*1024)))await require("node:events").once(process.stdout,"drain");
await new Promise(resolve=>setTimeout(resolve,5));
const {execFileSync}=require("node:child_process");
const child=execFileSync(process.execPath,["-e",${JSON.stringify('process.stdout.write("child")')}]).toString();
return {data:Buffer.from("abc"),map:new Map([["key",1]]),big:123n,child,streamCallback:true,streamDrain:true};`;
