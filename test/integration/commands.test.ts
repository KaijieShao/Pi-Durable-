import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { type FauxProviderHandle, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { ChatMap } from "../../src/channel/docs.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { sleep, waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { toolCall, untilAborted } from "../helpers/faux-steps.ts";
import { DATE, textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(faux: FauxProviderHandle): Promise<{ t: TestAgent; port: FakeTelegram; dir: string }> {
	const { dir, cleanup } = await tempDir();
	const port = new FakeTelegram();
	const t = await startTestAgent({ dir, faux, port });
	cleanups.push(cleanup, () => t.close());
	return { t, port, dir };
}

async function conversation(t: TestAgent) {
	const id = await waitFor(async () => (await t.agent.harness.snapshot(ChatMap, BG))?.chats[String(CHAT)]);
	const found = await t.agent.harness.conversation(id as never, BG);
	assert.ok(found !== undefined);
	return found;
}

function replyTo(port: FakeTelegram, messageId: number): string | undefined {
	return port.created(CHAT).find((m) => m.replyTo === messageId)?.text;
}

test("commands are registered; /start and /help reply once with the command list", async () => {
	const { t, port } = await setup(newFaux());
	assert.deepEqual(
		port.commands.map((c) => c.command),
		["new", "stop", "compact", "status", "help"],
	);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/start"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/help"));
	await waitFor(() => replyTo(port, 2));
	assert.match(replyTo(port, 1) ?? "", /\/new - Start a fresh context/);
	assert.match(replyTo(port, 2) ?? "", /Voice messages are off/);
});

test("/status reports model, thinking, auth, queue and spend", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("hi")]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "hello"));
	await waitFor(() => port.textsIn(CHAT).includes("hi"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/status"));
	const status = await waitFor(() => replyTo(port, 2));
	assert.match(status, /Model: faux\/faux-1, thinking off/);
	assert.match(status, /Auth: api_key/);
	assert.match(status, /State: idle, queued: 0/);
	assert.match(status, /Context: \d+/);
	assert.match(status, /This chat: in /);
});

test("/new starts a fresh context in the same conversation; history stays in storage", async () => {
	const faux = newFaux();
	let userMessages = -1;
	faux.setResponses([
		fauxAssistantMessage("first answer"),
		(context) => {
			userMessages = context.messages.filter((m) => m.role === "user").length;
			return fauxAssistantMessage("fresh answer");
		},
	]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "remember 42"));
	await waitFor(() => port.textsIn(CHAT).includes("first answer"));
	const before = await conversation(t);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/new"));
	await waitFor(() => replyTo(port, 2) === "New context. Old history is kept.");
	assert.equal((await before.context(BG)).messages.length, 0);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "what was it?"));
	await waitFor(() => port.textsIn(CHAT).includes("fresh answer"));
	assert.equal(userMessages, 1);
	assert.equal((await conversation(t)).id, before.id);
	const history = await before.entries({}, 50, undefined, BG);
	assert.ok(history.items.some((entry) => JSON.stringify(entry.model ?? []).includes("remember 42")));
});

test("T-new-names-dropped: /new tells which unanswered messages it dropped", async () => {
	const faux = newFaux();
	faux.setResponses([untilAborted, fauxAssistantMessage("fresh")]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "long job"));
	const conv = await conversation(t);
	await waitFor(async () => (await t.agent.harness.snapshot(LiveDoc, conv.id, BG))?.run, { what: "run" });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "please also check the invoice from Monday morning"));
	await waitFor(async () => ((await t.agent.harness.snapshot(InboxDoc, conv.id, BG))?.items.length ?? 0) === 1, {
		what: "queued",
	});
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "/new"));
	await waitFor(() => replyTo(port, 3) !== undefined, { what: "/new reply" });
	assert.equal(
		replyTo(port, 3),
		"New context. Old history is kept.\nThe request in progress was stopped.\n" +
			"Dropped without an answer (1): «please also check the invoice from Mond…». Send again what still matters.",
	);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 4, "hi"));
	await waitFor(() => replyTo(port, 4) === "fresh", { what: "answer in the new context" });
	assert.equal(replyTo(port, 2), undefined, "the dropped message gets no answer of its own");
});

test("T-commands-reset: after the bot changes, commands with old message ids run; a redelivered one runs once", async () => {
	const faux = newFaux();
	const { t, port } = await setup(faux);
	const later = DATE + 86_400;
	const status = textUpdate(CHAT, 1, "/status", { date: DATE });
	await t.agent.channel.handleUpdate(status);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/stop", { date: DATE }));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "/new", { date: DATE }));
	await waitFor(() => port.created(CHAT).length === 3, { what: "first replies" });
	await t.agent.channel.handleUpdate(status);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "/status", { date: later }));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/stop", { date: later }));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "/new", { date: later }));
	await waitFor(() => port.created(CHAT).length === 6, { what: "replies after the reset" });
	await sleep(200);
	const replies = port.created(CHAT).map((m) => `${m.replyTo}:${m.text.split("\n")[0]}`);
	assert.equal(replies.filter((r) => r.startsWith("1:")).length, 2, "the redelivered /status ran once");
	assert.equal(replies.filter((r) => r === "2:Nothing is running.").length, 2);
	assert.equal(replies.filter((r) => r === "3:New context. Old history is kept.").length, 2);
});

test("T-stop-keeps-queue: /stop aborts the current run; the queued message is still answered", async () => {
	const faux = newFaux();
	faux.setResponses([untilAborted, fauxAssistantMessage("queued answer")]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "long job"));
	const conv = await conversation(t);
	await waitFor(async () => (await t.agent.harness.snapshot(LiveDoc, conv.id, BG))?.run, { what: "run" });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "next"));
	await waitFor(async () => ((await t.agent.harness.snapshot(InboxDoc, conv.id, BG))?.items.length ?? 0) === 1, {
		what: "queued",
	});
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "/stop"));
	await waitFor(() => port.textsIn(CHAT).includes("queued answer"), { what: "queued answered" });
	assert.equal(replyTo(port, 3), "Stopped. 1 queued message(s) will continue.");
	assert.equal(replyTo(port, 2), "queued answer");
	assert.equal(replyTo(port, 1), undefined, "the stopped message without a preview stays silent");
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 4, "/stop"));
	await waitFor(() => replyTo(port, 4) === "Nothing is running.");
});

test("T-stop-tool: /stop during a long bash kills the process", async () => {
	const faux = newFaux();
	const { t, port, dir } = await setup(faux);
	const pidFile = join(dir, "work", "pid");
	faux.setResponses([
		toolCall("bash", { command: `echo $$ > ${pidFile}; exec sleep 30` }),
		fauxAssistantMessage("never"),
	]);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "run it"));
	await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", { what: "bash started" });
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	assert.doesNotThrow(() => process.kill(pid, 0));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/stop"));
	await waitFor(() => replyTo(port, 2) === "Stopped.", { what: "stopped reply" });
	await waitFor(
		() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		},
		{ what: "process gone" },
	);
	await sleep(100);
	assert.ok(!port.textsIn(CHAT).includes("never"));
});

test("/compact replies at once and reports the outcome later", async () => {
	const faux = newFaux();
	faux.setResponses([
		fauxAssistantMessage("a1"),
		fauxAssistantMessage("a2"),
		fauxAssistantMessage("summary of the chat"),
	]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "one"));
	await waitFor(() => port.textsIn(CHAT).includes("a1"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "two"));
	await waitFor(() => port.textsIn(CHAT).includes("a2"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 3, "/compact keep names"));
	await waitFor(() => port.created(CHAT).filter((m) => m.replyTo === 3).length === 2, { what: "two replies" });
	const replies = port
		.created(CHAT)
		.filter((m) => m.replyTo === 3)
		.map((m) => m.text);
	assert.equal(replies[0], "Compacting…");
	assert.match(replies[1] ?? "", /^(Compacted\.|Nothing to compact\.)$/);
});

test("/compact redelivered while the first copy runs starts one compaction", async () => {
	const faux = newFaux();
	faux.setResponses([
		fauxAssistantMessage("a1"),
		fauxAssistantMessage("a2"),
		fauxAssistantMessage("summary of the chat"),
		fauxAssistantMessage("second summary"),
	]);
	const { t, port } = await setup(faux);
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "one"));
	await waitFor(() => port.textsIn(CHAT).includes("a1"));
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "two"));
	await waitFor(() => port.textsIn(CHAT).includes("a2"));
	const update = textUpdate(CHAT, 4, "/compact");
	await Promise.all([t.agent.channel.handleUpdate(update), t.agent.channel.handleUpdate(update)]);
	await waitFor(() => port.created(CHAT).filter((m) => m.replyTo === 4).length >= 2, { what: "report" });
	await sleep(300);
	const reports = await t.agent.harness.commit((tx) => tx.scanTasks({ kind: "tg.compact-report" }, 100), BG);
	assert.equal(reports.items.length, 1);
	const all = await t.agent.harness.commit((tx) => tx.scanTasks({}, 100), BG);
	const compactions = all.items.filter((task) => /compact/i.test(task.kind) && task.kind !== "tg.compact-report");
	assert.equal(compactions.length, 1, `tasks: ${all.items.map((task) => task.kind).join(",")}`);
	assert.deepEqual(
		port
			.created(CHAT)
			.filter((m) => m.replyTo === 4)
			.map((m) => m.text)
			.slice(0, 1),
		["Compacting…"],
	);
});
