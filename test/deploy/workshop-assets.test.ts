import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("Workshop preserved assets: private rendering, drift detection, syntax and read-only management", () => {
	const result = spawnSync("python3", ["-B", "test/deploy/workshop_assets_test.py"], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: "1" },
	});
	assert.equal(result.status, 0, result.stdout + result.stderr);
});
