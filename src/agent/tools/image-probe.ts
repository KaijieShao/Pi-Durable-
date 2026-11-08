export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export type ImageProbe = { readonly mime: ImageMime; readonly width?: number; readonly height?: number };

/** Sniff an image type from its magic bytes and read its dimensions from the header when present. Never throws. */
export function probeImage(bytes: Uint8Array): ImageProbe | undefined {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return withSize("image/png", pngSize(bytes));
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return withSize("image/jpeg", jpegSize(bytes));
	if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return withSize("image/gif", gifSize(bytes));
	if (isWebp(bytes)) return withSize("image/webp", webpSize(bytes));
	return undefined;
}

type Size = { width: number; height: number } | undefined;

function withSize(mime: ImageMime, size: Size): ImageProbe {
	return size === undefined ? { mime } : { mime, width: size.width, height: size.height };
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
	return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function u16be(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function u16le(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function u32be(bytes: Uint8Array, at: number): number {
	return u16be(bytes, at) * 0x10000 + u16be(bytes, at + 2);
}

function u24le(bytes: Uint8Array, at: number): number {
	return u16le(bytes, at) + (bytes[at + 2] ?? 0) * 0x10000;
}

function pngSize(bytes: Uint8Array): Size {
	if (bytes.length < 24) return undefined;
	return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function gifSize(bytes: Uint8Array): Size {
	if (bytes.length < 10) return undefined;
	return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

function isWebp(bytes: Uint8Array): boolean {
	return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
}

function webpSize(bytes: Uint8Array): Size {
	const chunk = String.fromCharCode(...bytes.slice(12, 16));
	if (chunk === "VP8X" && bytes.length >= 30) return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
	if (chunk === "VP8 " && bytes.length >= 30)
		return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
	if (chunk === "VP8L" && bytes.length >= 25) {
		const b1 = bytes[21] ?? 0;
		const b2 = bytes[22] ?? 0;
		const b3 = bytes[23] ?? 0;
		const b4 = bytes[24] ?? 0;
		return { width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
	}
	return undefined;
}

/** Walk JPEG segments to the first start-of-frame marker. */
function jpegSize(bytes: Uint8Array): Size {
	let at = 2;
	while (at + 9 < bytes.length) {
		if (bytes[at] !== 0xff) return undefined;
		const marker = bytes[at + 1] ?? 0;
		if (isStartOfFrame(marker)) return { width: u16be(bytes, at + 7), height: u16be(bytes, at + 5) };
		const length = u16be(bytes, at + 2);
		if (length < 2) return undefined;
		at += 2 + length;
	}
	return undefined;
}

function isStartOfFrame(marker: number): boolean {
	return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}
