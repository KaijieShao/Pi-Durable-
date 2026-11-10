import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Update } from "grammy/types";
import { type ParsedUpdate, parseUpdate } from "../../src/coordinator/telegram/parse.ts";
import { type GroupMessageOptions, groupUpdate } from "../fixtures/fake-bot-api.ts";
import "../helpers/env.ts";

const G = -100_123;
const USER = 1001;
const GENERAL = { groupChatId: G, topicId: 1, botUsername: "test_bot" };
const TOPIC = { groupChatId: G, topicId: 5, botUsername: "test_bot" };

const FIXED_REASONS = new Set([
	"not_a_message",
	"edited_message",
	"other_chat",
	"no_message_id",
	"no_sender",
	"bot_sender",
	"sender_chat",
	"forwarded",
	"wrong_topic",
	"no_text",
	"other_bot",
	"unknown_command",
	"not_command",
]);

function msg(options: Partial<GroupMessageOptions> = {}): Update {
	return groupUpdate({ chatId: G, fromId: USER, ...options });
}

function ignored(result: ParsedUpdate): string {
	assert.equal(result.kind, "ignored", `expected ignored, got ${JSON.stringify(result)}`);
	assert.ok(FIXED_REASONS.has(result.reason), `reason ${result.reason} is not a fixed string`);
	return result.reason;
}

function command(result: ParsedUpdate) {
	assert.equal(result.kind, "command", `expected a command, got ${JSON.stringify(result)}`);
	return result;
}

describe("parseUpdate: commands and bot address", () => {
	it("parses a plain /task (privacy mode off, or the bot was addressed implicitly) with ids", () => {
		const update = msg({ text: "/task alpha add a signup form", messageId: 77, updateId: 9001 });
		const result = command(parseUpdate(update, GENERAL));
		assert.deepEqual(result, {
			kind: "command",
			name: "task",
			args: "alpha add a signup form",
			addressed: false,
			chatId: G,
			userId: USER,
			messageId: 77,
			updateId: 9001,
		});
	});

	it("accepts /task@bot (what privacy mode always delivers), case-insensitively", () => {
		for (const text of ["/task@test_bot alpha x", "/task@Test_Bot alpha x", "/TASK@TEST_BOT alpha x"]) {
			const result = command(parseUpdate(msg({ text }), GENERAL));
			assert.equal(result.name, "task");
			assert.equal(result.args, "alpha x");
			assert.equal(result.addressed, true);
		}
	});

	it("ignores a command addressed to another bot", () => {
		assert.equal(ignored(parseUpdate(msg({ text: "/task@otherbot alpha x" }), GENERAL)), "other_bot");
		assert.equal(ignored(parseUpdate(msg({ text: "/status@test_bot_2" }), GENERAL)), "other_bot");
	});

	it("accepts a standalone task bot mention without making it part of the request", () => {
		for (const text of [
			"/task @test_bot please use cooler colors\nand preserve the schedule",
			"/task @TEST_BOT please use cooler colors\nand preserve the schedule",
			"/task@test_bot @test_bot please use cooler colors\nand preserve the schedule",
		]) {
			const result = command(parseUpdate(msg({ text }), GENERAL));
			assert.equal(result.name, "task");
			assert.equal(result.args, "please use cooler colors\nand preserve the schedule");
			assert.equal(result.addressed, true);
		}
		assert.equal(command(parseUpdate(msg({ text: "/task @test_bot beta fix it" }), GENERAL)).args, "beta fix it");
		assert.equal(command(parseUpdate(msg({ text: "/task @test_bot" }), GENERAL)).args, "");
	});

	it("does not take tasks addressed by a standalone mention to another bot", () => {
		for (const text of ["/task @other_bot please fix it", "/task@test_bot @other_bot alpha fix it"]) {
			assert.equal(ignored(parseUpdate(msg({ text }), GENERAL)), "other_bot");
		}
		// Task shorthand must not loosen the numeric-id grammar of approvals or cancellation.
		assert.equal(command(parseUpdate(msg({ text: "/approve @test_bot 2" }), GENERAL)).args, "@test_bot 2");
	});

	it("knows exactly the five commands; others are ignored", () => {
		for (const name of ["task", "status", "cancel", "approve", "help"] as const) {
			assert.equal(command(parseUpdate(msg({ text: `/${name}` }), GENERAL)).name, name);
		}
		for (const text of ["/start", "/tasks alpha x", "/stop 3", "/new"]) {
			assert.equal(ignored(parseUpdate(msg({ text }), GENERAL)), "unknown_command");
		}
	});

	it("keeps the arguments (trimmed, inner newlines kept)", () => {
		assert.equal(command(parseUpdate(msg({ text: "/cancel 12" }), GENERAL)).args, "12");
		assert.equal(command(parseUpdate(msg({ text: "/approve@test_bot   12  " }), GENERAL)).args, "12");
		assert.equal(command(parseUpdate(msg({ text: "/status" }), GENERAL)).args, "");
		assert.equal(
			command(parseUpdate(msg({ text: "/task\nalpha first line\nsecond line\n" }), GENERAL)).args,
			"alpha first line\nsecond line",
		);
	});

	it("a command token must end at whitespace", () => {
		assert.equal(ignored(parseUpdate(msg({ text: "/task:alpha x" }), GENERAL)), "not_command");
		assert.equal(ignored(parseUpdate(msg({ text: "/task@test_bot,alpha" }), GENERAL)), "not_command");
	});

	it("a command sent as a reply is still a command (message type decides, not the reply)", () => {
		const result = command(parseUpdate(msg({ text: "/cancel 3", replyTo: 500 }), GENERAL));
		assert.equal(result.name, "cancel");
		assert.equal(result.args, "3");
	});
});

describe("parseUpdate: replies (follow-up candidates)", () => {
	it("a non-command reply is a reply with the replied-to message id and the text unchanged", () => {
		const result = parseUpdate(msg({ text: "  also add tests  ", replyTo: 500, messageId: 81, updateId: 7 }), GENERAL);
		assert.deepEqual(result, {
			kind: "reply",
			replyToMessageId: 500,
			text: "  also add tests  ",
			chatId: G,
			userId: USER,
			messageId: 81,
			updateId: 7,
		});
	});

	it("a reply to someone else's message is still handed over (the handler checks task_messages)", () => {
		const result = parseUpdate(msg({ text: "agree", replyTo: { messageId: 40, fromBot: false } }), GENERAL);
		assert.equal(result.kind, "reply");
	});

	it("plain text that is neither a command nor a reply is ignored, mentions included", () => {
		assert.equal(ignored(parseUpdate(msg({ text: "please fix the bug" }), GENERAL)), "not_command");
		assert.equal(ignored(parseUpdate(msg({ text: "@test_bot fix the bug" }), GENERAL)), "not_command");
		assert.equal(ignored(parseUpdate(msg({ text: "task alpha do it" }), GENERAL)), "not_command");
	});

	it("a reply without text (photo, sticker) is ignored", () => {
		const update = msg({
			replyTo: 500,
			extra: { photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1 }] },
		});
		assert.equal(ignored(parseUpdate(update, GENERAL)), "no_text");
		const captioned = msg({ extra: { caption: "/task alpha x", photo: [] } });
		assert.equal(ignored(parseUpdate(captioned, GENERAL)), "no_text");
	});
});

describe("parseUpdate: who and where", () => {
	it("ignores other chats, including a private chat", () => {
		assert.equal(
			ignored(parseUpdate(groupUpdate({ chatId: -999, fromId: USER, text: "/status" }), GENERAL)),
			"other_chat",
		);
		const privateChat = {
			update_id: 1,
			message: {
				message_id: 1,
				date: 1,
				chat: { id: G, type: "private", first_name: "x" },
				from: { id: USER, is_bot: false, first_name: "x" },
				text: "/status",
			},
		} as unknown as Update;
		assert.equal(ignored(parseUpdate(privateChat, GENERAL)), "other_chat");
	});

	it("accepts both basic groups and supergroups", () => {
		assert.equal(parseUpdate(msg({ text: "/help", chatType: "group" }), GENERAL).kind, "command");
		assert.equal(parseUpdate(msg({ text: "/help", chatType: "supergroup" }), GENERAL).kind, "command");
	});

	it("ignores bots, missing senders and messages sent on behalf of a chat", () => {
		assert.equal(ignored(parseUpdate(msg({ text: "/task alpha x", isBot: true }), GENERAL)), "bot_sender");
		assert.equal(ignored(parseUpdate(msg({ text: "fix", replyTo: 500, isBot: true }), GENERAL)), "bot_sender");
		const noSender = msg({ text: "/status" }) as unknown as { message: Record<string, unknown> };
		delete noSender.message.from;
		assert.equal(ignored(parseUpdate(noSender as unknown as Update, GENERAL)), "no_sender");
		const anonymous = msg({ text: "/task alpha x", extra: { sender_chat: { id: G, type: "supergroup", title: "g" } } });
		assert.equal(ignored(parseUpdate(anonymous, GENERAL)), "sender_chat");
		const automatic = msg({ text: "/task alpha x", extra: { is_automatic_forward: true } });
		assert.equal(ignored(parseUpdate(automatic, GENERAL)), "sender_chat");
	});

	it("ignores forwarded messages (someone else's words)", () => {
		const forwarded = msg({
			text: "/task alpha x",
			extra: { forward_origin: { type: "hidden_user", sender_user_name: "x", date: 1 } },
		});
		assert.equal(ignored(parseUpdate(forwarded, GENERAL)), "forwarded");
	});

	it("ignores edited messages, even of a command", () => {
		assert.equal(ignored(parseUpdate(msg({ text: "/task alpha x", edited: true }), GENERAL)), "edited_message");
		assert.equal(ignored(parseUpdate(msg({ text: "more", replyTo: 500, edited: true }), GENERAL)), "edited_message");
	});

	it("ignores updates that are not messages, and ephemeral messages (id 0)", () => {
		const callback = { update_id: 3, callback_query: { id: "q", from: { id: USER }, data: "x" } } as unknown as Update;
		assert.equal(ignored(parseUpdate(callback, GENERAL)), "not_a_message");
		assert.equal(ignored(parseUpdate(msg({ text: "/status", messageId: 0 }), GENERAL)), "no_message_id");
	});
});

describe("parseUpdate: topics", () => {
	it("with General configured, messages in a forum topic are ignored", () => {
		assert.equal(ignored(parseUpdate(msg({ text: "/task alpha x", threadId: 5 }), GENERAL)), "wrong_topic");
		assert.equal(ignored(parseUpdate(msg({ text: "fix", threadId: 5, replyTo: 500 }), GENERAL)), "wrong_topic");
	});

	it("with General configured, a reply carrying a non-topic thread id is still General", () => {
		const update = msg({ text: "fix", replyTo: 500, extra: { message_thread_id: 480 } });
		assert.equal(parseUpdate(update, GENERAL).kind, "reply");
	});

	it("with a topic configured, only messages in that topic count", () => {
		assert.equal(parseUpdate(msg({ text: "/task@test_bot alpha x", threadId: 5 }), TOPIC).kind, "command");
		assert.equal(ignored(parseUpdate(msg({ text: "/task alpha x" }), TOPIC)), "wrong_topic");
		assert.equal(ignored(parseUpdate(msg({ text: "/task alpha x", threadId: 6 }), TOPIC)), "wrong_topic");
		// is_topic_message missing: not a topic message even if a thread id is present.
		const notTopic = msg({ text: "/status", extra: { message_thread_id: 5 } });
		assert.equal(ignored(parseUpdate(notTopic, TOPIC)), "wrong_topic");
	});

	it("in a topic, the implicit reply to the topic's creation message is not a reply", () => {
		const plain = msg({ text: "hello everyone", threadId: 5 });
		assert.equal(ignored(parseUpdate(plain, TOPIC)), "not_command");
		const reply = parseUpdate(msg({ text: "also do X", threadId: 5, replyTo: 612 }), TOPIC);
		assert.equal(reply.kind, "reply");
		assert.equal(reply.kind === "reply" ? reply.replyToMessageId : 0, 612);
	});
});

describe("parseUpdate: ignored reasons never carry message text", () => {
	it("every ignored result is one of the fixed reasons", () => {
		const secret = "SECRET-TEXT-42";
		const cases: Update[] = [
			msg({ text: `${secret}` }),
			msg({ text: `/task@otherbot ${secret}` }),
			msg({ text: `/unknown ${secret}` }),
			msg({ text: `/task ${secret}`, isBot: true }),
			msg({ text: `/task ${secret}`, edited: true }),
			msg({ text: `/task ${secret}`, threadId: 9 }),
			groupUpdate({ chatId: -5, fromId: USER, text: secret }),
		];
		for (const update of cases) {
			const result = parseUpdate(update, GENERAL);
			const reason = ignored(result);
			assert.ok(!JSON.stringify(result).includes(secret), reason);
		}
	});
});
