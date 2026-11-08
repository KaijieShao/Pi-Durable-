import { readFile, stat } from "node:fs/promises";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Api, ImageContent, Message, Model, Models, TextContent } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	GenerationTask,
	type HookApi,
	type HookRegistration,
	hook,
	type ToolExecutionApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { type ImageMime, type ImageProbe, probeImage } from "./image-probe.ts";

const MAX_DIMENSION = 8000;
const FALLBACK_MAX_BYTES = 3_932_160;
const HEADER_BYTES = 64 * 1024;
/** Images re-attached per request; older ones are replaced by a note to keep requests small. */
export const IMAGES_PER_REQUEST = 4;

export type ImageDetails = { imagePath: string; mime: ImageMime };

/** Largest raw image a model accepts: 3/4 of its base64 limit, else 3.75 MB. */
export function maxImageBytes(model: Model<Api> | undefined): number {
	const base64 = model?.inputLimits?.images?.resize?.maxBytes;
	return base64 === undefined ? FALLBACK_MAX_BYTES : Math.floor((base64 * 3) / 4);
}

export type ImageCheck = { ok: true; probe: ImageProbe } | { ok: false; reason: string };

/** Validate an image before it may be attached: type, byte size and dimensions. */
export function checkImage(bytes: Uint8Array, size: number, maxBytes: number): ImageCheck {
	const probe = probeImage(bytes);
	if (probe === undefined) return { ok: false, reason: "not a PNG, JPEG, WebP or GIF image" };
	const dims = probe.width === undefined ? "unknown size" : `${probe.width}x${probe.height}`;
	const tooWide = (probe.width ?? 0) > MAX_DIMENSION || (probe.height ?? 0) > MAX_DIMENSION;
	if (size > maxBytes || tooWide) {
		return {
			ok: false,
			reason:
				`Image too large to view (${megabytes(size)} MB, ${dims}; limit ${megabytes(maxBytes)} MB and ${MAX_DIMENSION} px). ` +
				"Downscale it first, e.g. with ImageMagick: `convert in.png -resize 2000x2000 out.jpg`",
		};
	}
	return { ok: true, probe };
}

function megabytes(bytes: number): string {
	return (bytes / 1_048_576).toFixed(1);
}

async function modelOf(models: Models, ref: { provider: string; modelId: string } | undefined) {
	return ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
}

/**
 * `read` that recognizes images by content: it returns a short text and records the canonical path in `details`;
 * the generation hook attaches the bytes per request, so they never enter durable history. Other files go to the
 * stock `read`.
 */
export function createImageReadTool(): ToolRegistration {
	const read = createReadTool() as unknown as ToolRegistration;
	return {
		...read,
		description: `${read.description} Images (PNG, JPEG, WebP, GIF) are shown to you as pictures.`,
		execute: async (args, api, context) => {
			const image = await inspectImage(String((args as { path: string }).path), api, context);
			return image ?? read.execute(args, api, context);
		},
	};
}

async function inspectImage(path: string, api: ToolExecutionApi, context: Context) {
	const env = api.env;
	if (env === undefined) return undefined;
	const canonical = await env.canonicalPath(path, context);
	if (!canonical.ok) return undefined;
	const reader = await env.openBinaryReader(canonical.value, undefined, context);
	if (!reader.ok) return undefined;
	const [info, header] = await Promise.all([
		reader.value.info(context),
		reader.value.read(0, HEADER_BYTES, context),
	]).finally(() => reader.value.close(context));
	if (!info.ok || !header.ok || probeImage(header.value) === undefined) return undefined;
	const model = await modelOf(api.models, (await api.agent(context)).model);
	const check = checkImage(header.value, info.value.size, maxImageBytes(model));
	if (!check.ok) return { output: [text(check.reason)], isError: true };
	const { width, height, mime } = check.probe;
	const size = `${width ?? "?"}x${height ?? "?"}, ${megabytes(info.value.size)} MB`;
	const details: ImageDetails = { imagePath: canonical.value, mime };
	return { output: [text(`Image ${canonical.value} (${size}) is attached for viewing.`)], details };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

type ToolResult = Extract<Message, { role: "toolResult" }>;

/** The trusted image path of a `read` result: only `details` count, never text. */
export function imagePathOf(message: Message): string | undefined {
	if (message.role !== "toolResult" || message.toolName !== "read") return undefined;
	const details = message.details as JsonValue | undefined;
	if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
	const path = (details as Record<string, JsonValue>).imagePath;
	return typeof path === "string" ? path : undefined;
}

/** Re-attach the newest images to the request; older ones get a note. */
export async function attachImages(
	messages: readonly Message[],
	options: { maxBytes: number; canView: boolean },
): Promise<Message[]> {
	const positions = messages.flatMap((message, index) => (imagePathOf(message) === undefined ? [] : [index]));
	const recent = new Set(positions.slice(-IMAGES_PER_REQUEST));
	return Promise.all(
		messages.map(async (message, index) => {
			const path = imagePathOf(message);
			if (path === undefined) return message;
			const result = message as ToolResult;
			if (!options.canView) return appendContent(result, text("[this model cannot view images]"));
			if (!recent.has(index))
				return appendContent(result, text("[image omitted to save context; read it again to view]"));
			return appendContent(result, await loadImage(path, options.maxBytes));
		}),
	);
}

function appendContent(message: ToolResult, part: TextContent | ImageContent): ToolResult {
	return { ...message, content: [...message.content, part] } as ToolResult;
}

async function loadImage(path: string, maxBytes: number): Promise<TextContent | ImageContent> {
	try {
		const info = await stat(path);
		if (info.size > maxBytes) return text(`[image no longer available: larger than ${megabytes(maxBytes)} MB]`);
		const bytes = await readFile(path);
		const check = checkImage(bytes, bytes.length, maxBytes);
		if (!check.ok) return text(`[image no longer available: ${check.reason}]`);
		return { type: "image", data: bytes.toString("base64"), mimeType: check.probe.mime };
	} catch {
		return text("[image no longer available: file missing or unreadable]");
	}
}

async function requestModel(api: HookApi, context: Context) {
	const agent = await api.snapshot(AgentDoc, api.conversationId, context);
	return modelOf(api.models, agent?.model);
}

/** Generation hook that attaches image bytes for `read` results at request time. */
export function createImageRequestHook(): HookRegistration {
	return hook(GenerationTask, {
		beforeRequest: async (request, api, context) => {
			if (!request.messages.some((message) => imagePathOf(message) !== undefined)) return undefined;
			const model = await requestModel(api, context);
			const canView = model === undefined || model.input.includes("image");
			const messages = await attachImages(request.messages, { maxBytes: maxImageBytes(model), canView });
			return { messages };
		},
	});
}
