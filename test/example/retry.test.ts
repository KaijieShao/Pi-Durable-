import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramUnavailable, TelegramUnknown } from "../../src/telegram/errors.ts";
import { createRetryTransformer } from "../../src/telegram/retry.ts";

type Result = {
	ok: boolean;
	error_code?: number;
	description?: string;
	parameters?: { retry_after?: number };
	result?: unknown;
};

function harness(results: (Result | Error)[]) {
	const waits: number[] = [];
	let calls = 0;
	const transformer = createRetryTransformer({ sleep: async (ms) => void waits.push(ms) });
	const prev = async () => {
		const next = results[Math.min(calls++, results.length - 1)];
		if (next instanceof Error) throw next;
		return next as never;
	};
	const call = (method: string) => transformer(prev as never, method as never, {} as never, undefined);
	return { call, waits, calls: () => calls };
}

const ok: Result = { ok: true, result: true };
const r429: Result = { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } };
const r500: Result = { ok: false, error_code: 502, description: "Bad Gateway" };

test("idempotent methods retry 429, 5xx and network errors up to 3 attempts", async () => {
	const a = harness([r429, r500, ok]);
	assert.deepEqual(await a.call("editMessageText"), ok);
	assert.deepEqual(a.waits, [7000, 2000]);
	const b = harness([new Error("socket hang up"), new Error("again"), new Error("third")]);
	await assert.rejects(b.call("getFile"), TelegramUnavailable);
	assert.equal(b.calls(), 3);
	const c = harness([r500, r500, r500]);
	assert.deepEqual(await c.call("sendChatAction"), r500);
});

test("non-idempotent sends retry only 429; 5xx or network errors mean unknown outcome", async () => {
	const a = harness([r429, ok]);
	assert.deepEqual(await a.call("sendMessage"), ok);
	assert.deepEqual(a.waits, [7000]);
	const b = harness([r500, ok]);
	await assert.rejects(b.call("sendMessage"), TelegramUnknown);
	assert.equal(b.calls(), 1);
	const c = harness([new Error("reset"), ok]);
	await assert.rejects(c.call("sendDocument"), TelegramUnknown);
	const rich = harness([r500, ok]);
	await assert.rejects(rich.call("sendRichMessage"), TelegramUnknown, "a rich answer is never sent twice");
	const d = harness([{ nonsense: true } as never]);
	await assert.rejects(d.call("sendPhoto"), TelegramUnknown);
	const e = harness([r429, r429, r429, r429]);
	assert.deepEqual(await e.call("sendMessage"), r429);
	assert.equal(e.calls(), 3);
});

test("retry_after waits are capped at 30 s; client errors are not retried", async () => {
	const a = harness([{ ...r429, parameters: { retry_after: 600 } }, ok]);
	await a.call("editMessageText");
	assert.deepEqual(a.waits, [30_000]);
	const bad: Result = { ok: false, error_code: 400, description: "Bad Request: chat not found" };
	const b = harness([bad, ok]);
	assert.deepEqual(await b.call("editMessageText"), bad);
	assert.equal(b.calls(), 1);
});

test("an aborted call is not retried", async () => {
	const controller = new AbortController();
	controller.abort(new Error("stop"));
	const transformer = createRetryTransformer({ sleep: async () => undefined });
	const prev = async () => {
		throw new Error("network");
	};
	await assert.rejects(
		transformer(prev as never, "editMessageText" as never, {} as never, controller.signal as never),
		/stop/,
	);
});
