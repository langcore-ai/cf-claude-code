import { describe, expect, test } from "bun:test";

import { ToolDispatcher } from "../core";
import type { RuntimeTool } from "../tools";

describe("ToolDispatcher", () => {
	test("执行已注册工具", async () => {
		const tools: RuntimeTool[] = [
			{
				schema: {
					name: "echo",
					description: "echo",
					inputSchema: { type: "object" },
				},
				execute: async (call) => ({
					toolUseId: call.id,
					name: call.name,
					content: String(call.input.value ?? ""),
				}),
			},
		];
		const dispatcher = new ToolDispatcher(tools);

		const result = await dispatcher.execute(
			{
				id: "tool-1",
				name: "echo",
				input: { value: "hello" },
			},
			{
				workspace: { name: "test", files: undefined as never },
				skills: undefined as never,
				getSession: async () => undefined as never,
				updateSession: async () => {},
			},
		);

		expect(result.content).toBe("hello");
	});

	test("未知工具直接报错", async () => {
		const dispatcher = new ToolDispatcher([]);

		await expect(
			dispatcher.execute(
				{
					id: "tool-1",
					name: "missing",
					input: {},
				},
				{
					workspace: { name: "test", files: undefined as never },
					skills: undefined as never,
					getSession: async () => undefined as never,
					updateSession: async () => {},
				},
			),
		).rejects.toThrow("Unknown tool: missing");
	});
});
