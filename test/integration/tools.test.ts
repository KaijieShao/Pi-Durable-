import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type FauxProviderHandle, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { ChatMap } from "../../src/channel/docs.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastToolResult, observe, textOf, toolCall } from "../helpers/faux-steps.ts";
import { pngBytes } from "../helpers/images.ts";
import { textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
	faux: FauxProviderHandle,
	uploadBytes?: number,
): Promise<{ t: TestAgent; port: FakeTelegram; work: string }> {
	const { dir, cleanup } = await tempDir();
	const work = join(dir, "work");
	await mkdir(work, { recursive: true });
	const port = new FakeTelegram();
	const t = await startTestAgent({
		dir,
		faux,
		port,
		deps: uploadBytes === undefined ? {} : { limits: { uploadBytes } },
	});
	cleanups.push(cleanup, () => t.close());
	return { t, port, work };
}

type Seen = { isError: boolean; text: string; images: string[] };

function inspect(messages: readonly Message[]): Seen {
	const result = lastToolResult(messages);
	const images = (result?.content ?? []).flatMap((part) => (part.type === "image" ? [part.mimeType] : []));
	return { isError: result?.isError === true, text: textOf(result), images };
}

test("T-image-inject: read of an image attaches its bytes per request; history keeps only text", async () => {
	const faux = newFaux();
	const seen: Seen[] = [];
	faux.setResponses([
		toolCall("read", { path: "inbox/pic.png" }),
		(context) => {
			seen.push(inspect(context.messages));
			return fauxAssistantMessage("I see a black square");
		},
	]);
	const { t, port, work } = await setup(faux);
	await mkdir(join(work, "inbox"), { recursive: true });
	await writeFile(join(work, "inbox", "pic.png"), pngBytes(64, 48));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "look"));
	await waitFor(() => port.textsIn(CHAT).includes("I see a black square"));
	assert.equal(seen[0]?.isError, false);
	assert.deepEqual(seen[0]?.images, ["image/png"]);
	assert.match(seen[0]?.text ?? "", /pic\.png \(64x48, 0\.0 MB\) is attached for viewing/);
	const id = (await t.agent.harness.snapshot(ChatMap, BG))?.chats[String(CHAT)];
	const conversation = await t.agent.harness.conversation(id as never, BG);
	assert.ok(conversation !== undefined);
	const view = await conversation.context(BG);
	const stored = JSON.stringify(view.messages);
	assert.ok(!stored.includes('"type":"image"'), "no image bytes in durable history");
});

test("T-image-validate: an oversized image is a model-readable error, not an attachment; text files read normally", async () => {
	const faux = newFaux();
	const seen: Seen[] = [];
	faux.setResponses([
		toolCall("read", { path: "huge.png" }),
		observe((messages) => seen.push(inspect(messages)), toolCall("read", { path: "notes.txt" })),
		observe((messages) => seen.push(inspect(messages)), fauxAssistantMessage("done")),
	]);
	const { t, port, work } = await setup(faux);
	await writeFile(join(work, "huge.png"), pngBytes(9000, 10));
	await writeFile(join(work, "notes.txt"), "plain notes");
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "look"));
	await waitFor(() => port.textsIn(CHAT).includes("done"));
	assert.equal(seen[0]?.isError, true);
	assert.match(seen[0]?.text ?? "", /Image too large to view .*9000x10.*Downscale/s);
	assert.deepEqual(seen[0]?.images, []);
	assert.equal(seen[1]?.isError, false);
	assert.match(seen[1]?.text ?? "", /plain notes/);
});

test("T-send-file-limits: missing, directory and oversized files are tool errors; images go as photos", async () => {
	const faux = newFaux();
	const seen: Seen[] = [];
	const step = (next: ReturnType<typeof toolCall>) => observe((messages) => seen.push(inspect(messages)), next);
	faux.setResponses([
		toolCall("telegram_send_file", { path: "missing.txt" }),
		step(toolCall("telegram_send_file", { path: "." })),
		step(toolCall("telegram_send_file", { path: "big.bin" })),
		step(toolCall("telegram_send_file", { path: "pic.png", caption: "the picture" })),
		step(toolCall("telegram_send_file", { path: "report.txt" })),
		observe((messages) => seen.push(inspect(messages)), fauxAssistantMessage("sent")),
	]);
	const { t, port, work } = await setup(faux, 1000);
	await writeFile(join(work, "big.bin"), Buffer.alloc(2000));
	await writeFile(join(work, "pic.png"), pngBytes(16, 16));
	await writeFile(join(work, "report.txt"), "report");
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "send"));
	await waitFor(() => port.textsIn(CHAT).includes("sent"));
	assert.deepEqual(
		seen.map((s) => s.isError),
		[true, true, true, false, false],
	);
	assert.match(seen[0]?.text ?? "", /File not found/);
	assert.match(seen[1]?.text ?? "", /not a regular file/);
	assert.match(seen[2]?.text ?? "", /Telegram bots can send at most 0\.0 MB/);
	assert.match(seen[3]?.text ?? "", /Sent pic\.png .* as photo/);
	assert.match(seen[4]?.text ?? "", /Sent report\.txt .* as document/);
	const photo = port.created(CHAT).find((m) => m.kind === "photo");
	assert.equal(photo?.caption, "the picture");
	assert.equal(port.created(CHAT).filter((m) => m.kind === "document").length, 1);
});

test("T-bash-env: the agent's shell sees neither secrets nor the service environment", async () => {
	process.env.TELEGRAM_BOT_TOKEN = "999999:secret-token-value-that-must-not-leak";
	process.env.LEAKY_SERVICE_VAR = "leak";
	try {
		const faux = newFaux();
		let output = "";
		faux.setResponses([
			toolCall("bash", { command: "env" }),
			observe((messages) => {
				output = textOf(lastToolResult(messages));
			}, fauxAssistantMessage("ok")),
		]);
		const { t, port } = await setup(faux);
		await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "env"));
		await waitFor(() => port.textsIn(CHAT).includes("ok"));
		assert.match(output, /^PATH=/m);
		assert.ok(!output.includes("secret-token"), "no bot token");
		assert.ok(!output.includes("LEAKY_SERVICE_VAR"), "process env not inherited");
	} finally {
		delete process.env.TELEGRAM_BOT_TOKEN;
		delete process.env.LEAKY_SERVICE_VAR;
	}
});
