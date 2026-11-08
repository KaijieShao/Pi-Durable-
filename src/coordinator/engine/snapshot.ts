/**
 * The sealed snapshot (Architecture § Sealing: "an immutable copy of the main branch is captured after the trial's
 * tasks have merged"; § Isolated evaluator: it "grades an immutable copy of the main branch"; Interfaces and Storage
 * § Where Each Record Lives: "Immutable graded project copy — Sealed snapshot").
 *
 * The fetched main commit's files are exported (git.exportTree: no git data) into `<taskDir>/snapshots/.partial-<trial>`,
 * hashed, made read-only (directories 0555, files 0444, executables 0555) and only then renamed to
 * `<taskDir>/snapshots/<trial>-<commit, 12 digits>`, next to a read-only manifest `<that>.manifest.json` with the commit,
 * its git tree id and the content hash. The content hash is sha256 over every entry, symlinks not followed (type,
 * executable bit, path, then the content's or the link target's sha256), so the copy can be verified before and after
 * the evaluator ran, independently of git. Snapshots are kept (retained trials, Capacity § Disk).
 */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Git } from "../git.ts";

export const SNAPSHOTS_DIR = "snapshots";

export type SnapshotPaths = {
	readonly root: string;
	readonly partial: string;
	readonly final: string;
	readonly manifest: string;
};

export type Snapshot = {
	readonly path: string;
	readonly manifest: string;
	readonly commit: string;
	readonly tree: string;
	readonly hash: string;
	readonly files: number;
	readonly bytes: number;
};

export function snapshotPaths(taskDir: string, trial: string, commit: string): SnapshotPaths {
	const root = join(taskDir, SNAPSHOTS_DIR);
	const final = join(root, `${trial}-${commit.slice(0, 12)}`);
	return { root, partial: join(root, `.partial-${trial}`), final, manifest: `${final}.manifest.json` };
}

type Entry = { readonly line: string; readonly bytes: number; readonly file: boolean };

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

async function entryOf(full: string, path: string): Promise<Entry | "dir"> {
	const stat = await lstat(full);
	if (stat.isDirectory()) return "dir";
	if (stat.isSymbolicLink()) return { line: `l ${path} ${sha256(await readlink(full))}`, bytes: 0, file: false };
	if (!stat.isFile()) throw new Error(`the snapshot holds something that is not a file: ${path}`);
	const exec = (stat.mode & 0o111) !== 0 ? "x" : "-";
	return { line: `f ${exec} ${path} ${sha256(await readFile(full))}`, bytes: stat.size, file: true };
}

async function walk(root: string, rel: string, out: Entry[]): Promise<void> {
	const names = (await readdir(join(root, rel))).sort();
	for (const name of names) {
		const path = rel === "" ? name : `${rel}/${name}`;
		const entry = await entryOf(join(root, path), path);
		if (entry !== "dir") {
			out.push(entry);
			continue;
		}
		out.push({ line: `d ${path}`, bytes: 0, file: false });
		await walk(root, path, out);
	}
}

/** The content hash of a tree ("sha256:<hex>"), its file count and bytes. */
export async function treeHash(root: string): Promise<{ hash: string; files: number; bytes: number }> {
	const entries: Entry[] = [];
	await walk(root, "", entries);
	return {
		hash: `sha256:${sha256(entries.map((entry) => entry.line).join("\n"))}`,
		files: entries.filter((entry) => entry.file).length,
		bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
	};
}

/** A file's mode: read-only (0444, 0555 if executable) or writable by its owner (0600, 0700). */
function fileMode(mode: number, writable: boolean): number {
	const exec = (mode & 0o111) !== 0;
	if (writable) return exec ? 0o700 : 0o600;
	return exec ? 0o555 : 0o444;
}

/** Directories 0555, files 0444 (0555 if executable); symlinks untouched. Children first, the root last. */
async function setModes(path: string, writable: boolean): Promise<void> {
	const stat = await lstat(path);
	if (stat.isSymbolicLink()) return;
	if (!stat.isDirectory()) return chmod(path, fileMode(stat.mode, writable));
	if (writable) await chmod(path, 0o700);
	for (const name of await readdir(path)) await setModes(join(path, name), writable);
	if (!writable) await chmod(path, 0o555);
}

/** Remove a tree that may be read-only (a snapshot, a partial one); true once it is gone. */
export async function removeTree(path: string): Promise<boolean> {
	const stat = await lstat(path).catch(() => undefined);
	if (stat === undefined) return true;
	if (stat.isDirectory()) await setModes(path, true).catch(() => undefined);
	await rm(path, { recursive: true, force: true });
	return (await lstat(path).catch(() => undefined)) === undefined;
}

/** The snapshot's content hash is still `hash` (nothing changed it). False if it cannot be read either. */
export async function snapshotIntact(path: string, hash: string): Promise<boolean> {
	return (await treeHash(path).catch(() => undefined))?.hash === hash;
}

/**
 * Export `commit` for `trial`: a partial copy first (left by an earlier attempt: removed), hashed, read-only, then
 * renamed into place with its manifest. A final copy already there was never recorded (a restart before the record):
 * it is replaced. Throws if any step fails (nothing is recorded then).
 */
export async function exportSnapshot(
	git: Git,
	taskDir: string,
	p: { readonly trial: string; readonly commit: string },
): Promise<Snapshot> {
	const paths = snapshotPaths(taskDir, p.trial, p.commit);
	await mkdir(paths.root, { recursive: true, mode: 0o750 });
	for (const leftover of [paths.partial, paths.final, paths.manifest])
		if (!(await removeTree(leftover))) throw new Error("a leftover snapshot could not be removed");
	await mkdir(paths.partial, { mode: 0o700 });
	await git.exportTree(p.commit, paths.partial);
	const tree = await git.treeId(p.commit);
	const content = await treeHash(paths.partial);
	await setModes(paths.partial, false);
	await rename(paths.partial, paths.final);
	const manifest = {
		trial: p.trial,
		commit: p.commit,
		tree,
		hash: content.hash,
		files: content.files,
		bytes: content.bytes,
		path: paths.final,
	};
	await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444, flag: "wx" });
	if (!(await snapshotIntact(paths.final, content.hash))) throw new Error("the snapshot changed while it was sealed");
	return { path: paths.final, manifest: paths.manifest, commit: p.commit, tree, ...content };
}
