/**
 * TEST ONLY: the isolated evaluator in tests. `hostLauncher` is a LocalEvaluatorRunner (src/coordinator/sandbox/
 * local.ts) that runs the evaluator image's own launcher (deploy/docker/run-eval.mjs) and suite list
 * (deploy/docker/suites.json) on the host, against the paths the Coordinator hands the evaluator: the same grading
 * as in the container, without its isolation. `makeWritable` lets a test's temp dir with a read-only snapshot be removed.
 */
import { spawn } from "node:child_process";
import { chmod, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalEvaluatorRunner } from "../../src/coordinator/sandbox/local.ts";

export const RUN_EVAL = fileURLToPath(new URL("../../deploy/docker/run-eval.mjs", import.meta.url));
export const SUITES = fileURLToPath(new URL("../../deploy/docker/suites.json", import.meta.url));

/** Run the launcher on the host; its stdout and exit code. Killed (with its process group) on the signal. */
export function runLauncher(
	paths: { snapshot: string; hidden: string; scratch: string; suites?: string },
	options: { signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const args = [RUN_EVAL, "--snapshot", paths.snapshot, "--hidden", paths.hidden, "--scratch", paths.scratch];
	args.push("--suites", paths.suites ?? SUITES);
	return new Promise((resolve) => {
		const child = spawn(process.execPath, args, {
			cwd: paths.scratch,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				NODE_NO_WARNINGS: "1",
				...(options.deadlineMs === undefined ? {} : { PI_EVAL_DEADLINE_MS: String(options.deadlineMs) }),
			},
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		const kill = (): void => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// gone
			}
		};
		options.signal?.addEventListener("abort", kill, { once: true });
		child.on("close", (code) => {
			options.signal?.removeEventListener("abort", kill);
			resolve({ exitCode: code ?? 1, stdout, stderr });
		});
	});
}

/** The local evaluator's runner: the real launcher on the host, stopped on the Coordinator's signal. */
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
