import { describe, expect, test } from "bun:test";

import { MemoryStateExecutor } from "../core";
import { InMemoryWorkspace } from "../workspace";

describe("state executor", () => {
	test("可在 memory workspace 中真实执行 state.*", async () => {
		const workspace = new InMemoryWorkspace("memory", {
			"/data.json": '{"count":1}',
		});
		const executor = new MemoryStateExecutor(workspace);

		const result = await executor.execute(`async () => {
			const data = await state.readJson("/data.json");
			await state.writeJson("/data.json", { count: data.count + 1 }, { spaces: 2 });
			return await state.readJson("/data.json");
		}`);

		expect(result.resultType).toBe("object");
		expect(result.value).toEqual({ count: 2 });
		const stored = await workspace.files.readFile("/data.json");
		expect(stored.content).toContain('"count": 2');
	});

	test("非法代码会直接失败", async () => {
		const executor = new MemoryStateExecutor(new InMemoryWorkspace("memory"));
		await expect(
			executor.execute(`import foo from "bar"; async () => { return 1; }`),
		).rejects.toThrow("state_exec does not allow import statements");
	});
});
