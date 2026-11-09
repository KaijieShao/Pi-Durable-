/** Conservative local-artifact retention. Task databases, worktrees and remote branches are never cleanup inputs. */
import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type RetainedBundle = {
	readonly path: string;
	readonly kind: "trial" | "raw-trial-store" | "test-artifact" | "archive";
	/** Only a finished trial with a preserved report may register its disposable bundle. */
	readonly completedAt: number;
	readonly reportPreserved: boolean;
	readonly pinned: boolean;
};

export type RetentionPolicy = {
	readonly roots: readonly string[];
	/** Protect the entire original General data/task directories, not just task numbers in another database. */
	readonly protectedPaths: readonly string[];
	readonly retentionMs: Readonly<Record<RetainedBundle["kind"], number>>;
	readonly bundles: readonly RetainedBundle[];
};

export type RetentionAttachments = { readonly mounts: readonly string[]; readonly backingPaths: readonly string[] };

function mountPath(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_all, digits: string) => String.fromCharCode(Number.parseInt(digits, 8)));
}

/** Bind aliases may use the parent's device. Protect their backing directories as well as their targets. */
export function retentionMounts(text: string): RetentionAttachments {
	const rows = text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const parts = line.split(" ");
			if (parts.length < 10 || !parts.includes("-")) throw new Error("invalid mount metadata");
			return { device: parts[2], root: mountPath(parts[3] as string), target: mountPath(parts[4] as string) };
		});
	const backingPaths = rows.flatMap((row) =>
		row.root === "/"
			? []
			: rows
					.filter((parent) => parent.device === row.device && within(parent.root, row.root))
					.map((parent) => resolve(parent.target, relative(parent.root, row.root))),
	);
	return { mounts: rows.map((row) => row.target), backingPaths };
}

/** Linux worker only. Failure to read attachment metadata retains the candidate. */
export async function retentionAttachments(): Promise<RetentionAttachments> {
	const mounts = retentionMounts(await readFile("/proc/self/mountinfo", "utf8"));
	const backing = [...mounts.backingPaths];
	for (const name of await readdir("/sys/class/block")) {
		if (!/^loop\d+$/.test(name)) continue;
		try {
			const file = mountPath((await readFile(`/sys/class/block/${name}/loop/backing_file`, "utf8")).trim());
			if (!file.startsWith("/")) throw new Error("unknown loop backing path");
			backing.push(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return { mounts: mounts.mounts, backingPaths: backing };
}

export function attachedRetentionInput(path: string, attachments: RetentionAttachments): boolean {
	return (
		attachments.mounts.some((mount) => within(path, mount)) ||
		attachments.backingPaths.some((backing) => within(path, backing) || within(backing, path))
	);
}

function within(parent: string, path: string): boolean {
	const name = relative(resolve(parent), resolve(path));
	return name === "" || (!name.startsWith(`..${sep}`) && name !== ".." && !isAbsolute(name));
}

export function retentionCandidate(policy: RetentionPolicy, bundle: RetainedBundle, now: number): boolean {
	if (!isAbsolute(bundle.path) || resolve(bundle.path) !== bundle.path || !Number.isFinite(bundle.completedAt))
		return false;
	if (bundle.pinned || !bundle.reportPreserved || bundle.completedAt > now) return false;
	const age = policy.retentionMs[bundle.kind];
	if (!Number.isFinite(age) || age < 24 * 60 * 60 * 1000 || now - bundle.completedAt < age) return false;
	if (!policy.roots.some((root) => isAbsolute(root) && resolve(root) !== bundle.path && within(root, bundle.path)))
		return false;
	if (policy.protectedPaths.some((path) => within(path, bundle.path) || within(bundle.path, path))) return false;
	return true;
}

/** Refuse symlinks, hard links, nested mounts and a root reached through symlinks. No target outside its device. */
async function inspectEntry(current: string, device: number) {
	const stats = await lstat(current);
	if (stats.isSymbolicLink() || stats.dev !== device || (!stats.isDirectory() && stats.nlink !== 1))
		throw new Error("linked or mounted retention input");
	const children = stats.isDirectory() ? (await readdir(current)).map((name) => `${current}${sep}${name}`) : [];
	return { stats, children };
}

async function inspectBundle(path: string): Promise<{ allocatedBytes: number; apparentBytes: number }> {
	if ((await realpath(path)) !== path) throw new Error("symlinked retention path");
	const root = await lstat(path);
	if (root.dev !== (await lstat(dirname(path))).dev) throw new Error("mounted retention root");
	let allocatedBytes = 0;
	let apparentBytes = 0;
	let entries = 0;
	const pending = [path];
	for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
		if (++entries > 1_000_000) throw new Error("retention entry limit");
		const { stats, children } = await inspectEntry(current, root.dev);
		allocatedBytes += stats.blocks * 512;
		apparentBytes += stats.size;
		pending.push(...children);
	}
	return { allocatedBytes, apparentBytes };
}

export type RetentionResult = {
	path: string;
	outcome: "kept" | "candidate" | "deleted" | "absent" | "error";
	allocatedBytes?: number;
	apparentBytes?: number;
	reason?: "attached";
};

/** A one-shot worker. Errors retain the bundle and do not affect a successful task/merge. Idempotent after deletion. */
export async function retainBundles(
	policy: RetentionPolicy,
	now: number,
	apply: boolean,
	attachments: () => Promise<RetentionAttachments> = retentionAttachments,
): Promise<RetentionResult[]> {
	const results: RetentionResult[] = [];
	for (const bundle of policy.bundles) results.push(await retainOne(policy, bundle, now, apply, attachments));
	return results;
}

async function retainOne(
	policy: RetentionPolicy,
	bundle: RetainedBundle,
	now: number,
	apply: boolean,
	attachments: () => Promise<RetentionAttachments>,
): Promise<RetentionResult> {
	if (!retentionCandidate(policy, bundle, now)) return { path: bundle.path, outcome: "kept" };
	try {
		if (attachedRetentionInput(bundle.path, await attachments()))
			return { path: bundle.path, outcome: "kept", reason: "attached" };
		const sizes = await inspectBundle(bundle.path);
		if (apply) await rm(bundle.path, { recursive: true, force: false });
		return { path: bundle.path, outcome: apply ? "deleted" : "candidate", ...sizes };
	} catch (error) {
		return { path: bundle.path, outcome: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "error" };
	}
}

export type RetentionImage = {
	id: string;
	createdAt: number;
	disposable: boolean;
	tags: readonly string[];
	used: boolean;
};

/** Immutable current/rollback/frozen IDs and tags override the disposable label. Untagged does not mean disposable. */
export function disposableImage(image: RetentionImage, protectedRefs: ReadonlySet<string>, now: number): boolean {
	return (
		image.disposable &&
		!image.used &&
		Number.isFinite(image.createdAt) &&
		now - image.createdAt >= 7 * 86400_000 &&
		!protectedRefs.has(image.id) &&
		!image.tags.some((tag) => protectedRefs.has(tag))
	);
}
