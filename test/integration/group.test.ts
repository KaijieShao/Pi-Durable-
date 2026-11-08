import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { Api } from "grammy";
import type { Message, Update } from "grammy/types";
import { checkAccess } from "../../src/channel/access.ts";
import { createTelegramChannel } from "../../src/channel/create.ts";
import { ConfigError, parseConfig } from "../../src/config/schema.ts";
import { createGrammyPort } from "../../src/telegram/grammy-port.ts";
import { FakeBotApi } from "../fixtures/fake-bot-api.ts";
import { CHAT, newFaux, startTestAgent, TOKEN, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastUserText, observe } from "../helpers/faux-steps.ts";
import { textUpdate } from "../helpers/updates.ts";

const GROUP = -1001234567890;
const group = { chatId: GROUP, topicId: 1, botUsername: "test_bot" };
const allowed = new Set([CHAT]);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function groupUpdate(text: string, extra: Partial<Message> = {}): Update {
	const update = textUpdate(GROUP, 10, text, { fromId: CHAT, chatType: "group" });
	return {
		...update,
		message: {
			...update.message,
			chat: { id: GROUP, type: "supergroup", title: "Smule test", is_forum: true },
			...extra,
		},
	} as Update;
}

test("group admission requires the exact group, topic, sender and bot address", () => {
	assert.deepEqual(checkAccess(groupUpdate("/task@test_bot hello"), allowed, group), {
		allowed: true,
		chatId: GROUP,
		userId: CHAT,
	});
	const denied: [Update, string][] = [
		[groupUpdate("ordinary private group chatter"), "not_addressed"],
		[groupUpdate("/task@other_bot secret"), "not_addressed"],
		[groupUpdate("/task@test_bot_extra secret"), "not_addressed"],
		[groupUpdate("/task@test_bot secret", { is_topic_message: true, message_thread_id: 42 }), "wrong_topic"],
		[groupUpdate("/task@test_bot secret", { from: { id: 222, is_bot: false, first_name: "stranger" } }), "not_allowed"],
		[groupUpdate("/task@test_bot secret", { from: { id: CHAT, is_bot: true, first_name: "bot" } }), "bot_sender"],
		[textUpdate(-200, 1, "/task@test_bot secret", { fromId: CHAT, chatType: "group" }), "not_private"],
	];
	for (const [update, reason] of denied) {
		const decision = checkAccess(update, allowed, group);
		assert.ok(!decision.allowed);
		assert.equal(decision.reason, reason);
		assert.ok(!JSON.stringify(decision.fields).includes("secret"));
	}
	assert.ok(checkAccess(groupUpdate("hi @TEST_BOT"), allowed, group).allowed);
	const replied = groupUpdate("follow-up", {
		reply_to_message: {
			reply_to_message: undefined,
			message_id: 9,
			date: 1,
			chat: { id: GROUP, type: "supergroup", title: "group" },
			from: { id: 42, is_bot: true, first_name: "bot", username: "test_bot" },
		},
	});
	assert.ok(checkAccess(replied, allowed, group).allowed);
	assert.ok(checkAccess(textUpdate(CHAT, 1, "private"), allowed, group).allowed);
});

test("group config is opt-in and malformed or incomplete routing fails closed", () => {
	const base = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER_IDS: String(CHAT) };
	assert.equal(parseConfig(base).telegramGroup, undefined);
	assert.deepEqual(
		parseConfig({ ...base, TELEGRAM_GROUP_CHAT_ID: String(GROUP), TELEGRAM_BOT_USERNAME: "@test_bot" }).telegramGroup,
		group,
	);
	for (const extra of [
		{ TELEGRAM_GROUP_CHAT_ID: String(GROUP) },
		{ TELEGRAM_GROUP_CHAT_ID: "111", TELEGRAM_BOT_USERNAME: "test_bot" },
		{ TELEGRAM_GROUP_CHAT_ID: String(GROUP), TELEGRAM_GROUP_TOPIC_ID: "0", TELEGRAM_BOT_USERNAME: "test_bot" },
		{ TELEGRAM_GROUP_TOPIC_ID: "1", TELEGRAM_BOT_USERNAME: "test_bot" },
	])
		assert.throws(() => parseConfig({ ...base, ...extra }), ConfigError);
});

test("a mismatched group bot token fails before commands or stored work can be sent", async () => {
	const api = new FakeBotApi();
	const apiRoot = await api.start();
	cleanups.push(() => api.stop());
	const channel = createTelegramChannel({
		botToken: TOKEN,
		allowedUserIds: [CHAT],
		group: { ...group, botUsername: "wrong_bot" },
		apiRoot,
		workdir: process.cwd(),
		model: { provider: "faux", modelId: "faux-1" },
		thinkingLevel: "off",
	});
	await assert.rejects(channel.start({} as Harness, BG), /does not match/);
	assert.equal(api.count("getMe"), 1);
	assert.equal(api.count("setMyCommands"), 0);
	assert.equal(api.count("getUpdates"), 0);
});

test("/task in the approved group reaches the real harness and answers in that group, not a private chat", async () => {
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const faux = newFaux();
	let seen = "";
	faux.setResponses([
		observe((messages) => {
			seen = lastUserText(messages);
		}, fauxAssistantMessage("SMULE_GROUP_OK")),
	]);
	const port = new FakeTelegram();
	const t = await startTestAgent({
		dir,
		faux,
		port,
		config: {
			TELEGRAM_GROUP_CHAT_ID: String(GROUP),
			TELEGRAM_GROUP_TOPIC_ID: "1",
			TELEGRAM_BOT_USERNAME: "test_bot",
			TELEGRAM_RICH: "auto",
		},
	});
	cleanups.push(() => t.close());
	await t.agent.channel.handleUpdate(groupUpdate("/task@test_bot Please verify the group connection"));
	await waitFor(() => port.textsIn(GROUP).includes("SMULE_GROUP_OK"));
	assert.equal(seen, "Please verify the group connection");
	assert.equal(port.textsIn(CHAT).length, 0);
	assert.equal(port.drafts.length, 0);
	assert.ok(port.created(GROUP).some((message) => message.replyTo === 10));
	assert.equal(faux.state.callCount, 1);
	assert.deepEqual(t.fatal, []);
});

test("the real Telegram transport keeps custom topics for replies, typing and files; General is the default", async () => {
	const api = new FakeBotApi();
	const apiRoot = await api.start();
	cleanups.push(() => api.stop());
	const client = new Api(TOKEN, { apiRoot });
	const files: { method: string; body: Record<string, unknown> }[] = [];
	client.config.use(async (prev, method, payload, signal) => {
		if (method !== "sendDocument" && method !== "sendPhoto") return prev(method, payload, signal);
		files.push({ method, body: payload });
		return {
			ok: true,
			result: { message_id: 500, date: 1, chat: { id: GROUP, type: "supergroup", title: "group" } },
		} as never;
	});
	const port = createGrammyPort({ token: TOKEN, apiRoot, api: client, group: { chatId: GROUP, topicId: 42 } });
	await port.sendMessage(GROUP, "topic reply", { replyTo: 10 });
	await port.sendChatAction(GROUP, "typing");
	await port.sendDocument(GROUP, new URL("../../package.json", import.meta.url).pathname, "file");
	await port.sendPhoto(GROUP, new URL("../../assets/social-preview.jpg", import.meta.url).pathname, undefined);
	for (const method of ["sendMessage", "sendChatAction"]) {
		assert.equal(Number(api.calls.find((call) => call.method === method)?.body.message_thread_id), 42);
	}
	for (const method of ["sendDocument", "sendPhoto"])
		assert.equal(files.find((call) => call.method === method)?.body.message_thread_id, 42);
	const general = createGrammyPort({ token: TOKEN, apiRoot, group });
	await general.sendMessage(GROUP, "general", {});
	await general.sendMessage(CHAT, "private", {});
	const sends = api.calls.filter((call) => call.method === "sendMessage");
	assert.equal(sends.at(-2)?.body.message_thread_id, undefined);
	assert.equal(sends.at(-1)?.body.message_thread_id, undefined);
});
