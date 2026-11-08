import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { probeImage } from "../../src/agent/tools/image-probe.ts";
import { gifBytes, jpegBytes, pngBytes, webpBytes } from "../helpers/images.ts";
import { check } from "../helpers/property.ts";

test("P-image-probe: random bytes never throw", (t) => {
	const prefixes = fc.constantFrom(
		[],
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		[0xff, 0xd8, 0xff],
		[0x47, 0x49, 0x46, 0x38],
		[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
	);
	check(t, fc.tuple(prefixes, fc.uint8Array({ maxLength: 200 })), ([prefix, rest]) => {
		const result = probeImage(new Uint8Array([...prefix, ...rest]));
		if (result !== undefined) assert.match(result.mime, /^image\/(png|jpeg|gif|webp)$/);
	});
});

test("known headers are detected with dimensions", () => {
	assert.deepEqual(probeImage(pngBytes(640, 480)), { mime: "image/png", width: 640, height: 480 });
	assert.deepEqual(probeImage(jpegBytes(1024, 768)), { mime: "image/jpeg", width: 1024, height: 768 });
	assert.deepEqual(probeImage(gifBytes(10, 20)), { mime: "image/gif", width: 10, height: 20 });
	assert.deepEqual(probeImage(webpBytes(300, 200)), { mime: "image/webp", width: 300, height: 200 });
	assert.equal(probeImage(new TextEncoder().encode("hello world")), undefined);
});
