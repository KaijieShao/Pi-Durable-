import type { Message, Update } from "grammy/types";

/**
 * Routing of one Telegram update (Requirements § Follow-ups: "the type of Telegram message, not its wording, decides
 * whether it is a new task or a follow-up"). Pure: no store, no I/O.
 *
 * - Only new messages (never edits) in the configured group and topic, from a human sender, with text.
 * - A command is a message whose text starts with `/name` or `/name@bot`; `@otherbot` is someone else's command.
 * - A non-command message that explicitly replies to a message is a `reply`; the command handler decides whether
 *   that message belongs to a task (task_messages).
 * - Everything else is ignored. Ignored reasons are fixed strings, never message text, so they can be logged.
 *
 * Privacy mode: a plain `/task` may not reach the bot at all; `/task@bot` and replies to the bot always do.
 */
export type CommandName = "task" | "status" | "cancel" | "approve" | "help";

export const COMMAND_NAMES: readonly CommandName[] = ["task", "status", "cancel", "approve", "help"];

export type IgnoredReason =
	| "not_a_message"
	| "edited_message"
	| "other_chat"
	| "no_message_id"
	| "no_sender"
	| "bot_sender"
	| "sender_chat"
	| "forwarded"
	| "wrong_topic"
	| "no_text"
	| "other_bot"
	| "unknown_command"
	| "not_command";

export type ParsedUpdate =
	| { kind: "ignored"; reason: string }
	| {
			kind: "command";
			name: CommandName;
			/** Text after the command token, trimmed. */
			args: string;
			chatId: number;
			userId: number;
			messageId: number;
			updateId: number;
			/** True when the command named this bot explicitly (`/task@bot` or `/task @bot`). */
			addressed: boolean;
	  }
	| {
			kind: "reply";
			replyToMessageId: number;
			/** The reply's text, unchanged. */
			text: string;
			chatId: number;
			userId: number;
			messageId: number;
			updateId: number;
	  };

export type ParseOptions = {
	readonly groupChatId: number;
	/** Forum topic id; 1 = General or a group without topics. */
	readonly topicId: number;
	/** Bot username without "@". */
	readonly botUsername: string;
};

const COMMAND = /^\/([A-Za-z0-9_]{1,64})(?:@([A-Za-z0-9_]{1,64}))?(?=\s|$)/;

export function parseUpdate(update: Update, options: ParseOptions): ParsedUpdate {
	const message = update.message;
	if (message === undefined) return ignored(update.edited_message !== undefined ? "edited_message" : "not_a_message");
	const denial = placeDenial(message, options) ?? senderDenial(message);
	if (denial !== undefined) return ignored(denial);
	const text = message.text;
	if (text === undefined || message.from === undefined) return ignored("no_text");

	const base = {
		chatId: message.chat.id,
		userId: message.from.id,
		messageId: message.message_id,
		updateId: update.update_id,
	};
	const command = COMMAND.exec(text);
	if (command !== null) return commandOf(command, text, base, options);

	// Whether the replied-to message belongs to a task is the command handler's call (task_messages holds only the
	// bot's own message ids, and message ids are unique within a chat, so a reply to anyone else never matches).
	const reply = explicitReply(message);
	if (reply === undefined) return ignored("not_command");
	return { kind: "reply", replyToMessageId: reply.message_id, text, ...base };
}

function ignored(reason: IgnoredReason): ParsedUpdate {
	return { kind: "ignored", reason };
}

/** The configured group and topic only; a real (non-ephemeral) message id. */
function placeDenial(message: Message, options: ParseOptions): IgnoredReason | undefined {
	if (message.chat.id !== options.groupChatId) return "other_chat";
	if (message.chat.type !== "group" && message.chat.type !== "supergroup") return "other_chat";
	// Ephemeral / scheduled messages carry id 0: there is nothing to reply to or to deduplicate on.
	if (!Number.isSafeInteger(message.message_id) || message.message_id <= 0) return "no_message_id";
	if (topicOf(message) !== options.topicId) return "wrong_topic";
	return undefined;
}

/** A person typed it: a sender that is not a bot, not a chat, not a forward. */
function senderDenial(message: Message): IgnoredReason | undefined {
	if (message.from === undefined) return "no_sender";
	if (message.from.is_bot) return "bot_sender";
	// Sent on behalf of a chat (anonymous admin, linked channel): `from` is a placeholder, not a person.
	if (message.sender_chat !== undefined || message.is_automatic_forward === true) return "sender_chat";
	// A forwarded "/task" is someone else's words, not a command typed by this sender.
	if (message.forward_origin !== undefined) return "forwarded";
	return undefined;
}

function commandOf(
	command: RegExpExecArray,
	text: string,
	base: { chatId: number; userId: number; messageId: number; updateId: number },
	options: ParseOptions,
): ParsedUpdate {
	const target = command[2];
	if (target !== undefined && target.toLowerCase() !== options.botUsername.toLowerCase()) return ignored("other_bot");
	const name = command[1]?.toLowerCase() as CommandName;
	if (!COMMAND_NAMES.includes(name)) return ignored("unknown_command");
	let args = text.slice(command[0].length).trim();
	// Telegram also delivers the common `/task @bot <request>` spelling. This is a bot address,
	// never an agent id or part of the coding request. Leave every other command's grammar unchanged.
	const mention = name === "task" ? /^@([A-Za-z0-9_]{1,64})(?=\s|$)/.exec(args) : null;
	if (mention !== null && mention[1]?.toLowerCase() !== options.botUsername.toLowerCase()) return ignored("other_bot");
	if (mention !== null) args = args.slice(mention[0].length).trim();
	return {
		kind: "command",
		name,
		args,
		addressed: target !== undefined || mention !== null,
		...base,
	};
}

/** General (and a group without topics) is 1; a forum topic message carries its thread id. */
function topicOf(message: Message): number {
	// General is not a topic message; replies there can carry a non-topic thread id.
	return message.is_topic_message === true && message.message_thread_id !== undefined ? message.message_thread_id : 1;
}

/**
 * The message this one replies to, if the user chose to reply. In a forum topic every message carries the topic's
 * creation message as `reply_to_message`; that is not a reply.
 */
function explicitReply(message: Message): NonNullable<Message["reply_to_message"]> | undefined {
	const reply = message.reply_to_message;
	if (reply === undefined) return undefined;
	if ("forum_topic_created" in reply && reply.forum_topic_created !== undefined) return undefined;
	if (message.is_topic_message === true && reply.message_id === message.message_thread_id) return undefined;
	if (!Number.isSafeInteger(reply.message_id) || reply.message_id <= 0) return undefined;
	return reply;
}
