/**
 * The approval-rejection texts (src/coordinator/messages.ts): each names the task, says that the approval was
 * rejected or set aside and that nothing merged, says why, and offers only what the system supports next
 * (Interfaces and Storage § Telegram: "Each rejection gives its reason"; Architecture § Review and merge). Also the
 * texts of a task held because its branch changed on GitHub outside the Coordinator (a definite refusal of its push:
 * which branch, both heads, nothing merged, what is kept and what to do; no freeze).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	approvalBranchChanged,
	approvalLocalMoved,
	approvalMergedElsewhere,
	approvalPrClosed,
	approvalUnfinishedCombine,
	archiveHeld,
	heldApproval,
	heldFollowupNote,
	holdNote,
	mainMoved,
	mergeConflict,
	rejected,
	rejectedApprovalNote,
	reviewHeld,
	reviewReminder,
	runAdmitted,
	staleHead,
} from "../../src/coordinator/messages.ts";

const APPROVED = "5d6e7f80a1b2c3d4e5f60718293a4b5c6d7e8f90";
const ON_GITHUB = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const FACTS = { taskId: 3, branch: "task/3", approvedHead: APPROVED, githubHead: ON_GITHUB };
const COMBINED = "c0ffee00a1b2c3d4e5f60718293a4b5c6d7e8f90";
/** A held task: GitHub's branch is at ON_GITHUB, the Coordinator last pushed APPROVED, the worktree has COMBINED. */
const HELD = { taskId: 3, branch: "task/3", github: ON_GITHUB, local: COMBINED, pushed: APPROVED };
const RESTORE = [
	"What to do: restore task/3 on GitHub to 5d6e7f8, for example from a clone after git fetch origin:",
	`git push --force origin ${APPROVED}:refs/heads/task/3`,
	"(this drops the commits pushed since; save them on another branch first if you need them).",
];
const WHY_MOVED =
	"Why: branch task/3 on GitHub is at 1a2b3c4, but the Coordinator last pushed 5d6e7f8 there: the branch changed " +
	"outside the Coordinator. The Coordinator never overwrites commits on GitHub.";

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
				"The Coordinator never overwrites commits on GitHub: a follow-up run or a /cancel before the branch is " +
					"restored keeps its work in the task's worktree until then. The other tasks and the group carry on.",
			].join("\n"),
		);
	});

	test("the old, false advice is gone: no freeze warning, and nothing posts a head for a commit pushed outside", () => {
		const text = approvalBranchChanged(FACTS);
		assert.doesNotMatch(text, /freeze/, "a refused push holds only this task; the group carries on");
		assert.doesNotMatch(text, /do not reply with a follow-up/);
		assert.doesNotMatch(text, /once the bot posts it/);
		assert.doesNotMatch(text, /approve the new head/);
		assert.doesNotMatch(text, /for a follow-up run/, "a follow-up is not the way to merge the approved head");
	});

	test("the combined result's push was refused: the same steps, and the combination stays in the worktree", () => {
		const text = approvalBranchChanged({ ...FACTS, combined: COMBINED });
		assert.equal(
			text.split("\n")[2],
			"The combination with the latest main, c0ffee0, was not pushed; it stays in the task's worktree, and the " +
				"next approval, follow-up or /cancel builds on it.",
		);
		assert.equal(text.replace(`${text.split("\n")[2]}\n`, ""), approvalBranchChanged(FACTS));
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

describe("a task held because its branch changed on GitHub outside the Coordinator (no freeze)", () => {
	test("a run's checkpoint push refused: which branch, both heads, nothing merged, the kept commit, what to do", () => {
		assert.equal(
			reviewHeld({ ...HELD, runNo: 2, tests: "passed", interrupted: false }),
			[
				"Task 3 finished run 2, but GitHub refused the push of its checkpoint. Nothing was merged.",
				WHY_MOVED,
				"Kept: the run's work is committed in the task's worktree as c0ffee0 (tests: passed); it is not on GitHub yet.",
				...RESTORE,
				"Once that is done, the Coordinator pushes c0ffee0 and posts it for review; approve it then with /approve 3. " +
					"Or send /cancel 3 to drop the task.",
				"Until then /approve 3 is rejected. The other tasks and the group carry on.",
			].join("\n"),
		);
	});

	test("an interrupted run's push refused, and a branch that moved right after the push", () => {
		const interrupted = reviewHeld({ ...HELD, runNo: 2, tests: "failed (failed)", interrupted: true }).split("\n");
		assert.equal(
			interrupted[0],
			"Task 3 was interrupted by restart (run 2), and GitHub refused the push of its work so far. Nothing was merged.",
		);
		assert.match(interrupted[2] ?? "", /as c0ffee0 \(tests: failed \(failed\)\); it is not on GitHub yet\.$/);
		const after = reviewHeld({ ...HELD, local: APPROVED, runNo: 2, tests: "passed", interrupted: false }).split("\n");
		assert.deepEqual(after.slice(0, 3), [
			"Task 3 finished run 2 and its checkpoint was pushed, but then its branch changed on GitHub. Nothing was merged.",
			WHY_MOVED,
			"Kept: the task's worktree, at 5d6e7f8 (tests: passed).",
		]);
		assert.equal(
			after[6],
			"Once that is done, the Coordinator posts 5d6e7f8 for review again; approve it then with /approve 3. Or send " +
				"/cancel 3 to drop the task.",
		);
		assert.match(
			reviewHeld({ ...HELD, local: APPROVED, runNo: 2, tests: "passed", interrupted: true }),
			/^Task 3 was interrupted by restart \(run 2\); its work so far was pushed, but then its branch changed on GitHub\./,
		);
	});

	test("a branch the Coordinator never pushed was created outside it: delete it on GitHub", () => {
		const lines = reviewHeld({ ...HELD, pushed: null, runNo: 1, tests: "passed", interrupted: false }).split("\n");
		assert.deepEqual(lines.slice(1, 6), [
			"Why: branch task/3 exists on GitHub (at 1a2b3c4), but the Coordinator has not pushed it yet: it was created " +
				"outside the Coordinator. The Coordinator never overwrites commits on GitHub.",
			"Kept: the run's work is committed in the task's worktree as c0ffee0 (tests: passed); it is not on GitHub yet.",
			"What to do: delete task/3 on GitHub, for example from a clone:",
			"git push origin --delete task/3",
			"(save its commits on another branch first if you need them).",
		]);
	});

	test("a cancelled or failed task's final push refused: the worktree is kept until the branch is restored", () => {
		assert.equal(
			archiveHeld({ ...HELD, lead: "Task 3 cancelled.", prClosed: true }),
			[
				"Task 3 cancelled. Its worktree is kept: GitHub refused its final push.",
				WHY_MOVED,
				"Kept: the task's work is committed in its worktree as c0ffee0; it is not on GitHub yet. Nothing was merged. " +
					"Its pull request is closed.",
				...RESTORE,
				"Once that is done, the Coordinator pushes c0ffee0 and archives the worktree; the branch is kept.",
			].join("\n"),
		);
		const failed = archiveHeld({ ...HELD, local: APPROVED, lead: "Task 3 failed: limit.", prClosed: false });
		assert.deepEqual(failed.split("\n").slice(0, 3), [
			"Task 3 failed: limit. Its worktree is kept: GitHub refused its final push.",
			WHY_MOVED,
			"Kept: the worktree, at 5d6e7f8. Nothing was merged.",
		]);
	});

	test("/approve while held, /status and the reminder, and a follow-up admitted meanwhile", () => {
		assert.equal(
			rejected("/approve", heldApproval(HELD)),
			"/approve rejected: the latest checkpoint of Task 3, c0ffee0, is not on GitHub yet: branch task/3 changed on " +
				"GitHub outside the Coordinator (it was at 1a2b3c4 when the Coordinator last looked); once it is restored to " +
				"5d6e7f8, the bot pushes c0ffee0 and posts it for review; approve it then.",
		);
		assert.equal(
			rejected("/approve", heldApproval({ ...HELD, local: APPROVED })),
			"/approve rejected: branch task/3 of Task 3 changed on GitHub outside the Coordinator after 5d6e7f8 was pushed " +
				"(it was at 1a2b3c4 when the Coordinator last looked); once it is restored to 5d6e7f8, the bot posts 5d6e7f8 " +
				"for review again; approve it then.",
		);
		assert.match(heldApproval({ ...HELD, pushed: null }), /; once it is deleted, the bot pushes c0ffee0/);
		assert.equal(
			holdNote({ ...HELD, kind: "review" }),
			"Its latest checkpoint c0ffee0 waits until branch task/3 on GitHub is restored to 5d6e7f8: the branch changed " +
				"outside the Coordinator. See the bot's message about it for what to do.",
		);
		assert.equal(
			holdNote({ ...HELD, kind: "archive" }),
			"Its worktree is kept until branch task/3 on GitHub is restored to 5d6e7f8: the branch changed outside the " +
				"Coordinator and GitHub refused the final push. See the bot's message about it for what to do.",
		);
		assert.equal(
			reviewReminder({ taskId: 3, prUrl: null, rejectedNote: holdNote({ ...HELD, kind: "review" }) }),
			"Reminder: Task 3 is waiting for review. Its latest checkpoint c0ffee0 waits until branch task/3 on GitHub is " +
				"restored to 5d6e7f8: the branch changed outside the Coordinator. See the bot's message about it for what to do.",
		);
		assert.equal(
			heldFollowupNote("task/3"),
			"Branch task/3 on GitHub still differs from what the Coordinator pushed, so this run's result is pushed only " +
				"once the branch is restored",
		);
	});
});
