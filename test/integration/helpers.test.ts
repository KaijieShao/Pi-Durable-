import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import {
	type FauxProviderHandle,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { toolHint } from "../../src/delivery/hints.ts";
import { CHAT, newFaux, startTestAgent, type TestAgent, tempDir } from "../helpers/agent.ts";
import { sleep, waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { gate, lastUserText, textOf, untilAborted } from "../helpers/faux-steps.ts";
import { stoppedUpdate, textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Tool names a request offers, from the system messages' tool changes. */
function toolNames(messages: readonly Message[]): string[] {
	const names = new Set<string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) names.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
	}
	return [...names];
}

type ToolResult = Extract<Message, { role: "toolResult" }>;
const results = (messages: readonly Message[]): ToolResult[] =>
	messages.filter((message): message is ToolResult => message.role === "toolResult");

type Seen = { role: "parent" | "child"; model: string; tools: string[]; user: string };

/**
 * The faux queue is shared by the parent and its helpers, which run in any order: every step routes by whether the
 * request offers `helper` (the parent) or not (a helper).
 */
function router(options: {
	parent: (messages: readonly Message[]) => ReturnType<typeof fauxAssistantMessage>;
	child: FauxResponseFactory;
	seen: Seen[];
}): FauxResponseFactory {
	return (context, streamOptions, state, model) => {
		const tools = toolNames(context.messages);
		const role = tools.includes("helper") ? "parent" : "child";
		options.seen.push({ role, model: model.id, tools, user: lastUserText(context.messages) });
		return role === "parent" ? options.parent(context.messages) : options.child(context, streamOptions, state, model);
	};
}

const helperCalls = (...tasks: string[]) =>
	fauxAssistantMessage(
		tasks.map((task, i) => fauxToolCall("helper", { task }, { id: `call-${i}` })),
		{ stopReason: "toolUse" },
	);

/** Parent: delegate `tasks` on the first request, then report what came back. */
const delegate =
	(...tasks: string[]) =>
	(messages: readonly Message[]) => {
		const done = results(messages);
		if (done.length === 0) return helperCalls(...tasks);
		return fauxAssistantMessage(`Parent got: ${done.map((r) => `${r.isError ? "ERR " : ""}${textOf(r)}`).join(" | ")}`);
	};

async function setup(
	faux: FauxProviderHandle,
	options: { env?: Record<string, string>; dir?: string; config?: Record<string, string> } = {},
): Promise<{ t: TestAgent; port: FakeTelegram }> {
	const made = options.dir === undefined ? await tempDir() : undefined;
	if (made !== undefined) cleanups.push(made.cleanup);
	const port = new FakeTelegram();
	const t = await startTestAgent({
		dir: options.dir ?? made?.dir ?? "",
		faux,
		port,
		config: { PI_PLUGINS: "helpers", ...options.config },
		deps: { pluginEnv: options.env ?? {} },
	});
	return { t, port };
}

/** Conversations owned by a task: the helpers' children. */
async function children(harness: Harness): Promise<number[]> {
	const page = await harness.commit((tx) => tx.scanConversations({}, 100), BG);
	return page.items.filter((record) => record.owner !== undefined).map((record) => record.id);
}

const many = (step: FauxResponseFactory, n = 30) => Array.from({ length: n }, () => step);

test("T-helper-answer: the helper's final answer is the tool result; it has the full toolset but no helper tool", async () => {
	const faux = newFaux({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
	const seen: Seen[] = [];
	faux.setResponses(
		many(
			router({
				seen,
				parent: delegate("Name three primes"),
				child: (context) => fauxAssistantMessage(`2, 3, 5 for "${lastUserText(context.messages)}"`),
			}),
		),
	);
	const { t, port } = await setup(faux);
	cleanups.push(() => t.close());
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "go"));
	await waitFor(() => port.textsIn(CHAT).some((text) => text.startsWith("Parent got")), { what: "answer" });
	assert.deepEqual(port.textsIn(CHAT), ['Parent got: 2, 3, 5 for "Name three primes"']);
	const child = seen.filter((s) => s.role === "child");
	assert.equal(child.length, 1);
	assert.ok(child[0]?.tools.includes("bash") && child[0].tools.includes("telegram_send_file"), "full toolset");
	assert.ok(!child[0]?.tools.includes("helper"), "no nesting");
	assert.deepEqual([...new Set(seen.map((s) => s.model))], ["faux-1"], "both on the main model");
	assert.equal((await children(t.agent.harness)).length, 1);
	assert.equal(toolHint("helper", { task: "Find the cheapest\nflight to Rome" }), "helper: Find the cheapest");
});

test("T-helper-model: PI_HELPER_MODEL runs helpers on another model; a bad value is a problem and the main model", async () => {
	for (const [value, expected, problem] of [
		["faux/faux-2", "faux-2", undefined],
		["faux/nope", "faux-1", /PI_HELPER_MODEL=faux\/nope: faux\/nope is unknown.*helpers use the main model/],
		["nope", "faux-1", /PI_HELPER_MODEL=nope: use provider\/model/],
	] as const) {
		const faux = newFaux({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
		const seen: Seen[] = [];
		faux.setResponses(
			many(router({ seen, parent: delegate("Say hi"), child: () => fauxAssistantMessage("hi from helper") })),
		);
		const { t, port } = await setup(faux, { env: { PI_HELPER_MODEL: value } });
		cleanups.push(() => t.close());
		await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "go"));
		await waitFor(() => port.textsIn(CHAT).includes("Parent got: hi from helper"), { what: `answer ${value}` });
		assert.equal(seen.find((s) => s.role === "parent")?.model, "faux-1");
		assert.equal(seen.find((s) => s.role === "child")?.model, expected, value);
		const reasons = t.agent.plugins.report.problems.map((p) => p.reason).join("\n");
		if (problem === undefined) assert.equal(reasons, "");
		else assert.match(reasons, problem);
		assert.deepEqual(t.agent.plugins.report.loaded, ["helpers"]);
	}
});

test("T-helper-limit: calls beyond PI_HELPERS_MAX get an error telling the model to wait; the others run in parallel", async () => {
	const faux = newFaux();
	const seen: Seen[] = [];
	const release = gate();
	faux.setResponses(
		many(
			router({
				seen,
				parent: delegate("t0", "t1", "t2", "t3", "t4"),
				child: async (context) => {
					await release.promise;
					return fauxAssistantMessage(`done ${lastUserText(context.messages)}`);
				},
			}),
		),
	);
	const { t, port } = await setup(faux, { env: { PI_HELPERS_MAX: "2" } });
	cleanups.push(() => t.close());
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "go"));
	await waitFor(() => seen.filter((s) => s.role === "child").length === 2, { what: "two helpers running" });
	await sleep(200);
	release.open();
	const answer = await waitFor(() => port.textsIn(CHAT).find((text) => text.startsWith("Parent got")));
	const parts = answer.replace("Parent got: ", "").split(" | ");
	assert.equal(parts.filter((p) => p.startsWith("done t")).length, 2, answer);
	const refused = parts.filter((p) => p.startsWith("ERR "));
	assert.equal(refused.length, 3, answer);
	for (const part of refused) assert.match(part, /2 helpers are already running; wait for their answers/);
	assert.equal(seen.filter((s) => s.role === "child").length, 2, "only two helpers started");
	assert.equal((await children(t.agent.harness)).length, 2);
});

async function childTaskStates(harness: Harness): Promise<string[]> {
	const owned = new Set(await children(harness));
	const page = await harness.commit((tx) => tx.scanTasks({}, 500), BG);
	return page.items
		.filter((task) => owned.has(task.conversationId))
		.map((task) => (task.state.status === "terminal" ? task.state.outcome.status : task.state.status));
}

for (const how of ["/stop", "draft stop button"] as const) {
	test(`T-helper-stop: ${how} aborts the running helpers with their parent`, async () => {
		const faux = newFaux();
		const seen: Seen[] = [];
		let aborted = 0;
		const child: FauxResponseFactory = async (context, options, state, model) => {
			const message = await untilAborted(context, options, state, model);
			aborted += 1;
			return message;
		};
		faux.setResponses(many(router({ seen, parent: delegate("long a", "long b"), child })));
		const rich = how === "draft stop button";
		const { t, port } = await setup(faux, { config: { TELEGRAM_RICH: rich ? "auto" : "never" } });
		cleanups.push(() => t.close());
		await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "go"));
		await waitFor(() => seen.filter((s) => s.role === "child").length === 2, { what: "helpers running" });
		if (rich) {
			const draft = await waitFor(() => port.drafts[0], { what: "draft" });
			await t.agent.channel.handleUpdate(stoppedUpdate(CHAT, draft.draftId));
		} else await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/stop"));
		await waitFor(() => port.textsIn(CHAT).includes("Stopped."), { what: "stopped" });
		await waitFor(() => aborted === 2, { what: "both helper requests aborted" });
		await t.agent.harness.waitForIdle(BG);
		const states = await childTaskStates(t.agent.harness);
		assert.ok(states.length >= 2 && states.every((s) => s === "aborted"), states.join(","));
		assert.ok(!port.textsIn(CHAT).some((text) => text.startsWith("Parent got")));
	});
}

test("T-helper-restart: a restart mid-helper resumes the same child without a second submission", async () => {
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const first = newFaux();
	const seen1: Seen[] = [];
	let childStarted = false;
	first.setResponses(
		many(
			router({
				seen: seen1,
				parent: delegate("survive a restart"),
				child: (context, options, state, model) => {
					childStarted = true;
					return untilAborted(context, options, state, model);
				},
			}),
		),
	);
	const one = await setup(first, { dir });
	await one.t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "go"));
	await waitFor(() => childStarted, { what: "helper running" });
	await one.t.close();

	const second = newFaux();
	const seen2: Seen[] = [];
	second.setResponses(
		many(router({ seen: seen2, parent: delegate("unused"), child: () => fauxAssistantMessage("resumed answer") })),
	);
	const two = await setup(second, { dir });
	cleanups.push(() => two.t.close());
	await waitFor(() => two.port.textsIn(CHAT).includes("Parent got: resumed answer"), { what: "answer after restart" });
	const harness = two.t.agent.harness;
	const ids = await children(harness);
	assert.equal(ids.length, 1, "the same child, not a second one");
	assert.equal(seen2.filter((s) => s.role === "child").length, 1);
	const handle = await harness.conversation(ids[0] as never, BG);
	const users = (await handle?.context(BG))?.messages.filter((m) => m.role === "user") ?? [];
	assert.deepEqual(
		users.map((m) => textOf(m as never)),
		["survive a restart"],
		"one submission in the child",
	);
});

test("T-helper-plugin-off: a helper left running, then the plugin removed: the daemon starts and nothing hangs", async () => {
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	const first = newFaux();
	let childStarted = false;
	const child: FauxResponseFactory = (context, options, state, model) => {
		childStarted = true;
		return untilAborted(context, options, state, model);
	};
	first.setResponses(many(router({ seen: [], parent: delegate("left running"), child })));
	const one = await setup(first, { dir });
	await one.t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "go"));
	await waitFor(() => childStarted, { what: "helper running" });
	await one.t.close();

	const second = newFaux();
	let seen = "";
	second.setResponses(
		many((context) => {
			if (lastUserText(context.messages) === "left running") return fauxAssistantMessage("late child answer");
			const result = results(context.messages).at(-1);
			seen = `${result?.isError}:${textOf(result)}`;
			return fauxAssistantMessage("recovered");
		}),
	);
	const two = await setup(second, { dir, config: { PI_PLUGINS: "" } });
	cleanups.push(() => two.t.close());
	await waitFor(() => two.port.textsIn(CHAT).includes("recovered"), { what: "answer after restart" });
	assert.match(seen, /^true:[\s\S]*Tool helper was interrupted/);
	await two.t.agent.harness.waitForIdle(BG);
	const live = (await two.t.agent.harness.inspect(BG)).tasks;
	assert.deepEqual(
		live.filter((task) => task.state.kind === "blocked"),
		[],
	);
	assert.ok((await childTaskStates(two.t.agent.harness)).every((state) => ["aborted", "completed"].includes(state)));
});
