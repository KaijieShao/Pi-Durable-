import { defineExtension, type Extension, GenerationTask, hook, LiveDoc } from "@earendil-works/pi-durable";
import { finalReplyText } from "../delivery/final-text.ts";

export const EMPTY_NUDGE = "Your last reply was empty. Reply to the user.";
const MAX_REMEMBERED = 1000;

/**
 * An empty final answer goes back to the model once per run as a continuation; a second empty answer is delivered
 * as is. A continuation starts a new generation task, so task memos cannot remember the nudge; the run is identified
 * by its inputs, which a continuation keeps. Remembered in memory: after a restart at most one more nudge happens.
 */
export function createEmptyAnswerExtension(): Extension {
	const nudged = new Set<string>();
	return defineExtension({
		name: "empty-answer",
		hooks: [
			hook(GenerationTask, {
				onYield: async (answer, api, context) => {
					if (answer.stopReason !== "stop" || finalReplyText(answer) !== undefined) return undefined;
					const run = (await api.snapshot(LiveDoc, api.conversationId, context))?.run;
					const key = `${api.conversationId}:${run?.inputs.join(",") ?? api.taskId}`;
					if (nudged.has(key)) return undefined;
					nudged.add(key);
					if (nudged.size > MAX_REMEMBERED) nudged.delete(nudged.values().next().value as string);
					return { continue: EMPTY_NUDGE };
				},
			}),
		],
	});
}
