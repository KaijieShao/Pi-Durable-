import assert from "node:assert/strict";
import { rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createInstructionsReader } from "../../src/agent/prompt.ts";
import { tempDir } from "../helpers/agent.ts";

test("project instructions: stable 'none' when missing, re-read when the file changes", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const path = join(dir, "AGENTS.md");
		const read = createInstructionsReader(path);
		assert.match(await read(), /^<project_instructions path=".*AGENTS\.md">\nnone\n<\/project_instructions>$/);
		await writeFile(path, "Use bun.");
		assert.match(await read(), /\nUse bun\.\n/);
		await writeFile(path, "Use npm, not bun.");
		await utimes(path, new Date(), new Date(Date.now() + 5000));
		assert.match(await read(), /\nUse npm, not bun\.\n/);
		await writeFile(path, "x".repeat(70 * 1024));
		assert.match(await read(), /\[truncated: file is larger than 64 KB\]/);
		await rm(path);
		assert.match(await read(), /\nnone\n/);
	} finally {
		await cleanup();
	}
});
