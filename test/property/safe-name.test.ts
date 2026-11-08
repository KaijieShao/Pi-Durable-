import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { extensionForMime, sanitizeFileName } from "../../src/media/safe-name.ts";
import { check } from "../helpers/property.ts";

test("P-safe-name: output is a safe, short, non-empty name", (t) => {
	const name = fc.oneof(
		fc.string({ unit: "binary", maxLength: 300 }),
		fc.constantFrom("..", ".", "-rf", "../../etc/passwd", "...", ".bashrc", "a/b\\c", ""),
	);
	check(t, name, (input) => {
		const out = sanitizeFileName(input);
		assert.match(out, /^[A-Za-z0-9._-]{1,100}$/);
		assert.ok(!/^[.-]/.test(out), out);
		assert.ok(out !== "." && out !== "..");
	});
});

test("safe-name examples", () => {
	assert.equal(sanitizeFileName("report final.pdf"), "report_final.pdf");
	assert.equal(sanitizeFileName("../../etc/passwd"), "_.._etc_passwd");
	assert.equal(sanitizeFileName("Отчёт.docx"), "______.docx");
	const long = sanitizeFileName(`${"a".repeat(300)}.tar.gz`);
	assert.equal(long.length, 100);
	assert.ok(long.endsWith(".gz"));
	assert.equal(extensionForMime("image/png"), "png");
	assert.equal(extensionForMime(undefined), "bin");
});
