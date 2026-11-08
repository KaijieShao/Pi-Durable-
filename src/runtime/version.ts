import { createRequire } from "node:module";

/** Package version, read from package.json (two levels up from both src/ and dist/ modules). */
export function packageVersion(): string {
	try {
		const pkg = createRequire(import.meta.url)("../../package.json") as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/**
 * What a trial records of the build (Evaluation § Frozen Before Trial 1: "the Pi Durable and Telegram scaffold versions
 * with any patches"): this package (the Telegram scaffold), the installed Pi Durable, and the exact versions pinned in
 * package.json for pi-ai and grammy (their package.json is not exported). Pi Durable is used unmodified: no patches.
 */
export function buildVersions(): Record<string, string> {
	const require = createRequire(import.meta.url);
	const read = (path: string): { version?: string; dependencies?: Record<string, string> } => {
		try {
			return require(path) as { version?: string; dependencies?: Record<string, string> };
		} catch {
			return {};
		}
	};
	const own = read("../../package.json");
	return {
		"pi-durable-telegram": own.version ?? "unknown",
		"@earendil-works/pi-durable": read("@earendil-works/pi-durable/package.json").version ?? "unknown",
		"@earendil-works/pi-ai": own.dependencies?.["@earendil-works/pi-ai"] ?? "unknown",
		grammy: own.dependencies?.grammy ?? "unknown",
		node: process.version,
		patches: "none",
	};
}
