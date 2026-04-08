import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { z } from "zod";

import { ToolDispatcher } from "../core";
import { createRuntimeTool } from "../tools";

describe("ToolDispatcher", () => {
	test("执行已注册工具", async () => {
		const tools = [
			createRuntimeTool(
				"echo",
				"core",
				tool({
					description: "echo",
					inputSchema: z.object({ value: z.string() }),
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

	test("可按分组过滤 schema", () => {
		const dispatcher = new ToolDispatcher([
			createRuntimeTool(
				"core_echo",
				"core",
				tool({
					description: "core",
					inputSchema: z.object({}),
					execute: async () => "",
				}),
				async () => ({
					toolUseId: "1",
					name: "core_echo",
					content: "ok",
				}),
			),
			createRuntimeTool(
				"extended_echo",
				"extended",
				tool({
					description: "extended",
					inputSchema: z.object({}),
					execute: async () => "",
				}),
				async () => ({
					toolUseId: "2",
					name: "extended_echo",
					content: "ok",
				}),
			),
		]);

		expect(dispatcher.listSchemas(["core"]).map((schema) => schema.name)).toEqual(["core_echo"]);
		expect(dispatcher.listSchemas(["extended"]).map((schema) => schema.name)).toEqual(["extended_echo"]);
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
