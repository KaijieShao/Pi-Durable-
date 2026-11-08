/**
 * TEST ONLY: a stand-in for a leftover Pi process. To `ps` it looks exactly like one of `deployment` serving `runId`
 * (a `runner/main.js` entry with the deployment and run markers of src/runner/argv.ts), and it never exits by itself:
 * it ignores SIGTERM, SIGINT and SIGHUP and has no deadline, so only a SIGKILL from someone else ends it. A test that
 * sees it gone knows the watchdog (or recovery) killed it.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { runnerArgv } from "../../src/runner/argv.ts";
import { waitFor } from "./env.ts";

const DUMMY = [
	"for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});",
	"setInterval(() => {}, 1 << 30);",
	"",
].join("\n");

export type MarkedProcess = {
	readonly pid: number;
	/** Resolves with the signal that ended it. */
	readonly exited: Promise<NodeJS.Signals | null>;
	alive(): boolean;
};

/** Spawn it (detached: its own process group, like a Pi process) and wait until `ps` shows its markers. */
export async function markedProcess(
	t: TestContext,
	dir: string,
	deployment: string,
	runId: number,
): Promise<MarkedProcess> {
	const entry = join(dir, "dummy-pi", "runner", "main.js");
	await mkdir(join(dir, "dummy-pi", "runner"), { recursive: true });
	await writeFile(entry, DUMMY);
	const args = runnerArgv({ transport: "stdio", conversationAccess: "private", deployment, runId });
	const child: ChildProcess = spawn(process.execPath, [entry, ...args], {
		detached: true,
		stdio: "ignore",
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
	await waitFor(
		() =>
			spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.includes(
				`--pi-durable-run=${runId}`,
			),
		{ what: "the marked process running" },
	);
	return { pid, exited, alive: () => !gone };
}
