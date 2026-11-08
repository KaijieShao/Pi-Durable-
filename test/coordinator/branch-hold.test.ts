import assert from "node:assert/strict";
import { test } from "node:test";
import { blocksTaskRuns, parseBranchHold } from "../../src/coordinator/branch-hold.ts";
import { heldApproval, holdNote, reviewHeld } from "../../src/coordinator/messages.ts";

const HEAD = "a".repeat(40);
const legacy = {
	kind: "review",
	runId: 1,
	interrupted: false,
	branch: "task/1",
	local: HEAD,
	pushed: HEAD,
	github: HEAD,
	since: 1,
};

test("persisted branch holds retain legacy compatibility and represent a deleted branch without a fake SHA", () => {
	const old = parseBranchHold(JSON.stringify(legacy));
	assert.deepEqual(old, legacy);
	assert.equal(blocksTaskRuns(old), false);
	const deleted = { ...legacy, github: null, cause: "branch_deleted", prNumber: 7 };
	assert.deepEqual(parseBranchHold(JSON.stringify(deleted)), deleted);
	assert.equal(blocksTaskRuns(parseBranchHold(JSON.stringify(deleted))), true);
	assert.equal(parseBranchHold(JSON.stringify({ ...legacy, cause: "unknown" })), undefined);
	assert.equal(parseBranchHold(JSON.stringify({ ...legacy, github: "missing" })), undefined);
});

for (const cause of ["branch_deleted", "pr_closed"] as const) {
	test(`${cause} notices reject approval, keep the original PR identity and explain restoration`, () => {
		const facts = {
			taskId: 1,
			branch: "task/1",
			local: HEAD,
			pushed: HEAD,
			github: cause === "branch_deleted" ? null : HEAD,
			cause,
			prNumber: 7,
		};
		const text = reviewHeld({ ...facts, runNo: 1, tests: "passed", interrupted: false });
		assert.match(text, /Task 1 is held for review/);
		assert.match(text, /Nothing was merged/);
		assert.match(text, /original pull request #7/);
		assert.match(text, /No replacement pull request/);
		assert.match(text, /other tasks and the group carry on/);
		assert.match(heldApproval(facts), /Task 1 is held/);
		assert.match(holdNote({ ...facts, kind: "review" }), /worktree is retained/);
	});
}
