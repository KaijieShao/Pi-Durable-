import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Update } from "grammy/types";
import { type TelegramApi, TelegramError } from "../../src/coordinator/ports.ts";
import { Store } from "../../src/coordinator/store.ts";
import { createTelegramApi } from "../../src/coordinator/telegram/api.ts";
import { OFFSET_KEY, startPoller } from "../../src/coordinator/telegram/poller.ts";
import { createLogger, silentLogger } from "../../src/runtime/log.ts";
import { FakeBotApi } from "../fixtures/fake-bot-api.ts";
import { sleep, waitFor } from "../helpers/env.ts";

const G = -100_777;
const TOKEN = "123456789:AAH-test_token_value_that_is_long_enough";

let dir: string;
let fake: FakeBotApi;
let root: string;
let stores: Store[];

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "poller-"));
	fake = new FakeBotApi();
	root = await fake.start();
	stores = [];
});

afterEach(async () => {
	for (const store of stores) store.close();
	await fake.stop();
	rmSync(dir, { recursive: true, force: true });
});

function openStore(): Store {
	const store = new Store(join(dir, "coordinator.sqlite"));
	stores.push(store);
	return store;
}

function api(): TelegramApi {
	return createTelegramApi({ token: TOKEN, apiRoot: root });
}

/** The command handler's dedup: one row per update id, `INSERT OR IGNORE` in its own transaction. */
function recorder(store: Store) {
	const seen: number[] = [];
	return {
		seen,
		onUpdate(update: Update) {
			seen.push(update.update_id);
			store.tx(() => {
				store.run(
					"INSERT OR IGNORE INTO commands(update_id, kind, outcome, received_at) VALUES (?, 'ignored', 'ignored', ?)",
					update.update_id,
					Date.now(),
				);
			});
		},
		saved(): number[] {
			return store
				.all<{ update_id: number }>("SELECT update_id FROM commands ORDER BY update_id")
				.map((r) => r.update_id);
		},
	};
}

function push(count: number, firstId: number): Update[] {
	const out: Update[] = [];
	for (let i = 0; i < count; i++)
		out.push(fake.groupMessage({ chatId: G, fromId: 1, text: `/status ${i}`, updateId: firstId + i }));
	return out;
}

describe("poller: offset and batches", () => {
	it("first start polls from offset 0 with the long-poll timeout and only message updates", async () => {
		const store = openStore();
		const rec = recorder(store);
		push(2, 10);
		const poller = startPoller({ store, api: api(), onUpdate: rec.onUpdate, log: silentLogger, timeoutSeconds: 30 });
		await waitFor(() => store.getMeta(OFFSET_KEY) === "12", { what: "offset 12" });
		await poller.stop();
		const first = fake.calls.find((c) => c.method === "getUpdates");
		assert.deepEqual(first?.body, { offset: 0, timeout: 30, allowed_updates: ["message"] });
		assert.deepEqual(rec.saved(), [10, 11]);
	});

	it("saves the offset only after the whole batch is processed", async () => {
		const store = openStore();
		store.setMeta(OFFSET_KEY, "100");
		const offsetsSeen: (string | undefined)[] = [];
		const rec = recorder(store);
		push(3, 100);
		const poller = startPoller({
			store,
			api: api(),
			log: silentLogger,
			onUpdate(update) {
				offsetsSeen.push(store.getMeta(OFFSET_KEY));
				rec.onUpdate(update);
			},
		});
		await waitFor(() => store.getMeta(OFFSET_KEY) === "103", { what: "offset 103" });
		await poller.idle();
		await poller.stop();
		assert.deepEqual(offsetsSeen, ["100", "100", "100"]);
		assert.deepEqual(rec.seen, [100, 101, 102]);
		// The next getUpdates confirms the saved offset to Telegram.
		await waitFor(() => fake.calls.some((c) => c.method === "getUpdates" && c.body.offset === 103));
	});

	it("resumes from the saved offset after a restart (updates confirmed by the batch are not served again)", async () => {
		const store = openStore();
		const rec = recorder(store);
		push(2, 50);
		const first = startPoller({ store, api: api(), onUpdate: rec.onUpdate, log: silentLogger });
		await waitFor(() => store.getMeta(OFFSET_KEY) === "52");
		await first.stop();
		push(1, 52);
		const restarted = openStore();
		const rec2 = recorder(restarted);
		const second = startPoller({ store: restarted, api: api(), onUpdate: rec2.onUpdate, log: silentLogger });
		await waitFor(() => restarted.getMeta(OFFSET_KEY) === "53");
		await second.stop();
		assert.deepEqual(rec2.seen, [52]);
		assert.deepEqual(rec2.saved(), [50, 51, 52]);
		const offsets = fake.calls.filter((c) => c.method === "getUpdates").map((c) => c.body.offset);
		assert.ok(offsets.includes(52), "second poller started at the saved offset");
	});
});

describe("poller: crashes and redelivery", () => {
	it("onUpdate throwing mid-batch: the offset stays, the batch comes again, saved updates dedup by update id", async () => {
		const store = openStore();
		const rec = recorder(store);
		push(3, 1);
		let thrown = false;
		const lines: string[] = [];
		const poller = startPoller({
			store,
			api: api(),
			log: createLogger({ level: "debug", sink: (_level, line) => lines.push(line) }),
			backoffMs: [30],
			onUpdate(update) {
				rec.onUpdate(update);
				if (update.update_id === 2 && !thrown) {
					thrown = true;
					assert.equal(store.getMeta(OFFSET_KEY), undefined);
					throw new Error("handler crashed while saving update text /status 1");
				}
			},
		});
		await waitFor(() => store.getMeta(OFFSET_KEY) === "4", { what: "offset 4" });
		await poller.stop();
		// 1 and 2 were seen twice (the batch was redelivered), 3 once; each is saved exactly once.
		assert.deepEqual(rec.seen, [1, 2, 1, 2, 3]);
		assert.deepEqual(rec.saved(), [1, 2, 3]);
		const failed = lines.find((line) => line.includes("telegram_update_failed"));
		assert.ok(failed?.includes("update_id=2"), failed);
		assert.ok(!lines.some((line) => line.includes(TOKEN)), "no token in logs");
		const offsets = fake.calls.filter((c) => c.method === "getUpdates").map((c) => c.body.offset);
		assert.deepEqual(offsets.slice(0, 2), [0, 0], "the same offset was polled again after the failure");
	});

	it("a crash after the updates are saved but before the offset is: the restarted poller re-applies nothing", async () => {
		const store = openStore();
		const rec = recorder(store);
		push(2, 20);
		let poller: ReturnType<typeof startPoller> | undefined;
		poller = startPoller({
			store,
			api: api(),
			log: silentLogger,
			backoffMs: [60_000],
			onUpdate(update) {
				rec.onUpdate(update);
				// The process "dies" right after the last update of the batch committed, before the offset is saved.
				if (update.update_id === 21) throw new Error("killed");
			},
		});
		await waitFor(() => rec.saved().length === 2);
		await poller.stop();
		poller = undefined;
		assert.equal(store.getMeta(OFFSET_KEY), undefined);

		const restarted = openStore();
		const rec2 = recorder(restarted);
		const second = startPoller({ store: restarted, api: api(), onUpdate: rec2.onUpdate, log: silentLogger });
		await waitFor(() => restarted.getMeta(OFFSET_KEY) === "22");
		await second.stop();
		assert.deepEqual(rec2.seen, [20, 21], "the unconfirmed batch is delivered again");
		assert.deepEqual(rec2.saved(), [20, 21], "and deduplicated: each update is saved once");
	});

	it("a forced redelivery of a confirmed update is deduplicated by the handler", async () => {
		const store = openStore();
		const rec = recorder(store);
		const [update] = push(1, 70);
		const poller = startPoller({ store, api: api(), onUpdate: rec.onUpdate, log: silentLogger });
		await waitFor(() => store.getMeta(OFFSET_KEY) === "71");
		fake.redeliver(update as Update);
		await waitFor(() => rec.seen.length === 2);
		await poller.idle();
		await poller.stop();
		assert.deepEqual(rec.saved(), [70]);
		assert.equal(store.getMeta(OFFSET_KEY), "71");
	});
});

describe("poller: errors and stop", () => {
	it("retries 5xx and network failures with backoff", async () => {
		const store = openStore();
		const rec = recorder(store);
		fake.failNext("getUpdates", { status: 502 });
		fake.failNext("getUpdates", { drop: "before" });
		push(1, 5);
		const poller = startPoller({ store, api: api(), onUpdate: rec.onUpdate, log: silentLogger, backoffMs: [10, 20] });
		await waitFor(() => store.getMeta(OFFSET_KEY) === "6");
		await poller.stop();
		assert.deepEqual(rec.saved(), [5]);
		assert.ok(fake.count("getUpdates") >= 3);
	});

	it("waits at least Telegram's retry_after on 429", async () => {
		const store = openStore();
		const rec = recorder(store);
		fake.failNext("getUpdates", { status: 429, retryAfter: 1 });
		push(1, 8);
		const started = Date.now();
		const poller = startPoller({ store, api: api(), onUpdate: rec.onUpdate, log: silentLogger, backoffMs: [10] });
		await waitFor(() => store.getMeta(OFFSET_KEY) === "9");
		await poller.stop();
		assert.ok(Date.now() - started >= 950, `waited ${Date.now() - started} ms`);
	});

	it("401 is fatal: onFatal is called and polling stops", async () => {
		const store = openStore();
		fake.failNext("getUpdates", { status: 401 });
		let fatal: unknown;
		const poller = startPoller({
			store,
			api: api(),
			onUpdate: () => assert.fail("no update expected"),
			log: silentLogger,
			onFatal: (error) => {
				fatal = error;
			},
		});
		await waitFor(() => fatal !== undefined);
		assert.ok(fatal instanceof TelegramError);
		assert.equal(fatal.kind, "unauthorized");
		assert.ok(!fatal.message.includes(TOKEN));
		const calls = fake.count("getUpdates");
		await sleep(100);
		assert.equal(fake.count("getUpdates"), calls, "no more polling");
		await poller.stop();
	});

	it("stop() aborts a long poll promptly", async () => {
		const store = openStore();
		fake.delays.set("getUpdates", 20_000);
		const poller = startPoller({ store, api: api(), onUpdate: () => {}, log: silentLogger, timeoutSeconds: 30 });
		await waitFor(() => fake.count("getUpdates") === 1);
		const started = Date.now();
		await poller.stop();
		assert.ok(Date.now() - started < 1000, `stop took ${Date.now() - started} ms`);
	});

	it("stop() during a backoff returns at once", async () => {
		const store = openStore();
		fake.failNext("getUpdates", { status: 500 });
		const poller = startPoller({ store, api: api(), onUpdate: () => {}, log: silentLogger, backoffMs: [60_000] });
		await waitFor(() => fake.count("getUpdates") === 1);
		await sleep(30);
		const started = Date.now();
		await poller.stop();
		assert.ok(Date.now() - started < 500);
	});
});

describe("telegram api", () => {
	it("getMe maps username and can_read_all_group_messages", async () => {
		fake.username = "smule_code_bot";
		fake.canReadAllGroupMessages = true;
		assert.deepEqual(await api().getMe(), { id: 42, username: "smule_code_bot", canReadAllGroupMessages: true });
		fake.canReadAllGroupMessages = false;
		assert.equal((await api().getMe()).canReadAllGroupMessages, false);
	});

	it("sendMessage sends thread, reply parameters and disables link previews", async () => {
		const sent = await api().sendMessage({ chatId: G, text: "hello", threadId: 5, replyTo: 33 });
		const call = fake.calls.find((c) => c.method === "sendMessage");
		assert.deepEqual(call?.body, {
			chat_id: G,
			text: "hello",
			message_thread_id: 5,
			reply_parameters: { message_id: 33, allow_sending_without_reply: true },
			link_preview_options: { is_disabled: true },
		});
		assert.equal(fake.messages.get(sent.messageId)?.text, "hello");
		await api().sendMessage({ chatId: G, text: "plain" });
		const plain = fake.calls.filter((c) => c.method === "sendMessage")[1];
		assert.deepEqual(plain?.body, { chat_id: G, text: "plain", link_preview_options: { is_disabled: true } });
	});

	it("classifies errors, carries retry_after, and never puts the token or URL in a message", async () => {
		const cases: [Parameters<FakeBotApi["failNext"]>[1], string][] = [
			[{ status: 429, retryAfter: 7 }, "rate_limited"],
			[{ status: 500 }, "server"],
			[{ status: 503 }, "server"],
			[{ status: 401 }, "unauthorized"],
			[{ status: 404 }, "unauthorized"],
			[{ status: 403 }, "permanent"],
			[{ status: 400, description: `Bad Request: chat not found ${TOKEN}` }, "permanent"],
			[{ drop: "before" }, "network"],
		];
		for (const [failure, kind] of cases) {
			fake.failNext("sendMessage", failure);
			const error = await api()
				.sendMessage({ chatId: G, text: "x" })
				.then(
					() => assert.fail("expected an error"),
					(e: unknown) => e,
				);
			assert.ok(error instanceof TelegramError, String(error));
			assert.equal(error.kind, kind, error.message);
			assert.ok(!error.message.includes(TOKEN), error.message);
			assert.ok(!error.message.includes(root), error.message);
			if (kind === "rate_limited") assert.equal(error.retryAfterSeconds, 7);
			if ("status" in failure) assert.equal(error.status, failure.status);
		}
	});

	it("an error answer with HTTP 200 (ok:false) is still classified by error_code", async () => {
		fake.failGetMe = 401;
		await assert.rejects(api().getMe(), (e: unknown) => e instanceof TelegramError && e.kind === "unauthorized");
	});

	it("a refused connection is a network error without URL or token", async () => {
		const closed = createServer();
		await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
		const { port } = closed.address() as AddressInfo;
		await new Promise<void>((resolve) => closed.close(() => resolve()));
		const dead = createTelegramApi({ token: TOKEN, apiRoot: `http://127.0.0.1:${port}` });
		const error = await dead.getMe().catch((e: unknown) => e);
		assert.ok(error instanceof TelegramError);
		assert.equal(error.kind, "network");
		assert.ok(!error.message.includes(TOKEN) && !error.message.includes(String(port)), error.message);
	});

	it("times out a hung call (requestTimeoutMs) as a network error", async () => {
		fake.delays.set("sendMessage", 5000);
		const slow = createTelegramApi({ token: TOKEN, apiRoot: root, requestTimeoutMs: 100 });
		const error = await slow.sendMessage({ chatId: G, text: "x" }).catch((e: unknown) => e);
		assert.ok(error instanceof TelegramError);
		assert.equal(error.kind, "network");
		assert.match(error.message, /timed out/);
	});

	it("a malformed 200 answer is a server error (retryable), not success", async () => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<html>proxy</html>");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		try {
			const bad = createTelegramApi({ token: TOKEN, apiRoot: `http://127.0.0.1:${port}/` });
			const error = await bad.sendMessage({ chatId: G, text: "x" }).catch((e: unknown) => e);
			assert.ok(error instanceof TelegramError);
			assert.equal(error.kind, "server");
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
