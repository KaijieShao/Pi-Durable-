/**
 * DEPLOYMENT CHECK, Linux only, with REAL systemd (Deployment § Processes, § Network, § Logs; "Deployment checks:
 * tests must show ... that the metadata block holds"). Skipped unless `process.platform === "linux"` and
 * PI_SYSTEMD_TESTS=1. Run it on the VM after the one-time host setup (docs/isolation.md), as the Coordinator's user,
 * from a checkout the Pi user can read and that is not under /home (ProtectHome hides it):
 *
 *   sudo -u pi-coordinator env PI_SYSTEMD_TESTS=1 PI_SYSTEMD_TEST_DATA_DIR=/var/lib/pi-durable-test \
 *     node --test --test-concurrency=1 test/runner/systemd-linux.test.ts
 *
 * PI_SYSTEMD_TEST_DATA_DIR (default /var/lib/pi-durable-test) must have the production layout (data dir 0710 and
 * conversations/ 2770 with group pi-durable, run-home/ owned by pi-runner, mode 0700); PI_RUNNER_USER, PI_RUNNER_GROUP
 * and PI_RUNNER_SLICE default to the production names.
 *
 * Proves, through the production launcher and real transient units: the launcher's availability check passes; the
 * unit's process runs as the Pi user (not the Coordinator's), in the Pi slice, got the run key from stdin and not its
 * environment, reaches the relay on 127.0.0.1 but neither the metadata server nor an outside address, can write only
 * its own directories (not another group-writable one) and cannot read the Coordinator's database; the real runner completes a run against
 * a fake model on 127.0.0.1 and leaves a conversation file 0660 owned by the Pi user; kill() leaves no unit, and no
 * escaped child either (one that left its session with setsid); and a unit WITHOUT any IP filter (outside the Pi
 * slice, whose filter would apply to it too) still cannot reach the metadata server (the host firewall rule alone).
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, chown, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { RunLauncher, RunnerHandle } from "../../src/coordinator/ports.ts";
import { createSystemdRunLauncher, unitName } from "../../src/coordinator/runner-systemd.ts";
import { deploymentId } from "../../src/runner/argv.ts";
import type { FromRunner, RunnerStart } from "../../src/runner/protocol.ts";
import { silentLogger } from "../../src/runtime/log.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeModel } from "../helpers/fake-model.ts";

const enabled = process.platform === "linux" && process.env.PI_SYSTEMD_TESTS === "1";
const skip = enabled ? false : "Linux deployment check: set PI_SYSTEMD_TESTS=1 on a host with the systemd setup";
const DATA_DIR = process.env.PI_SYSTEMD_TEST_DATA_DIR ?? "/var/lib/pi-durable-test";
const USER = process.env.PI_RUNNER_USER ?? "pi-runner";
const GROUP = process.env.PI_RUNNER_GROUP ?? "pi-durable";
const SLICE = process.env.PI_RUNNER_SLICE ?? "pi-durable-runs.slice";
const PROBE = fileURLToPath(new URL("../fixtures/isolation-probe.mjs", import.meta.url));
const RUN_KEY = randomBytes(32).toString("base64url");

const fake = new FakeModel();
let launcher: RunLauncher;
let nextRun = Date.now() % 1_000_000;

function piUid(): number {
	const result = spawnSync("id", ["-u", USER], { encoding: "utf8" });
	assert.equal(result.status, 0, `id -u ${USER}`);
	return Number(result.stdout.trim());
}

function systemd(runnerPath?: string): RunLauncher {
	return createSystemdRunLauncher({
		dataDir: DATA_DIR,
		log: silentLogger,
		user: USER,
		group: GROUP,
		slice: SLICE,
		systemdRun: "systemd-run",
		systemctl: "systemctl",
		...(runnerPath === undefined ? {} : { runnerPath }),
	});
}

function startFor(runId: number, input: string): RunnerStart {
	return {
		type: "start",
		runId,
		taskId: runId,
		conversationPath: join(DATA_DIR, "conversations", `linux-test-${runId}-${randomBytes(4).toString("hex")}.sqlite`),
		fresh: true,
		model: { modelId: "gpt-4.1-mini", thinkingLevel: "off", relayBaseUrl: fake.url, codexGateway: false },
		input: { content: input, requestId: `u${runId}` },
		steers: [],
		instructions: "Keep answers short.",
		limits: { maxRetries: 0, toolResultBytes: 16 * 1024, deadlineMs: 60_000 },
		checkOps: [],
	};
}

function launch(using: RunLauncher, start: RunnerStart): { handle: RunnerHandle; messages: FromRunner[] } {
	const messages: FromRunner[] = [];
	const handle = using.launch(start, RUN_KEY, (message) => messages.push(message), { generation: 1 });
	return { handle, messages };
}

/** A process of another user: kill(0) says EPERM while it lives, ESRCH once it is gone. */
function processState(pid: number): "gone" | "alive (another user)" | "alive (ours)" {
	try {
		process.kill(pid, 0);
		return "alive (ours)";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "alive (another user)";
	}
}

function unitActive(unit: string): string {
	return spawnSync("systemctl", ["show", "--property=ActiveState", "--value", "--", unit], {
		encoding: "utf8",
	}).stdout.trim();
}

describe("systemd isolation on this Linux host (real systemd)", { skip, timeout: 180_000 }, () => {
	before(async () => {
		await fake.start();
		launcher = systemd();
		// A stand-in for the Coordinator's database, owner-only, which the Pi user must not read.
		await writeFile(join(DATA_DIR, "coordinator.sqlite"), "not a database", { mode: 0o600 }).catch(() => undefined);
		// A directory the Pi group could write (like conversations/) that is not in the unit's ReadWritePaths.
		const outside = join(DATA_DIR, "outside");
		await mkdir(outside, { recursive: true });
		await chown(outside, process.getuid?.() ?? -1, (await stat(join(DATA_DIR, "conversations"))).gid);
		await chmod(outside, 0o2770);
	});
	after(async () => {
		await fake.stop();
	});

	it("the launcher's availability check passes", async () => {
		assert.deepEqual(await launcher.available(), { ok: true });
	});

	it("a unit runs as the Pi user in the slice and reaches only localhost; it writes only its own directories", async () => {
		const runId = ++nextRun;
		const { handle, messages } = launch(systemd(PROBE), startFor(runId, "probe"));
		await handle.exited;
		const progress = messages.find((message) => message.type === "progress");
		assert.ok(progress !== undefined && progress.type === "progress", JSON.stringify(messages));
		const seen = JSON.parse(progress.text);
		assert.equal(seen.uid, piUid(), "runs as the Pi user");
		assert.notEqual(seen.uid, process.getuid?.(), "not as the Coordinator's user");
		const unit = unitName(deploymentId(DATA_DIR), runId, 1);
		assert.ok(seen.cgroup.includes(`${SLICE}/${unit}`), seen.cgroup);
		assert.equal(seen.gotKey, true, "the run key arrived on stdin");
		assert.equal(seen.keyInEnv, false, "and not in the environment");
		assert.equal(seen.relay, "connected", "the relay on 127.0.0.1 is reachable");
		assert.notEqual(seen.metadata, "connected", "the metadata server is blocked");
		assert.notEqual(seen.external, "connected", "no other address is reachable");
		assert.equal(seen.writeConversations, true);
		assert.equal(seen.writeOutside, false, "ProtectSystem=strict: a group-writable directory elsewhere is read-only");
		assert.equal(seen.readCoordinatorDb, false, "the Coordinator's database is not readable by the Pi user");
		assert.notEqual(unitActive(unit), "active");
	});

	it("the real runner completes a run in a unit; the conversation file is 0660, owned by the Pi user", async () => {
		fake.requests.length = 0;
		fake.script(() => ({ text: "Hello from the unit." }));
		const start = startFor(++nextRun, "say hello");
		const { handle, messages } = launch(launcher, start);
		await handle.exited;
		const finished = messages.find((message) => message.type === "finished");
		assert.ok(finished !== undefined && finished.type === "finished");
		assert.equal(finished.outcome, "answered");
		assert.equal(fake.requests[0]?.auth, `Bearer ${RUN_KEY}`);
		const file = await stat(start.conversationPath);
		assert.equal(file.mode & 0o777, 0o660);
		assert.equal(file.uid, piUid());
		await rm(start.conversationPath, { force: true });
		await rm(`${start.conversationPath}-wal`, { force: true });
		await rm(`${start.conversationPath}-shm`, { force: true });
	});

	it("kill() stops the whole unit and exited resolves only once it is gone", async () => {
		fake.script(() => ({ hang: true }));
		const start = startFor(++nextRun, "hang");
		const { handle } = launch(launcher, start);
		await fake.waitForRequests(1, 30_000);
		const unit = unitName(deploymentId(DATA_DIR), start.runId, 1);
		assert.equal(unitActive(unit), "active");
		// Restart cleanup's deployment-wide listing finds it by its name.
		assert.ok(launcher.leftovers()?.some((ref) => ref.runId === start.runId && ref.generation === 1));
		handle.kill();
		await handle.exited;
		assert.ok(["inactive", "failed"].includes(unitActive(unit)));
		assert.equal(launcher.isRunner({ runId: start.runId, generation: 1, pid: null }), false);
		await rm(start.conversationPath, { force: true });
	});

	it("cleanup survives escape: a child that left its session (setsid) dies with the unit", async () => {
		const start = startFor(++nextRun, "escape");
		const { handle, messages } = launch(systemd(PROBE), start);
		const progress = await waitFor(() => messages.find((message) => message.type === "progress"), {
			what: "the escaped child's pid",
			timeoutMs: 30_000,
		});
		const escaped = progress.type === "progress" ? Number(JSON.parse(progress.text).escaped) : 0;
		assert.ok(escaped > 1);
		assert.equal(processState(escaped), "alive (another user)");
		handle.kill();
		await handle.exited;
		await waitFor(() => processState(escaped) === "gone", { what: "the escaped child gone", timeoutMs: 10_000 });
	});

	it("the host firewall alone blocks the metadata server for the Pi user (a unit without any IP filter)", async () => {
		const unit = unitName(deploymentId(DATA_DIR), ++nextRun, 1);
		// Deliberately NOT in the Pi slice: the slice's own IPAddressDeny=any applies to all its member units, so only a
		// unit outside it (system.slice, no IP filter of its own) shows the nftables rule holding by itself.
		const result = spawnSync(
			"systemd-run",
			[
				`--unit=${unit}`,
				`--uid=${USER}`,
				`--gid=${GROUP}`,
				"--pipe",
				"--wait",
				"--collect",
				"--quiet",
				"--no-ask-password",
				"--",
				process.execPath,
				PROBE,
				"--metadata-only",
			],
			{ encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
		);
		assert.equal(result.status, 0, "the probe unit ran");
		const outcomes = JSON.parse(result.stdout.trim());
		assert.notEqual(outcomes.v4, "connected", "169.254.169.254 is dropped for the Pi user");
		assert.notEqual(outcomes.v6, "connected", "fd20:ce::254 is dropped for the Pi user");
		await waitFor(() => unitActive(unit) !== "active", { what: "probe unit gone" });
	});
});
