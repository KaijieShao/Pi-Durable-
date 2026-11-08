import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
	attachmentNote,
	attachmentOf,
	inboxPath,
	localDate,
	missingAttachmentNote,
	otherNote,
} from "../../src/media/attachments.ts";
import { createDeepgramStt, kindForStatus, parseTranscript } from "../../src/media/deepgram.ts";
import { SttError } from "../../src/media/stt.ts";
import { DownloadError, downloadToFile } from "../../src/telegram/download.ts";
import { tempDir } from "../helpers/agent.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";

test("deepgram: request shape and transcript", async () => {
	let seen: { url: string; init: RequestInit } | undefined;
	const fetchImpl = (async (url: string, init: RequestInit) => {
		seen = { url, init };
		return Response.json({
			results: { channels: [{ detected_language: "ru", alternatives: [{ transcript: " привет мир " }] }] },
		});
	}) as typeof fetch;
	const stt = createDeepgramStt("dg-key", fetchImpl);
	const result = await stt.transcribe(new Uint8Array([1, 2]), "audio/ogg", new AbortController().signal);
	assert.deepEqual(result, { text: "привет мир", language: "ru" });
	assert.match(seen?.url ?? "", /model=nova-3&detect_language=true&smart_format=true/);
	assert.deepEqual(seen?.init.headers, { Authorization: "Token dg-key", "Content-Type": "audio/ogg" });
});

test("deepgram: status mapping and failures", async () => {
	assert.equal(kindForStatus(401), "auth");
	assert.equal(kindForStatus(403), "auth");
	assert.equal(kindForStatus(402), "quota");
	assert.equal(kindForStatus(429), "quota");
	assert.equal(kindForStatus(400), "bad_audio");
	assert.equal(kindForStatus(503), "unavailable");
	const failing = createDeepgramStt("k", (async () => new Response("no", { status: 429 })) as unknown as typeof fetch);
	await assert.rejects(
		failing.transcribe(new Uint8Array(), "audio/ogg", new AbortController().signal),
		(e: unknown) => e instanceof SttError && e.kind === "quota",
	);
	const down = createDeepgramStt("k", (async () => {
		throw new Error("ECONNREFUSED https://api.deepgram.com");
	}) as unknown as typeof fetch);
	await assert.rejects(
		down.transcribe(new Uint8Array(), "audio/ogg", new AbortController().signal),
		(e: unknown) => e instanceof SttError && e.kind === "unavailable" && !e.message.includes("deepgram.com"),
	);
	assert.deepEqual(parseTranscript({ results: { channels: [{ alternatives: [] }] } }), { text: "" });
	assert.throws(() => parseTranscript({}), SttError);
});

test("attachments: deterministic inbox path and the user turn", () => {
	const at = new Date(2026, 9, 10, 12, 0, 0);
	assert.equal(localDate(at), "2026-10-10");
	assert.equal(inboxPath("/w", at, 42, "my file.pdf"), "/w/inbox/2026-10-10/42-my_file.pdf");
	const note = attachmentNote({
		kind: "photo",
		workdir: "/w",
		path: "/w/inbox/2026-10-10/42-photo.jpg",
		isImage: true,
		caption: "look",
	});
	assert.equal(
		note,
		"[attachment] photo saved to inbox/2026-10-10/42-photo.jpg (absolute: /w/inbox/2026-10-10/42-photo.jpg)\nView it with the read tool.\nCaption: look",
	);
	assert.ok(
		!attachmentNote({ kind: "document", workdir: "/w", path: "/w/a.txt", isImage: false, caption: undefined }).includes(
			"read tool",
		),
	);
});

test("download: part file renamed atomically; limits and HTTP errors are token-free", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const port = new FakeTelegram();
		port.files.set("f1", new Uint8Array([1, 2, 3]));
		const dest = join(dir, "inbox", "d", "1-a.bin");
		assert.equal(await downloadToFile({ port, fileId: "f1" }, dest), 3);
		assert.deepEqual([...(await readFile(dest))], [1, 2, 3]);
		port.files.set("big", new Uint8Array(100));
		await assert.rejects(
			downloadToFile({ port, fileId: "big", limit: 10 }, join(dir, "inbox", "d", "2-b.bin")),
			DownloadError,
		);
		assert.deepEqual((await readdir(join(dir, "inbox", "d"))).sort(), ["1-a.bin"]);
		port.downloadFile = async () => new Response("x", { status: 502 });
		await assert.rejects(downloadToFile({ port, fileId: "f1" }, join(dir, "x")), /download failed: HTTP 502/);
	} finally {
		await cleanup();
	}
});

test("attachments: every file kind is named by what the user sent", () => {
	const base = { message_id: 1, date: 1, chat: { id: 1, type: "private" as const, first_name: "u" } };
	const of = (fields: object) => attachmentOf({ ...base, ...fields } as never);
	assert.deepEqual(of({ video: { file_id: "v", file_size: 9, mime_type: "video/quicktime" } }), {
		kind: "video",
		fileId: "v",
		fileSize: 9,
		name: "video.quicktime",
		mime: "video/quicktime",
	});
	assert.equal(of({ video: { file_id: "v", file_name: "clip.mp4" } })?.name, "clip.mp4");
	// An animation also carries a document; the user sent an animation.
	assert.equal(
		of({ animation: { file_id: "a" }, document: { file_id: "a", file_name: "x.gif.mp4" } })?.kind,
		"animation",
	);
	assert.equal(of({ sticker: { file_id: "s" } })?.name, "sticker.webp");
	assert.equal(of({ sticker: { file_id: "s", is_animated: true } })?.name, "sticker.tgs");
	assert.equal(of({ sticker: { file_id: "s", is_video: true } })?.name, "sticker.webm");
	assert.equal(of({ voice: { file_id: "o" } })?.name, "voice.ogg");
	assert.equal(of({ audio: { file_id: "m", file_name: "song.flac" } })?.name, "song.flac");
	assert.equal(of({ video_note: { file_id: "n" } })?.name, "video_note.mp4");
	assert.equal(of({ location: { latitude: 1, longitude: 2 } }), undefined);
});

test("attachments: a file that was not fetched and a message without a file are still described to the model", () => {
	const attachment = { kind: "video", fileId: "v", fileSize: 34 * 1024 * 1024, name: "clip.mp4", mime: "video/mp4" };
	assert.equal(
		missingAttachmentNote({ attachment, reason: "bots can download files up to 20 MB", caption: "look" }),
		'[attachment] video "clip.mp4", 34.0 MB was not downloaded: bots can download files up to 20 MB\nCaption: look',
	);
	const base = { message_id: 1, date: 1, chat: { id: 1, type: "private" as const, first_name: "u" } };
	assert.equal(
		otherNote({ ...base, location: { latitude: 41.3, longitude: 69.2 } } as never),
		'[telegram location] {"location":{"latitude":41.3,"longitude":69.2}}',
	);
	assert.match(
		otherNote({ ...base, poll: { question: "q" }, caption: "c" } as never),
		/^\[telegram poll\] .*\nCaption: c$/,
	);
	assert.equal(otherNote(base as never), "[telegram empty message] {}");
});
