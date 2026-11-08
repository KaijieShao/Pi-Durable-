import type { Context } from "@earendil-works/chord";
import type { Conversation, ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import type { DeliverTask } from "../delivery/task.ts";
import type { DeliverInput } from "../delivery/types.ts";
import { INTAKE_RING_SIZE, Intake, pushRing, updateMarker } from "./docs.ts";

/**
 * Why a message is a duplicate: `redelivered` when this very update was seen, `other_update` when only the key was
 * (a message id that came back with the same date; Telegram never does this, so it is worth a warning).
 */
export type DuplicateReason = "redelivered" | "other_update";

/** Read-only check before any download or transcription: was this message already admitted, and how is it known? */
export async function knownAs(
	harness: Harness,
	conversation: Conversation,
	key: string,
	updateId: number | undefined,
	context: Context,
): Promise<DuplicateReason | undefined> {
	const keys = (await harness.snapshot(Intake, conversation.id, context))?.keys ?? [];
	if (!keys.includes(key)) return undefined;
	return updateId !== undefined && keys.includes(updateMarker(updateId)) ? "redelivered" : "other_update";
}

/** Record `key` (and the update's marker) in the intake ring; false when the key was already there. */
export function recordKey(
	conversation: Conversation,
	key: string,
	context: Context,
	updateId?: number,
): Promise<boolean> {
	return conversation.commit(async (tx) => record(await tx.doc(Intake, conversation.id), key, updateId), context);
}

function record(intake: { keys: string[] }, key: string, updateId: number | undefined): boolean {
	if (!pushRing(intake.keys, key, INTAKE_RING_SIZE)) return false;
	if (updateId !== undefined) pushRing(intake.keys, updateMarker(updateId), INTAKE_RING_SIZE);
	return true;
}

/**
 * Admit a message atomically: record its key and create its delivery task in one commit, so a redelivered update can
 * neither double-submit nor slip in before the task has submitted.
 */
export function admit(
	conversation: Conversation,
	deliver: DeliverTask,
	input: DeliverInput,
	context: Context,
	updateId?: number,
): Promise<"admitted" | "duplicate"> {
	return conversation.commit(
		async (tx) => ((await admitIn(tx, conversation.id, deliver, input, updateId)) ? "admitted" : "duplicate"),
		context,
	);
}

/** The body of `admit` inside a caller's commit; false when `input.requestId` was already admitted. */
export async function admitIn(
	tx: Tx,
	conversationId: ConversationId,
	deliver: DeliverTask,
	input: DeliverInput,
	updateId?: number,
): Promise<boolean> {
	if (!record(await tx.doc(Intake, conversationId), input.requestId, updateId)) return false;
	const options = { ownership: { kind: "conversation" }, background: true, conversationId } as const;
	await tx.createTask(deliver, input, options);
	return true;
}
