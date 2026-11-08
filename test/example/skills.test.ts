import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createSkillsReader, skillRoots } from "../../src/plugins/skills.ts";
import { tempDir } from "../helpers/agent.ts";

async function skill(root: string, folder: string, frontmatter: string): Promise<string> {
	const path = join(root, folder, "SKILL.md");
	await mkdir(join(root, folder), { recursive: true });
	await writeFile(path, `---\n${frontmatter}\n---\n# ${folder}\n`);
	return path;
}

test("T-skills: three roots by priority, first name wins, stable text, rescan only after a change", async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const work = join(dir, "work");
		const env = { HOME: dir, PI_CODING_AGENT_DIR: "~/pi-home", PI_SKILLS_DIRS: "extra, ~/more" };
		const roots = skillRoots({ env, workdir: work });
		assert.deepEqual(roots, [
			join(work, "skills"),
			join(dir, "pi-home", "skills"),
			join(work, "extra"),
			join(dir, "more"),
		]);
		const read = createSkillsReader(roots);
		assert.equal(await read(), `No skills found in ${roots.join(", ")}.`);

		const deploy = await skill(join(work, "skills"), "deploy", "name: deploy\ndescription: Ship the service");
		await skill(join(dir, "pi-home", "skills"), "deploy-copy", "name: deploy\ndescription: Global duplicate");
		const review = await skill(
			join(dir, "pi-home", "skills"),
			"review",
			"description: >\n  Review a diff\n  carefully",
		);
		await skill(join(work, "extra"), "nodesc", "name: nodesc");
		const notes = await skill(join(dir, "more"), "notes", "name: 'notes'\ndescription: \"Take   notes\"");
		const first = await read();
		assert.equal(
			first,
			[
				"When a task matches one of these skills, first read its SKILL.md with the read tool and follow it.",
				`- deploy: Ship the service\n  ${deploy}`,
				`- review: Review a diff carefully\n  ${review}`,
				`- notes: Take notes\n  ${notes}`,
			].join("\n"),
		);
		assert.equal(await read(), first, "same text while nothing changed");

		await writeFile(deploy, "---\nname: deploy\ndescription: Ship it now, then verify\n---\n");
		assert.match(await read(), /- deploy: Ship it now, then verify/);
		await rm(join(dir, "more", "notes"), { recursive: true });
		assert.doesNotMatch(await read(), /notes/);
	} finally {
		await cleanup();
	}
});
