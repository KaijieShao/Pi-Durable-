import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fitTelegramText, startOutbox, TELEGRAM_TEXT_LIMIT } from "../../src/coordinator/outbox.ts";
import type { SendMessageParams, TelegramApi } from "../../src/coordinator/ports.ts";
import { type OutboxMessage, Store } from "../../src/coordinator/store.ts";
import { createTelegramApi } from "../../src/coordinator/telegram/api.ts";
import { createLogger, silentLogger } from "../../src/runtime/log.ts";
import { FakeBotApi } from "../fixtures/fake-bot-api.ts";
import { sleep, waitFor } from "../helpers/env.ts";

const G = -100_555;
const TOKEN = "123456789:AAH-test_token_value_that_is_long_enough";
const fast = () => 20;

let dir: string;
let fake: FakeBotApi;
let root: string;
let stores: Store[];
let senders: { stop(): Promise<void> }[];

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "outbox-"));
	fake = new FakeBotApi();
	root = await fake.start();
	stores = [];
	senders = [];
});

afterEach(async () => {
	for (const sender of senders) await sender.stop();
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

/** A TelegramApi wrapper that timestamps every sendMessage. */
function timed(inner: TelegramApi) {
	const sends: { at: number; text: string }[] = [];
	const wrapped: TelegramApi = {
		getMe: (signal) => inner.getMe(signal),
		getUpdates: (offset, timeout, signal) => inner.getUpdates(offset, timeout, signal),
		sendMessage: (params: SendMessageParams, signal?: AbortSignal) => {
			sends.push({ at: Date.now(), text: params.text });
			return inner.sendMessage(params, signal);
		},
	};
	return { api: wrapped, sends };
}

function enqueue(store: Store, message: Partial<OutboxMessage> & { text: string }): number {
	return store.tx(() => store.enqueue({ chatId: G, priority: "required", kind: "test", ...message }));
}

function start(store: Store, options: Partial<Parameters<typeof startOutbox>[0]> = {}) {
	const sender = startOutbox({
		store,
		api: api(),
		threadId: undefined,
		log: silentLogger,
		backoffMs: fast,
		...options,
	});
	senders.push(sender);
	return sender;
}

type Row = { id: number; state: string; attempts: number; telegram_message_id: number | null; text: string };
function row(store: Store, id: number): Row {
	const found = store.get<Row>("SELECT id, state, attempts, telegram_message_id, text FROM outbox WHERE id = ?", id);
	assert.ok(found, `outbox row ${id}`);
	return found;
}

describe("outbox: order and replacement", () => {
	it("sends required messages before progress, FIFO within each class", async () => {
		const store = openStore();
		enqueue(store, { text: "progress task 1", priority: "progress", taskId: 1 });
		enqueue(store, { text: "required A" });
		enqueue(store, { text: "progress task 2", priority: "progress", taskId: 2 });
		enqueue(store, { text: "required B", taskId: 1 });
		const sender = start(store);
		await sender.idle();
		assert.deepEqual(
			fake.sent().map((m) => m.text),
			["required A", "required B", "progress task 1", "progress task 2"],
		);
	});

	it("keeps only the latest progress message per task (end to end through Store.enqueue)", async () => {
		const store = openStore();
		enqueue(store, { text: "task 1: step 1", priority: "progress", taskId: 1 });
		enqueue(store, { text: "task 2: step 1", priority: "progress", taskId: 2 });
		enqueue(store, { text: "task 1: step 2", priority: "progress", taskId: 1 });
		enqueue(store, { text: "task 1 accepted", taskId: 1 });
		enqueue(store, { text: "task 1: step 3", priority: "progress", taskId: 1 });
		const sender = start(store);
		await sender.idle();
		assert.deepEqual(
			fake.sent().map((m) => m.text),
			["task 1 accepted", "task 2: step 1", "task 1: step 3"],
		);
		assert.equal(store.get<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE state = 'pending'")?.n, 0);
	});

	it("a required row in retry holds back progress (never progress while a required message is pending)", async () => {
		const store = openStore();
		fake.failNext("sendMessage", { status: 502 }, 2);
		enqueue(store, { text: "required", taskId: 3 });
		enqueue(store, { text: "progress", priority: "progress", taskId: 3 });
		const sender = start(store, { backoffMs: () => 60 });
		await waitFor(() => fake.sent().length === 2);
		await sender.idle();
		assert.deepEqual(
			fake.sent().map((m) => m.text),
			["required", "progress"],
		);
		assert.equal(fake.count("sendMessage"), 4);
	});

	it("delivery backlog with 429s: required first, nothing dropped", async () => {
		const store = openStore();
		for (let i = 0; i < 6; i++) enqueue(store, { text: `p${i}`, priority: "progress", taskId: 10 + i });
		for (let i = 0; i < 3; i++) enqueue(store, { text: `r${i}`, taskId: 10 + i });
		fake.failNext("sendMessage", { status: 429, retryAfter: 1 });
		const sender = start(store);
		await sender.idle();
		const texts = fake.sent().map((m) => m.text);
		assert.deepEqual(texts, ["r0", "r1", "r2", "p0", "p1", "p2", "p3", "p4", "p5"]);
		assert.equal(store.get<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE state = 'sent'")?.n, 9);
	});
});

describe("outbox: failures", () => {
	it("honours 429 retry_after: no send at all before it passes", async () => {
		const store = openStore();
		const t = timed(api());
		fake.failNext("sendMessage", { status: 429, retryAfter: 1 });
		const a = enqueue(store, { text: "first" });
		const b = enqueue(store, { text: "second" });
		const sender = start(store, { api: t.api });
		await sender.idle();
		assert.deepEqual(
			t.sends.map((s) => s.text),
			["first", "first", "second"],
		);
		const [limited, retried] = t.sends;
		assert.ok(limited && retried);
		assert.ok(retried.at - limited.at >= 950, `retried after ${retried.at - limited.at} ms`);
		assert.equal(row(store, a).state, "sent");
		assert.equal(row(store, b).state, "sent");
		assert.equal(row(store, a).attempts, 1, "a 429 is flow control, not a failed attempt");
	});

	it("retries 5xx and dropped connections with backoff until Telegram confirms", async () => {
		const store = openStore();
		fake.failNext("sendMessage", { status: 500 });
		fake.failNext("sendMessage", { status: 503 });
		fake.failNext("sendMessage", { drop: "before" });
		const attempts: number[] = [];
		const id = enqueue(store, { text: "eventually" });
		const sender = start(store, {
			backoffMs: (attempt) => {
				attempts.push(attempt);
				return 20;
			},
		});
		await waitFor(() => row(store, id).state === "sent");
		await sender.idle();
		assert.deepEqual(attempts, [1, 2, 3]);
		assert.equal(row(store, id).attempts, 4);
		assert.deepEqual(
			fake.sent().map((m) => m.text),
			["eventually"],
		);
	});

	it("401 keeps the row pending (token trouble is not a message failure)", async () => {
		const store = openStore();
		fake.failNext("sendMessage", { status: 401 }, 2);
		const id = enqueue(store, { text: "kept" });
		const sender = start(store);
		await waitFor(() => row(store, id).state === "sent");
		await sender.idle();
		assert.equal(store.get<{ n: number }>("SELECT count(*) AS n FROM failed_events")?.n, 0);
	});

	it("a permanent 4xx marks the row failed with a metadata-only failed_events row; the queue goes on", async () => {
		const store = openStore();
		const lines: string[] = [];
		fake.failNext("sendMessage", { status: 403, description: "Forbidden: bot was kicked from the supergroup chat" });
		const bad = enqueue(store, { text: "SECRET user text", kind: "task_ack", taskId: 4 });
		const good = enqueue(store, { text: "next" });
		const sender = start(store, { log: createLogger({ level: "debug", sink: (_l, line) => lines.push(line) }) });
		await sender.idle();
		assert.equal(row(store, bad).state, "failed");
		assert.equal(row(store, good).state, "sent");
		const events = store.all<{ outbox_id: number; kind: string; reason: string }>(
			"SELECT outbox_id, kind, reason FROM failed_events",
		);
		assert.equal(events.length, 1);
		assert.equal(events[0]?.outbox_id, bad);
		assert.equal(events[0]?.kind, "task_ack");
		assert.match(events[0]?.reason ?? "", /403/);
		assert.ok(!events[0]?.reason.includes("SECRET"), "no message text in the reason");
		assert.ok(!events[0]?.reason.includes(TOKEN));
		assert.ok(!lines.some((l) => l.includes("SECRET") || l.includes(TOKEN)), "logs are metadata only");
		assert.equal(
			store.get<{ n: number }>("SELECT count(*) AS n FROM task_messages")?.n,
			0,
			"a failed row maps nothing",
		);
	});
});

describe("outbox: what is sent", () => {
	it("records task_messages for task rows, in the same transaction as marking sent", async () => {
		const store = openStore();
		const withTask = enqueue(store, { text: "Task 7 accepted", taskId: 7, replyTo: 31 });
		const without = enqueue(store, { text: "help text", replyTo: 32 });
		const sender = start(store);
		await sender.idle();
		const sent = row(store, withTask);
		assert.equal(sent.state, "sent");
		assert.ok(sent.telegram_message_id !== null);
		assert.deepEqual(
			store.all("SELECT chat_id, message_id, task_id FROM task_messages").map((r) => ({ ...r })),
			[{ chat_id: G, message_id: sent.telegram_message_id, task_id: 7 }],
		);
		assert.equal(row(store, without).state, "sent");
		assert.equal(fake.messages.get(sent.telegram_message_id)?.text, "Task 7 accepted");
	});

	it("passes the thread id, reply parameters (allow_sending_without_reply) and disables previews", async () => {
		const store = openStore();
		enqueue(store, { text: "in topic", replyTo: 44 });
		const sender = start(store, { threadId: 5 });
		await sender.idle();
		assert.deepEqual(fake.sent()[0], {
			id: fake.sent()[0]?.id,
			chatId: G,
			text: "in topic",
			replyTo: 44,
			allowSendingWithoutReply: true,
			threadId: 5,
			linkPreviewDisabled: true,
		});
	});

	it("General (threadId undefined or 1) sends no message_thread_id", async () => {
		const store = openStore();
		enqueue(store, { text: "general" });
		const sender = start(store, { threadId: 1 });
		await sender.idle();
		const call = fake.calls.find((c) => c.method === "sendMessage");
		assert.equal(call?.body.message_thread_id, undefined);
		assert.equal(call?.body.reply_parameters, undefined);
	});

	it("uses the chat id of each row", async () => {
		const store = openStore();
		enqueue(store, { text: "to G", chatId: G });
		enqueue(store, { text: "to H", chatId: -200 });
		const sender = start(store);
		await sender.idle();
		assert.deepEqual(fake.textsIn(G), ["to G"]);
		assert.deepEqual(fake.textsIn(-200), ["to H"]);
	});

	it("cuts texts above 4096 characters with an ellipsis", async () => {
		const store = openStore();
		enqueue(store, { text: "x".repeat(5000) });
		const sender = start(store);
		await sender.idle();
		const text = fake.sent()[0]?.text ?? "";
		assert.equal(text.length, TELEGRAM_TEXT_LIMIT);
		assert.ok(text.endsWith("…"));
		assert.equal(fitTelegramText("short"), "short");
		assert.equal(fitTelegramText("y".repeat(4096)).length, 4096);
		// Never splits a surrogate pair.
		const emoji = `${"a".repeat(4094)}😀😀`;
		const cut = fitTelegramText(emoji);
		assert.ok(cut.length <= TELEGRAM_TEXT_LIMIT);
		assert.ok(!/[\ud800-\udbff]…$/.test(cut));
	});

	it("kick() makes a newly enqueued row go out without waiting for the poll interval", async () => {
		const store = openStore();
		const sender = start(store, { pollMs: 60_000 });
		await sender.idle();
		enqueue(store, { text: "kicked" });
		sender.kick();
		await waitFor(() => fake.sent().length === 1, { timeoutMs: 1000 });
	});
});

describe("outbox: at-least-once", () => {
	it("a lost response after Telegram accepted the message: sent again (duplicate), never lost", async () => {
		const store = openStore();
		fake.failNext("sendMessage", { drop: "after" });
		const id = enqueue(store, { text: "Task 9 accepted", taskId: 9 });
		const sender = start(store);
		await waitFor(() => row(store, id).state === "sent");
		await sender.idle();
		assert.deepEqual(
			fake.sent().map((m) => m.text),
			["Task 9 accepted", "Task 9 accepted"],
		);
		const sent = row(store, id);
		assert.equal(sent.telegram_message_id, fake.sent()[1]?.id);
		assert.equal(store.get<{ n: number }>("SELECT count(*) AS n FROM task_messages WHERE task_id = 9")?.n, 1);
	});

	it("a crash between send and mark: after restart the row is sent again", async () => {
		const store = openStore();
		const id = enqueue(store, { text: "Task 3 accepted", taskId: 3 });
		const inner = api();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		// Telegram accepts the message, then the process "dies" before recording it (the call never returns).
		const dying: TelegramApi = {
			getMe: (s) => inner.getMe(s),
			getUpdates: (o, t, s) => inner.getUpdates(o, t, s),
			sendMessage: async (params, signal) => {
				await inner.sendMessage(params, signal);
				await gate;
				throw new Error("process gone");
			},
		};
		const crashed = startOutbox({ store, api: dying, threadId: undefined, log: silentLogger, backoffMs: fast });
		await waitFor(() => fake.sent().length === 1);
		assert.equal(row(store, id).state, "pending");

		const restarted = openStore();
		const sender = start(restarted);
		await waitFor(() => row(restarted, id).state === "sent");
		await sender.idle();
		assert.deepEqual(
			fake.sent().map((m) => m.text),
			["Task 3 accepted", "Task 3 accepted"],
			"a duplicate is possible; the message is never lost",
		);
		release?.();
		await crashed.stop();
		assert.equal(row(restarted, id).state, "sent", "the dead sender's late failure does not undo the mark");
	});

	it("stop() during a hung send: the row stays pending and goes out on the next start", async () => {
		const store = openStore();
		fake.delays.set("sendMessage", 10_000);
		const id = enqueue(store, { text: "slow" });
		const first = startOutbox({ store, api: api(), threadId: undefined, log: silentLogger, backoffMs: fast });
		await waitFor(() => fake.count("sendMessage") === 1);
		const started = Date.now();
		await first.stop();
		assert.ok(Date.now() - started < 3000, `stop took ${Date.now() - started} ms`);
		assert.equal(row(store, id).state, "pending");
		assert.equal(row(store, id).attempts, 0, "an aborted send is not counted as a failure");
		fake.delays.delete("sendMessage");
		const second = start(store);
		await waitFor(() => row(store, id).state === "sent");
		await second.idle();
		assert.equal(fake.sent().length, 2, "the first send reached Telegram before the abort: duplicate");
	});

	it("idle() resolves when nothing is due, and after stop()", async () => {
		const store = openStore();
		const sender = start(store);
		await sender.idle();
		const id = enqueue(store, { text: "later" });
		store.run("UPDATE outbox SET next_attempt_at = ? WHERE id = ?", Date.now() + 60_000, id);
		await sender.idle();
		assert.equal(fake.sent().length, 0, "a row waiting for its retry is not due");
		await sender.stop();
		await sender.idle();
		await sleep(10);
	});
});
