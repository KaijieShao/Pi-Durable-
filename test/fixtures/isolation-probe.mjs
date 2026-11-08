// TEST ONLY (test/runner/systemd-linux.test.ts): started by the systemd launcher in place of the runner, inside a
// real transient unit. Reads the key frame and the start message from stdin like the runner, then reports what the
// process can see and reach as one `progress` frame (JSON text) and a `finished` frame. Never prints the key.

import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

function reach(host, port) {
	return new Promise((resolve) => {
		const socket = connect({ host, port, timeout: 3000 });
		socket.once("connect", () => {
			socket.destroy();
			resolve("connected");
		});
		socket.once("timeout", () => {
			socket.destroy();
			resolve("timeout");
		});
		socket.once("error", (error) => resolve(error.code ?? "error"));
	});
}

function canWrite(dir) {
	const file = join(dir, `.probe-${process.pid}`);
	try {
		writeFileSync(file, "x");
		unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}

function canRead(path) {
	try {
		accessSync(path, constants.R_OK);
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}

async function probe(keyFrame, start) {
	const relay = new URL(start.model.relayBaseUrl);
	const conversations = start.conversationPath.slice(0, start.conversationPath.lastIndexOf("/"));
	const dataDir = conversations.slice(0, conversations.lastIndexOf("/"));
	return {
		uid: process.getuid(),
		gid: process.getgid(),
		cgroup: readFileSync("/proc/self/cgroup", "utf8"),
		gotKey: typeof keyFrame.key === "string" && keyFrame.key.length > 0,
		keyInEnv: "OPENAI_API_KEY" in process.env,
		relay: await reach(relay.hostname, Number(relay.port)),
		metadata: await reach("169.254.169.254", 80),
		external: await reach("1.1.1.1", 443),
		writeConversations: canWrite(conversations),
		// Group-writable for the Pi user, but not in ReadWritePaths: ProtectSystem=strict keeps it read-only.
		writeOutside: canWrite(join(dataDir, "outside")),
		readCoordinatorDb: canRead(join(dataDir, "coordinator.sqlite")),
	};
}

// Input "escape": start a child that leaves this process group and session (setsid) and is re-parented, report its
// pid, then wait to be killed. Killing the unit must kill the child too (KillMode=control-group).
function startEscapedChild() {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
	child.unref();
	const progress = { type: "progress", text: JSON.stringify({ escaped: child.pid }) };
	process.stdout.write(`${JSON.stringify(progress)}\n`);
	setInterval(() => {}, 1000);
}

// `--metadata-only`: just try the metadata server and print the outcome (a unit without the IP filter, to check the
// host firewall rule on its own).
if (process.argv[2] === "--metadata-only") {
	const outcomes = { v4: await reach("169.254.169.254", 80), v6: await reach("fd20:ce::254", 80) };
	process.stdout.write(`${JSON.stringify(outcomes)}\n`, () => process.exit(0));
} else {
	const lines = [];
	const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	input.on("line", (line) => {
		lines.push(line);
		if (lines.length < 2) return;
		input.close();
		const start = JSON.parse(lines[1]);
		if (start.input?.content === "escape") {
			startEscapedChild();
			return;
		}
		void probe(JSON.parse(lines[0]), start).then((result) => {
			const progress = { type: "progress", text: JSON.stringify(result) };
			const finished = { type: "finished", outcome: "answered", delivered: [], unconsumed: [], answered: [] };
			process.stdout.write(`${JSON.stringify(progress)}\n${JSON.stringify(finished)}\n`, () => process.exit(0));
		});
	});
}
