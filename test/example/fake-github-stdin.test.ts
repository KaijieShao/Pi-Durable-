import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { originGit } from "../helpers/fake-github.ts";

test("a fixture Git process that closes stdin early returns its allowed exit code without an unhandled EPIPE", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "fake-github-stdin-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const result = await originGit(root, ["--invalid-pi-fixture-argument"], {
		input: "fixture input\n".repeat(1_000_000),
		okCodes: [129],
	});
	assert.equal(result.code, 129);
	assert.equal(result.stdout, "");
});
