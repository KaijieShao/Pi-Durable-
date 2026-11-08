import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Agent, openAgent } from "../../src/agent/open.ts";
import type { Stt } from "../../src/media/stt.ts";
import { createLogger } from "../../src/runtime/log.ts";
import { FakeBotApi } from "../fixtures/fake-bot-api.ts";
import { CHAT, newFaux, tempDir, testConfig } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { gate } from "../helpers/faux-steps.ts";
import { textUpdate, voiceUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Daemon = { agent: Agent; logs: string[]; shutdown(): Promise<void> };

/** The real agent with real grammY long polling against the fake Bot API; `shutdown` is the daemon's SIGTERM path. */
async function startPolling(dir: string, root: string, stt: Stt, ...answers: string[]): Promise<Daemon> {
	const config = testConfig(dir, { TELEGRAM_API_ROOT: root });
	await mkdir(config.workdir, { recursive: true });
	const faux = newFaux();
	faux.setResponses(answers.map((answer) => fauxAssistantMessage(answer)));
	const models = createModels();
	models.setProvider(faux.provider);
	const logs: string[] = [];
	const log = createLogger({ level: "debug", sink: (_level, line) => logs.push(line) });
	const agent = await openAgent(config, { models, stt, log, previewIntervalMs: 50, onFatal: () => {} });
	await agent.channel.start(agent.harness, BG);
	let closed = false;
	const shutdown = async () => {
		if (closed) return;
		closed = true;
		await agent.channel.stop();
		await agent.harness.close(BG);
	};
	cleanups.push(shutdown);
	return { agent, logs, shutdown };
}

async function setup() {
	const { dir, cleanup } = await tempDir("pdt-stop-");
	const api = new FakeBotApi();
	const root = await api.start();
	cleanups.push(cleanup, () => api.stop());
	return { dir, api, root };
}

test("T-sigterm-mid-voice: an update still being transcribed at shutdown is not confirmed; after restart it is answered once", {
	timeout: 60_000,
}, async () => {
	const { dir, api, root } = await setup();
	api.files.set("v1", new Uint8Array([1, 2, 3]));
	const release = gate();
	let calls = 0;
	const slow: Stt = {
		transcribe: async () => {
			calls++;
			await release.promise;
			return { text: "please deploy", language: "en" };
		},
	};
	const first = await startPolling(dir, root, slow, "unused");
	const update = voiceUpdate(CHAT, 1, "v1", 3);
	api.enqueue(update);
	await waitFor(() => calls === 1, { what: "transcription started", timeoutMs: 10_000 });
	await first.shutdown();
	release.open();
	assert.ok(api.confirmed <= update.update_id, `update ${update.update_id} confirmed (offset ${api.confirmed})`);

	const fast: Stt = { transcribe: async () => ({ text: "please deploy", language: "en" }) };
	const second = await startPolling(dir, root, fast, "deployed");
	await waitFor(() => api.textsIn(CHAT).includes("deployed"), { what: "answer after restart", timeoutMs: 20_000 });
	assert.deepEqual(
		api.textsIn(CHAT).filter((text) => text.startsWith("🎙")),
		["🎙 please deploy"],
		"transcript echoed once",
	);
	assert.equal(api.textsIn(CHAT).filter((text) => text === "deployed").length, 1);
	await second.shutdown();
});

test("T-sigterm-drained: a handler that finishes during shutdown is confirmed; later updates are left for the next process", {
	timeout: 60_000,
}, async () => {
	const { dir, api, root } = await setup();
	const release = gate();
	const slow: Stt = {
		transcribe: async () => {
			await release.promise;
			return { text: "x" };
		},
	};
	api.files.set("v2", new Uint8Array([1]));
	const first = await startPolling(dir, root, slow, "unused");
	const voice = voiceUpdate(CHAT, 5, "v2", 1);
	const text = textUpdate(CHAT, 6, "late message");
	api.enqueue(voice);
	await waitFor(() => api.count("getFile") === 1, { what: "voice in flight", timeoutMs: 10_000 });
	const stopping = first.shutdown();
	api.enqueue(text);
	release.open();
	await stopping;
	assert.equal(api.confirmed, voice.update_id + 1, "the finished voice update is confirmed");
	const polls = api.count("getUpdates");
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.equal(api.count("getUpdates"), polls, "the stopped process polls no more");
	assert.ok(!first.logs.some((line) => line.includes("message_admitted") && line.includes("message=6")));

	const second = await startPolling(dir, root, slow, "voice answer", "late answer");
	const replyTo6 = () => [...api.messages.values()].find((m) => m.replyTo === 6 && m.text.endsWith("answer"));
	await waitFor(replyTo6, { what: "late message answered", timeoutMs: 20_000 });
	await second.shutdown();
});
