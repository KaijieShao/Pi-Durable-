import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test(".gitignore keeps every .env* file, data, dependencies and builds out of git", () => {
	const lines = readFileSync(join(import.meta.dirname, "../../.gitignore"), "utf8")
		.split("\n")
		.map((line) => line.trim());
	for (const required of [".env*", "data/", "node_modules/", "dist/"]) assert.ok(lines.includes(required), required);
	assert.ok(!lines.some((line) => line.startsWith("!.env") && line !== "!.env.example"), "no secret file re-included");
});
