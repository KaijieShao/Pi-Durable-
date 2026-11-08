/**
 * The approval-rejection texts (src/coordinator/messages.ts): each names the task, says that the approval was
 * rejected or set aside and that nothing merged, says why, and offers only what the system supports next
 * (Interfaces and Storage § Telegram: "Each rejection gives its reason"; Architecture § Review and merge).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	approvalBranchChanged,
	approvalLocalMoved,
	approvalMergedElsewhere,
	approvalPrClosed,
	approvalUnfinishedCombine,
	mainMoved,
	mergeConflict,
	rejected,
	rejectedApprovalNote,
	reviewReminder,
	runAdmitted,
	staleHead,
} from "../../src/coordinator/messages.ts";

const APPROVED = "5d6e7f80a1b2c3d4e5f60718293a4b5c6d7e8f90";
const ON_GITHUB = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const FACTS = { taskId: 3, branch: "task/3", approvedHead: APPROVED, githubHead: ON_GITHUB };

describe("merge step: the pull request head on GitHub is not the approved head", () => {
	test("pushed outside the Coordinator: why (both heads, outside) and what to do (restore, then /approve or /cancel)", () => {
		assert.equal(
			approvalBranchChanged(FACTS),
			[
				"Approval of Task 3 rejected; nothing was merged.",
				"Why: branch task/3 on GitHub is at 1a2b3c4, but the approval was for 5d6e7f8, the head the bot posted. " +
					"The branch changed outside the Coordinator.",
				"What to do: restore task/3 on GitHub to 5d6e7f8, for example from a clone after git fetch origin:",
				`git push --force origin ${APPROVED}:refs/heads/task/3`,
				"(this drops the commits pushed since; save them on another branch first if you need them). " +
					"Then send /approve 3 again to approve that head, or /cancel 3 to drop the task.",
				"Until the branch is restored, do not reply with a follow-up or send /cancel 3: the Coordinator never " +
					"overwrites commits on GitHub, so its push would be refused and the group would freeze.",
			].join("\n"),
		);
	});

	test("the old, false advice is gone: nothing will ever post a head for a commit pushed outside the Coordinator", () => {
		const text = approvalBranchChanged(FACTS);
		assert.doesNotMatch(text, /once the bot posts it/);
		assert.doesNotMatch(text, /approve the new head/);
		assert.doesNotMatch(text, /for a follow-up run/, "a follow-up would push onto the foreign commit and freeze");
	});

	test("pushed by the Coordinator itself (an interrupted combine with main): a follow-up run or /cancel", () => {
		assert.equal(
			approvalUnfinishedCombine(FACTS),
			[
				"Approval of Task 3 rejected; nothing was merged.",
				"Why: branch task/3 on GitHub is at 1a2b3c4, but the approval was for 5d6e7f8, the head the bot posted. " +
					"1a2b3c4 was pushed by the Coordinator itself: an earlier merge attempt combined the task with the latest " +
					"main and was interrupted before it posted the result.",
				"What to do: reply to a message of Task 3 for a follow-up run, then approve the head the bot posts after " +
					"it; or send /cancel 3.",
			].join("\n"),
		);
	});

	test("merged on GitHub at another head: the Coordinator merged nothing; the owner checks main; /cancel to close", () => {
		assert.equal(
			approvalMergedElsewhere(FACTS),
			[
				"Approval of Task 3 rejected; the Coordinator merged nothing.",
				"Why: the pull request of Task 3 was merged on GitHub outside the Coordinator, at 1a2b3c4 instead of the " +
					"approved head 5d6e7f8. Main on GitHub now contains that merge; the group owner should check it.",
				"What to do: this pull request cannot be merged again. To close the task, make sure branch task/3 on " +
					"GitHub is at 5d6e7f8 or deleted (restore it if it changed), then send /cancel 3.",
			].join("\n"),
		);
	});

	test("closed on GitHub: branch at the approved head, then reopen and /approve again, or /cancel", () => {
		assert.equal(
			approvalPrClosed(FACTS),
			[
				"Approval of Task 3 rejected; nothing was merged.",
				"Why: the pull request of Task 3 was closed on GitHub outside the Coordinator.",
				"What to do: make sure branch task/3 on GitHub is at 5d6e7f8, the approved head (restore it if it was " +
					"changed or deleted). Then reopen the pull request on GitHub and send /approve 3 again, or send " +
					"/cancel 3 to drop the task.",
			].join("\n"),
		);
	});

	test("GitHub has the approved head but the Coordinator's record moved: says so, and to check before approving", () => {
		assert.equal(
			approvalLocalMoved({ ...FACTS, localHead: ON_GITHUB }),
			[
				"Approval of Task 3 rejected; nothing was merged.",
				"Why: the Coordinator's record of branch task/3 is at 1a2b3c4, not at the approved head 5d6e7f8 (GitHub " +
					"still has 5d6e7f8).",
				"What to do: this is not expected; the group owner should check /status 3 and the Coordinator's log " +
					"before anyone approves it again.",
			].join("\n"),
		);
		assert.match(approvalLocalMoved({ ...FACTS, localHead: null }), /is at no commit, not at the approved head/);
	});
});

describe("merge step: approval set aside because main moved or conflicts", () => {
	test("main moved, combined result passed: why (the approval does not cover it) and /approve it", () => {
		assert.equal(
			mainMoved({ taskId: 2, approvedHead: APPROVED, head: ON_GITHUB, tests: "passed", testsPassed: true }),
			"Main moved; Task 2 was combined with the latest main and retested (passed). Head: 1a2b3c4. Nothing was " +
				"merged: the approval of 5d6e7f8 does not cover this combined result, so approve it with /approve 2.",
		);
	});

	test("main moved, combined result failed: it cannot merge, so a follow-up rather than /approve", () => {
		const text = mainMoved({
			taskId: 2,
			approvedHead: APPROVED,
			head: ON_GITHUB,
			tests: "failed (failed)",
			testsPassed: false,
		});
		assert.equal(
			text,
			"Main moved; Task 2 was combined with the latest main and retested (failed (failed)). Head: 1a2b3c4. " +
				"Nothing was merged: the approval of 5d6e7f8 does not cover this combined result, and it cannot merge " +
				"until its tests pass. Reply to this message for a follow-up to fix them, then approve the head the bot " +
				"posts after it.",
		);
		assert.doesNotMatch(text, /\/approve 2/);
	});

	test("conflict, fix run admitted: files, nothing merged, why, and approve the fixed head", () => {
		assert.equal(
			mergeConflict({ taskId: 2, approvedHead: APPROVED, files: "README.md", admitted: { position: 1 } }),
			"Merge conflict in: README.md. Nothing was merged: Task 2 could not be combined with the latest main, so " +
				"the approval of 5d6e7f8 no longer applies. A run of Task 2 was admitted to resolve it (queue position 1); " +
				"when the bot posts its result, review it and approve the new head with /approve 2.",
		);
	});

	test("conflict, fix run not queued: the reason, and reply to start the fix", () => {
		assert.equal(
			mergeConflict({
				taskId: 2,
				approvedHead: APPROVED,
				files: "a.js, b.js",
				admitted: { refused: "queue full: 3 waiting tasks for agent alpha" },
			}),
			"Merge conflict in: a.js, b.js. Nothing was merged: Task 2 could not be combined with the latest main, so " +
				"the approval of 5d6e7f8 no longer applies. The conflict-fix run could not be queued (queue full: 3 " +
				"waiting tasks for agent alpha); reply to this message to start the conflict fix when the queue has " +
				"room, then approve the head the bot posts after it.",
		);
	});
});

describe("/approve refused at command time", () => {
	test("a run was admitted: first run, conflict fix, follow-up after a posted head, follow-up without one", () => {
		assert.equal(
			rejected("/approve", runAdmitted({ taskId: 4, postedHead: null, kind: "initial" })),
			"/approve rejected: Task 4 is still on its first run, so the bot has not posted a head to approve yet; " +
				"wait for its review message, then send /approve 4.",
		);
		assert.equal(
			rejected("/approve", runAdmitted({ taskId: 4, postedHead: null, kind: "conflict" })),
			"/approve rejected: a conflict-fix run of Task 4 is queued or running, so there is no head to approve yet; " +
				"wait for the bot to post its result, then approve the new head with /approve 4.",
		);
		assert.equal(
			rejected("/approve", runAdmitted({ taskId: 4, postedHead: APPROVED, kind: "followup" })),
			"/approve rejected: a new run of Task 4 was admitted, so 5d6e7f8, the head the bot last posted, is no " +
				"longer what would merge; wait for the bot to post that run's result, then approve its new head with " +
				"/approve 4.",
		);
		assert.equal(
			rejected("/approve", runAdmitted({ taskId: 4, postedHead: null, kind: "followup" })),
			"/approve rejected: a new run of Task 4 is queued or running and the bot has not posted a head to approve " +
				"yet; wait for the bot to post its result, then send /approve 4.",
		);
	});

	test("the branch is not at the posted head, nothing was posted, or a conflict waits for its fix", () => {
		assert.equal(
			rejected("/approve", staleHead({ taskId: 5, head: ON_GITHUB, postedHead: APPROVED, conflict: false })),
			"/approve rejected: the branch of Task 5 is at 1a2b3c4, but the bot last posted 5d6e7f8; reply to a message " +
				"of Task 5 for a follow-up run, then approve the head the bot posts after it.",
		);
		assert.equal(
			rejected("/approve", staleHead({ taskId: 5, head: ON_GITHUB, postedHead: null, conflict: false })),
			"/approve rejected: the bot has not posted a head of Task 5 to approve; reply to a message of Task 5 for a " +
				"follow-up run, then approve the head the bot posts after it.",
		);
		assert.equal(
			rejected("/approve", staleHead({ taskId: 5, head: ON_GITHUB, postedHead: null, conflict: true })),
			"/approve rejected: the merge of Task 5 with the latest main stopped with a conflict, so there is no head to " +
				"approve yet; reply to a message of Task 5 to start the conflict fix, then approve the head the bot posts " +
				"after it.",
		);
	});
});

describe("after a rejected approval: the review reminder points back to the rejection", () => {
	const changed = { head_commit: APPROVED, state: "invalidated", reason: "branch changed after approval" };
	const url = "https://github.com/acme/demo/pull/9";

	test("branch changed or pull request closed, nothing posted since: see that message, no follow-up offered", () => {
		const note = rejectedApprovalNote(changed, APPROVED);
		assert.equal(
			reviewReminder({ taskId: 3, prUrl: url, rejectedNote: note }),
			`Reminder: Task 3 is waiting for review. Pull request: ${url}. Its last approval was rejected because the ` +
				"branch changed after approval; see that message for what to do next.",
		);
		assert.equal(
			rejectedApprovalNote({ ...changed, reason: "pull request closed" }, APPROVED),
			"Its last approval was rejected because the pull request was closed on GitHub; see that message for what to " +
				"do next.",
		);
	});

	test("otherwise the usual next step: never approved, other reasons, still valid, or a new head posted since", () => {
		assert.equal(
			reviewReminder({ taskId: 3, prUrl: null, rejectedNote: rejectedApprovalNote(undefined, APPROVED) }),
			"Reminder: Task 3 is waiting for review. Reply to this message for a follow-up, or send /approve 3.",
		);
		assert.equal(rejectedApprovalNote({ ...changed, reason: "tests failed" }, APPROVED), undefined);
		assert.equal(rejectedApprovalNote({ ...changed, reason: "main moved" }, APPROVED), undefined);
		assert.equal(rejectedApprovalNote({ ...changed, state: "valid" }, APPROVED), undefined);
		assert.equal(rejectedApprovalNote(changed, ON_GITHUB), undefined);
		assert.equal(rejectedApprovalNote(changed, null), undefined);
	});
});
