import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { piAgentDir } from "../config/pi-home.ts";
import { parseList } from "../config/schema.ts";
import { expandPath, type PluginContext } from "./load.ts";

type Found = { path: string; folder: string; stamp: string };
const MAX_SKILLS = 200;

/** Top-level `name` and `description` of a YAML frontmatter: plain, quoted or `>`/`|` block values. */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
	if (lines[0]?.trimEnd() !== "---" || end < 0) return {};
	const out: { name?: string; description?: string } = {};
	lines.slice(1, end).forEach((line, i, body) => {
		const match = /^(name|description):(.*)$/.exec(line);
		if (match === null) return;
		const head = match[2]?.trim() ?? "";
		const rest = body.slice(i + 1);
		const stop = rest.findIndex((l) => /^\S/.test(l));
		const more = (stop < 0 ? rest : rest.slice(0, stop)).map((l) => l.trim());
		const value = [/^[>|][+-]?$/.test(head) ? "" : head, ...more].filter(Boolean).join(" ");
		out[match[1] as "name" | "description"] = /^(['"])(.*)\1$/s.exec(value)?.[2] ?? value;
	});
	return out;
}

async function walk(roots: readonly string[]): Promise<Found[]> {
	const found: Found[] = [];
	for (const root of roots) {
		for (const folder of (await readdir(root).catch(() => [])).sort()) {
			const path = join(root, folder, "SKILL.md");
			const info = await stat(path).catch(() => undefined);
			if (info?.isFile() === true) found.push({ path, folder, stamp: `${path}:${info.mtimeMs}:${info.size}` });
		}
	}
	return found;
}

async function render(found: readonly Found[], roots: readonly string[]): Promise<string> {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const skill of found) {
		const meta = parseFrontmatter(await readFile(skill.path, "utf8").catch(() => ""));
		const name = (meta.name || skill.folder).trim();
		const description = meta.description?.replace(/\s+/g, " ").trim().slice(0, 1024);
		if (!description || seen.has(name)) continue;
		seen.add(name);
		lines.push(`- ${name}: ${description}\n  ${skill.path}`);
	}
	if (lines.length === 0) return `No skills found in ${roots.join(", ")}.`;
	const more = lines.length > MAX_SKILLS ? [`...and ${lines.length - MAX_SKILLS} more`] : [];
	const head = "When a task matches one of these skills, first read its SKILL.md with the read tool and follow it.";
	return [head, ...lines.slice(0, MAX_SKILLS), ...more].join("\n");
}

/** The skills section, rebuilt only when a SKILL.md appears, disappears or changes, so the text stays stable. */
export function createSkillsReader(roots: readonly string[]): () => Promise<string> {
	let cached: { print: string; text: string } | undefined;
	return async () => {
		const found = await walk(roots);
		const print = found.map((skill) => skill.stamp).join("\n");
		if (cached?.print !== print) cached = { print, text: await render(found, roots) };
		return cached.text;
	};
}

/** Roots by priority: `<workdir>/skills`, pi's own skills, then `PI_SKILLS_DIRS`. */
export function skillRoots(ctx: Pick<PluginContext, "env" | "workdir">): string[] {
	const extra = parseList(ctx.env.PI_SKILLS_DIRS).map((dir) => expandPath(dir, ctx));
	return [...new Set([join(ctx.workdir, "skills"), join(piAgentDir(ctx.env), "skills"), ...extra])];
}

export default function skillsPlugin(ctx: PluginContext): Extension {
	const read = createSkillsReader(skillRoots(ctx));
	return defineExtension({ name: "skills", sections: [section("skills", () => read())] });
}
