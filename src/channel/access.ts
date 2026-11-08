import type { Update } from "grammy/types";

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
 * Only private messages, taps and stops from allow-listed, non-bot users in their own chat pass. The log fields carry
 * ids and the update kind, never text or captions.
 */
export function checkAccess(update: Update, allowed: ReadonlySet<number>): AccessDecision {
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
	if (chat?.type !== "private") return deny("not_private");
	if (from === undefined) return deny("no_sender");
	if (from.is_bot) return deny("bot_sender");
	if (from.id !== chat.id) return deny("sender_not_chat");
	if (!allowed.has(from.id)) return deny("not_allowed");
	return { allowed: true, chatId: chat.id, userId: from.id };
}
