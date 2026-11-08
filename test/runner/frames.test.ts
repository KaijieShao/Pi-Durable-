/**
 * The stdio transport's framing (src/runner/frames.ts) and the Pi process's arguments and markers
 * (src/runner/argv.ts): newline-delimited JSON split correctly across chunks, oversize and malformed lines dropped,
 * a well-formed key frame only, and markers that identify a deployment's and a run's Pi processes without secrets.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import {
	deploymentId,
	hasRunnerMarkers,
	MARKER_DEPLOYMENT,
	MARKER_RUN,
	markedRunId,
	parseRunnerArgv,
	runnerArgv,
} from "../../src/runner/argv.ts";
import { encodeFrame, keyFromFrame, readFrames } from "../../src/runner/frames.ts";

function collect(maxBytes?: number) {
	const stream = new PassThrough();
	const frames: unknown[] = [];
	const invalid: string[] = [];
	let ended = 0;
	readFrames(
		stream,
		{ frame: (value) => frames.push(value), invalid: (kind) => invalid.push(kind), end: () => ended++ },
		maxBytes,
	);
	return { stream, frames, invalid, ended: () => ended };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("stdio frames", () => {
	it("splits newline-delimited JSON across arbitrary chunk boundaries", async () => {
		const reader = collect();
		const text = `${encodeFrame({ type: "a", text: "line\nbreak inside a string" })}${encodeFrame({ type: "b", n: 2 })}`;
		for (const piece of [text.slice(0, 5), text.slice(5, 40), text.slice(40)]) reader.stream.write(piece);
		reader.stream.write(Buffer.from(encodeFrame({ type: "c", text: "ünïcödé ✓" })).subarray(0, 12));
		reader.stream.write(Buffer.from(encodeFrame({ type: "c", text: "ünïcödé ✓" })).subarray(12));
		await tick();
		assert.deepEqual(reader.frames, [
			{ type: "a", text: "line\nbreak inside a string" },
			{ type: "b", n: 2 },
			{ type: "c", text: "ünïcödé ✓" },
		]);
		assert.deepEqual(reader.invalid, []);
	});

	it("drops a malformed line and an oversize one up to its newline, keeps the frames around them", async () => {
		const reader = collect(64);
		reader.stream.write("not json\n");
		reader.stream.write(`${encodeFrame({ ok: 1 })}{"big":"${"x".repeat(50)}`);
		reader.stream.write(`${"y".repeat(50)}"}\n${encodeFrame({ ok: 2 })}`);
		reader.stream.write("\n\n");
		await tick();
		assert.deepEqual(reader.frames, [{ ok: 1 }, { ok: 2 }]);
		assert.deepEqual(reader.invalid, ["json", "oversize"]);
	});

	it("ends once, dropping a trailing partial line", async () => {
		const reader = collect();
		reader.stream.write('{"partial":');
		reader.stream.end();
		await tick();
		reader.stream.destroy();
		await tick();
		assert.deepEqual(reader.frames, []);
		assert.equal(reader.ended(), 1);
	});

	it("accepts only a well-formed key frame", () => {
		const key = "k".repeat(43);
		assert.equal(keyFromFrame({ type: "key", key }), key);
		for (const bad of [
			undefined,
			null,
			"key",
			{ type: "start", key },
			{ type: "key" },
			{ type: "key", key: 42 },
			{ type: "key", key: "short" },
			{ type: "key", key: `${key} with space` },
			{ type: "key", key: `${key}\n` },
			{ type: "key", key: "k".repeat(513) },
		]) {
			assert.equal(keyFromFrame(bad), undefined, JSON.stringify(bad));
		}
	});
});

describe("runner arguments and markers", () => {
	it("round-trips the arguments; the defaults are the local IPC transport with private files", () => {
		const deployment = deploymentId("/var/lib/pi-durable");
		const args = runnerArgv({ transport: "stdio", conversationAccess: "group", deployment, runId: 12 });
		assert.deepEqual(args, [
			"--transport=stdio",
			"--conversation-access=group",
			`--pi-durable-deployment=${deployment}`,
			"--pi-durable-run=12",
		]);
		assert.deepEqual(parseRunnerArgv(args), {
			transport: "stdio",
			conversationAccess: "group",
			deployment,
			runId: 12,
		});
		assert.deepEqual(parseRunnerArgv([]), {
			transport: "ipc",
			conversationAccess: "private",
			deployment: undefined,
			runId: undefined,
		});
	});

	it("refuses unknown, repeated or malformed arguments", () => {
		for (const argv of [
			["--transport=tcp"],
			["--conversation-access=world"],
			["--pi-durable-run=-1"],
			["--pi-durable-run=1x"],
			["--pi-durable-deployment=XYZ"],
			["--transport=ipc", "--transport=stdio"],
			["--key=secret"],
			["extra"],
		]) {
			assert.equal(typeof parseRunnerArgv(argv), "string", argv.join(" "));
		}
	});

	it("the deployment marker is a stable hash of the resolved data dir, not the path itself", () => {
		const id = deploymentId("/var/lib/pi-durable");
		assert.match(id, /^[0-9a-f]{16}$/);
		assert.equal(deploymentId("/var/lib/pi-durable/../pi-durable"), id);
		assert.notEqual(deploymentId("/var/lib/other"), id);
	});

	it("finds a deployment's and a run's Pi processes by whole-word markers", () => {
		const id = deploymentId("/var/lib/pi-durable");
		const command = `/usr/bin/node /opt/pi/src/runner/main.ts --transport=ipc ${MARKER_DEPLOYMENT}${id} ${MARKER_RUN}12`;
		assert.equal(hasRunnerMarkers(command, id), true);
		assert.equal(hasRunnerMarkers(command, id, 12), true);
		assert.equal(hasRunnerMarkers(command, id, 1), false, "run 1 is not run 12");
		assert.equal(hasRunnerMarkers(command, deploymentId("/var/lib/other"), 12), false);
		assert.equal(hasRunnerMarkers(`${command}0`, id, 12), false, "whole words only");
		assert.equal(hasRunnerMarkers("/usr/bin/node /opt/pi/src/runner/main.ts", id), false);
		// The run a marked process serves (restart cleanup's deployment-wide sweep), only with this deployment's marker.
		assert.equal(markedRunId(command, id), 12);
		assert.equal(markedRunId(command, deploymentId("/var/lib/other")), undefined);
		assert.equal(markedRunId(`/usr/bin/node main.ts ${MARKER_DEPLOYMENT}${id}`, id), undefined, "no run marker");
		assert.equal(markedRunId(`${command} ${MARKER_RUN}13`, id), undefined, "two run markers");
		assert.equal(markedRunId(`/usr/bin/node main.ts ${MARKER_DEPLOYMENT}${id} ${MARKER_RUN}x`, id), undefined);
	});
});
