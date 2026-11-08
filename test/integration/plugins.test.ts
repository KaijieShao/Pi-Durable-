import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { CHAT, newFaux, startTestAgent, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { FakeTelegram } from "../helpers/fake-telegram.ts";
import { lastToolResult, observe, textOf, toolCall } from "../helpers/faux-steps.ts";
import { textUpdate } from "../helpers/updates.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A dependency-free plugin whose tool `name` answers `reply`, as the docs show. */
function pluginSource(name: string, reply: string, extension = `ext-${name}`): string {
	return `export default (ctx) => ({
	name: ${JSON.stringify(extension)},
	tools: [{
		name: ${JSON.stringify(name)},
		description: "test tool",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ output: [{ type: "text", text: ${JSON.stringify(reply)} + " " + ctx.workdir.length }] }),
	}],
});\n`;
}

async function writeFiles(files: Record<string, string>): Promise<void> {
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, text);
	}
}

async function setup(plugins: string, prepare: (dir: string) => Promise<void> = async () => {}) {
	const { dir, cleanup } = await tempDir();
	cleanups.push(cleanup);
	await prepare(dir);
	return { dir, port: new FakeTelegram(), config: { PI_PLUGINS: plugins } };
}

test("T-plugin-sources: a file, a folder and an npm package from the plugins dir load; their tools run", async () => {
	const { dir, port, config } = await setup("./p/file.mjs, ~/folder, demo-plugin", async (root) => {
		await writeFiles({
			[join(root, "work", "p", "file.mjs")]: pluginSource("from_file", "file ok"),
			[join(root, "folder", "package.json")]: JSON.stringify({ exports: { ".": { import: "./main.mjs" } } }),
			[join(root, "folder", "main.mjs")]: pluginSource("from_folder", "folder ok"),
			[join(root, "data", "plugins", "node_modules", "demo-plugin", "package.json")]: JSON.stringify({
				main: "lib.mjs",
			}),
			[join(root, "data", "plugins", "node_modules", "demo-plugin", "lib.mjs")]: pluginSource("from_npm", "npm ok"),
		});
	});
	const faux = newFaux();
	const results: string[] = [];
	const record = (messages: readonly Message[]) => results.push(textOf(lastToolResult(messages)));
	faux.setResponses([
		toolCall("from_file", {}),
		observe(record, toolCall("from_folder", {})),
		observe(record, toolCall("from_npm", {})),
		observe(record, fauxAssistantMessage("all three ran")),
	]);
	const t = await startTestAgent({ dir, faux, port, config, deps: { pluginEnv: { HOME: dir } } });
	cleanups.push(() => t.close());
	assert.deepEqual(t.agent.plugins.report, { loaded: ["./p/file.mjs", "~/folder", "demo-plugin"], problems: [] });
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "run them"));
	await waitFor(() => port.textsIn(CHAT).includes("all three ran"));
	const n = join(dir, "work").length;
	assert.deepEqual(results, [`file ok ${n}`, `folder ok ${n}`, `npm ok ${n}`]);
	assert.equal(port.count("sendMessage"), 1, "no plugin notice when all loaded");
});

const sectionPlugin = (name: string, key: string) =>
	`export default () => ({ name: "${name}", sections: [{ key: "${key}", render: () => "HIJACKED" }] });\n`;

test("T-plugin-broken: broken plugins are skipped, logged, told once in chat and listed in /status", async () => {
	const { dir, port, config } = await setup(
		"./missing.mjs, ./throws.mjs, ./tasks.mjs, ./clash.mjs, not a name!, absent-pkg, ./good.mjs, ./again.mjs, " +
			"./badkey.mjs, ./dupe.mjs, ./hijack.mjs",
		async (root) => {
			const work = join(root, "work");
			await writeFiles({
				[join(work, "throws.mjs")]: `export default () => { throw new Error("boom in factory"); };\n`,
				[join(work, "tasks.mjs")]: `export default () => ({ name: "with-tasks", tasks: [{ name: "x" }] });\n`,
				[join(work, "clash.mjs")]: pluginSource("bash", "replaced"),
				[join(work, "good.mjs")]: pluginSource("good_tool", "good"),
				[join(work, "again.mjs")]: pluginSource("good_tool", "again", "ext-again"),
				[join(work, "badkey.mjs")]: sectionPlugin("badkey", "My Section"),
				[join(work, "dupe.mjs")]:
					`const t = { name: "dup", description: "d", parameters: { type: "object" }, execute: async () => ({ output: [] }) };
export default () => ({ name: "ext-dup", tools: [t, t] });\n`,
				[join(work, "hijack.mjs")]: sectionPlugin("hijack", "preamble"),
			});
		},
	);
	const t = await startTestAgent({ dir, faux: newFaux(), port, config, deps: { pluginEnv: {} } });
	cleanups.push(() => t.close());
	assert.deepEqual(t.agent.plugins.report.loaded, ["./good.mjs"]);
	const reasons = Object.fromEntries(t.agent.plugins.report.problems.map((p) => [p.plugin, p.reason]));
	assert.match(reasons["./missing.mjs"] ?? "", /^did not load: not found: .*missing\.mjs$/);
	assert.equal(reasons["./throws.mjs"], "did not load: boom in factory");
	assert.equal(reasons["./tasks.mjs"], "did not load: plugins cannot define tasks");
	assert.equal(reasons["./clash.mjs"], "did not load: the name bash is already taken");
	assert.equal(reasons["not a name!"], "did not load: not a plugin name or path");
	assert.match(reasons["absent-pkg"] ?? "", /not installed: run npm install --prefix .*plugins absent-pkg/);
	assert.equal(reasons["./again.mjs"], "did not load: the name good_tool is already taken");
	assert.match(reasons["./badkey.mjs"] ?? "", /^did not load: Section key "My Section" must match/);
	assert.equal(reasons["./dupe.mjs"], "did not load: Extension ext-dup has two tools named dup");
	assert.equal(reasons["./hijack.mjs"], "did not load: the name section:preamble is already taken");
	assert.equal(t.logs.filter((line) => line.includes("warn plugin_problem")).length, 10);

	const notice = await waitFor(() => port.created(CHAT).find((m) => m.text.startsWith("Plugin ")));
	assert.equal(notice.text.split("\n").length, 10);
	assert.match(notice.text, /^Plugin \.\/throws\.mjs: did not load: boom in factory$/m);
	assert.equal(port.count("sendMessage"), 1, "one notice");

	await t.agent.channel.handleUpdate(textUpdate(CHAT, 2, "/status"));
	const status = await waitFor(() => port.created(CHAT).find((m) => m.text.includes("Plugins:")));
	assert.match(status.text, /Plugins: \.\/good\.mjs; problems: \.\/missing\.mjs \(did not load: not found/);
});

const HANG = `export default () => ({
	name: "hanger",
	tools: [{
		name: "hang",
		description: "waits",
		parameters: { type: "object", properties: {} },
		execute: (_args, _api, context) => new Promise((_resolve, reject) => {
			globalThis.__hangStarted = true;
			context.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
		}),
	}],
});\n`;

for (const [label, after] of [
	["removed", ""],
	["broken", "./broken.mjs"],
] as const) {
	test(`T-plugin-${label}-unfinished: a ${label} plugin with a running tool call does not block startup`, async () => {
		const { dir, port, config } = await setup("./hang.mjs", async (root) => {
			await writeFiles({
				[join(root, "work", "hang.mjs")]: HANG,
				[join(root, "work", "broken.mjs")]: `throw new Error("module is broken");\n`,
			});
		});
		const first = newFaux();
		first.setResponses([toolCall("hang", {})]);
		(globalThis as { __hangStarted?: boolean }).__hangStarted = false;
		const t1 = await startTestAgent({ dir, faux: first, port, config, deps: { pluginEnv: {} } });
		await t1.agent.channel.handleUpdate(textUpdate(CHAT, 1, "hang"));
		await waitFor(() => (globalThis as { __hangStarted?: boolean }).__hangStarted, { what: "tool running" });
		await t1.close();

		const second = newFaux();
		let seen = "";
		second.setResponses([
			(context) => {
				const result = lastToolResult(context.messages);
				seen = `${result?.isError}:${textOf(result)}`;
				return fauxAssistantMessage("recovered");
			},
		]);
		const t2 = await startTestAgent({
			dir,
			faux: second,
			port,
			config: { PI_PLUGINS: after },
			deps: { pluginEnv: {} },
		});
		cleanups.push(() => t2.close());
		await waitFor(() => port.textsIn(CHAT).includes("recovered"), { what: "answer after restart" });
		assert.match(seen, /^true:[\s\S]*Tool hang was interrupted/);
		assert.equal(port.textsIn(CHAT).filter((text) => text === "recovered").length, 1);
		const notices = port.created(CHAT).filter((m) => m.text.startsWith("Plugin "));
		assert.equal(notices.length, label === "broken" ? 1 : 0);
	});
}

test("T-plugin-builtin: the built-in skills plugin puts its section into the request", async () => {
	const { dir, port, config } = await setup("skills", async (root) => {
		await writeFiles({
			[join(root, "work", "skills", "tidy", "SKILL.md")]: "---\nname: tidy\ndescription: Tidy up\n---\n",
		});
	});
	const faux = newFaux();
	let prompt = "";
	faux.setResponses([
		(context) => {
			const system = context.messages as unknown as { role: string; sections?: Record<string, string | null> }[];
			prompt = system.flatMap((m) => (m.role === "system" ? Object.values(m.sections ?? {}) : [])).join("\n");
			return fauxAssistantMessage("ok");
		},
	]);
	const t = await startTestAgent({ dir, faux, port, config, deps: { pluginEnv: { HOME: dir } } });
	cleanups.push(() => t.close());
	await t.agent.channel.handleUpdate(textUpdate(CHAT, 1, "hi"));
	await waitFor(() => port.textsIn(CHAT).includes("ok"));
	assert.match(prompt, /<skills>\n.*read tool.*\n- tidy: Tidy up\n {2}\S+tidy\/SKILL\.md\n<\/skills>/);
});
