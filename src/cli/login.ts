import { createModels } from "@earendil-works/pi-ai";
import { loadProvider } from "../agent/providers.ts";
import { FileCredentialStore } from "../auth/credential-store.ts";
import { createHeadlessInteraction } from "../auth/interaction.ts";
import { authFileFromEnv, dataDirFromEnv } from "../config/schema.ts";
import { errorSummary } from "../runtime/log.ts";
import { ensurePrivateDir } from "../runtime/private-dir.ts";

/**
 * `login <provider>`: OAuth when the provider offers it (Anthropic: Claude Pro/Max with the headless copy-code flow),
 * else an API key prompt. Credentials go to the file the daemon reads (`PI_AUTH_FILE`, else pi's shared `auth.json`;
 * mode 600) through the same store and lock as the daemon and pi, so it is safe while either runs. Logging in with
 * pi's own `/login` works just as well. Uses pi-ai's own login flows unchanged.
 */
export async function runLogin(provider: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const dataDir = dataDirFromEnv(env);
	const providerImpl = await loadProvider(provider);
	if (providerImpl === undefined) {
		process.stderr.write(`Unknown provider: ${provider}\n`);
		return 2;
	}
	await ensurePrivateDir(dataDir);
	const path = authFileFromEnv(env);
	const models = createModels({ credentials: new FileCredentialStore(path) });
	models.setProvider(providerImpl);
	const interaction = createHeadlessInteraction();
	const type = providerImpl.auth.oauth === undefined ? "api_key" : "oauth";
	try {
		await models.login(provider, type, interaction);
		process.stdout.write(`\nLogged in to ${provider} (${type}); credentials stored in ${path} (mode 600).\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`\nLogin failed: ${errorSummary(error)}\n`);
		return 1;
	} finally {
		interaction.close();
	}
}
