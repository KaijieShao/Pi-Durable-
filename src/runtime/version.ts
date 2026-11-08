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
