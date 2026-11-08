/** Actual production main.ts routing, with no platform injection, secrets, database or real Docker. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { waitFor } from "../helpers/env.ts";

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

test("production main routes watchdog: Linux process mode exits 2 before state; Mac starts and stops cleanly", {
	timeout: 15_000,
}, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "watchdog-main-")),
		dataDir = join(dir, "absent-state"),
		envFile = join(dir, "watchdog.env");
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(
		envFile,
		[
			`PI_DATA_DIR=${dataDir}`,
			"TELEGRAM_GROUP_CHAT_ID=-100888",
			"PI_RUNNER_ISOLATION=process",
			`DOCKER_BIN=${join(dir, "no-docker")}`,
			"LOG_LEVEL=debug",
			"",
		].join("\n"),
	);
	const child = spawn(process.execPath, [MAIN, "watchdog", "--env-file", envFile], {
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, NODE_NO_WARNINGS: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "",
		complete = false;
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8");
	});
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			complete = true;
			resolve({ code, signal });
		});
	});
	t.after(async () => {
		if (!complete) child.kill("SIGKILL");
		await exited;
	});
	if (process.platform === "linux") {
		assert.deepEqual(await exited, { code: 2, signal: null });
		assert.match(
			output,
			/PI_RUNNER_ISOLATION: Linux requires systemd isolation in the Pi slice; process isolation is refused/,
		);
		assert.ok(!output.includes("watchdog_starting"), "configuration fails before starting the watchdog");
	} else {
		await waitFor(
			() => {
				if (complete) assert.fail(`watchdog exited before startup: ${output}`);
				return output.includes("watchdog_waiting_for_database");
			},
			{ what: "the actual main watchdog route waiting for its absent database" },
		);
		assert.match(output, /watchdog_starting .*isolation=process/);
		child.kill("SIGTERM");
		assert.deepEqual(await exited, { code: 0, signal: null });
		assert.match(output, /watchdog_stopped/);
	}
	assert.equal(existsSync(dataDir), false, "neither the parser nor waiting watchdog creates Coordinator state");
	assert.ok(!output.includes("TELEGRAM_BOT_TOKEN"), "main used the watchdog-only config, not the Coordinator config");
});
