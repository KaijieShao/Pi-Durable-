import { chmod, mkdir } from "node:fs/promises";

/**
 * Create `dir` (mode 700) or tighten an existing one to 700: `mkdir` leaves an existing directory's mode alone, and
 * files inside are created with the umask default.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
}

/** Make existing files owner-only; absent ones are skipped. */
export async function makePrivate(paths: readonly string[]): Promise<void> {
	for (const path of paths) {
		await chmod(path, 0o600).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
