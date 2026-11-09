import assert from "node:assert/strict";
import { test } from "node:test";
import { coordinatorEnvironment } from "../../deploy/gcp/environment.ts";
import { scrubSecrets } from "../../src/config/scrub.ts";

test("GCP startup preserves gateway configuration for parsing while keeping it out of child environments", () => {
	const source = {
		PATH: "/usr/bin:/bin",
		PI_MODEL: "gpt-6.1-sol",
		OPENAI_BASE_URL: "https://gateway.example.test/openai/v1",
		OPENAI_CODEX_GATEWAY: "1",
		OPENAI_API_KEY: "fixture-only-provider-key",
	};
	const configInput = coordinatorEnvironment(source);
	assert.equal(configInput.OPENAI_BASE_URL, "https://gateway.example.test/openai/v1");
	assert.equal(configInput.OPENAI_CODEX_GATEWAY, "1");
	assert.equal(configInput.PI_MODEL, "gpt-6.1-sol");
	assert.equal(configInput.OPENAI_API_KEY, "fixture-only-provider-key");
	assert.equal("OPENAI_API_KEY" in source, false);
	assert.equal("OPENAI_BASE_URL" in source, false);
	assert.equal(source.PATH, "/usr/bin:/bin");
	// runCoordinatorCli consumes this snapshot, then scrubs it after parsing the config.
	scrubSecrets(configInput);
	assert.equal("OPENAI_API_KEY" in configInput, false);
	assert.equal("OPENAI_BASE_URL" in configInput, false);
});
