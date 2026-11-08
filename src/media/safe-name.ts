const MAX_LENGTH = 100;

/**
 * A file name safe for any file system and shell: only `[A-Za-z0-9._-]`, no leading dot or dash, at most 100
 * characters with the extension kept, never empty, `.` or `..`.
 */
export function sanitizeFileName(name: string): string {
	const replaced = name.normalize("NFKD").replace(/[^A-Za-z0-9._-]/g, "_");
	const stripped = replaced.replace(/^[.-]+/, "");
	const capped = capKeepingExtension(stripped);
	return capped === "" || /^\.+$/.test(capped) ? "file" : capped;
}

function capKeepingExtension(name: string): string {
	if (name.length <= MAX_LENGTH) return name;
	const dot = name.lastIndexOf(".");
	const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
	return name.slice(0, MAX_LENGTH - extension.length) + extension;
}

/** File extension for a MIME type, for documents without a name. */
export function extensionForMime(mime: string | undefined): string {
	const known: Record<string, string> = {
		"image/jpeg": "jpg",
		"image/png": "png",
		"image/webp": "webp",
		"image/gif": "gif",
		"application/pdf": "pdf",
		"text/plain": "txt",
		"application/zip": "zip",
		"application/json": "json",
		"audio/ogg": "ogg",
		"audio/mpeg": "mp3",
		"video/mp4": "mp4",
	};
	if (mime !== undefined && known[mime] !== undefined) return known[mime];
	const subtype = /^[a-z]+\/([a-z0-9.+-]+)$/i.exec(mime ?? "")?.[1];
	return subtype === undefined ? "bin" : sanitizeFileName(subtype).slice(0, 10);
}
