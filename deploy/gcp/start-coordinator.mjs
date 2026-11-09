#!/usr/bin/env node
import { runCoordinatorCli } from "../../src/cli/run.ts";
import { coordinatorEnvironment } from "./environment.ts";

// Values stay in process memory and never enter files or child-process environments.

const project = process.env.GOOGLE_CLOUD_PROJECT ?? "project-9824d5fb-1d2b-4351-a2b";
const credentials = [
	["TELEGRAM_BOT_TOKEN", "pi-durable-telegram-token"],
	["OPENAI_API_KEY", "pi-durable-model-api-key"],
	["GITHUB_TOKEN", "pi-durable-github-token"],
];

async function readCredential(name, id, accessToken) {
	const response = await fetch(
		`https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets/${id}/versions/latest:access`,
		{ headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) },
	);
	if (!response.ok) {
		process.stderr.write(`credential_unavailable variable=${name} secret=${id} status=${response.status}\n`);
		return undefined;
	}
	const payload = await response.json();
	const value = Buffer.from(payload.payload?.data ?? "", "base64").toString("utf8");
	if (!value.trim()) {
		process.stderr.write(`credential_unavailable variable=${name} secret=${id} reason=empty\n`);
		return undefined;
	}
	return value;
}

async function start() {
	const env = coordinatorEnvironment(process.env);
	const metadata = await fetch(
		"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
		{ headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(10_000) },
	);
	if (!metadata.ok) throw new Error("metadata_identity_unavailable");
	const identity = await metadata.json();
	if (typeof identity.access_token !== "string") throw new Error("metadata_identity_unavailable");
	let missing = false;
	for (const [name, id] of credentials) {
		const value = await readCredential(name, id, identity.access_token);
		if (value === undefined) missing = true;
		else env[name] = value;
	}
	if (missing) return 2;
	if (process.argv.includes("--check-secrets")) {
		process.stdout.write("secret_manager_credentials_available count=3\n");
		return 0;
	}
	const result = await runCoordinatorCli({
		env,
		start: async (config, deps) =>
			(await import("../../src/coordinator/coordinator.ts")).startCoordinator(config, deps),
	});
	return typeof result === "number" ? result : undefined;
}

start().then(
	(code) => {
		if (code !== undefined) process.exitCode = code;
	},
	() => {
		// Error objects, upstream response bodies and URLs can contain credentials.
		process.stderr.write("startup_failed reason=secret_manager_or_runtime_unavailable\n");
		process.exitCode = 2;
	},
);
