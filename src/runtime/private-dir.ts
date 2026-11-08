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
	await setModes(paths, 0o600);
}

/** Make existing files readable and writable by their owner and group only (0660); absent ones are skipped. */
export async function makeGroupShared(paths: readonly string[]): Promise<void> {
	await setModes(paths, 0o660);
}

async function setModes(paths: readonly string[], mode: number): Promise<void> {
	for (const path of paths) {
		await chmod(path, mode).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
