import { scrubSecrets } from "../../src/config/scrub.ts";

/** Capture provider configuration before scrubbing the process environment used by children. */
export function coordinatorEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const snapshot = { ...source };
	scrubSecrets(source);
	return snapshot;
}
