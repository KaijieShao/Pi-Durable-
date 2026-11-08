import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../../src/cli/args.ts";

test("argv parsing", () => {
	assert.deepEqual(parseArgs([]), { command: "help" });
	assert.deepEqual(parseArgs(["--version"]), { command: "version" });
	assert.deepEqual(parseArgs(["run"]), { command: "run" });
	assert.deepEqual(parseArgs(["run", "--env-file", "/e"]), { command: "run", envFile: "/e" });
	assert.deepEqual(parseArgs(["--env-file=/e", "run"]), { command: "run", envFile: "/e" });
	assert.deepEqual(parseArgs(["login", "anthropic"]), { command: "login", provider: "anthropic" });
	assert.equal(parseArgs(["login"]).command, "invalid");
	assert.equal(parseArgs(["run", "--env-file"]).command, "invalid");
	assert.equal(parseArgs(["serve"]).command, "invalid");
});
