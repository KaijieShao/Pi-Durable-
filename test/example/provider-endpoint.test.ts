import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentModels, createAuthContext } from "../../src/agent/models.ts";
import { codexGatewayPayload } from "../../src/agent/openai-relay.ts";
import { loadProvider } from "../../src/agent/providers.ts";

const endpoint = "https://relay.example.test/openai/v1";
const context = (value: string) => ({ env: async (name: string) => (name === "OPENAI_BASE_URL" ? value : undefined) });

test("Codex gateways preserve instructions, tools and user input while removing unsupported options", () => {
	const original = {
		input: [
			{ role: "developer", content: [{ type: "input_text", text: "Project instructions" }] },
			{ role: "user", content: "Question" },
		],
		tools: [{ type: "function", name: "read" }],
		max_output_tokens: 256,
		temperature: 1,
		prompt_cache_retention: "24h",
		prompt_cache_key: "session-1",
	};
	const params = codexGatewayPayload(original);
	assert.equal(params.instructions, "Project instructions");
	assert.deepEqual(params.input, [{ role: "user", content: "Question" }]);
	assert.deepEqual(params.tools, original.tools);
	assert.equal(params.prompt_cache_key, "session-1");
	assert.equal(params.stream, true);
	assert.equal(params.store, false);
	assert.ok(!("max_output_tokens" in params));
	assert.ok(!("temperature" in params));
	assert.equal(original.input.length, 2);
});

test("custom OpenAI endpoints reach all catalog models and exclude unrelated OAuth", async () => {
	const provider = await loadProvider("openai", context(`${endpoint}/`));
	assert.ok(provider);
	assert.equal(provider.baseUrl, endpoint);
	assert.ok(provider.getModels().length > 0);
	assert.ok(provider.getAllModels?.().every((model) => model.baseUrl === endpoint));
	assert.equal(provider.auth.oauth, undefined);
	assert.ok(provider.auth.apiKey);
});

test("the endpoint remains available after secrets are scrubbed from process.env", async () => {
	const models = await createAgentModels({
		provider: "openai",
		credentials: {
			read: async () => undefined,
			list: async () => [],
			modify: async () => undefined,
			delete: async () => {},
		},
		authContext: createAuthContext({ OPENAI_API_KEY: "test-only", OPENAI_BASE_URL: endpoint }, {}),
	});
	const model = models.getModel("openai", "gpt-5.4");
	assert.equal(model?.baseUrl, endpoint);
	assert.equal((await models.getAuth("openai"))?.auth.apiKey, "test-only");
});

test("Codex gateway requests transmit usable tool definitions instead of incremental tool items", async () => {
	const env = { OPENAI_API_KEY: "test-only", OPENAI_BASE_URL: endpoint, OPENAI_CODEX_GATEWAY: "1" };
	const models = await createAgentModels({
		provider: "openai",
		credentials: {
			read: async () => undefined,
			list: async () => [],
			modify: async () => undefined,
			delete: async () => {},
		},
		authContext: createAuthContext(env, env),
	});
	const model = models.getModel("openai", "gpt-6.1-sol");
	assert.ok(model);
	let captured: Record<string, unknown> | undefined;
	await models.completeSimple(
		model,
		{
			systemPrompt: "Use the read tool.",
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
						additionalProperties: false,
					},
				},
			],
			messages: [{ role: "user", content: "Read package.json", timestamp: 0 }],
		},
		{
			fetch: async (_url, init) => {
				captured = JSON.parse(String(init?.body));
				return new Response(JSON.stringify({ error: { message: "Fixture stops after capturing the request" } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				});
			},
		},
	);
	assert.ok(captured);
	assert.deepEqual(
		(captured.tools as { name: string }[]).map((tool) => tool.name),
		["read"],
	);
	assert.match(String(captured.instructions), /Use the read tool/);
	assert.ok(!(captured.input as { type?: string }[]).some((item) => item.type === "additional_tools"));
});

test("custom endpoints reject unsafe URLs without echoing their credentials", async () => {
	for (const value of [
		"not a URL",
		"http://remote.example.test",
		"https://name:private@relay.example.test",
		"https://relay.example.test?key=private",
	]) {
		await assert.rejects(loadProvider("openai", context(value)), (error: Error) => {
			assert.match(error.message, /OPENAI_BASE_URL/);
			assert.ok(!error.message.includes("private"));
			return true;
		});
	}
	assert.equal(
		(await loadProvider("openai", context("http://127.0.0.1:1234/v1")))?.baseUrl,
		"http://127.0.0.1:1234/v1",
	);
});
