import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import {
	type FauxProviderHandle,
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	type Message,
} from "@earendil-works/pi-ai";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { ChatMap } from "../../src/channel/docs.ts";
import { createReminderTask, Reminders } from "../../src/plugins/reminders/task.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { sleep, waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { textOf, toolCall } from "../helpers/faux-steps.ts";
import { textUpdate } from "../helpers/updates.ts";

const TZ = "Asia/Tashkent"; // UTC+5, no DST
/** Wed 2026-10-14 12:02 in Tashkent. */
const T0 = Date.UTC(2026, 9, 14, 7, 2);
const DAY = 24 * 60 * 60_000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Result = { error: boolean; text: string };

/** Wake inputs get `Woke: <note>`; every other request takes the next scripted step. Tool results are recorded. */
function agentSteps(script: FauxResponseStep[], results: Result[] = []): FauxResponseStep[] {
	let i = 0;
	const step: FauxResponseFactory = (context, ...rest) => {
		const last = context.messages.at(-1);
		if (last?.role === "toolResult") results.push({ error: last.isError, text: textOf(last) });
		if (last?.role === "user" && textOf(last as never).startsWith("[reminder"))
			return fauxAssistantMessage(`Woke: ${textOf(last as never)}`);
		const next = script[i++] ?? fauxAssistantMessage("(end of script)");
		return typeof next === "function" ? next(context, ...rest) : next;
	};
	return Array.from({ length: 40 }, () => step);
}

async function start(
	faux: FauxProviderHandle,
	options: { dir: string; port: FakeTelegram; now: () => number; plugins?: string; allowed?: string },
): Promise<TestAgent> {
	const t = await startTestAgent({
		dir: options.dir,
		faux,
		port: options.port,
		config: {
			PI_PLUGINS: options.plugins ?? "reminders",
			...(options.allowed === undefined ? {} : { TELEGRAM_ALLOWED_USER_IDS: options.allowed }),
		},
		deps: { now: options.now, pluginEnv: { PI_TIMEZONE: TZ } },
	});
	return t;
}

async function room() {
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	return { dir, port: new FakeTelegram() };
}

async function conversationId(harness: Harness): Promise<ConversationId> {
	return (await waitFor(async () => (await harness.snapshot(ChatMap, BG))?.chats[String(CHAT)])) as ConversationId;
}

async function remindTasks(harness: Harness) {
	return (await harness.commit((tx) => tx.scanTasks({ kind: "tg.remind" }, 100), BG)).items;
}

async function wakeNotes(harness: Harness): Promise<string[]> {
	const conversation = await harness.conversation(await conversationId(harness), BG);
	const messages = (await conversation?.context(BG))?.messages ?? [];
	return messages
		.filter((m) => m.role === "user")
		.map((m) => textOf(m as never))
		.filter((text) => text.startsWith("[reminder"));
}

const sections = (messages: readonly Message[]) =>
	messages.flatMap((m) => (m.role === "system" ? Object.values(m.sections ?? {}) : [])).join("\n");

test("T-remind-ops: add, list and cancel; wrong input is an error for the model; the prompt names the date", async () => {
	const { dir, port } = await room();
	const results: Result[] = [];
	let prompt = "";
	const firstId = () => /Reminder (r\d+)/.exec(results[0]?.text ?? "")?.[1] ?? "none";
	const faux = newFaux();
	faux.setResponses(
		agentSteps(
			[
				(context) => {
					prompt = sections(context.messages);
					return toolCall("remind", { op: "add", text: "call mom", at: "2026-10-15T09:00", every: "daily" });
				},
				toolCall("remind", { op: "add", text: "x" }),
				toolCall("remind", { op: "add", text: "y", at: "2026-10-14T11:00" }),
				toolCall("remind", { op: "add", text: "in an hour", in: 60 }),
				toolCall("remind", { op: "add", text: "z", in: 5, every: "hourly" }),
				toolCall("remind", { op: "list" }),
				() => toolCall("remind", { op: "cancel", id: firstId() }),
				toolCall("remind", { op: "cancel", id: "__proto__" }),
				toolCall("remind", { op: "list" }),
				fauxAssistantMessage("done"),
			],
			results,
		),
	);
	const t = await start(faux, { dir, port, now: () => T0 });
	cleanups.push(() => t.close());
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "remind me"));
	await waitFor(() => port.textsIn(CHAT).includes("done"), { what: "done" });
	const id = firstId();
	const later = /Reminder (r\d+)/.exec(results[3]?.text ?? "")?.[1];
	assert.match(results[0]?.text ?? "", /^Reminder r\d+: Thu 2026-10-15 09:00 \(Asia\/Tashkent\), then daily\.$/);
	assert.deepEqual(
		results.map((r) => r.error),
		[false, true, true, false, true, false, false, true, false],
	);
	assert.match(results[1]?.text ?? "", /add needs exactly one of at or in/);
	assert.match(results[2]?.text ?? "", /Wed 2026-10-14 11:00 is in the past; now is Wed 2026-10-14 12:02/);
	assert.equal(results[3]?.text, `Reminder ${later}: Wed 2026-10-14 13:02 (Asia/Tashkent).`);
	assert.match(results[4]?.text ?? "", /every must be daily, weekdays, weekly or a number of minutes/);
	assert.equal(
		results[5]?.text,
		`Now: Wed 2026-10-14 12:02 (Asia/Tashkent)\n${later}  Wed 2026-10-14 13:02  in an hour\n` +
			`${id}  Thu 2026-10-15 09:00, then daily  call mom`,
	);
	assert.equal(results[6]?.text, `Cancelled ${id}: call mom`);
	assert.match(results[7]?.text ?? "", /no reminder "__proto__"; see op list/);
	assert.equal(
		results[8]?.text,
		`Now: Wed 2026-10-14 12:02 (Asia/Tashkent)\n${later}  Wed 2026-10-14 13:02  in an hour`,
	);

	const doc = await t.agent.harness.snapshot(Reminders, await conversationId(t.agent.harness), BG);
	assert.deepEqual(Object.keys(doc?.items ?? {}), [later]);
	assert.equal(doc?.items[later ?? ""]?.next, T0 + 60 * 60_000);
	assert.match(prompt, /<reminders>\nToday is Wed 2026-10-14, time zone Asia\/Tashkent\.\n/);
	const body = /<reminders>\n([\s\S]*?)\n<\/reminders>/.exec(prompt)?.[1] ?? "";
	assert.ok(body.split("\n").length <= 6, body);
});

test("T-remind-due: a due reminder wakes the agent once, survives /new, answers no message; a duplicate task is dropped", async () => {
	const { dir, port } = await room();
	const startAt = Date.UTC(2026, 9, 14, 7, 2, 57); // 12:02:57, three seconds before 12:03
	const began = Date.now();
	const now = () => startAt + (Date.now() - began);
	const faux = newFaux();
	faux.setResponses(
		agentSteps([
			toolCall("remind", { op: "add", text: "stretch", at: "2026-10-14T12:03" }),
			fauxAssistantMessage("Set."),
		]),
	);
	const t = await start(faux, { dir, port, now });
	cleanups.push(() => t.close());
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "remind me to stretch at 12:03"));
	await waitFor(() => port.textsIn(CHAT).includes("Set."), { what: "set" });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/new"));
	await waitFor(() => port.textsIn(CHAT).some((text) => text.startsWith("New context")), { what: "/new" });
	const woke = await waitFor(() => port.created(CHAT).find((m) => m.text.startsWith("Woke:")), {
		what: "wake answer",
		timeoutMs: 15_000,
	});
	assert.match(woke.text, /^Woke: \[reminder r\d+, set Wed 2026-10-14 12:02\] stretch$/);
	assert.equal(woke.replyTo, undefined, "a wake replies to no message");
	const harness = t.agent.harness;
	const conversation = await conversationId(harness);
	assert.deepEqual((await harness.snapshot(Reminders, conversation, BG))?.items, {});
	assert.deepEqual(
		(await remindTasks(harness)).map((task) => task.state.status),
		["terminal"],
	);

	// A second task for the same reminder and due time (a double timer) finds the wake already admitted.
	const id = /reminder (r\d+)/.exec(woke.text)?.[1] ?? "";
	const due = Date.UTC(2026, 9, 14, 7, 3);
	await harness.commit(async (tx) => {
		const entry = { text: "stretch", next: due, wall: "12:03", tz: TZ, setAt: startAt };
		(await tx.doc(Reminders, conversation)).items[id] = entry;
		const options = { ownership: { kind: "conversation" as const }, background: true, conversationId: conversation };
		await tx.createTask(createReminderTask(new Set([CHAT])), { id, due }, options);
	}, BG);
	await waitFor(async () => (await remindTasks(harness)).every((task) => task.state.status === "terminal"));
	await sleep(300);
	assert.equal(port.textsIn(CHAT).filter((text) => text.startsWith("Woke:")).length, 1);
	assert.equal((await harness.commit((tx) => tx.scanTasks({ kind: "tg.deliver" }, 100), BG)).items.length, 2);
});

test("T-remind-missed: reminders missed while down fire once, late; a daily one jumps to its next day; a restart does not refire", async () => {
	const { dir, port } = await room();
	const faux = newFaux();
	faux.setResponses(
		agentSteps([
			toolCall("remind", { op: "add", text: "lunch", at: "2026-10-14T13:00" }),
			toolCall("remind", { op: "add", text: "standup", at: "2026-10-15T09:30", every: "daily" }),
			fauxAssistantMessage("Both set."),
		]),
	);
	const first = await start(faux, { dir, port, now: () => T0 });
	await first.agent.channel.handleUpdate(textUpdate(CHAT, 1, "set two"));
	await waitFor(() => port.textsIn(CHAT).includes("Both set."), { what: "set" });
	await first.close();

	const sat = T0 + 3 * DAY; // Sat 2026-10-17 12:02
	const second = newFaux();
	second.setResponses(agentSteps([]));
	const t2 = await start(second, { dir, port, now: () => sat });
	await waitFor(async () => (await wakeNotes(t2.agent.harness)).length === 2, { what: "two wakes", timeoutMs: 15_000 });
	await t2.agent.harness.waitForIdle(BG);
	const notes = (await wakeNotes(t2.agent.harness)).sort();
	assert.match(
		notes[0] ?? "",
		/^\[reminder r\d+, set Wed 2026-10-14 12:02, was due Wed 2026-10-14 13:00, late: the service was down\] lunch$/,
	);
	assert.match(
		notes[1] ?? "",
		/^\[reminder r\d+, set Wed 2026-10-14 12:02, was due Thu 2026-10-15 09:30, late: the service was down\] standup$/,
	);
	const conversation = await conversationId(t2.agent.harness);
	const items = Object.values((await t2.agent.harness.snapshot(Reminders, conversation, BG))?.items ?? {});
	const sunday = Date.UTC(2026, 9, 18, 4, 30); // Sun 09:30 in Tashkent
	assert.deepEqual(
		items.map((r) => [r.text, r.next]),
		[["standup", sunday]],
	);
	const live = (await remindTasks(t2.agent.harness)).filter((task) => task.state.status !== "terminal");
	assert.deepEqual(
		live.map((task) => (task.state as { checkpoint?: { due?: number } }).checkpoint?.due),
		[sunday],
	);
	await t2.close();

	const third = newFaux();
	third.setResponses(agentSteps([]));
	const t3 = await start(third, { dir, port, now: () => sat + 60_000 });
	cleanups.push(() => t3.close());
	await sleep(500);
	await t3.agent.harness.waitForIdle(BG);
	assert.equal((await wakeNotes(t3.agent.harness)).length, 2, "nothing fired twice");
	assert.equal(third.state.callCount, 0);
});

test("T-remind-plugin-off: a pending reminder with the plugin removed: the daemon starts and the reminder is dropped", async () => {
	const { dir, port } = await room();
	const faux = newFaux();
	faux.setResponses(
		agentSteps([
			toolCall("remind", { op: "add", text: "lunch", at: "2026-10-14T13:00" }),
			fauxAssistantMessage("Set."),
		]),
	);
	const first = await start(faux, { dir, port, now: () => T0 });
	await first.agent.channel.handleUpdate(textUpdate(CHAT, 1, "lunch"));
	await waitFor(() => port.textsIn(CHAT).includes("Set."), { what: "set" });
	await first.close();

	const second = newFaux();
	second.setResponses(agentSteps([]));
	const t2 = await start(second, { dir, port, now: () => T0 + DAY, plugins: "" });
	cleanups.push(() => t2.close());
	const harness = t2.agent.harness;
	await waitFor(async () => (await remindTasks(harness)).every((task) => task.state.status === "terminal"), {
		what: "reminder task ended",
	});
	assert.ok(
		t2.logs.some(
			(line) => line.includes("harness_report") && /reminder r\d+ dropped: the reminders plugin is off/.test(line),
		),
	);
	assert.deepEqual((await harness.snapshot(Reminders, await conversationId(harness), BG))?.items, {});
	assert.equal((await harness.inspect(BG)).tasks.filter((task) => task.state.kind === "blocked").length, 0);
	await sleep(200);
	assert.equal(second.state.callCount, 0, "no wake");
	assert.deepEqual(port.textsIn(CHAT), ["Set."]);
});

test("T-remind-revoked: a reminder of a user taken off the allow-list is dropped at its due time: no wake, no answer", async () => {
	const { dir, port } = await room();
	const faux = newFaux();
	faux.setResponses(
		agentSteps([
			toolCall("remind", { op: "add", text: "standup", at: "2026-10-14T13:00", every: "daily" }),
			fauxAssistantMessage("Set."),
		]),
	);
	const first = await start(faux, { dir, port, now: () => T0 });
	await first.agent.channel.handleUpdate(textUpdate(CHAT, 1, "standup daily"));
	await waitFor(() => port.textsIn(CHAT).includes("Set."), { what: "set" });
	await first.close();

	const second = newFaux();
	second.setResponses(agentSteps([]));
	const t2 = await start(second, { dir, port, now: () => T0 + DAY, allowed: "999" });
	cleanups.push(() => t2.close());
	const harness = t2.agent.harness;
	await waitFor(async () => (await remindTasks(harness)).every((task) => task.state.status === "terminal"), {
		what: "reminder task ended",
	});
	assert.ok(t2.logs.some((line) => /reminder r\d+ dropped: its chat is no longer allowed/.test(line)));
	assert.deepEqual((await harness.snapshot(Reminders, await conversationId(harness), BG))?.items, {});
	await sleep(200);
	assert.equal(second.state.callCount, 0, "no wake");
	assert.deepEqual(port.textsIn(CHAT), ["Set."]);
	assert.equal((await harness.commit((tx) => tx.scanTasks({ kind: "tg.deliver" }, 100), BG)).items.length, 1);
});

test("T-remind-cancel-ends: cancel ends the sleeping task at once, so add and cancel cannot pile up live tasks", async () => {
	const { dir, port } = await room();
	const results: Result[] = [];
	const lastId = () => /Reminder (r\d+)/.exec(results.at(-1)?.text ?? "")?.[1] ?? "none";
	const script: FauxResponseStep[] = [];
	for (let i = 0; i < 3; i++)
		script.push(toolCall("remind", { op: "add", text: `far ${i}`, at: "2027-10-01T09:00" }), () =>
			toolCall("remind", { op: "cancel", id: lastId() }),
		);
	const faux = newFaux();
	faux.setResponses(agentSteps([...script, fauxAssistantMessage("done")], results));
	const t = await start(faux, { dir, port, now: () => T0 });
	cleanups.push(() => t.close());
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "add and cancel"));
	await waitFor(() => port.textsIn(CHAT).includes("done"), { what: "done" });
	assert.deepEqual(
		results.map((r) => r.text.split(":")[0]?.split(" ")[0]),
		["Reminder", "Cancelled", "Reminder", "Cancelled", "Reminder", "Cancelled"],
	);
	const harness = t.agent.harness;
	await waitFor(async () => (await remindTasks(harness)).every((task) => task.state.status === "terminal"), {
		what: "cancelled tasks ended",
	});
	assert.equal((await remindTasks(harness)).length, 3);
	assert.equal(faux.state.callCount, 7, "no wake");
});
