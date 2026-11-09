import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { getGlobalDispatcher } from "undici";
import { TelegramError } from "../../src/coordinator/ports.ts";
import { createTelegramApi } from "../../src/coordinator/telegram/api.ts";

async function endpoint(t: TestContext, handler: (method: string, response: ServerResponse) => void) {
	const sockets = new Set<Socket>();
	let connections = 0;
	const server = createServer((request, response) => {
		request.resume();
		response.setHeader("content-type", "application/json");
		handler(request.url?.split("/").at(-1) ?? "", response);
	});
	server.keepAliveTimeout = 60_000;
	server.on("connection", (socket) => {
		connections++;
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	return {
		root: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		connections: () => connections,
	};
}

test("Telegram transport reuses its connection beyond Node fetch's default four-second idle window", async (t) => {
	const globalDispatcher = getGlobalDispatcher();
	const host = await endpoint(t, (method, response) => {
		const result = method === "getMe" ? { id: 1, username: "test_bot" } : { message_id: 1 };
		response.end(JSON.stringify({ ok: true, result }));
	});
	const api = createTelegramApi({ token: "test-only", apiRoot: host.root });
	t.after(() => api.close?.());
	await api.getMe();
	await sleep(4500);
	assert.deepEqual(await api.sendMessage({ chatId: 1, text: "paced reply" }), { messageId: 1 });
	assert.equal(host.connections(), 1, "the paced reply must reuse the already established connection");
	assert.equal(getGlobalDispatcher(), globalDispatcher, "Telegram must not replace other clients' global pool");
});

test("Telegram transport sends a reply while its long poll remains held, then closes after abort", async (t) => {
	let markPolled: () => void = () => {};
	let pollResponse: ServerResponse | undefined;
	const polled = new Promise<void>((resolve) => {
		markPolled = resolve;
	});
	const host = await endpoint(t, (method, response) => {
		if (method === "getUpdates") {
			pollResponse = response;
			markPolled();
		} else response.end(JSON.stringify({ ok: true, result: { message_id: 2 } }));
	});
	const api = createTelegramApi({ token: "test-only", apiRoot: host.root });
	const controller = new AbortController();
	t.after(async () => {
		controller.abort();
		await api.close?.();
	});
	const poll = api.getUpdates(0, 30, controller.signal).catch((error: unknown) => error);
	await polled;
	const reply = await Promise.race([
		api.sendMessage({ chatId: 1, text: "required reply" }),
		sleep(2000, "reply blocked behind long poll", { ref: false }),
	]);
	assert.deepEqual(reply, { messageId: 2 });
	assert.equal(pollResponse?.writableEnded, false, "the long poll has not been released to let the reply through");
	assert.equal(host.connections(), 2);
	controller.abort();
	const error: unknown = await poll;
	assert.ok(error instanceof TelegramError && error.kind === "network");
	await api.close?.();
});
