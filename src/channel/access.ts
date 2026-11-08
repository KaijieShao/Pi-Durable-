import type { Message, Update } from "grammy/types";
import type { TelegramGroup } from "../config/schema.ts";

export type AccessDecision =
	| { readonly allowed: true; readonly chatId: number; readonly userId: number }
	| { readonly allowed: false; readonly reason: string; readonly fields: Readonly<Record<string, unknown>> };

/** The kind of an update, for logs: its first payload field. */
export function updateKind(update: Update): string {
	return Object.keys(update).find((key) => key !== "update_id") ?? "unknown";
}

type Parties = { chat: { id: number; type: string } | undefined; from: { id: number; is_bot: boolean } | undefined };

/** Chat and sender of the kinds the channel handles: messages, button taps and draft stops. */
function partiesOf(update: Update): Parties | undefined {
	if (update.message !== undefined) return { chat: update.message.chat, from: update.message.from };
	const query = update.callback_query;
	if (query !== undefined) return { chat: query.message?.chat, from: query.from };
	const stopped = update.stopped_message_generation;
	// A stop names no sender; it comes from a private chat, whose id is the user's id.
	if (stopped !== undefined) return { chat: stopped.chat, from: { id: stopped.chat.id, is_bot: false } };
	return undefined;
}

/**
 * Private chats stay sender-bound. An opt-in group must match the configured topic and bot address as well as the
 * sender allowlist. The log fields carry ids and the update kind, never text or captions.
 */
export function checkAccess(update: Update, allowed: ReadonlySet<number>, group?: TelegramGroup): AccessDecision {
	const parties = partiesOf(update);
	const chat = parties?.chat;
	const from = parties?.from;
	const fields = {
		update_id: update.update_id,
		kind: updateKind(update),
		from: from?.id,
		chat: chat?.id,
		chat_type: chat?.type,
	};
	const deny = (reason: string): AccessDecision => ({ allowed: false, reason, fields: { ...fields, reason } });
	if (parties === undefined) return deny("not_a_message");
	if (chat === undefined) return deny("not_private");
	if (!chatAllowed(chat, group)) return deny("not_private");
	if (from === undefined) return deny("no_sender");
	if (from.is_bot) return deny("bot_sender");
	if (chat.type === "private" && from.id !== chat.id) return deny("sender_not_chat");
	if (!allowed.has(from.id)) return deny("not_allowed");
	const groupReason = groupDenial(update, group);
	if (groupReason !== undefined) return deny(groupReason);
	return { allowed: true, chatId: chat.id, userId: from.id };
}

function chatAllowed(chat: { id: number; type: string }, group: TelegramGroup | undefined): boolean {
	if (chat.type === "private") return true;
	return (chat.type === "group" || chat.type === "supergroup") && group?.chatId === chat.id;
}

function groupDenial(update: Update, group: TelegramGroup | undefined): string | undefined {
	const message = update.message ?? update.callback_query?.message;
	if (group === undefined || message?.chat.id !== group.chatId) return undefined;
	// General is not a topic message; replies there can carry a non-topic thread id.
	const topicId = "is_topic_message" in message && message.is_topic_message ? message.message_thread_id : 1;
	if (topicId !== group.topicId) return "wrong_topic";
	if (update.message !== undefined && !addressesBot(update.message, group.botUsername)) return "not_addressed";
	return undefined;
}

function addressesBot(message: Message, username: string): boolean {
	const name = username.toLowerCase();
	const text = message.text ?? message.caption ?? "";
	const command = /^\/[A-Za-z0-9_]+(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(text);
	if (command?.[1] !== undefined) return command[1].toLowerCase() === name;
	if (message.reply_to_message?.from?.is_bot && message.reply_to_message.from.username?.toLowerCase() === name)
		return true;
	return [...text.matchAll(/@([A-Za-z0-9_]+)/g)].some((match) => match[1]?.toLowerCase() === name);
}
