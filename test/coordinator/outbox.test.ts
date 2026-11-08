import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fitTelegramText, OUTBOX_HOLD_KEY, startOutbox, TELEGRAM_TEXT_LIMIT } from "../../src/coordinator/outbox.ts";
import type { SendMessageParams, TelegramApi } from "../../src/coordinator/ports.ts";
import { type OutboxMessage, Store } from "../../src/coordinator/store.ts";
import { createTelegramApi } from "../../src/coordinator/telegram/api.ts";
import { MAX_TELEGRAM_PARTS, splitTelegramText } from "../../src/coordinator/telegram/split.ts";
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

	it("keeps a 429 hold across a restart: the saved retry_after is honoured by the next sender", async () => {
		const store = openStore();
		let clock = Date.now();
		const now = () => clock;
		fake.failNext("sendMessage", { status: 429, retryAfter: 30 });
		const a = enqueue(store, { text: "held" });
		const first = start(store, { now });
		await waitFor(() => store.getMeta(OUTBOX_HOLD_KEY), { what: "saved hold" });
		const holdUntil = Number(store.getMeta(OUTBOX_HOLD_KEY));
		assert.equal(holdUntil, clock + 30_000, "the hold's end is saved in the store");
		await first.stop();
		const attempts = fake.count("sendMessage");
		assert.equal(attempts, 1, "one refused attempt before the restart");

		// "Restart": a new sender on the same database, 10 s later, still inside Telegram's retry_after.
		clock += 10_000;
		const second = start(store, { now });
		for (let i = 0; i < 5; i++) {
			second.kick();
			await sleep(40);
		}
		assert.equal(fake.count("sendMessage"), attempts, "nothing is sent while the saved hold lasts");
		assert.equal(row(store, a).state, "pending");

		// Once the clock passes the saved hold, the row goes out.
		clock = holdUntil + 1;
		second.kick();
		await waitFor(() => row(store, a).state === "sent", { what: "sent after the hold" });
		assert.deepEqual(fake.textsIn(G), ["held"]);
		assert.equal(row(store, a).attempts, 1, "the 429 did not count as a failed attempt");
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

	it("splits texts above 4096 characters into ordered parts instead of cutting them", async () => {
		const store = openStore();
		const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(3, "0")} ${"x".repeat(20)}`);
		const long = lines.join("\n");
		assert.ok(long.length > 2 * TELEGRAM_TEXT_LIMIT, "needs three parts");
		const firstId = enqueue(store, { text: long, taskId: 7, replyTo: 42 });
		enqueue(store, { text: "after" });
		const sender = start(store);
		await sender.idle();
		const sent = fake.sent();
		assert.deepEqual(
			sent.map((m) => m.text.slice(0, 6)),
			["[1/3] ", "[2/3] ", "[3/3] ", "after"],
			"parts go out in order, before the next message",
		);
		for (const m of sent) assert.ok(m.text.length <= TELEGRAM_TEXT_LIMIT, `part of ${m.text.length} characters`);
		// Nothing is lost: the parts without their markers, joined at the line breaks they were split at, are the text.
		const rebuilt = sent
			.slice(0, 3)
			.map((m) => m.text.replace(/^\[\d+\/\d+\] /, ""))
			.join("\n");
		assert.equal(rebuilt, long);
		assert.ok(!sent.some((m) => m.text.includes("…")), "no ellipsis cut");
		// Only the first part replies to the user's message; every part belongs to the task (replies are follow-ups).
		assert.deepEqual(
			sent.map((m) => m.replyTo),
			[42, undefined, undefined, undefined],
		);
		const mapped = store.all<{ message_id: number }>(
			"SELECT message_id FROM task_messages WHERE task_id = 7 ORDER BY message_id",
		);
		assert.deepEqual(
			mapped.map((r) => r.message_id),
			sent.slice(0, 3).map((m) => m.id),
		);
		const rows = store.all<{ id: number; state: string }>("SELECT id, state FROM outbox ORDER BY id");
		assert.equal(rows[0]?.id, firstId, "enqueue returns the first part's id");
		assert.deepEqual(
			rows.map((r) => r.state),
			["sent", "sent", "sent", "sent"],
		);
	});

	it("splitTelegramText: line, then word, then hard breaks; never a split surrogate pair; bounded parts", () => {
		assert.deepEqual(splitTelegramText("short"), ["short"]);
		assert.deepEqual(splitTelegramText("y".repeat(4096)), ["y".repeat(4096)], "exactly the limit stays whole");
		// Words without line breaks break at a space.
		const words = Array.from({ length: 1500 }, (_, i) => `w${i}`).join(" ");
		const wordParts = splitTelegramText(words);
		assert.ok(wordParts.length >= 2);
		assert.equal(wordParts.map((p) => p.replace(/^\[\d+\/\d+\] /, "")).join(" "), words);
		// No spaces at all: a hard cut that never separates a surrogate pair.
		const emoji = "😀".repeat(5000);
		const emojiParts = splitTelegramText(emoji);
		for (const part of emojiParts) {
			assert.ok(part.length <= TELEGRAM_TEXT_LIMIT);
			assert.ok(!/[\ud800-\udbff]$/.test(part) && !/^\[\d+\/\d+\] [\udc00-\udfff]/.test(part));
		}
		assert.equal(emojiParts.map((p) => p.replace(/^\[\d+\/\d+\] /, "")).join(""), emoji);
		// A runaway text is bounded: at most MAX_TELEGRAM_PARTS parts, the last says what was left out.
		const huge = "z".repeat(TELEGRAM_TEXT_LIMIT * (MAX_TELEGRAM_PARTS + 5));
		const bounded = splitTelegramText(huge);
		assert.equal(bounded.length, MAX_TELEGRAM_PARTS);
		assert.match(bounded.at(-1) ?? "", /… \[\d+ more characters not sent\]$/);
		for (const part of bounded) assert.ok(part.length <= TELEGRAM_TEXT_LIMIT);
		// The send-time guard still cuts a row that was written without enqueue (never splits a surrogate pair).
		assert.equal(fitTelegramText("short"), "short");
		const cut = fitTelegramText(`${"a".repeat(4094)}😀😀`);
		assert.ok(cut.length <= TELEGRAM_TEXT_LIMIT && !/[\ud800-\udbff]…$/.test(cut));
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
