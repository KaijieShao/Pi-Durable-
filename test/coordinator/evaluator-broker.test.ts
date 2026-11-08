/** In-memory protocol fixtures only: no application payload, subprocess, network or filesystem access. */
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { serialize } from "node:v8";
import {
	decodeFileEvidence,
	type EvaluationProcess,
	runEvaluationPair,
} from "../../src/coordinator/sandbox/evaluator-broker.ts";

function simulatedChild() {
	return Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null as number | null,
		signalCode: null,
	});
}
function processOf(child: ReturnType<typeof simulatedChild>, verified = true): EvaluationProcess {
	return {
		child: child as unknown as ChildProcessWithoutNullStreams,
		scratch: "/not-accessed",
		stop: async () => {
			if (child.exitCode === null) {
				child.exitCode = 0;
				child.emit("close", 0);
			}
			return verified;
		},
	};
}
async function scenario(proxyExited: boolean, verified = true, observerFailure = false) {
	const grader = simulatedChild(),
		app = simulatedChild(),
		proxy = simulatedChild();
	const plan = { type: "plan", version: 3, suites: ["baseline"], expectedTests: { baseline: ["test"] } };
	const suite = {
		type: "suite",
		name: "baseline",
		outcome: "passed",
		exitCode: 0,
		durationMs: 1,
		expectedTests: ["test"],
		executedTests: ["test"],
		passedTests: ["test"],
	};
	const request = (id: number, op: string) =>
		grader.stdout.write(`${JSON.stringify({ type: "rpc", id, op, payload: serialize(null).toString("base64") })}\n`);
	grader.stdin.on("data", (chunk) => {
		for (const line of chunk.toString().trim().split("\n")) {
			const reply = JSON.parse(line);
			if (reply.id === 1) {
				request(2, observerFailure ? "read_file" : "evaluate");
				continue;
			}
			grader.stdout.write(`${JSON.stringify(suite)}\n${JSON.stringify({ type: "done" })}\n`);
			grader.exitCode = 0;
			grader.emit("close", 0);
		}
	});
	proxy.stdin.on("data", (chunk) => {
		const request = JSON.parse(chunk.toString());
		proxy.stdout.write(
			`\u001ePDAPP3 ${JSON.stringify({ id: request.id, ok: true, payload: serialize(1).toString("base64") })}\n`,
		);
		if (proxyExited) proxy.exitCode = 0; // Deliberately defer close: planned teardown must not hide this fault.
	});
	const result = runEvaluationPair({
		grader: processOf(grader),
		deadlineMs: 1000,
		...(observerFailure
			? {
					fileObserver: async () => {
						throw new Error("scripted observer operational failure");
					},
				}
			: {}),
		launchSubject: async () => {
			setImmediate(() => proxy.stdout.write('\u001ePDAPP3 {"ready":true}\n'));
			return { ...processOf(app, verified), transport: proxy as unknown as ChildProcessWithoutNullStreams };
		},
	});
	grader.stdout.write(`${JSON.stringify(plan)}\n`);
	request(1, "reset");
	return result;
}

test("proxy exit before its close event is an independent subject failure even when all test results pass", async () => {
	assert.equal((await scenario(false)).subjectFailed, false);
	assert.equal((await scenario(true)).subjectFailed, true);
});
test("unverified termination remains a failure independently of passing hidden reports", async () => {
	assert.equal((await scenario(false, false)).failed, true);
});

test("unknown observer failures remain infrastructure failures even if a negative assertion reports passed", async () => {
	assert.equal((await scenario(false, true, true)).failed, true);
	for (const text of [
		"{",
		JSON.stringify({ ok: false, kind: "infrastructure" }),
		JSON.stringify({ ok: false, kind: "EIO" }),
		JSON.stringify({ ok: true, data: "AAAA!" }),
	])
		assert.equal(decodeFileEvidence(text).kind, "infrastructure");
	for (const kind of ["missing", "unsafe", "not_regular"])
		assert.equal(decodeFileEvidence(JSON.stringify({ ok: false, kind })).kind, "refused");
	assert.deepEqual(decodeFileEvidence(JSON.stringify({ ok: true, data: Buffer.from("known").toString("base64") })), {
		kind: "data",
		bytes: Buffer.from("known"),
	});
});
