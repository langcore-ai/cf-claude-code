import { describe, expect, test } from "bun:test";

import { InMemorySkillProvider, MergedSkillProvider, WorkspaceSkillProvider } from "../skills";
import { InMemoryWorkspace } from "../workspace";

describe("skills", () => {
	test("支持列出并读取 skill", async () => {
		const provider = new InMemorySkillProvider([
			{
				name: "readme-ai-docs",
				description: "doc helper",
				files: {
					"/SKILL.md": "# Hello",
					"/docs/guide.md": "guide",
				},
			},
		]);

		const skills = await provider.list();
		expect(skills[0]?.name).toBe("readme-ai-docs");

		const skill = await provider.open("readme-ai-docs");
		expect(skill).not.toBeNull();
		expect(await skill!.readEntry()).toBe("# Hello");
	});

	test("合并 provider 时 workspace skill 覆盖 memory skill", async () => {
		const workspace = new InMemoryWorkspace("skills", {
			"/skills/readme-ai-docs/SKILL.md": "---\ndescription: workspace\n---\n# Workspace",
			"/skills/readme-ai-docs/docs/guide.md": "workspace guide",
		});
		const provider = new MergedSkillProvider({
			providers: [
				new WorkspaceSkillProvider({ workspace }),
				new InMemorySkillProvider([
					{
						name: "readme-ai-docs",
						description: "memory",
						files: {
							"/SKILL.md": "# Memory",
						},
					},
				]),
			],
		});

		const skills = await provider.list();
		expect(skills[0]?.description).toBe("workspace");

		const skill = await provider.open("readme-ai-docs");
		expect(await skill?.readEntry()).toContain("# Workspace");
		const guide = await skill?.workspace.files.readFile("/docs/guide.md");
		expect(guide?.content).toBe("workspace guide");
	});
});
