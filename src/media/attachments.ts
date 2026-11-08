import { join, relative } from "node:path";
import type { Message, PhotoSize } from "grammy/types";
import { extensionForMime, sanitizeFileName } from "./safe-name.ts";

/** Any file a Telegram message can carry. `kind` is Telegram's own name for it. */
export type Attachment = {
	readonly kind: string;
	readonly fileId: string;
	readonly fileSize: number | undefined;
	readonly name: string;
	readonly mime: string | undefined;
};

/** Speech kinds, tried with speech-to-text first. */
const SPEECH_KINDS: ReadonlySet<string> = new Set(["voice", "audio", "video_note"]);

type FileLike = { file_id: string; file_size?: number; file_name?: string; mime_type?: string };
type Reader = (message: Message) => Attachment | undefined;

/** The largest size of a photo. */
export function pickPhoto(photo: readonly PhotoSize[]): PhotoSize | undefined {
	return [...photo].sort((a, b) => (a.file_size ?? a.width * a.height) - (b.file_size ?? b.width * b.height)).at(-1);
}

function fileOf(kind: string, file: FileLike | undefined, fallbackName: string, fallbackMime?: string) {
	if (file === undefined) return undefined;
	const mime = file.mime_type ?? fallbackMime;
	return { kind, fileId: file.file_id, fileSize: file.file_size, name: file.file_name ?? fallbackName, mime };
}

function stickerName(sticker: { is_animated?: boolean; is_video?: boolean }): string {
	if (sticker.is_animated === true) return "sticker.tgs";
	return sticker.is_video === true ? "sticker.webm" : "sticker.webp";
}

/** One reader per file-carrying field, in the order Telegram clients show them. */
const READERS: readonly Reader[] = [
	(m) => {
		const best = m.photo === undefined ? undefined : pickPhoto(m.photo);
		return best === undefined ? undefined : fileOf("photo", best, "photo.jpg", "image/jpeg");
	},
	// An animation also carries `document`; name it by what the user sent.
	(m) => fileOf("animation", m.animation, "animation.mp4", "video/mp4"),
	(m) => fileOf("document", m.document, `file.${extensionForMime(m.document?.mime_type)}`),
	(m) => fileOf("video", m.video, `video.${extensionForMime(m.video?.mime_type ?? "video/mp4")}`, "video/mp4"),
	(m) => fileOf("voice", m.voice, "voice.ogg", "audio/ogg"),
	(m) => fileOf("video_note", m.video_note, "video_note.mp4", "video/mp4"),
	(m) => fileOf("audio", m.audio, `audio.${extensionForMime(m.audio?.mime_type ?? "audio/mpeg")}`, "audio/mpeg"),
	(m) => (m.sticker === undefined ? undefined : fileOf("sticker", m.sticker, stickerName(m.sticker))),
];

/** The file a message carries, whatever its kind; undefined when it carries none. */
export function attachmentOf(message: Message): Attachment | undefined {
	for (const read of READERS) {
		const found = read(message);
		if (found !== undefined) return found;
	}
	return undefined;
}

export function isSpeech(attachment: Attachment): boolean {
	return SPEECH_KINDS.has(attachment.kind);
}

/** Local calendar date `YYYY-MM-DD`. */
export function localDate(at: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** `<workdir>/inbox/<date>/<messageId>-<safe name>`: deterministic, so a redelivered update overwrites, not duplicates. */
export function inboxPath(workdir: string, at: Date, messageId: number, name: string): string {
	return join(workdir, "inbox", localDate(at), `${messageId}-${sanitizeFileName(name)}`);
}

function withTail(lines: string[], note: string | undefined, caption: string | undefined): string {
	if (note !== undefined) lines.push(note);
	if (caption !== undefined && caption.trim() !== "") lines.push(`Caption: ${caption}`);
	return lines.join("\n");
}

/** The user turn that tells the model where an attachment was saved. */
export function attachmentNote(options: {
	kind: string;
	workdir: string;
	path: string;
	isImage: boolean;
	caption: string | undefined;
	note?: string;
}): string {
	const lines = [
		`[attachment] ${options.kind} saved to ${relative(options.workdir, options.path)} (absolute: ${options.path})`,
	];
	if (options.isImage) lines.push("View it with the read tool.");
	return withTail(lines, options.note, options.caption);
}

/** The user turn for a file that could not be fetched: the model still learns what was sent and why it is missing. */
export function missingAttachmentNote(options: {
	attachment: Attachment;
	reason: string;
	caption: string | undefined;
}): string {
	const { kind, name, fileSize } = options.attachment;
	const size = fileSize === undefined ? "" : `, ${(fileSize / (1024 * 1024)).toFixed(1)} MB`;
	return withTail(
		[`[attachment] ${kind} "${name}"${size} was not downloaded: ${options.reason}`],
		undefined,
		options.caption,
	);
}

const SKIPPED_FIELDS: ReadonlySet<string> = new Set([
	"message_id",
	"date",
	"chat",
	"from",
	"caption",
	"caption_entities",
	"entities",
	"forward_origin",
	"reply_to_message",
	"quote",
	"edit_date",
	"has_protected_content",
	"is_automatic_forward",
	"link_preview_options",
]);

/**
 * The user turn for a message with no text and no file (location, contact, poll, dice, ...): its own fields as JSON,
 * so the model reads whatever Telegram sent, including kinds added after this code was written.
 */
export function otherNote(message: Message): string {
	const fields = Object.entries(message).filter(([key]) => !SKIPPED_FIELDS.has(key));
	const kinds = fields.map(([key]) => key).join(", ") || "empty message";
	const body = JSON.stringify(Object.fromEntries(fields)).slice(0, 4000);
	return withTail([`[telegram ${kinds}] ${body}`], undefined, message.caption);
}
