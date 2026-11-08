import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import type { CallbackQuery } from "grammy/types";
import { contextLine, markChosen } from "../format/rich.ts";
import { telegramErrorSummary } from "../telegram/errors.ts";
import { Buttons, rememberButtons } from "./docs.ts";
import { admit } from "./intake.ts";
import type { ChannelRuntime } from "./scope.ts";

const CONTEXT_CHARS = 1500;

type Tap = { chatId: number; messageId: number; sent: string; data: string };

/**
 * A tap on an answer's button is the user's next message: the button's data and a line naming the message it was
 * under. It is admitted once per callback query, so a redelivered tap is a duplicate; then the message shows the
 * choice. Buttons of any old message work; without the sent Markdown the choice is just not marked.
 */
export async function handleTap(rt: ChannelRuntime, query: CallbackQuery): Promise<void> {
	await rt.port.answerCallbackQuery(query.id).catch((error: unknown) => {
		rt.log.debug("callback_answer_failed", telegramErrorSummary(error));
	});
	const message = query.message;
	if (query.data === undefined || message === undefined) return;
	const chatId = message.chat.id;
	const messageId = message.message_id;
	const conversation = await rt.directory.get(chatId, BG);
	const sent = (await rt.harness.snapshot(Buttons, conversation.id, BG))?.messages[String(messageId)];
	const context = contextLine(sent ?? ("text" in message ? (message.text ?? "") : ""), CONTEXT_CHARS);
	const content = context === "" ? query.data : `${query.data}\n\n(button under your message: «${context}»)`;
	const input = { chatId, messageId, requestId: `tg:${chatId}:cq:${query.id}`, content };
	const result = await admit(conversation, rt.deliver, input, BG);
	rt.log.info(result === "admitted" ? "tap_admitted" : "update_duplicate", { chat: chatId, message: messageId });
	if (result === "admitted" && sent !== undefined)
		rt.track(markChoice(rt, conversation, { chatId, messageId, sent, data: query.data }));
}

/** Mark the tapped button and disable the other choices of its row; failures are logged, never thrown. */
async function markChoice(rt: ChannelRuntime, conversation: Conversation, tap: Tap): Promise<void> {
	const marked = markChosen(tap.sent, tap.data);
	if (marked === undefined) return;
	try {
		await rt.port.editMessageText(tap.chatId, tap.messageId, marked, { rich: true });
		await conversation.commit(
			async (tx) => rememberButtons(await tx.doc(Buttons, conversation.id), tap.messageId, marked),
			BG,
		);
	} catch (error) {
		rt.log.warn("tap_mark_failed", { chat: tap.chatId, ...telegramErrorSummary(error) });
	}
}
