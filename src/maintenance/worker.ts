/** One-shot housekeeping; no Coordinator commands, task DB writes, remote Git refs, or service control. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { disposableImage, type RetentionPolicy, retainBundles } from "./retention.ts";

const exec = promisify(execFile);
const configPath = process.argv[process.argv.indexOf("--config") + 1];
if (!process.argv.includes("--config") || !configPath?.startsWith("/"))
	throw new Error("--config requires an absolute path");
const config = JSON.parse(await readFile(configPath, "utf8")) as {
	policy: RetentionPolicy;
	apply: boolean;
	docker?: { protectedRefs: string[]; pruneBuildCache: boolean };
};
if (
	!Array.isArray(config.policy?.roots) ||
	!Array.isArray(config.policy?.protectedPaths) ||
	!Array.isArray(config.policy?.bundles)
)
	throw new Error("invalid retention policy");
const report: Record<string, unknown> = { at: Date.now(), apply: config.apply === true };
report.bundles = await retainBundles(config.policy, Date.now(), config.apply === true);

async function docker(args: string[]): Promise<string> {
	return (await exec("docker", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}

function imageMetadata(
	raw: { Id: string; RepoTags?: string[]; Created: string; Config?: { Labels?: Record<string, string> } },
	used: ReadonlySet<string>,
) {
	const tags = raw.RepoTags ?? [];
	return {
		id: raw.Id,
		tags,
		createdAt: Date.parse(raw.Created),
		disposable: raw.Config?.Labels?.["pi-durable.disposable"] === "true",
		used: used.has(raw.Id) || tags.some((tag) => used.has(tag)),
	};
}

async function retainImages(): Promise<unknown[]> {
	const settings = config.docker;
	if (settings === undefined || settings.protectedRefs.length === 0) return [{ outcome: "disabled" }];
	const protectedRefs = new Set(settings.protectedRefs);
	// Labels are explicit opt-in, never inferred from an unused/dangling image. Inspect ALL stopped/running refs.
	const used = new Set((await docker(["ps", "-a", "--no-trunc", "--format", "{{.Image}}"])).split("\n"));
	const ids = new Set(
		(await docker(["image", "ls", "-q", "--no-trunc", "--filter", "label=pi-durable.disposable=true"]))
			.split("\n")
			.filter(Boolean),
	);
	const results: unknown[] = [];
	for (const id of ids) {
		const raw = JSON.parse(await docker(["image", "inspect", id]))[0];
		const image = imageMetadata(raw, used);
		if (!disposableImage(image, protectedRefs, Date.now())) {
			results.push({ id, outcome: "kept" });
			continue;
		}
		// No --force: Docker still refuses an image referenced by a container that appeared during the scan.
		if (config.apply === true) await docker(["image", "rm", id]);
		results.push({ id, outcome: config.apply === true ? "deleted" : "candidate" });
	}
	return results;
}

try {
	report.images = await retainImages();
	if (config.apply === true && config.docker?.pruneBuildCache === true) {
		// Unused build cache only. Does not remove image/layer refs or volumes, and is independent of task outcomes.
		await docker(["builder", "prune", "--force", "--filter", "until=168h", "--keep-storage", "2GB"]);
		report.buildCache = "unused cache older than seven days pruned, 2GB retained";
	}
} catch {
	report.docker = "cleanup error; retained remaining data; inspect the maintenance service";
	process.exitCode = 1;
}
console.log(JSON.stringify(report));
