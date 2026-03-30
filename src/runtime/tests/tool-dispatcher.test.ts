import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { jsonSchema } from "@ai-sdk/provider-utils";

import { ToolDispatcher } from "../core";
import { createRuntimeTool } from "../tools";

describe("ToolDispatcher", () => {
	test("执行已注册工具", async () => {
		const tools = [
			createRuntimeTool(
				"echo",
				tool({
					description: "echo",
					inputSchema: jsonSchema({ type: "object" }) as never,
					execute: async () => "",
				}),
				async (call) => ({
					toolUseId: call.id,
					name: call.name,
					content: String(call.input.value ?? ""),
				}),
			),
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
