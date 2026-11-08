import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { FakeBotApi } from "../fixtures/fake-bot-api.ts";
import { CHAT, TOKEN, tempDir } from "../helpers/agent.ts";
import { waitFor } from "../helpers/env.ts";
import { textUpdate } from "../helpers/updates.ts";

type Child = {
	process: ChildProcess;
	output: string[];
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function spawnDaemon(dir: string, apiRoot: string, mode: "slow" | "fast"): Child {
	const child = spawn(process.execPath, [join(import.meta.dirname, "../fixtures/daemon-child.ts")], {
		env: {
			PATH: process.env.PATH,
			HOME: dir,
			FAKE_MODE: mode,
			TELEGRAM_BOT_TOKEN: TOKEN,
			TELEGRAM_ALLOWED_USER_IDS: String(CHAT),
			TELEGRAM_API_ROOT: apiRoot,
			PI_PROVIDER: "faux",
			PI_MODEL: "faux-1",
			PI_THINKING: "off",
			PI_WORKDIR: join(dir, "work"),
			PI_DATA_DIR: join(dir, "data"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output: string[] = [];
	child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
	child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
		child.on("exit", (code, signal) => resolve({ code, signal })),
	);
	return { process: child, output, exited };
}

async function setup() {
	const { dir, cleanup } = await tempDir("pdt-e2e-");
	await mkdir(join(dir, "work"), { recursive: true });
	const api = new FakeBotApi();
	const root = await api.start();
	return {
		dir,
		api,
		root,
		cleanup: async () => {
			await api.stop();
			await cleanup();
		},
	};
}

function lockPid(dir: string): number | undefined {
	const path = join(dir, "data", "owner.lock");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid : undefined;
}

const draftOf = (call: { method: string; body: Record<string, unknown> }) =>
	call.method === "sendRichMessageDraft" ? (call.body.rich_message as { markdown: string }).markdown : undefined;

test("E2E-kill9: SIGKILL mid-run; the next process takes over the lock, resumes, and the rich answer lands once", {
	timeout: 60_000,
}, async () => {
	const { dir, api, root, cleanup } = await setup();
	const children: Child[] = [];
	try {
		const first = spawnDaemon(dir, root, "slow");
		children.push(first);
		await waitFor(() => api.count("getUpdates") > 0, { what: "polling", timeoutMs: 20_000 });
		const update = textUpdate(CHAT, 1, "work");
		api.enqueue(update);
		const draft = await waitFor(() => api.calls.find((call) => draftOf(call)?.startsWith("Partial")), {
			what: "draft",
			timeoutMs: 20_000,
		});
		assert.equal(draft.body.can_stop, true);
		assert.equal(draft.body.chat_id, CHAT);
		first.process.kill("SIGKILL");
		await first.exited;
		assert.equal(lockPid(dir), first.process.pid, "stale lock left behind");

		api.redeliver(update);
		const second = spawnDaemon(dir, root, "fast");
		children.push(second);
		await waitFor(() => api.textsIn(CHAT).includes("final answer"), {
			what: "final answer",
			timeoutMs: 20_000,
		}).catch((error) => {
			console.log(second.output.join(""));
			throw error;
		});
		assert.equal(lockPid(dir), second.process.pid, "lock taken over");
		assert.equal(api.messages.size, 1, "one message in total");
		assert.equal(api.count("sendRichMessage"), 1);
		assert.equal([...api.messages.values()][0]?.replyTo, 1);
		assert.equal(api.textsIn(CHAT).filter((text) => text === "final answer").length, 1);
		await waitFor(() => second.output.join("").includes("update_duplicate"), { what: "redelivery dropped" }).catch(
			(error) => {
				console.log(second.output.join(""));
				throw error;
			},
		);
		second.process.kill("SIGTERM");
		assert.equal((await second.exited).code, 0);
	} finally {
		for (const child of children) child.process.kill("SIGKILL");
		await cleanup();
	}
});

test("E2E-sigterm: SIGTERM mid-stream exits 0, confirms the offset and releases the lock", {
	timeout: 60_000,
}, async () => {
	const { dir, api, root, cleanup } = await setup();
	const child = spawnDaemon(dir, root, "slow");
	try {
		await waitFor(() => api.count("getUpdates") > 0, { what: "polling", timeoutMs: 20_000 });
		const update = textUpdate(CHAT, 1, "work");
		api.enqueue(update);
		await waitFor(() => api.calls.some((call) => draftOf(call)?.startsWith("Partial")), {
			what: "draft",
			timeoutMs: 20_000,
		});
		const polled = api.calls.find((call) => call.method === "getUpdates")?.body.allowed_updates;
		assert.deepEqual(polled, ["message", "callback_query", "stopped_message_generation"]);
		const started = Date.now();
		child.process.kill("SIGTERM");
		const { code } = await child.exited;
		assert.equal(code, 0, child.output.join(""));
		assert.ok(Date.now() - started < 20_000);
		assert.equal(lockPid(dir), undefined, "lock released");
		assert.ok(api.confirmed > update.update_id, "offset confirmed");
		assert.equal(api.count("deleteWebhook"), 1);
		assert.equal(api.count("setMyCommands"), 1);
	} finally {
		child.process.kill("SIGKILL");
		await cleanup();
	}
});

test("T-poll-errors: a rejected bot token exits 2; another poller exits 1", { timeout: 60_000 }, async () => {
	const { dir, api, root, cleanup } = await setup();
	try {
		api.failGetMe = 401;
		const bad = spawnDaemon(dir, root, "fast");
		assert.equal((await bad.exited).code, 2, bad.output.join(""));
		assert.match(bad.output.join(""), /rejected the bot token/);
		api.failGetMe = undefined;
		api.failGetUpdates = 409;
		const conflict = spawnDaemon(dir, root, "fast");
		assert.equal((await conflict.exited).code, 1, conflict.output.join(""));
		assert.match(conflict.output.join(""), /Another process polls this bot token/);
		assert.equal(lockPid(dir), undefined);
	} finally {
		await cleanup();
	}
});
