import { describe, expect, test } from "bun:test";

import { InMemoryTranscriptStore } from "../adapters";
import { autoCompactSession, createCompactedMessages, estimateTokenCount, microCompactMessages } from "../core";
import type { AIClient, GenerateTurnInput, ModelTurnResult } from "../types";
import type { SessionState } from "../types";

class StubAiClient implements AIClient {
	constructor(private readonly handler: (input: GenerateTurnInput) => Promise<ModelTurnResult>) {}

	async generateTurn(input: GenerateTurnInput): Promise<ModelTurnResult> {
		return this.handler(input);
	}
}

function createSession(messages: SessionState["messages"]): SessionState {
	return {
		id: "session-1",
		config: {
			systemPrompt: "test",
			tokenThreshold: 10,
			maxTurnsPerMessage: 3,
		},
		messages,
		todos: [],
		tasks: [],
		todoIdleTurns: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

describe("compact", () => {
	test("微压缩会收缩较旧的 tool_result 文本", () => {
		const messages = microCompactMessages([
			{
				id: "1",
				role: "user",
				createdAt: new Date().toISOString(),
				content: [
					{ type: "tool_result", toolUseId: "a", content: "old-1" },
					{ type: "tool_result", toolUseId: "b", content: "old-2" },
					{ type: "tool_result", toolUseId: "c", content: "old-3" },
					{ type: "tool_result", toolUseId: "d", content: "keep-4" },
				],
			},
		]);

		expect(messages[0]?.content[0]).toMatchObject({ content: "[Previous: used unknown_tool]" });
		expect(messages[0]?.content[3]).toMatchObject({ content: "keep-4" });
	});

	test("达到阈值时自动压缩并写入 transcriptRef", async () => {
		const session = createSession([
			{
				id: "1",
				role: "user",
				createdAt: new Date().toISOString(),
				content: [{ type: "text", text: "x".repeat(200) }],
			},
			{
				id: "2",
				role: "assistant",
				createdAt: new Date().toISOString(),
				content: [{ type: "text", text: "y".repeat(200) }],
			},
		]);

		expect(estimateTokenCount(session.messages)).toBeGreaterThan(session.config.tokenThreshold);
		let summarized = false;
		const result = await autoCompactSession(session, {
			aiClient: new StubAiClient(async () => {
				summarized = true;
				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "continuity summary" }],
				};
			}),
			transcriptStore: new InMemoryTranscriptStore(),
		});
		expect(result.compacted).toBe(true);
		expect(summarized).toBe(true);
		expect(result.session.compactSummary).toBe("continuity summary");
		expect(result.session.transcriptRef).toContain("memory://");
		expect(result.session.messages).toHaveLength(2);
	});

	test("compact 后消息替换为 continuity 形式", () => {
		const messages = createCompactedMessages("memory://session/1", "continuity summary");
		expect(messages).toHaveLength(2);
		expect(messages[0]?.content[0]).toMatchObject({
			type: "text",
		});
		expect(messages[1]?.content[0]).toMatchObject({
			type: "text",
			text: "Understood. I will continue from the continuity summary.",
		});
	});
});
