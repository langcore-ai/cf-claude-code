import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { toAiMessages, toAiTools, toModelTurnResult } from "../adapters";

describe("ai-sdk-client helpers", () => {
	test("消息映射到 AI SDK 结构", () => {
		const messages = toAiMessages([
			{
				id: "1",
				role: "user",
				createdAt: new Date().toISOString(),
				content: [{ type: "text", text: "hello" }],
			},
		]);

		expect(messages[0]).toMatchObject({
			role: "user",
			content: "hello",
		});
	});

	test("工具 schema 映射", () => {
		const tools = toAiTools([
			{
				name: "read_file",
				description: "read",
				inputSchema: z.object({ path: z.string() }),
			},
		]);

		expect(tools.read_file).toBeDefined();
	});

	test("tool call 优先转成 tool_use", () => {
		const result = toModelTurnResult({
			toolCalls: [
				{
					toolCallId: "tool-1",
					toolName: "read_file",
					input: { path: "/README.md" },
				},
			],
		});

		expect(result.stopReason).toBe("tool_use");
		expect(result.content[0]).toMatchObject({
			type: "tool_use",
			name: "read_file",
			input: { path: "/README.md" },
		});
	});
});
