import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { TelegramPort } from "./port.ts";

export const DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** A download failure whose message is safe to log and show: no URL, no cause. */
export class DownloadError extends Error {
	constructor(reason: string) {
		super(`download failed: ${reason}`);
		this.name = "DownloadError";
	}
}

type Source = { port: TelegramPort; fileId: string; limit?: number; signal?: AbortSignal };

/** Download a Telegram file into memory, enforcing the size limit while reading. */
export async function downloadToMemory(source: Source): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	await streamFile(source, async (chunk) => {
		chunks.push(chunk);
	});
	return Buffer.concat(chunks);
}

/** Download a Telegram file to `dest` through a `.part` file and an atomic rename; the part is removed on failure. */
export async function downloadToFile(source: Source, dest: string): Promise<number> {
	await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
	const part = `${dest}.${randomBytes(4).toString("hex")}.part`;
	const handle = await open(part, "w", 0o600);
	let size = 0;
	try {
		size = await streamFile(source, async (chunk) => {
			await handle.write(chunk);
		});
		await handle.close();
		await rename(part, dest);
		return size;
	} catch (error) {
		await handle.close().catch(() => undefined);
		await unlink(part).catch(() => undefined);
		throw error;
	}
}

async function streamFile(source: Source, sink: (chunk: Uint8Array) => Promise<void>): Promise<number> {
	const limit = source.limit ?? DOWNLOAD_LIMIT_BYTES;
	const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
	const signal = source.signal === undefined ? timeout : AbortSignal.any([timeout, source.signal]);
	try {
		const file = await source.port.getFile(source.fileId, signal);
		if ((file.size ?? 0) > limit) throw new DownloadError("file is too big");
		const response = await source.port.downloadFile(file.path, signal);
		if (!response.ok || response.body === null) throw new DownloadError(`HTTP ${response.status}`);
		return await pump(response.body, limit, sink);
	} catch (error) {
		throw safeError(error, timeout.aborted);
	}
}

async function pump(
	body: ReadableStream<Uint8Array>,
	limit: number,
	sink: (chunk: Uint8Array) => Promise<void>,
): Promise<number> {
	let size = 0;
	for await (const chunk of body) {
		size += chunk.byteLength;
		if (size > limit) throw new DownloadError("file is too big");
		await sink(chunk);
	}
	return size;
}

function safeError(error: unknown, timedOut: boolean): Error {
	if (error instanceof DownloadError) return error;
	if (timedOut) return new DownloadError("timeout");
	if (error instanceof Error && error.name === "TelegramApiError") return new DownloadError(error.message);
	return new DownloadError("network error");
}
