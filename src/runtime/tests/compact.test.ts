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
		mode: "normal",
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
			aiClient: new StubAiClient(async (input) => {
				summarized = true;
				expect(input.modelRole).toBe("compact");
				expect(input.systemPrompt).toContain("continuity summarizer");
				expect(
					input.messages[0]?.content[0] && "text" in input.messages[0].content[0]
						? input.messages[0].content[0].text
						: "",
				).toContain("Current Goal");
				expect(
					input.messages[0]?.content[0] && "text" in input.messages[0].content[0]
						? input.messages[0].content[0].text
						: "",
				).toContain("Important User Feedback");
				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "<analysis>thinking</analysis>\n<summary>continuity summary</summary>" }],
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
		expect(messages[0]?.content[0] && "text" in messages[0].content[0] ? messages[0].content[0].text : "").toContain(
			"Treat the following summary as authoritative continuity context.",
		);
		expect(messages[1]?.content[0]).toMatchObject({
			type: "text",
			text: "Understood. I will continue from the continuity summary.",
		});
	});

	test("plan 模式 compact 后仍保留 plan mode", async () => {
		const session = {
			...createSession([
				{
					id: "1",
					role: "user" as const,
					createdAt: new Date().toISOString(),
					content: [{ type: "text" as const, text: "x".repeat(200) }],
				},
			]),
			mode: "plan" as const,
		};

		const result = await autoCompactSession(session, {
			aiClient: new StubAiClient(async () => ({
				stopReason: "end_turn",
				content: [{ type: "text", text: "<summary>continuity summary</summary>" }],
			})),
			transcriptStore: new InMemoryTranscriptStore(),
		});

		expect(result.session.mode).toBe("plan");
		expect(result.session.compactSummary).toBe("continuity summary");
	});
});
