import "../helpers/env.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { Update } from "grammy/types";
import { type CommandContext, handleUpdate } from "../../src/coordinator/commands.ts";
import { parseCoordinatorConfig } from "../../src/coordinator/config.ts";
import { DEMO_LIMITS, type Limits } from "../../src/coordinator/limits.ts";
import { Store } from "../../src/coordinator/store.ts";
import { silentLogger } from "../../src/runtime/log.ts";

const GROUP = -1001234567;
const OTHER_CHAT = -1009999999;
const OWNER = 900;
const ANA = 101;
const BOB = 102;
const CAROL = 103;
const BOT = "pd_test_bot";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const NEW_HEAD = "ffffeeee0000111122223333444455556666aaaa";

type Row = Record<string, unknown>;

type Fixture = {
	readonly store: Store;
	readonly ctx: CommandContext;
	/** Deliver one update; returns the handler's result and the ids used. */
	send(
		from: number,
		text: string,
		options?: { replyTo?: number; updateId?: number; chatId?: number },
	): { kick: boolean; updateId: number; messageId: number };
	/** /task: returns the new task id (asserts it was accepted). */
	submit(from: number, agent: string, text?: string): number;
	/** The bot posted a message for the task (the outbox sender records it); returns its message id. */
	post(taskId: number): number;
	/** Engine stand-in: the task's run finished, the review step pushed `head` and opened a PR. */
	toReview(taskId: number, head?: string): void;
	setRun(taskId: number, state: string): void;
	task(taskId: number): Row;
	/** Required replies to a user's message. */
	repliesTo(messageId: number): Row[];
	reply(messageId: number): string;
	count(table: string, where?: string, ...params: (string | number)[]): number;
};

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

let nextUpdateId = 10_000;
let nextMessageId = 500;

function fixture(options: { limits?: Partial<Limits>; members?: string; freeBytes?: (path: string) => number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pd-commands-"));
	let clock = 1_800_000_000_000;
	const store = new Store(join(dir, "coordinator.sqlite"), () => ++clock);
	cleanups.push(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const config = parseCoordinatorConfig(
		{
			TELEGRAM_BOT_TOKEN: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			TELEGRAM_BOT_USERNAME: BOT,
			TELEGRAM_GROUP_CHAT_ID: String(GROUP),
			TELEGRAM_OWNER_ID: String(OWNER),
			...(options.members === undefined ? {} : { TELEGRAM_MEMBER_IDS: options.members }),
			PI_AGENTS: "alpha,beta,gamma",
			PI_MODEL: "gpt-test",
			OPENAI_API_KEY: "test-key",
			PROJECT_TOKEN_CEILING: "1000000",
			GITHUB_TOKEN: "test-token",
			GITHUB_REPO: "acme/signup",
			PI_DATA_DIR: join(dir, "data"),
			PI_TASK_DIR: join(dir, "tasks"),
		},
		{ cwd: dir, home: dir, uid: 1000, gid: 1000 },
	);
	const ctx: CommandContext = {
		config,
		limits: { ...DEMO_LIMITS, ...options.limits },
		log: silentLogger,
		freeBytes: options.freeBytes ?? (() => 50 * 1024 ** 3),
	};
	const f: Fixture = {
		store,
		ctx,
		send(from, text, opts = {}) {
			const updateId = opts.updateId ?? nextUpdateId++;
			const messageId = nextMessageId++;
			const chat = { id: opts.chatId ?? GROUP, type: "supergroup" as const, title: "team" };
			const update = {
				update_id: updateId,
				message: {
					message_id: messageId,
					date: 1_790_000_000,
					chat,
					from: { id: from, is_bot: false, first_name: "U" },
					text,
					...(opts.replyTo === undefined
						? {}
						: {
								reply_to_message: {
									message_id: opts.replyTo,
									date: 1_790_000_000,
									chat,
									from: { id: 4242, is_bot: true, first_name: "bot" },
									text: "status",
								},
							}),
				},
			} as unknown as Update;
			return { ...handleUpdate(store, ctx, update), updateId, messageId };
		},
		submit(from, agent, text = "add email validation") {
			const sent = f.send(from, `/task@${BOT} ${agent} ${text}`);
			const row = store.get<{ task_id: number | null; outcome: string }>(
				"SELECT task_id, outcome FROM commands WHERE update_id = ?",
				sent.updateId,
			);
			assert.equal(row?.outcome, "accepted", f.reply(sent.messageId));
			return row?.task_id as number;
		},
		post(taskId) {
			const messageId = nextMessageId++;
			store.run("INSERT INTO task_messages(chat_id, message_id, task_id) VALUES (?, ?, ?)", GROUP, messageId, taskId);
			return messageId;
		},
		toReview(taskId, head = HEAD) {
			store.run(
				`UPDATE tasks SET state = 'review', branch = ?, worktree_path = ?, base_commit = 'base', head_commit = ?,
				 posted_head = ?, tests_passed_head = ?, pr_number = ?, pr_url = ? WHERE id = ?`,
				`task/${taskId}`,
				`/tasks/worktrees/task-${taskId}`,
				head,
				head,
				head,
				taskId + 40,
				`https://github.com/acme/signup/pull/${taskId + 40}`,
				taskId,
			);
			store.run(
				"UPDATE runs SET state = 'finished', review_done = 1 WHERE task_id = ? AND state NOT IN ('failed', 'cancelled')",
				taskId,
			);
		},
		setRun(taskId, state) {
			const run = store.get<{ id: number }>("SELECT id FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1", taskId);
			store.run("UPDATE runs SET state = ? WHERE id = ?", state, run?.id ?? -1);
		},
		task(taskId) {
			return store.get<Row>("SELECT * FROM tasks WHERE id = ?", taskId) ?? {};
		},
		repliesTo(messageId) {
			return store.all<Row>("SELECT * FROM outbox WHERE reply_to = ? ORDER BY id", messageId);
		},
		reply(messageId) {
			const rows = f.repliesTo(messageId);
			assert.equal(rows.length, 1, `exactly one reply to message ${messageId}`);
			return String(rows[0]?.text);
		},
		count(table, where = "1 = 1", ...params) {
			return store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params)?.n ?? 0;
		},
	};
	return f;
}

/** Engine stand-in: dispatch reserved a slot for the task's queued run. */
function dispatch(f: Fixture, taskId: number, agent: string): void {
	const run = f.store.get<{ id: number }>("SELECT id FROM runs WHERE task_id = ? AND state = 'queued'", taskId);
	f.store.run(
		"INSERT INTO slots(kind, task_id, run_id, agent_id, acquired_at) VALUES ('run', ?, ?, ?, 0)",
		taskId,
		run?.id ?? -1,
		agent,
	);
	f.store.run("UPDATE runs SET state = 'running' WHERE id = ?", run?.id ?? -1);
	f.store.run(
		"UPDATE tasks SET state = 'running', branch = ?, worktree_path = ? WHERE id = ?",
		`task/${taskId}`,
		`/w/${taskId}`,
		taskId,
	);
}

describe("handleUpdate: /task", () => {
	test("accepts a task: task row, initial queued run, ack replying to the command with id and position", () => {
		const f = fixture();
		const sent = f.send(ANA, `/task@${BOT} alpha add email validation\nand tests`);
		assert.equal(sent.kick, true);
		const task = f.store.get<Row>("SELECT * FROM tasks");
		assert.equal(task?.state, "queued");
		assert.equal(task?.agent_id, "alpha");
		assert.equal(task?.creator_id, ANA);
		assert.equal(task?.text, "add email validation\nand tests");
		assert.equal(task?.update_id, sent.updateId);
		const run = f.store.get<Row>("SELECT * FROM runs");
		assert.equal(run?.kind, "initial");
		assert.equal(run?.state, "queued");
		assert.equal(run?.request_id, String(sent.updateId));
		assert.equal(run?.input_text, "add email validation\nand tests");
		assert.equal(run?.requested_by, ANA);
		const [ack] = f.repliesTo(sent.messageId);
		assert.equal(ack?.priority, 0);
		assert.equal(ack?.task_id, task?.id);
		assert.equal(ack?.chat_id, GROUP);
		assert.equal(ack?.text, `Task ${task?.id} accepted for agent alpha. Queue position 1.`);
		const command = f.store.get<Row>("SELECT * FROM commands WHERE update_id = ?", sent.updateId);
		assert.deepEqual(
			[command?.kind, command?.outcome, command?.task_id, command?.user_id],
			["task", "accepted", task?.id, ANA],
		);
	});

	test("a plain /task (no @bot) and an upper-case agent id are accepted", () => {
		const f = fixture();
		const sent = f.send(ANA, "/task ALPHA do it");
		assert.match(f.reply(sent.messageId), /^Task \d+ accepted for agent alpha\. Queue position 1\.$/);
	});

	test("duplicate update id: one task, one ack, no second effect", () => {
		const f = fixture();
		const first = f.send(ANA, `/task@${BOT} alpha one`, { updateId: 77 });
		const again = f.send(ANA, `/task@${BOT} alpha one`, { updateId: 77 });
		assert.equal(first.kick, true);
		assert.equal(again.kick, false);
		assert.equal(f.count("tasks"), 1);
		assert.equal(f.count("runs"), 1);
		assert.equal(f.count("commands"), 1);
		assert.equal(f.count("outbox"), 1);
	});

	test("acceptance and its ack are one transaction: a failure after the task insert leaves nothing", () => {
		const f = fixture();
		const store = f.store as Store & { enqueue: Store["enqueue"] };
		store.enqueue = () => {
			throw new Error("injected outbox failure");
		};
		assert.throws(() => f.send(ANA, `/task@${BOT} alpha one`, { updateId: 88 }), /injected outbox failure/);
		assert.equal(f.store.inTransaction, false);
		for (const table of ["commands", "tasks", "runs", "outbox"]) assert.equal(f.count(table), 0, table);
		// Redelivery after the failure is handled normally (the update was not marked as seen).
		delete (store as Partial<Store>).enqueue;
		f.send(ANA, `/task@${BOT} alpha one`, { updateId: 88 });
		assert.equal(f.count("tasks"), 1);
		assert.equal(f.count("outbox"), 1);
	});

	test("queue caps: per agent, per group, with positions and 'queue full' reasons", () => {
		const f = fixture();
		const a1 = f.send(ANA, "/task alpha one");
		const a2 = f.send(BOB, "/task alpha two");
		assert.match(f.reply(a1.messageId), /Queue position 1\./);
		assert.match(f.reply(a2.messageId), /Queue position 2\./);
		const a3 = f.send(CAROL, "/task alpha three");
		assert.equal(a3.kick, false);
		assert.equal(f.reply(a3.messageId), "Task request rejected: queue full: agent alpha already has 2 waiting tasks.");
		const b1 = f.send(CAROL, "/task beta one");
		assert.match(f.reply(b1.messageId), /accepted for agent beta\. Queue position 1\./);
		f.send(CAROL, "/task beta two");
		const g1 = f.send(CAROL, "/task gamma one");
		assert.equal(f.reply(g1.messageId), "Task request rejected: queue full: the group already has 4 waiting tasks.");
		assert.equal(f.count("tasks"), 4);
		const rejected = f.store.get<Row>("SELECT * FROM commands WHERE update_id = ?", g1.updateId);
		assert.deepEqual([rejected?.kind, rejected?.outcome, rejected?.task_id], ["task", "rejected", null]);
		assert.match(String(rejected?.reason), /^queue full/);
		// A queued run that starts frees its waiting place.
		dispatch(f, 1, "alpha");
		const a4 = f.send(CAROL, "/task alpha four");
		assert.match(f.reply(a4.messageId), /accepted for agent alpha\. Queue position 2\./);
	});

	test("queue cap per user", () => {
		const f = fixture({ limits: { waitingPerUser: 2 } });
		f.submit(ANA, "alpha");
		f.submit(ANA, "beta");
		const third = f.send(ANA, "/task gamma three");
		assert.equal(f.reply(third.messageId), "Task request rejected: queue full: you already have 2 waiting tasks.");
		f.submit(BOB, "gamma");
	});

	test("unknown agent, missing text, too long text are rejected with the reason", () => {
		const f = fixture();
		const unknown = f.send(ANA, "/task delta fix it");
		assert.equal(
			f.reply(unknown.messageId),
			'Task request rejected: unknown agent "delta"; configured agents: alpha, beta, gamma.',
		);
		const bare = f.send(ANA, "/task");
		assert.match(f.reply(bare.messageId), /rejected: usage: \/task <agent> <text>; agents: alpha, beta, gamma\.$/);
		const empty = f.send(ANA, "/task alpha   ");
		assert.match(f.reply(empty.messageId), /rejected: the task text is empty/);
		const long = f.send(ANA, `/task alpha ${"x".repeat(4001)}`);
		assert.match(f.reply(long.messageId), /too long \(4001 characters; the limit is 4000\)/);
		f.submit(ANA, "alpha", "y".repeat(4000));
		assert.equal(f.count("tasks"), 1);
	});

	test("member allowlist: non-members rejected; members and the owner accepted", () => {
		const f = fixture({ members: `${ANA}` });
		const bob = f.send(BOB, "/task alpha one");
		assert.match(f.reply(bob.messageId), /rejected: only the group's listed members and the owner/);
		f.submit(ANA, "alpha");
		f.submit(OWNER, "beta");
	});

	test("low or unreadable disk rejects new tasks", () => {
		const low = fixture({ freeBytes: (path) => (path.endsWith("tasks") ? 10 * 1024 ** 2 : 50 * 1024 ** 3) });
		const sent = low.send(ANA, "/task alpha one");
		assert.match(low.reply(sent.messageId), /^Task request rejected: disk low: free space on the task disk is 10 MiB/);
		assert.equal(low.count("tasks"), 0);
		const broken = fixture({
			freeBytes: () => {
				throw new Error("EIO");
			},
		});
		const other = broken.send(ANA, "/task alpha one");
		assert.match(broken.reply(other.messageId), /disk low: free space on the data disk cannot be read/);
	});

	test("ack says when the task waits for open reviews or an execution slot", () => {
		const f = fixture();
		for (const [i, agent] of ["alpha", "beta", "gamma", "alpha"].entries()) {
			const id = f.submit(ANA, agent, `t${i}`);
			dispatch(f, id, agent);
			f.toReview(id);
			f.store.run("DELETE FROM slots WHERE task_id = ?", id);
		}
		const waiting = f.send(BOB, "/task beta five");
		assert.match(
			f.reply(waiting.messageId),
			/Queue position 1\. Waiting for open reviews to finish \(4 open tasks\)\.$/,
		);
		const g = fixture();
		const first = g.submit(ANA, "alpha");
		dispatch(g, first, "alpha");
		const second = g.submit(ANA, "beta");
		dispatch(g, second, "beta");
		const third = g.send(BOB, "/task gamma three");
		assert.match(g.reply(third.messageId), /Queue position 1\. Waiting for an execution slot \(2\/2 in use\)\.$/);
		const fourth = g.send(BOB, "/task alpha four");
		assert.match(g.reply(fourth.messageId), /Waiting for agent alpha to finish its current run\.$/);
	});
});

describe("handleUpdate: frozen group", () => {
	test("rejects /task, follow-ups and /approve with the frozen notice; /status and /cancel work", () => {
		const f = fixture();
		const reviewed = f.submit(ANA, "alpha");
		f.toReview(reviewed);
		const queued = f.submit(ANA, "beta");
		const posted = f.post(reviewed);
		f.store.freeze(GROUP, "stop unconfirmed");

		const task = f.send(ANA, "/task gamma new");
		assert.match(
			f.reply(task.messageId),
			/^Task request rejected: The group is frozen \(stop unconfirmed\)\. New tasks, follow-ups and approvals/,
		);
		const followup = f.send(ANA, "more please", { replyTo: posted });
		assert.match(f.reply(followup.messageId), /^Follow-up rejected: The group is frozen/);
		const approve = f.send(ANA, `/approve ${reviewed}`);
		assert.match(f.reply(approve.messageId), /^\/approve rejected: The group is frozen/);
		assert.equal(f.task(reviewed).state, "review");
		assert.equal(f.count("approvals"), 0);
		assert.equal(f.count("followups"), 0);
		assert.equal(f.count("tasks"), 2);

		const status = f.send(BOB, "/status");
		assert.match(f.reply(status.messageId), /^Group: frozen \(stop unconfirmed\)\./);
		const cancel = f.send(ANA, `/cancel ${queued}`);
		assert.equal(f.reply(cancel.messageId), `Task ${queued} cancelled.`);
		assert.equal(f.task(queued).state, "cancelled");
	});
});

describe("handleUpdate: permissions", () => {
	test("follow-up, /approve and /cancel: creator and owner allowed, other members rejected", () => {
		const f = fixture();
		const id = f.submit(ANA, "alpha");
		f.toReview(id);
		const posted = f.post(id);

		const bobFollowup = f.send(BOB, "do it differently", { replyTo: posted });
		assert.equal(
			f.reply(bobFollowup.messageId),
			`Follow-up rejected: only the creator of Task ${id} or the group owner can follow up on it.`,
		);
		const bobApprove = f.send(BOB, `/approve ${id}`);
		assert.match(f.reply(bobApprove.messageId), /^\/approve rejected: only the creator of Task \d+ or the group owner/);
		const bobCancel = f.send(BOB, `/cancel ${id}`);
		assert.match(f.reply(bobCancel.messageId), /^\/cancel rejected: only the creator of Task \d+ or the group owner/);
		assert.equal(f.task(id).state, "review");
		assert.equal(f.task(id).cancel_requested, 0);

		// The owner may follow up; the creator may approve and cancel.
		const ownerFollowup = f.send(OWNER, "owner's idea", { replyTo: posted });
		assert.match(f.reply(ownerFollowup.messageId), /^Follow-up started another run of Task \d+/);
		f.toReview(id, NEW_HEAD);
		const anaApprove = f.send(ANA, `/approve ${id}`);
		assert.match(f.reply(anaApprove.messageId), /^Approved Task \d+ at ffffeee/);

		const other = f.submit(BOB, "beta");
		const ownerCancel = f.send(OWNER, `/cancel ${other}`);
		assert.equal(f.reply(ownerCancel.messageId), `Task ${other} cancelled.`);
		assert.equal(f.task(other).reason, "cancelled by the group owner");
		const third = f.submit(CAROL, "gamma");
		const carolCancel = f.send(CAROL, `/cancel ${third}`);
		assert.equal(f.reply(carolCancel.messageId), `Task ${third} cancelled.`);
	});
});

describe("handleUpdate: follow-ups", () => {
	test("task queued (run not started): steer saved for that run, with its queue position", () => {
		const f = fixture();
		f.submit(BOB, "alpha");
		const id = f.submit(ANA, "alpha");
		const sent = f.send(ANA, "also reject plus-addresses", { replyTo: f.post(id) });
		assert.equal(sent.kick, true);
		assert.equal(
			f.reply(sent.messageId),
			`Follow-up saved; it will be steered into Task ${id} when its run starts. Queue position 2.`,
		);
		const followup = f.store.get<Row>("SELECT * FROM followups");
		const run = f.store.get<Row>("SELECT * FROM runs WHERE task_id = ?", id);
		assert.deepEqual(
			[followup?.mode, followup?.state, followup?.run_id, followup?.update_id, followup?.text],
			["steer", "pending", run?.id, sent.updateId, "also reject plus-addresses"],
		);
		assert.equal(f.count("runs", "task_id = ?", id), 1);
		assert.equal(f.task(id).followup_count, 1);
	});

	for (const state of ["starting", "running"]) {
		test(`run ${state}: steer into the running task`, () => {
			const f = fixture();
			const id = f.submit(ANA, "alpha");
			dispatch(f, id, "alpha");
			f.setRun(id, state);
			const sent = f.send(ANA, "steer me", { replyTo: f.post(id) });
			assert.equal(
				f.reply(sent.messageId),
				`Follow-up saved; it will be steered into the running Task ${id} (in progress, not queued).`,
			);
			const followup = f.store.get<Row>("SELECT * FROM followups");
			assert.deepEqual([followup?.mode, followup?.state], ["steer", "pending"]);
		});
	}

	test("run finalizing: rejected with a retry hint (neither steer nor run is safe yet)", () => {
		const f = fixture();
		const id = f.submit(ANA, "alpha");
		dispatch(f, id, "alpha");
		f.setRun(id, "finalizing");
		const sent = f.send(ANA, "late", { replyTo: f.post(id) });
		assert.match(f.reply(sent.messageId), /^Follow-up rejected: the run of Task \d+ is stopping; reply again/);
		assert.equal(f.count("followups"), 0);
		assert.equal(f.task(id).followup_count, 0);
	});

	test("task in review: starts another run (followup, queued), invalidates a valid approval", () => {
		const f = fixture();
		const id = f.submit(ANA, "alpha");
		f.toReview(id);
		f.store.run(
			"INSERT INTO approvals(task_id, user_id, update_id, head_commit, state, created_at) VALUES (?, ?, 1, ?, 'valid', 0)",
			id,
			ANA,
			HEAD,
		);
		const sent = f.send(ANA, "add a unit test too", { replyTo: f.post(id) });
		assert.equal(
			f.reply(sent.messageId),
			`Follow-up started another run of Task ${id} on the same branch and pull request. Queue position 1.`,
		);
		const run = f.store.get<Row>("SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1", id);
		const followup = f.store.get<Row>("SELECT * FROM followups");
		assert.deepEqual(
			[run?.kind, run?.state, run?.request_id, run?.input_text, run?.followup_id, run?.requested_by],
			["followup", "queued", String(sent.updateId), "add a unit test too", followup?.id, ANA],
		);
		assert.deepEqual([followup?.mode, followup?.state, followup?.run_id], ["run", "started", run?.id]);
		assert.equal(f.task(id).state, "queued");
		assert.equal(f.task(id).followup_count, 1);
		const approval = f.store.get<Row>("SELECT * FROM approvals");
		assert.deepEqual([approval?.state, approval?.reason], ["invalidated", "new run admitted"]);
		// The task now has a queued run: a second reply steers into it.
		const second = f.send(ANA, "and docs", { replyTo: f.post(id) });
		assert.match(f.reply(second.messageId), /steered into Task \d+ when its run starts\. Queue position 1\./);
	});

	test("task running whose run already finished (review step in progress): another run is queued", () => {
		const f = fixture();
		const id = f.submit(ANA, "alpha");
		dispatch(f, id, "alpha");
		f.setRun(id, "finished");
		const sent = f.send(ANA, "next", { replyTo: f.post(id) });
		assert.match(f.reply(sent.messageId), /^Follow-up started another run of Task \d+ on the same branch\./);
		assert.equal(f.count("runs", "task_id = ? AND state = 'queued' AND kind = 'followup'", id), 1);
	});

	test("follow-up run counts against the author's waiting caps", () => {
		const f = fixture({ limits: { waitingPerUser: 1 } });
		const id = f.submit(ANA, "alpha");
		f.toReview(id);
		f.submit(ANA, "beta");
		const sent = f.send(ANA, "again", { replyTo: f.post(id) });
		assert.equal(f.reply(sent.messageId), "Follow-up rejected: queue full: you already have 1 waiting task.");
		assert.equal(f.task(id).state, "review");
		assert.equal(f.count("followups"), 0);
		assert.equal(f.count("runs", "task_id = ?", id), 1);
	});

	test("merging, merged, cancelled, failed and cancel-requested tasks reject follow-ups", () => {
		const f = fixture();
		const id = f.submit(ANA, "alpha");
		f.toReview(id);
		const posted = f.post(id);
		const cases: [string, RegExp][] = [
			["merging", /merge in progress for Task \d+; reply again if it returns to review, or send a new \/task/],
			["merged", /Task \d+ is already merged; send a new \/task for further work/],
			["cancelled", /Task \d+ was cancelled; send a new \/task/],
			["failed", /Task \d+ failed \(request limit reached\); send a new \/task/],
		];
		for (const [state, expected] of cases) {
			f.store.run("UPDATE tasks SET state = ?, reason = 'request limit reached' WHERE id = ?", state, id);
			const sent = f.send(ANA, "more", { replyTo: posted });
			assert.match(f.reply(sent.messageId), expected, state);
		}
		f.store.run("UPDATE tasks SET state = 'review', cancel_requested = 1 WHERE id = ?", id);
		const sent = f.send(ANA, "more", { replyTo: posted });
		assert.match(f.reply(sent.messageId), /Task \d+ is being cancelled; send a new \/task/);
		assert.equal(f.count("followups"), 0);
	});

	test("limits: 5 follow-ups per task (6th rejected), 4000 characters each", () => {
		const f = fixture();
		const id = f.submit(ANA, "alpha");
		dispatch(f, id, "alpha");
		const posted = f.post(id);
		const long = f.send(ANA, "z".repeat(4001), { replyTo: posted });
		assert.equal(
			f.reply(long.messageId),
			"Follow-up rejected: the follow-up text is too long (4001 characters; the limit is 4000).",
		);
		for (let i = 0; i < 5; i++) {
			const sent = f.send(ANA, i === 0 ? "z".repeat(4000) : `steer ${i}`, { replyTo: posted });
			assert.match(f.reply(sent.messageId), /^Follow-up saved/);
		}
		const sixth = f.send(ANA, "one more", { replyTo: posted });
		assert.equal(
			f.reply(sixth.messageId),
			`Follow-up rejected: Task ${id} already has 5 follow-ups, the limit; send a new /task for further work.`,
		);
		assert.equal(f.count("followups"), 5);
		assert.equal(f.task(id).followup_count, 5);
	});

	test("a reply to a message that is not a task message is ignored: recorded, no reply", () => {
		const f = fixture();
		const id = f.submit(ANA, "alpha");
		f.post(id);
		const sent = f.send(ANA, "hello?", { replyTo: 1 });
		assert.equal(sent.kick, false);
		assert.equal(f.repliesTo(sent.messageId).length, 0);
		const row = f.store.get<Row>("SELECT * FROM commands WHERE update_id = ?", sent.updateId);
		assert.deepEqual([row?.kind, row?.outcome, row?.reason], ["ignored", "ignored", "reply_not_task"]);
		assert.equal(f.count("followups"), 0);
		// Plain chatter and other chats: ignored and recorded, so redelivery is deduplicated.
		const chatter = f.send(BOB, "lunch?");
		const elsewhere = f.send(BOB, "/task alpha x", { chatId: OTHER_CHAT });
		f.send(BOB, "/task alpha x", { chatId: OTHER_CHAT, updateId: elsewhere.updateId });
		assert.equal(f.count("commands", "outcome = 'ignored'"), 3);
		assert.equal(
			f.store.get<Row>("SELECT reason FROM commands WHERE update_id = ?", chatter.updateId)?.reason,
			"not_command",
		);
		assert.equal(f.count("outbox"), 1);
		assert.equal(f.count("tasks"), 1);
	});
});

describe("handleUpdate: /approve", () => {
	test("accepted: approval bound to the posted head, task merging, ack with sha and merge queue position", () => {
		const f = fixture();
		const id = f.submit(ANA, "alpha");
		f.toReview(id);
		const sent = f.send(ANA, `/approve@${BOT} ${id}`);
		assert.equal(sent.kick, true);
		assert.equal(
			f.reply(sent.messageId),
			`Approved Task ${id} at a1b2c3d; merging when the merge queue reaches it. Merge queue position 1.`,
		);
		const approval = f.store.get<Row>("SELECT * FROM approvals");
		assert.deepEqual(
			[approval?.task_id, approval?.user_id, approval?.update_id, approval?.head_commit, approval?.state],
			[id, ANA, sent.updateId, HEAD, "valid"],
		);
		assert.equal(f.task(id).state, "merging");
		const again = f.send(ANA, `/approve ${id}`);
		assert.match(f.reply(again.messageId), /Task \d+ is already approved and merging/);
		const other = f.submit(BOB, "beta");
		f.toReview(other);
		const second = f.send(OWNER, `/approve #${other}`);
		assert.match(f.reply(second.messageId), /Merge queue position 2\./);
	});

	test("rejected when the head moved since the bot posted it", () => {
		const f = fixture();
		const id = f.submit(ANA, "alpha");
		f.toReview(id);
		f.store.run("UPDATE tasks SET head_commit = ? WHERE id = ?", NEW_HEAD, id);
		const sent = f.send(ANA, `/approve ${id}`);
		assert.equal(
			f.reply(sent.messageId),
			"/approve rejected: the branch changed since the bot posted it; wait for the new head.",
		);
		assert.equal(f.count("approvals"), 0);
		assert.equal(f.task(id).state, "review");
	});

	test("rejected when a new run was admitted, when not in review, and without a pull request", () => {
		const f = fixture();
		const id = f.submit(ANA, "alpha");
		const early = f.send(ANA, `/approve ${id}`);
		assert.match(f.reply(early.messageId), /a new run of Task \d+ has been admitted/);
		f.toReview(id);
		f.send(ANA, "one more thing", { replyTo: f.post(id) });
		const afterFollowup = f.send(ANA, `/approve ${id}`);
		assert.match(f.reply(afterFollowup.messageId), /^\/approve rejected: a new run of Task \d+ has been admitted/);
		f.toReview(id);
		f.store.run("UPDATE tasks SET state = 'running' WHERE id = ?", id);
		const running = f.send(ANA, `/approve ${id}`);
		assert.match(f.reply(running.messageId), /Task \d+ is running, not in review/);
		f.store.run("UPDATE tasks SET state = 'review', pr_number = NULL, pr_url = NULL WHERE id = ?", id);
		const noPr = f.send(ANA, `/approve ${id}`);
		assert.match(f.reply(noPr.messageId), /Task \d+ has no pull request, so there is nothing to merge/);
		const missing = f.send(ANA, "/approve 999");
		assert.equal(f.reply(missing.messageId), "/approve rejected: there is no Task 999 in this group.");
		const usage = f.send(ANA, "/approve");
		assert.equal(f.reply(usage.messageId), "/approve rejected: usage: /approve <task id>.");
		assert.equal(f.count("approvals"), 0);
	});
});

describe("handleUpdate: /cancel", () => {
	test("queued task that never started: cancelled at once; pending steer expires with its own message", () => {
		const f = fixture();
		const id = f.submit(ANA, "alpha");
		const steer = f.send(ANA, "steer", { replyTo: f.post(id) });
		const sent = f.send(ANA, `/cancel ${id}`);
		assert.equal(f.reply(sent.messageId), `Task ${id} cancelled.`);
		assert.deepEqual([f.task(id).state, f.task(id).reason], ["cancelled", "cancelled by its creator"]);
		assert.equal(f.task(id).cancel_requested, 0);
		assert.equal(f.store.get<Row>("SELECT state FROM runs WHERE task_id = ?", id)?.state, "cancelled");
		const followup = f.store.get<Row>("SELECT * FROM followups");
		assert.deepEqual([followup?.state, followup?.reason], ["expired", "expired (cancelled)"]);
		const notices = f.repliesTo(steer.messageId);
		assert.equal(notices.length, 2);
		assert.equal(notices[1]?.text, `Follow-up to Task ${id} expired: the task was cancelled.`);
		assert.equal(notices[1]?.priority, 0);
		const again = f.send(ANA, `/cancel ${id}`);
		assert.equal(f.reply(again.messageId), `/cancel rejected: Task ${id} is already cancelled.`);
	});

	test("running, in review, or queued with a worktree: cancel_requested for the engine", () => {
		const f = fixture();
		const running = f.submit(ANA, "alpha");
		dispatch(f, running, "alpha");
		const sent = f.send(ANA, `/cancel ${running}`);
		assert.match(f.reply(sent.messageId), new RegExp(`^Cancelling Task ${running}… You will get a message once`));
		assert.deepEqual([f.task(running).cancel_requested, f.task(running).cancel_requested_by], [1, ANA]);
		assert.equal(f.task(running).state, "running");
		const twice = f.send(ANA, `/cancel ${running}`);
		assert.match(f.reply(twice.messageId), /is being cancelled already/);

		const review = f.submit(BOB, "beta");
		f.toReview(review);
		const inReview = f.send(OWNER, `/cancel ${review}`);
		assert.match(f.reply(inReview.messageId), /its pull request is closed and its worktree archived/);
		assert.equal(f.task(review).cancel_requested, 1);

		const requeued = f.submit(CAROL, "gamma");
		f.toReview(requeued);
		f.send(CAROL, "again", { replyTo: f.post(requeued) });
		assert.equal(f.task(requeued).state, "queued");
		f.send(CAROL, `/cancel ${requeued}`);
		assert.equal(f.task(requeued).cancel_requested, 1);
		assert.equal(f.task(requeued).state, "queued");
		assert.equal(f.count("runs", "task_id = ? AND state = 'queued'", requeued), 1);
	});

	test("merging and terminal tasks cannot be cancelled", () => {
		const f = fixture();
		const id = f.submit(ANA, "alpha");
		f.toReview(id);
		f.send(ANA, `/approve ${id}`);
		const merging = f.send(ANA, `/cancel ${id}`);
		assert.match(f.reply(merging.messageId), /merge in progress for Task \d+; it cannot be cancelled now/);
		f.store.run("UPDATE tasks SET state = 'merged' WHERE id = ?", id);
		const merged = f.send(ANA, `/cancel ${id}`);
		assert.match(f.reply(merged.messageId), /Task \d+ is already merged/);
		assert.equal(f.task(id).cancel_requested, 0);
	});
});

describe("handleUpdate: /status and /help", () => {
	test("summary lists group state, slots, open tasks with positions and PR links, recent finished ones", () => {
		const f = fixture();
		const review = f.submit(ANA, "alpha");
		f.toReview(review);
		const running = f.submit(BOB, "beta");
		dispatch(f, running, "beta");
		const queued = f.submit(CAROL, "beta");
		const done = f.submit(CAROL, "gamma");
		f.store.run(
			"UPDATE tasks SET state = 'merged', pr_url = 'https://github.com/acme/signup/pull/7' WHERE id = ?",
			done,
		);
		f.store.run("UPDATE runs SET state = 'finished' WHERE task_id = ?", done);
		const sent = f.send(BOB, "/status");
		assert.equal(sent.kick, false);
		const text = f.reply(sent.messageId);
		assert.match(text, /^Group: normal\. Execution slots in use: 1\/2\./);
		const prUrl = `https://github.com/acme/signup/pull/${review + 40}`;
		assert.ok(text.includes(`Task ${review} · alpha · in review · ${prUrl}`));
		assert.ok(text.includes(`Task ${running} · beta · running`));
		assert.ok(text.includes(`Task ${queued} · beta · queued · queue position 1 · waiting for agent beta`));
		assert.match(text, /Recently finished:\nTask \d+ · gamma · merged · https:\/\/github\.com\/acme\/signup\/pull\/7/);
		const row = f.store.get<Row>("SELECT * FROM commands WHERE update_id = ?", sent.updateId);
		assert.deepEqual([row?.kind, row?.outcome], ["status", "answered"]);
		assert.ok(text.length <= 4096);
	});

	test("detail of one task; unknown task rejected", () => {
		const f = fixture();
		const id = f.submit(ANA, "alpha", "add email validation");
		f.toReview(id);
		const sent = f.send(CAROL, `/status ${id}`);
		const text = f.reply(sent.messageId);
		assert.match(text, new RegExp(`^Task ${id} · agent alpha · in review`));
		assert.ok(text.includes("Request: add email validation"));
		assert.ok(text.includes(`Pull request: https://github.com/acme/signup/pull/${id + 40}.`));
		assert.ok(text.includes("Head: a1b2c3d (tests passed at this head)."));
		assert.ok(text.includes(`/approve ${id}`));
		assert.equal(f.repliesTo(sent.messageId)[0]?.task_id, id);
		const missing = f.send(CAROL, "/status 404");
		assert.equal(f.reply(missing.messageId), "/status rejected: there is no Task 404 in this group.");
	});

	test("/help lists the commands and the configured agents", () => {
		const f = fixture();
		const sent = f.send(ANA, `/help@${BOT}`);
		const text = f.reply(sent.messageId);
		assert.match(text, /\/task <agent> <text>/);
		assert.match(text, /agents: alpha, beta, gamma/);
		assert.match(text, new RegExp(`/task@${BOT}`));
		assert.match(text, /\/approve <task id>/);
		assert.match(text, /\/cancel <task id>/);
		assert.match(text, /\/status/);
	});
});
