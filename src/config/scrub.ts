/** Names of variables that hold secrets and must not reach child processes. */
export function isSecretName(name: string): boolean {
	if (name === "TELEGRAM_BOT_TOKEN" || name === "DEEPGRAM_API_KEY") return true;
	if (/^(ANTHROPIC|CLAUDE|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|XAI|MISTRAL|OPENROUTER|DEEPSEEK|AWS)_/.test(name))
		return true;
	return /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_ACCESS_KEY)$/.test(name);
}

/**
 * Remove secret variables from `env` (normally `process.env`) after the config is parsed and return them, so model
 * auth can still read provider keys from the returned snapshot.
 */
export function scrubSecrets(env: Record<string, string | undefined>): Record<string, string> {
	const removed: Record<string, string> = {};
	for (const name of Object.keys(env)) {
		if (!isSecretName(name)) continue;
		const value = env[name];
		if (value !== undefined) removed[name] = value;
		delete env[name];
	}
	return removed;
}
