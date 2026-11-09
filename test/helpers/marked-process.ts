/**
 * TEST ONLY: a stand-in for a leftover Pi process. To `ps` it looks exactly like one of `deployment` serving `runId`
 * (a `runner/main.js` entry with the deployment and run markers of src/runner/argv.ts), and it never exits by itself:
 * it ignores SIGTERM, SIGINT and SIGHUP and has no deadline, so only a SIGKILL from someone else ends it. A test that
 * sees it gone knows the watchdog (or recovery) killed it.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { runnerArgv } from "../../src/runner/argv.ts";
import { waitFor } from "./env.ts";

const DUMMY = [
	"for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});",
	"setInterval(() => {}, 1 << 30);",
	"process.send('ready', () => process.disconnect());",
	"",
].join("\n");

export type MarkedProcess = {
	readonly pid: number;
	/** Resolves with the signal that ended it. */
	readonly exited: Promise<NodeJS.Signals | null>;
	alive(): boolean;
};

/** Spawn an immutable entry (detached, like Pi), and wait for its signal handlers and `ps` markers. */
export async function markedProcess(
	t: TestContext,
	dir: string,
	deployment: string,
	runId: number,
): Promise<MarkedProcess> {
	// Rewriting one shared main.js can truncate it while an earlier child is loading it. That child then
	// exits normally, giving a false watchdog failure. Each stand-in owns an entry which is never rewritten.
	const home = await mkdtemp(join(dir, "dummy-pi-"));
	const entry = join(home, "runner", "main.js");
	await mkdir(join(home, "runner"), { recursive: true });
	await writeFile(entry, DUMMY);
	const args = runnerArgv({ transport: "stdio", conversationAccess: "private", deployment, runId });
	const child: ChildProcess = spawn(process.execPath, [entry, ...args], {
		detached: true,
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
	});
	const pid = child.pid ?? 0;
	let gone = false;
	const exited = new Promise<NodeJS.Signals | null>((resolve) =>
		child.once("exit", (_code, signal) => {
			gone = true;
			resolve(signal);
		}),
	);
	t.after(() => {
		if (!gone) process.kill(pid, "SIGKILL");
	});
	await new Promise<void>((resolve, reject) => {
		child.once("message", (message) => {
			if (message === "ready") resolve();
			else reject(new Error("unexpected marked-process readiness message"));
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => reject(new Error(`marked process exited before ready: ${code}/${signal}`)));
	});
	await waitFor(
		() =>
			spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.includes(
				`--pi-durable-run=${runId}`,
			),
		{ what: "the marked process running" },
	);
	return { pid, exited, alive: () => !gone };
}
