/** Explicit opt-ins for deployment tests; these are not application settings or credentials. */
const DEPLOYMENT_TEST_ENV = new Set(["PI_SYSTEMD_TESTS", "PI_SYSTEMD_TEST_DATA_DIR", "PI_WATCHDOG_LINUX_TESTS"]);

/** Remove host variables that could change behavior (agent sessions export provider credentials). */
export function scrubHostEnv(): void {
	for (const name of Object.keys(process.env)) {
		if (DEPLOYMENT_TEST_ENV.has(name)) continue;
		if (/^(ANTHROPIC_|CLAUDE_|TELEGRAM_|PI_|DEEPGRAM_|OPENAI_)/.test(name)) delete process.env[name];
	}
}

scrubHostEnv();

/** Poll `check` until it returns a truthy value or the timeout passes. */
export async function waitFor<T>(
	check: () => T | Promise<T>,
	options: { timeoutMs?: number; what?: string } = {},
): Promise<NonNullable<T>> {
	const deadline = Date.now() + (options.timeoutMs ?? 10_000);
	for (;;) {
		const value = await check();
		if (value) return value as NonNullable<T>;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${options.what ?? "condition"}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
