import assert from "node:assert/strict";
import { chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { splitForTelegram } from "../../src/format/chunk.ts";
import { CHAT, newFaux, startTestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { blockUntilAborted, FakeTelegram } from "../helpers/fake-telegram.ts";
import { words } from "../helpers/faux-steps.ts";
import { textUpdate } from "../helpers/updates.ts";

async function deliverOutcomes(harness: Harness): Promise<string[]> {
	const page = await harness.commit((tx) => tx.scanTasks({ kind: "tg.deliver" }, 100), BG);
	return page.items.map((task) => (task.state.status === "terminal" ? task.state.outcome.status : task.state.status));
}

test("T-crash-generation + T-close-no-fault: closed mid-stream, reopened, the answer lands once in the same preview", async () => {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	try {
		const slow = newFaux({ tokensPerSecond: 40 });
		slow.setResponses([fauxAssistantMessage(`Partial ${words(600)}`)]);
		const first = await startTestAgent({ dir, faux: slow, port });
		await first.agent.channel.handleUpdate(textUpdate(CHAT, 1, "work"));
		const preview = await waitFor(() => port.created(CHAT).find((m) => m.text.startsWith("Partial")), {
			what: "preview",
			timeoutMs: 15_000,
		});
		await first.close();

		const fast = newFaux();
		fast.setResponses([fauxAssistantMessage("Final answer after restart")]);
		const second = await startTestAgent({ dir, faux: fast, port });
		try {
			await waitFor(() => port.messages.get(preview.id)?.text === "Final answer after restart", {
				what: "final in the preview",
				timeoutMs: 15_000,
			});
			assert.equal(port.count("sendMessage"), 1, "no second message");
			assert.equal(fast.state.callCount, 1, "the interrupted request was resent once");
			// Closing mid-run did not fault the task: it resumed and completed.
			assert.deepEqual(await deliverOutcomes(second.agent.harness), ["completed"]);
		} finally {
			await second.close();
		}
	} finally {
		await cleanup();
	}
});

test("T-crash-after-answer: closed while the final edit is in flight; after reopen it is edited again, the model is not called", async () => {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	try {
		const faux = newFaux({ tokensPerSecond: 200 });
		const answer = `Answer ${words(300)} THE END`;
		faux.setResponses([fauxAssistantMessage(answer)]);
		let blocked = false;
		const unhook = port.use((call, signal) => {
			if (call.method === "editMessageText" && call.options?.fast !== true) {
				blocked = true;
				return blockUntilAborted(signal);
			}
		});
		const first = await startTestAgent({ dir, faux, port });
		await first.agent.channel.handleUpdate(textUpdate(CHAT, 2, "go"));
		await waitFor(() => blocked, { what: "final edit in flight", timeoutMs: 15_000 });
		await first.close();
		unhook();
		const idle = newFaux();
		const second = await startTestAgent({ dir, faux: idle, port });
		try {
			const final = splitForTelegram(answer)[0]?.html ?? "?";
			await waitFor(() => port.textsIn(CHAT).includes(final), { what: "final edit" });
			assert.equal(port.created(CHAT).length, 1);
			assert.equal(idle.state.callCount, 0);
			assert.deepEqual(await deliverOutcomes(second.agent.harness), ["completed"]);
		} finally {
			await second.close();
		}
	} finally {
		await cleanup();
	}
});

test("T-inflight-unknown: a chunk send in flight at close is skipped after reopen, never sent twice", async () => {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	try {
		const faux = newFaux();
		const answer = Array.from({ length: 50 }, (_, i) => `Block ${i} ${"z".repeat(200)}`).join("\n\n");
		const chunks = splitForTelegram(answer);
		assert.ok(chunks.length >= 3);
		faux.setResponses([fauxAssistantMessage(answer)]);
		let blocked = false;
		const unhook = port.use((call, signal) => {
			if (call.method === "sendMessage" && call.text === chunks[1]?.html) {
				blocked = true;
				return blockUntilAborted(signal);
			}
		});
		const first = await startTestAgent({ dir, faux, port });
		await first.agent.channel.handleUpdate(textUpdate(CHAT, 3, "go"));
		await waitFor(() => blocked, { what: "chunk 1 in flight" });
		await first.close();
		unhook();
		const second = await startTestAgent({ dir, faux: newFaux(), port });
		try {
			await waitFor(() => second.logs.some((line) => line.includes("info delivered")), { what: "delivered" });
			assert.ok(second.logs.some((line) => line.includes("delivery_unknown") && line.includes("chunk=1")));
			const texts = port.textsIn(CHAT);
			assert.equal(texts.filter((text) => text === chunks[1]?.html).length, 0, "chunk 1 not resent");
			for (const chunk of [chunks[0], ...chunks.slice(2)])
				assert.equal(texts.filter((text) => text === chunk?.html).length, 1);
		} finally {
			await second.close();
		}
	} finally {
		await cleanup();
	}
});

test("T-data-perms: an existing world-readable data directory is tightened; the database is private", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const data = join(dir, "data");
		await mkdir(data, { mode: 0o755 });
		await chmod(data, 0o755);
		const t = await startTestAgent({ dir, faux: newFaux(), port: new FakeTelegram() });
		try {
			assert.equal((await stat(data)).mode & 0o777, 0o700);
			assert.equal((await stat(join(data, "durable.sqlite"))).mode & 0o077, 0, "no group or other access");
		} finally {
			await t.close();
		}
	} finally {
		await cleanup();
	}
});
