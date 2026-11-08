/**
 * Sealing and the isolated evaluator, end to end through the real Coordinator against 127.0.0.1 fakes (Architecture
 * § Sealing, § Isolated evaluator, § Request Flow; Capacity § Evaluator, § Exclusive phases; Deployment § Evaluation
 * exclusivity; Evaluation § What's Graded, § Frozen Before Trial 1). The trigger is the owner CLI (`owner seal`, the
 * trial harness's); the evaluator is the local test evaluator (sandbox/local.ts) running the evaluator image's own
 * launcher and suite list on the host (test/helpers/evaluator.ts), over the snapshot, the hidden tests and the scratch
 * directory the Coordinator hands it. The real Docker evaluator: test/coordinator/evaluator-docker.test.ts.
 *
 *   - A seal is refused, with each reason, while a trial task is not merged; nothing changes.
 *   - Sealing holds dispatch (a /task is accepted and queued, with the sealing note), merges (an /approve is accepted,
 *     its merge waits) and follow-up delivery (a reply to the running task is saved, never steered in); the active run
 *     finishes and is finalized (review step included) first; the evaluator starts only when nothing executes.
 *   - The snapshot is the merged main (the trial task's change, not the unmerged ones), read-only, with its manifest
 *     and content hash, unchanged after the evaluation; the evaluator gets it, the configured hidden tests and a fresh
 *     scratch directory; the per-suite results and what the trial records are stored, the result is posted, and only
 *     after the verified cleanup (scratch wiped) does dispatch reopen: the queued task, the follow-up's run and the
 *     held merge then go on.
 *   - Dispatch is held deployment-wide: an evaluation of another group of the deployment holds this group's dispatch;
 *     one evaluation at a time.
 *   - A cleanup that cannot be verified, or an evaluator that cannot start (or has no scratch space), freezes the group
 *     (result recorded).
 *   - A restart during the evaluation: recorded as interrupted (not graded), cleanup verified, dispatch reopens.
 *   - A freeze while sealing stops the sealing: nothing is graded, the group stays frozen.
 *   - A restart while sealing: restart recovery's jobs (a review step's tests) finish and execution is verified
 *     stopped again before a snapshot phase goes on; no recovery job runs while the evaluator runs or is cleaned up.
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { treeHash } from "../../src/coordinator/engine/snapshot.ts";
import type { Evaluator, EvaluatorSpec, Sandbox } from "../../src/coordinator/ports.ts";
import { Store } from "../../src/coordinator/store.ts";
import type { ServerMessage } from "../fixtures/fake-bot-api.ts";
import { sleep } from "../helpers/env.ts";
import { nodeSuite } from "../helpers/evaluator.ts";
import type { FakeHandler, FakeStep } from "../helpers/fake-model.ts";
import {
	agentPosition,
	GROUP,
	nodeTestCheck,
	OWNER,
	type Stack,
	type StackOptions,
	startStack,
	USER1,
	USER2,
} from "./harness.ts";

const SIGNUP_JS = "exports.signup = (email) => /^[^@\\s]+@[^@\\s]+$/.test(email);\n";
const NOTES_JS = "exports.notes = [];\n";
const EXTRA_JS = "exports.extra = 1;\n";
const LATER_JS = "exports.later = 1;\n";

/** The hidden tests: one module (signup), the integration test, the baseline suite. */
const HIDDEN: Readonly<Record<string, string>> = {
	...nodeSuite("modules/signup", "signup.test.js", [
		{
			id: "accepts-email",
			name: "accepts an email",
			body: 'assert.equal(await app.call("signup.js", "signup", ["ana@example.com"]), true);',
		},
		{
			id: "rejects-junk",
			name: "refuses junk",
			body: 'assert.equal(await app.call("signup.js", "signup", ["junk"]), false);',
		},
	]),
	...nodeSuite("integration", "flow.test.js", [
		{
			id: "flow",
			name: "signup flow",
			body: 'assert.equal(await app.evaluate(\'const {signup} = await importModule("signup.js"); const {version} = await importModule("index.js"); return signup("b@c.d") && version;\'), 1);',
		},
	]),
	...nodeSuite("baseline", "version.test.js", [
		{ id: "version", name: "version", body: 'assert.equal(await app.call("index.js", "version"), 1);' },
	]),
};

type Gate = { readonly opened: Promise<void>; open(): void };

function gate(): Gate {
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open: () => open() };
}

const write = (path: string, content: string): FakeStep => ({
	toolCalls: [{ name: "write", args: { path, content } }],
});

type Step = FakeStep | (() => Promise<FakeStep>);

/** The plan whose `when` matches the run's newest user message; step k answers after k tool rounds. */
function agent(plans: readonly { when: RegExp; steps: readonly Step[] }[]): FakeHandler {
	return async (request) => {
		const { input, round } = agentPosition(request);
		const plan = plans.find((candidate) => candidate.when.test(input));
		const step = plan?.steps[round] ?? plan?.steps.at(-1) ?? { text: "no plan" };
		return typeof step === "function" ? step() : step;
	};
}

type EvaluationRow = {
	id: number;
	chat_id: number;
	trial: string;
	state: string;
	tasks: string;
	snapshot_commit: string | null;
	snapshot_tree: string | null;
	snapshot_hash: string | null;
	snapshot_path: string | null;
	scratch_path: string | null;
	outcome: string | null;
	reason: string | null;
	suites: string | null;
	facts: string | null;
	cleanup_verified: number | null;
	started_ok: number | null;
};

function evaluations(stack: Stack): EvaluationRow[] {
	return stack.coordinator.store.all<EvaluationRow>("SELECT * FROM evaluations ORDER BY id");
}

function groupState(stack: Stack): string {
	return stack.coordinator.store.groupState(GROUP).state;
}

async function stackFor(t: TestContext, options: StackOptions): Promise<Stack> {
	const stack = await startStack({ hiddenTests: HIDDEN, ...options });
	t.after(() => stack.stop());
	return stack;
}

/** Send a command and wait for the bot's reply to it. */
async function command(stack: Stack, userId: number, text: string): Promise<ServerMessage> {
	const since = stack.lastBotMessageId();
	const sent = stack.sendCommand(userId, text);
	return stack.waitForBotMessage((message) => message.replyTo === sent, { since });
}

async function replyTo(stack: Stack, userId: number, messageId: number, text: string): Promise<ServerMessage> {
	const since = stack.lastBotMessageId();
	const sent = stack.reply(userId, messageId, text);
	return stack.waitForBotMessage((message) => message.replyTo === sent, { since });
}

const mode = (path: string): number => lstatSync(path).mode & 0o777;

/** What the evaluator saw when the Coordinator started it, recorded by a wrapper around the local evaluator. */
type Seen = {
	spec: EvaluatorSpec;
	activeRuns: number;
	slots: number;
	runStates: Record<number, string>;
	mergeCalls: number;
	modelRequests: number;
	snapshotWritable: boolean;
	snapshotFiles: string[];
	scratchFiles: string[];
	mainSha: string;
	signup: string;
};

/** Wrap the evaluator: record what the Coordinator gives it and what holds at that moment (`look`). */
function spy(seen: Seen[], look: (spec: EvaluatorSpec) => Promise<Seen>): (evaluator: Evaluator) => Evaluator {
	return (evaluator) => ({
		...evaluator,
		run: async (spec) => {
			seen.push(await look(spec));
			return evaluator.run(spec);
		},
	});
}

async function canWrite(dir: string): Promise<boolean> {
	try {
		await writeFile(join(dir, "intruder.txt"), "x");
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------------------------------------------

test("sealing: refused while a trial task is not merged; then dispatch, merges and follow-up delivery are held, the active run finishes first, the merged main is graded read-only, the result is recorded and posted, and dispatch reopens only after the verified cleanup", {
	timeout: 240_000,
}, async (t) => {
	const notesArrived = gate();
	const notesRelease = gate();
	const seen: Seen[] = [];
	let stackRef: Stack | undefined;
	const look = async (spec: EvaluatorSpec): Promise<Seen> => {
		const stack = stackRef as Stack;
		const store = stack.coordinator.store;
		const runStates = Object.fromEntries(
			store
				.all<{ task_id: number; state: string }>("SELECT task_id, state FROM runs ORDER BY id")
				.map((row) => [row.task_id, row.state]),
		);
		return {
			spec,
			activeRuns: stack.coordinator.engine.activeRuns().length,
			slots: store.get<{ n: number }>("SELECT COUNT(*) AS n FROM slots")?.n ?? -1,
			runStates,
			mergeCalls: stack.github.calls.filter((call) => call.method === "PUT" && /\/merge$/.test(call.path)).length,
			modelRequests: stack.model.requests.length,
			snapshotWritable: await canWrite(spec.snapshot),
			snapshotFiles: readdirSync(spec.snapshot).sort(),
			scratchFiles: readdirSync(spec.scratch),
			mainSha: await stack.mainSha(),
			signup: readFileSync(join(spec.snapshot, "signup.js"), "utf8"),
		};
	};
	const stack = await stackFor(t, {
		model: agent([
			{ when: /^SIGNUP/, steps: [write("signup.js", SIGNUP_JS), { text: "Added signup.js." }] },
			{
				when: /^NOTES/,
				steps: [
					write("notes.js", NOTES_JS),
					async () => {
						notesArrived.open();
						await notesRelease.opened;
						return { text: "Added notes.js." };
					},
				],
			},
			{ when: /^EXTRA/, steps: [write("extra.js", EXTRA_JS), { text: "Added extra.js." }] },
			{ when: /^LATER/, steps: [write("later.js", LATER_JS), { text: "Added later.js." }] },
			{ when: /^FOLLOW/, steps: [{ text: "Followed up." }] },
		]),
		wrap: { evaluator: spy(seen, look) },
	});
	stackRef = stack;

	// Task 1 (the trial's task) merges; Task 2 runs (held in its second model call); Task 3 waits in review.
	await command(stack, USER1, "/task alpha SIGNUP: add signup.js");
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	await command(stack, USER1, "/approve 1");
	await stack.waitForBotMessage(/^Task 1 merged into main/);
	const notesAck = await command(stack, USER2, "/task beta NOTES: add notes.js");
	await notesArrived.opened;
	await command(stack, USER1, "/task alpha EXTRA: add extra.js");
	await stack.waitForBotMessage(/^Task 3 is ready for review \(run 1\)/);

	// The trial's tasks by default: every task since the last evaluation (none yet): 1, 2 and 3; two are not merged.
	const refused = await stack.owner("seal");
	assert.equal(refused.code, 1);
	assert.match(
		refused.stderr,
		/^Sealing of group -?\d+ refused: the trial's tasks must all be merged first; not merged: Task 2 \(running\), Task 3 \(in review\)\./,
	);
	assert.match(refused.stderr, /name them with --tasks <id,\.\.\.> to choose/);
	assert.deepEqual(evaluations(stack), []);
	assert.equal(groupState(stack), "normal");
	const badTrial = await stack.owner("seal", "--trial", "t1", "--tasks", "1,3");
	assert.equal(badTrial.code, 1);
	assert.match(badTrial.stderr, /not merged: Task 3 \(in review\)/);

	const sealed = await stack.owner("seal", "--trial", "t1", "--tasks", "1");
	assert.equal(sealed.code, 0, sealed.stderr);
	assert.match(
		sealed.stdout,
		/^Sealing started for trial t1 \(group -?\d+\)\. Trial tasks \(named\): Task 1, all merged\./,
	);
	await stack.waitForBotMessage(
		/^Sealing for trial t1: the trial's tasks \(Task 1\) are merged\. Dispatch is held across the deployment/,
	);
	assert.equal(groupState(stack), "sealing");
	const again = await stack.owner("seal", "--trial", "t2", "--tasks", "1");
	assert.equal(again.code, 1);
	assert.match(again.stderr, /trial t1 is being sealed and evaluated; one evaluation at a time/);

	// While sealing: a new /task is accepted and queued; a reply to the running task is saved but not delivered; an
	// approval is accepted and its merge held.
	const later = await command(stack, USER1, "/task alpha LATER: add later.js");
	assert.match(
		later.text,
		/^Task 4 accepted for agent alpha\. Queue position 1\. Waiting: dispatch is held while the group is sealed/,
	);
	const follow = await replyTo(stack, USER2, notesAck.id, "FOLLOW: also list the notes");
	assert.match(follow.text, /^Follow-up saved, not delivered yet: the group is sealing for an evaluation/);
	const approve = await command(stack, USER1, "/approve 3");
	assert.match(approve.text, /^Approved Task 3 at [0-9a-f]{7}; .*Merges are held while the group is sealed/);
	await sleep(1500);
	assert.equal(seen.length, 0, "no evaluator while a run is active");
	const status = await stack.owner("status");
	assert.match(status.stdout, /\nGroup -?\d+: sealing \(reason: trial t1\)/);
	assert.match(
		status.stdout,
		/\nEvaluation in progress: trial t1, sealing \(finishing the runs and merge tests in progress\) since \S+; waiting for 1 active run to finish; trial tasks: Task 1\./,
	);
	const queued = stack.runs<{ task_id: number; state: string }>().find((run) => run.task_id === 4);
	assert.equal(queued?.state, "queued");
	const pending = stack.followups<{ state: string; mode: string }>()[0];
	assert.deepEqual({ ...pending }.state, "pending");
	assert.ok(
		!stack.model.requests.some((request) => JSON.stringify(request.body).includes("FOLLOW")),
		"the reply was not steered into the running task",
	);

	// The active run finishes (and is finalized: its review step) before anything is graded.
	notesRelease.open();
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/);
	await stack.waitForBotMessage(/^Follow-up started another run of Task 2/);
	const result = await stack.waitForBotMessage(/^Evaluation of trial t1: /, { timeoutMs: 120_000 });
	assert.match(
		result.text,
		/^Evaluation of trial t1: PASSED\. Snapshot of main at [0-9a-f]{7}\. Trial tasks: Task 1\. Suites \(3 of 3 passed\): module:signup passed, integration passed, baseline passed\. Dispatch has reopened\.$/,
	);

	// What held while the evaluator ran.
	assert.equal(seen.length, 1, "one evaluator run");
	const at = seen[0] as Seen;
	assert.equal(at.activeRuns, 0, "no run active during the evaluation");
	assert.equal(at.slots, 0, "no execution slot held during the evaluation");
	assert.equal(at.runStates[4], "queued", "the /task accepted while sealing waited");
	assert.equal(at.runStates[2], "queued", "the follow-up's run waited (Task 2's latest run)");
	assert.equal(at.mergeCalls, 1, "only Task 1's merge: the approval made while sealing was held");
	assert.ok(
		!stack.model.requests.slice(0, at.modelRequests).some((request) => JSON.stringify(request.body).includes("FOLLOW")),
		"the follow-up reached the model only after the evaluation",
	);
	// The snapshot: the merged main (Task 1's change; not the unmerged Tasks 2 and 3), read-only.
	const [row] = evaluations(stack);
	assert.ok(row !== undefined);
	assert.equal(row.snapshot_commit, at.mainSha, "the snapshot is main as it was sealed");
	assert.equal(at.signup, SIGNUP_JS);
	assert.ok(at.snapshotFiles.includes("signup.js") && !at.snapshotFiles.includes("notes.js"), at.snapshotFiles.join());
	assert.ok(!at.snapshotFiles.includes("extra.js") && !at.snapshotFiles.includes(".git"), at.snapshotFiles.join());
	assert.equal(at.snapshotWritable, false, "the snapshot is read-only");
	assert.equal(at.spec.snapshot, row.snapshot_path);
	assert.equal(
		at.spec.snapshot,
		join(stack.config.paths.taskDir, "snapshots", `t1-${row.snapshot_commit?.slice(0, 12)}`),
	);
	assert.equal(at.spec.hiddenTests, stack.config.evaluation.hiddenTestsDir);
	assert.equal(at.spec.hiddenTests, join(stack.dir, "hidden"));
	assert.equal(at.spec.scratch, row.scratch_path);
	assert.ok(at.spec.scratch.startsWith(join(stack.config.paths.taskDir, "eval-scratch")));
	assert.deepEqual(at.scratchFiles, [], "a fresh scratch directory");
	assert.equal(at.spec.deadlineMs, 30 * 60_000);

	// Recorded: outcome per suite, the snapshot (immutable: the hash still matches), what the trial records.
	assert.equal(row.state, "done");
	assert.equal(row.outcome, "passed");
	assert.equal(row.cleanup_verified, 1);
	assert.equal(row.started_ok, 1);
	assert.deepEqual(
		JSON.parse(row.suites ?? "[]").map((suite: { name: string; outcome: string }) => `${suite.name}=${suite.outcome}`),
		["module:signup=passed", "integration=passed", "baseline=passed"],
	);
	const path = row.snapshot_path as string;
	assert.equal((await treeHash(path)).hash, row.snapshot_hash, "unchanged after the evaluation");
	assert.equal(mode(path), 0o555);
	assert.equal(mode(join(path, "signup.js")), 0o444);
	const manifest = JSON.parse(readFileSync(`${path}.manifest.json`, "utf8"));
	assert.equal(mode(`${path}.manifest.json`), 0o444);
	assert.deepEqual(
		[manifest.trial, manifest.commit, manifest.tree, manifest.hash],
		["t1", row.snapshot_commit, row.snapshot_tree, row.snapshot_hash],
	);
	const facts = JSON.parse(row.facts ?? "{}");
	assert.equal(facts.toolPolicyVersion, "1");
	assert.equal(facts.versions["@earendil-works/pi-durable"], "1.5.0");
	assert.equal(facts.versions.patches, "none");
	assert.deepEqual(facts.limits.evaluator, { cpus: 2, memoryMiB: 2048, pids: 512 });
	assert.deepEqual(facts.limits.agent, { cpus: 0.5, memoryMiB: 512, pids: 128 });
	assert.match(facts.images.evaluator.imageId, /^sha256:/);
	assert.match(facts.hiddenTests.hash, /^sha256:[0-9a-f]{64}$/);
	assert.equal(facts.hiddenTests.files, 6);
	assert.equal(existsSync(row.scratch_path as string), false, "the scratch directory was wiped");
	assert.equal(groupState(stack), "normal");

	// Dispatch reopened: the queued task runs, the follow-up's run runs, the held merge merges.
	await stack.waitForBotMessage(/^Task 4 is ready for review \(run 1\)/, { since: result.id });
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 2\)/, { since: result.id });
	await stack.waitForBotMessage(/^Task 3 merged into main/, { since: result.id });
	const done = await stack.owner("status");
	assert.match(
		done.stdout,
		/\nLast evaluation: trial t1 PASSED at \S+; snapshot [0-9a-f]{7} at \S+; trial tasks: Task 1; suites: module:signup passed, integration passed, baseline passed; cleanup verified\n/,
	);
	assert.doesNotMatch(done.stdout, /Evaluation in progress/);
	// A trial is evaluated once.
	const rerun = await stack.owner("seal", "--trial", "t1", "--tasks", "1");
	assert.equal(rerun.code, 1);
	assert.match(rerun.stderr, /trial t1 was evaluated already \(a trial is never rerun or replaced\)/);
});

test("dispatch is held deployment-wide: an evaluation of another group holds this group's dispatch; one at a time", {
	timeout: 120_000,
}, async (t) => {
	const stack = await stackFor(t, {
		model: agent([{ when: /^LATER/, steps: [write("later.js", LATER_JS), { text: "Added later.js." }] }]),
	});
	const store = stack.coordinator.store;
	// Another group of the deployment is sealing (its evaluation in progress).
	store.tx(() => {
		store.run(
			"INSERT INTO groups(chat_id, state, reason, recheck_required, updated_at) VALUES (-42, 'sealing', 'trial x', 0, 1)",
		);
		store.run(
			`INSERT INTO evaluations(chat_id, trial, state, tasks, last_task_id, requested_at)
			 VALUES (-42, 'other', 'evaluating', '[]', 0, 1)`,
		);
	});
	const ack = await command(stack, USER1, "/task alpha LATER: add later.js");
	assert.match(ack.text, /Waiting: dispatch is held while the group is sealed for an evaluation/);
	await sleep(2000);
	assert.equal(stack.runs<{ state: string }>()[0]?.state, "queued");
	assert.equal(stack.model.requests.length, 0);
	const busy = await stack.owner("seal");
	assert.equal(busy.code, 1);
	assert.match(busy.stderr, /trial other is being sealed and evaluated; one evaluation at a time/);
	const status = await stack.owner("status");
	assert.match(
		status.stdout,
		/\nEvaluation in progress: trial other \(group -42\), the evaluator is grading the snapshot/,
	);
	// That evaluation ends: this group's queued task dispatches.
	store.tx(() => {
		store.run("UPDATE evaluations SET state = 'done', outcome = 'passed' WHERE trial = 'other'");
		store.run("UPDATE groups SET state = 'normal' WHERE chat_id = -42");
	});
	stack.coordinator.engine.kick();
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
});

test("an evaluator cleanup that cannot be verified freezes the group (the result is recorded); so does an evaluator that cannot start, or whose scratch space cannot be created", {
	timeout: 120_000,
}, async (t) => {
	let stuck = true;
	const stack = await stackFor(t, {
		wrap: {
			evaluator: (evaluator) => ({
				...evaluator,
				live: async () => (stuck ? ["pd-e-stuck"] : evaluator.live()),
				killAll: async () => {},
			}),
		},
	});
	const sealed = await stack.owner("seal", "--trial", "c1");
	assert.equal(sealed.code, 0, sealed.stderr);
	assert.match(sealed.stdout, /Trial tasks \(every task of the group since the last evaluation\): none, all merged/);
	// Main as it is (no trial task added signup.js): the module and integration suites fail, the baseline passes.
	const result = await stack.waitForBotMessage(/^Evaluation of trial c1: /, { timeoutMs: 60_000 });
	assert.equal(
		result.text,
		`Evaluation of trial c1: NOT PASSED. Snapshot of main at ${(await stack.mainSha()).slice(0, 7)}. Trial tasks: none. ` +
			"Suites (1 of 3 passed): module:signup failed (exit 1), integration failed (exit 1), baseline passed. The group " +
			"is frozen; only the owner CLI can unfreeze it.",
	);
	await stack.waitForBotMessage(
		/^Group frozen: the evaluator's cleanup for trial c1 could not be verified \(the evaluator container could not be verified gone\)/,
	);
	assert.equal(groupState(stack), "frozen");
	const [row] = evaluations(stack);
	assert.deepEqual([row?.state, row?.outcome, row?.cleanup_verified], ["done", "not_passed", 0]);
	const rejected = await command(stack, USER1, "/task alpha anything");
	assert.match(rejected.text, /^Task request rejected: The group is frozen/);
	// Resolved (the container is gone): the owner's unfreeze repeats the recovery checks and reopens dispatch.
	stuck = false;
	const unfrozen = await stack.owner("unfreeze");
	assert.equal(unfrozen.code, 0, unfrozen.stderr);
	assert.equal(groupState(stack), "normal");

	// An evaluator that cannot start: frozen, recorded as not evaluated.
	const failing = await stackFor(t, {
		wrap: {
			evaluator: (evaluator) => ({ ...evaluator, run: async () => ({ kind: "not_started", reason: "no image" }) }),
		},
	});
	assert.equal((await failing.owner("seal", "--trial", "c2")).code, 0);
	const failed = await failing.waitForBotMessage(/^Evaluation of trial c2: /, { timeoutMs: 60_000 });
	assert.match(
		failed.text,
		/^Evaluation of trial c2: NOT EVALUATED: the evaluator could not start\..* Suites \(0 of 0 passed\): none graded\. The group is frozen/,
	);
	await failing.waitForBotMessage(/^Group frozen: the evaluator for trial c2 could not start\./);
	assert.equal(failing.coordinator.store.groupState(GROUP).state, "frozen");
	const [record] = evaluations(failing);
	assert.deepEqual([record?.outcome, record?.started_ok, record?.cleanup_verified], ["error", 0, 1]);

	// Its scratch space cannot be created (task disk trouble): it never starts, and the group freezes.
	let ran = false;
	const noScratch = await stackFor(t, {
		wrap: {
			evaluator: (evaluator) => ({
				...evaluator,
				createScratch: async () => {
					throw new Error("no space left on device");
				},
				run: async (spec) => {
					ran = true;
					return evaluator.run(spec);
				},
			}),
		},
	});
	assert.equal((await noScratch.owner("seal", "--trial", "c3")).code, 0);
	const noSpace = await noScratch.waitForBotMessage(/^Evaluation of trial c3: /, { timeoutMs: 60_000 });
	assert.match(
		noSpace.text,
		/^Evaluation of trial c3: NOT EVALUATED: the evaluator's scratch space could not be created\..* The group is frozen/,
	);
	await noScratch.waitForBotMessage(/^Group frozen: the evaluator for trial c3 could not start\./);
	assert.equal(ran, false, "no evaluator without its scratch space");
	const [noSpaceRow] = evaluations(noScratch);
	assert.deepEqual([noSpaceRow?.outcome, noSpaceRow?.started_ok, noSpaceRow?.scratch_path], ["error", 0, null]);

	// A failed application transport is a failed trial, not an unverified stop. Verified cleanup reopens dispatch.
	const transportFailure = await stackFor(t, {
		wrap: {
			evaluator: (evaluator) => ({
				...evaluator,
				run: async () => ({ kind: "ran", end: "error", suites: [], durationMs: 0, subjectFailed: true }),
			}),
		},
	});
	assert.equal((await transportFailure.owner("seal", "--trial", "c4")).code, 0);
	const transportResult = await transportFailure.waitForBotMessage(/^Evaluation of trial c4: /, { timeoutMs: 60_000 });
	assert.match(transportResult.text, /NOT PASSED.*Dispatch has reopened\.$/);
	assert.equal(groupState(transportFailure), "normal");
	const [transportRow] = evaluations(transportFailure);
	assert.deepEqual(
		[transportRow?.state, transportRow?.outcome, transportRow?.cleanup_verified],
		["done", "not_passed", 1],
	);
	assert.ok(transportRow?.scratch_path);
	assert.equal(existsSync(transportRow.scratch_path), false);
});

test("a restart during the evaluation: recorded as interrupted (not graded), its cleanup verified, then dispatch reopens and the queued task runs", {
	timeout: 180_000,
}, async (t) => {
	const started = gate();
	const stack = await stackFor(t, {
		model: agent([{ when: /^LATER/, steps: [write("later.js", LATER_JS), { text: "Added later.js." }] }]),
		wrap: {
			evaluator: (evaluator) => ({
				...evaluator,
				run: async (spec) => {
					started.open();
					// Never finishes on its own: only the stop's signal ends it.
					await new Promise<void>((resolve) => spec.signal?.addEventListener("abort", () => resolve(), { once: true }));
					return { kind: "ran", suites: [], end: "aborted", durationMs: 0 };
				},
			}),
		},
	});
	assert.equal((await stack.owner("seal", "--trial", "r1")).code, 0);
	await started.opened;
	const ack = await command(stack, OWNER, "/task alpha LATER: add later.js");
	assert.match(ack.text, /Waiting: dispatch is held while the group is sealed/);
	const scratch = evaluations(stack)[0]?.scratch_path as string;
	assert.ok(existsSync(scratch));
	const since = stack.lastBotMessageId();
	await stack.restart();
	const result = await stack.waitForBotMessage(/^Evaluation of trial r1: /, { since, timeoutMs: 60_000 });
	assert.match(
		result.text,
		/^Evaluation of trial r1: INTERRUPTED \(not graded; reported as not tested\): interrupted by a restart\. Snapshot of main at [0-9a-f]{7}\. Trial tasks: none\. Suites \(0 of 0 passed\): none graded\. Dispatch has reopened\.$/,
	);
	const [row] = evaluations(stack);
	assert.deepEqual([row?.state, row?.outcome, row?.cleanup_verified], ["done", "interrupted", 1]);
	assert.equal(existsSync(scratch), false, "the scratch directory was wiped");
	assert.equal(groupState(stack), "normal");
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/, { since });
});

test("a freeze while sealing stops the sealing: nothing is graded and the group stays frozen", {
	timeout: 120_000,
}, async (t) => {
	const arrived = gate();
	const seen: number[] = [];
	const stack = await stackFor(t, {
		model: agent([
			{
				when: /^SLOW/,
				steps: [
					write("slow.js", "exports.slow = 1;\n"),
					async () => {
						arrived.open();
						return { hang: true };
					},
				],
			},
		]),
		wrap: {
			evaluator: (evaluator) => ({
				...evaluator,
				run: async (spec) => {
					seen.push(1);
					return evaluator.run(spec);
				},
			}),
		},
	});
	await command(stack, USER1, "/task alpha SLOW: add slow.js");
	await arrived.opened;
	const refused = await stack.owner("seal", "--trial", "f1");
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /not merged: Task 1 \(running\)/);
	// An earlier trial's evaluation covered Task 1: this trial's window starts after it (no task of its own).
	const db = stack.coordinator.store;
	db.tx(() =>
		db.run(
			`INSERT INTO evaluations(chat_id, trial, state, tasks, last_task_id, requested_at, outcome, cleanup_verified)
			 VALUES (?, 'earlier', 'done', '[1]', 1, 1, 'not_passed', 1)`,
			GROUP,
		),
	);
	const sealed = await stack.owner("seal", "--trial", "f1");
	assert.equal(sealed.code, 0, sealed.stderr);
	await stack.waitForBotMessage(/^Sealing for trial f1/);
	await sleep(500);
	assert.equal(groupState(stack), "sealing", "waiting for the running Task 1");
	// Something freezes the group while it waits: the running task is cancelled, the sealing ends ungraded.
	db.tx(() => db.freeze(GROUP, "test freeze"));
	stack.coordinator.engine.kick();
	await stack.waitForBotMessage(
		/^Trial f1 was not evaluated: the group was frozen while sealing\. Nothing was graded\.$/,
	);
	await stack.coordinator.idle();
	assert.equal(groupState(stack), "frozen");
	assert.deepEqual(
		evaluations(stack).map((row) => [row.trial, row.state, row.outcome]),
		[
			["earlier", "done", "not_passed"],
			["f1", "done", "error"],
		],
	);
	assert.equal(stack.tasks<{ state: string }>()[0]?.state, "cancelled");
	assert.deepEqual(seen, [], "no evaluator");
});

test("a restart while sealing: restart recovery's jobs (a review step's tests) finish and execution is verified stopped again before the snapshot is graded; none runs during the evaluator or its cleanup", {
	timeout: 240_000,
}, async (t) => {
	const atFetch = gate();
	const releaseFetch = gate();
	const evaluatorStarted = gate();
	let holdFetch = false;
	let blockEvaluator = false;
	let observe = false;
	let sandboxRef: Sandbox | undefined;
	let readOnly: Store | undefined;
	t.after(() => readOnly?.close());
	/** The evaluation in progress as a separate read-only connection sees it ("none" when there is none). */
	const phase = (): string =>
		readOnly?.get<{ state: string }>("SELECT state FROM evaluations WHERE state != 'done' ORDER BY id LIMIT 1")
			?.state ?? "none";
	const checks: string[] = [];
	const evaluatorSaw: { live: string[]; slots: number }[] = [];
	const stack = await stackFor(t, {
		model: agent([
			{ when: /^SIGNUP/, steps: [write("signup.js", SIGNUP_JS), { text: "Added signup.js." }] },
			{ when: /^EXTRA/, steps: [write("extra.js", EXTRA_JS), { text: "Added extra.js." }] },
		]),
		checks: {
			// The approved tests, observed after the restarts: in which evaluation phase each one starts and ends.
			test: async (worktree, writable) => {
				if (!observe) return nodeTestCheck(worktree, writable);
				checks.push(`start:${phase()}`);
				await sleep(1000);
				const result = await nodeTestCheck(worktree, writable);
				checks.push(`end:${phase()}`);
				return result;
			},
		},
		wrap: {
			sandbox: (sandbox) => {
				sandboxRef = sandbox;
				return sandbox;
			},
			// Holds the snapshot phase's fetch of main (then fails it) so that the restart finds the evaluation there.
			git: (git) => ({
				...git,
				fetchBase: async () => {
					if (!holdFetch) return git.fetchBase();
					atFetch.open();
					await releaseFetch.opened;
					throw new Error("the fetch was held by the test");
				},
			}),
			evaluator: (evaluator) => ({
				...evaluator,
				run: async (spec) => {
					evaluatorSaw.push({
						live: (await sandboxRef?.live()) ?? ["?"],
						slots: readOnly?.get<{ n: number }>("SELECT COUNT(*) AS n FROM slots")?.n ?? -1,
					});
					if (!blockEvaluator) return evaluator.run(spec);
					evaluatorStarted.open();
					await new Promise<void>((resolve) => spec.signal?.addEventListener("abort", () => resolve(), { once: true }));
					return { kind: "ran", suites: [], end: "aborted", durationMs: 0 };
				},
			}),
		},
	});
	readOnly = new Store(join(stack.config.paths.dataDir, "coordinator.sqlite"), Date.now, { readOnly: true });
	await command(stack, USER1, "/task alpha SIGNUP: add signup.js");
	await stack.waitForBotMessage(/^Task 1 is ready for review \(run 1\)/);
	await command(stack, USER1, "/approve 1");
	await stack.waitForBotMessage(/^Task 1 merged into main/);
	await command(stack, USER2, "/task beta EXTRA: add extra.js");
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/);
	/** Task 2's review step is to be done again at the next start (as for a push GitHub refused): a recovery job. */
	const reviewAgain = () =>
		stack.coordinator.store.tx(() => stack.coordinator.store.run("UPDATE runs SET review_done = 0 WHERE task_id = 2"));

	// 1. A restart in the snapshot phase: the recovery job's tests run first, then execution is verified stopped again,
	// and only then is the snapshot graded.
	holdFetch = true;
	assert.equal((await stack.owner("seal", "--trial", "s1", "--tasks", "1")).code, 0);
	await atFetch.opened;
	assert.equal(phase(), "snapshot");
	reviewAgain();
	holdFetch = false;
	observe = true;
	const since = stack.lastBotMessageId();
	const restarting = stack.restart();
	releaseFetch.open();
	await restarting;
	const first = await stack.waitForBotMessage(/^Evaluation of trial s1: /, { since, timeoutMs: 120_000 });
	assert.match(first.text, /^Evaluation of trial s1: PASSED\..* Dispatch has reopened\.$/);
	assert.deepEqual(checks, ["start:snapshot", "end:snapshot"], "the recovery job's tests ran before the evaluator");
	assert.deepEqual(evaluatorSaw, [{ live: [], slots: 0 }], "nothing executed when the evaluator started");
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/, { since });
	assert.equal(groupState(stack), "normal");

	// 2. A restart while the evaluator runs: interrupted, its cleanup verified; the recovery job waits until then.
	checks.length = 0;
	blockEvaluator = true;
	assert.equal((await stack.owner("seal", "--trial", "s2", "--tasks", "1")).code, 0);
	await evaluatorStarted.opened;
	reviewAgain();
	const since2 = stack.lastBotMessageId();
	await stack.restart();
	const second = await stack.waitForBotMessage(/^Evaluation of trial s2: /, { since: since2, timeoutMs: 60_000 });
	assert.match(
		second.text,
		/^Evaluation of trial s2: INTERRUPTED .*: interrupted by a restart\..* Dispatch has reopened\.$/,
	);
	await stack.waitForBotMessage(/^Task 2 is ready for review \(run 1\)/, { since: since2 });
	assert.deepEqual(checks, ["start:none", "end:none"], "the recovery job ran only after the evaluation was done");
	assert.equal(groupState(stack), "normal");
});
