import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { truncate } from "../../format/escape.ts";
import { recordKey } from "../intake.ts";
import { type MessageScope, reply } from "../scope.ts";

export const NEW_REPLY = "New context. Old history is kept.";

const SHOWN = 5;
const START_LENGTH = 40;

/** What /new is about to drop: whether a request is running, and the start of each queued message. */
export type Dropped = { running: boolean; queued: string[] };

/**
 * /new: abort the current work and queued inputs, then reset the same conversation; the old transcript stays in
 * storage. Delivery tasks are background work, so they survive and report `aborted`, which says nothing in the chat:
 * the reply names what was dropped instead, so no message disappears unnoticed.
 */
export async function runNew(scope: MessageScope): Promise<void> {
	if (!(await recordKey(scope.conversation, scope.key, BG, scope.updateId))) return;
	const dropped = await pending(scope);
	await scope.conversation.abort(BG);
	await scope.conversation.reset(undefined, BG);
	await reply(scope, newReply(dropped));
}

async function pending(scope: MessageScope): Promise<Dropped> {
	const { harness } = scope.rt;
	const id = scope.conversation.id;
	const live = await harness.snapshot(LiveDoc, id, BG);
	const inbox = await harness.snapshot(InboxDoc, id, BG);
	const queued = (inbox?.items ?? []).flatMap((item) => (item.mode === "write" ? [] : [startOf(item.content)]));
	return { running: live?.run !== undefined, queued };
}

/** The first words of a queued input; an input without text is named by what it is. */
export function startOf(content: unknown): string {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content.flatMap((part) => (part?.type === "text" ? [String(part.text)] : [])).join(" ")
				: "";
	const flat = text.replace(/\s+/g, " ").trim();
	return flat === "" ? "[attachment]" : truncate(flat, START_LENGTH);
}

export function newReply(dropped: Dropped): string {
	const lines = [NEW_REPLY];
	if (dropped.running) lines.push("The request in progress was stopped.");
	const count = dropped.queued.length;
	if (count > 0) {
		const shown = dropped.queued.slice(0, SHOWN).map((start) => `«${start}»`);
		const more = count > SHOWN ? ` and ${count - SHOWN} more` : "";
		lines.push(`Dropped without an answer (${count}): ${shown.join(", ")}${more}. Send again what still matters.`);
	}
	return lines.join("\n");
}
