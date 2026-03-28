import { describe, expect, test } from "bun:test";

import { InMemoryWorkspace } from "../workspace";

describe("workspace", () => {
	test("读写文件并列目录", async () => {
		const workspace = new InMemoryWorkspace("test");
		await workspace.files.writeFile("/src/app.ts", "export const ok = true;");

		const file = await workspace.files.readFile("/src/app.ts");
		const root = await workspace.files.list("/");
		const src = await workspace.files.list("/src");

		expect(file.content).toContain("ok");
		expect(root[0]?.path).toBe("/src");
		expect(src[0]?.path).toBe("/src/app.ts");
		expect(workspace.backend.kind).toBe("memory");
		expect(typeof workspace.backend.shellFileSystem.readFile).toBe("function");
	});
});
