import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

/** Same lock as pi's own auth storage (proper-lockfile on the file, 30 s stale), so pi and the daemon can share it. */
const LOCK_OPTIONS = {
	realpath: false,
	stale: 30_000,
	retries: { retries: 300, factor: 1.2, minTimeout: 10, maxTimeout: 200 },
} as const;

type CredentialFile = Record<string, Credential>;

/**
 * File-backed pi-ai credential store: JSON `{ [providerId]: Credential }`, mode 0600. Every read goes to the file,
 * because an OAuth refresh rotates the refresh token and another process (pi, `login`) may have written it. Writes are
 * serialized per provider in this process and across processes with pi's own lock (proper-lockfile on the file), then
 * written atomically. That makes it safe to share pi's `~/.pi/agent/auth.json`.
 */
export class FileCredentialStore implements CredentialStore {
	readonly path: string;
	readonly #chains = new Map<string, Promise<unknown>>();

	constructor(path: string) {
		this.path = path;
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		const file = await this.#load();
		return Object.hasOwn(file, providerId) ? file[providerId] : undefined;
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const file = await this.#load();
		return Object.entries(file).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#enqueue(providerId, () =>
			this.#locked(options, async () => {
				const file = await this.#load();
				const current = Object.hasOwn(file, providerId) ? file[providerId] : undefined;
				const next = await fn(current);
				if (next === undefined) return current;
				await this.#write({ ...file, [providerId]: next });
				return next;
			}),
		);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#enqueue(providerId, () =>
			this.#locked(options, async () => {
				const file = await this.#load();
				if (!Object.hasOwn(file, providerId)) return;
				const { [providerId]: _removed, ...rest } = file;
				await this.#write(rest);
			}),
		);
	}

	#enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.#chains.get(providerId) ?? Promise.resolve();
		const run = previous.then(task, task);
		const settled = run.catch(() => undefined);
		this.#chains.set(providerId, settled);
		void settled.then(() => {
			if (this.#chains.get(providerId) === settled) this.#chains.delete(providerId);
		});
		return run;
	}

	async #locked<T>(options: AuthOperationOptions | undefined, fn: () => Promise<T>): Promise<T> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await this.#ensureFile();
		options?.signal?.throwIfAborted();
		const release = await lockfile.lock(this.path, LOCK_OPTIONS);
		try {
			options?.signal?.throwIfAborted();
			return await fn();
		} finally {
			await release().catch(() => undefined);
		}
	}

	/** proper-lockfile locks an existing file; create an empty store first, as pi does. */
	async #ensureFile(): Promise<void> {
		try {
			const handle = await open(this.path, "wx", 0o600);
			await handle.writeFile("{}\n");
			await handle.close();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}

	async #load(): Promise<CredentialFile> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error(`Cannot read credentials file ${this.path}`);
		}
		try {
			const value = JSON.parse(text) as unknown;
			if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
			return value as CredentialFile;
		} catch {
			// Never echo file contents: they are secrets.
			throw new Error(`Credentials file ${this.path} is not valid JSON`);
		}
	}

	async #write(file: CredentialFile): Promise<void> {
		const temp = `${this.path}.${process.pid}.tmp`;
		const handle = await open(temp, "w", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(temp, this.path);
		} catch (error) {
			await unlink(temp).catch(() => undefined);
			throw error;
		}
	}
}

export function createFileCredentialStore(path: string): CredentialStore {
	return new FileCredentialStore(path);
}
