import { describe, expect, test } from "bun:test";

import { buildMainPromptSections, buildSubagentPromptSections, composeMainSystemPrompt, renderPromptSections } from "../core/prompt-composer";
import type { SessionState } from "../types";

/**
 * 创建最小会话快照，供 prompt composer 测试复用。
 * @returns 会话状态
 */
function createSession(overrides?: Partial<SessionState>): SessionState {
	return {
		id: "session-1",
		mode: "normal",
		config: {
			systemPrompt: "",
			tokenThreshold: 4000,
			maxTurnsPerMessage: 6,
		},
		messages: [],
		todos: [],
		tasks: [],
		todoIdleTurns: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("prompt composer", () => {
	test("主会话 prompt 片段顺序固定", () => {
		const sections = buildMainPromptSections({
			customPrompt: "custom rules",
			skills: [{ name: "skill-a", description: "desc" }],
			hasStatePrompt: true,
			renderedStatePrompt: "state prompt",
			session: createSession({
				mode: "plan",
				compactSummary: "summary",
			}),
			rememberedTodos: null,
		});

		expect(sections.map((section) => section.id)).toEqual([
			"identity",
			"workflow",
			"start_reminder",
			"plan_mode",
			"skills",
			"end_reminder",
			"state",
			"compact",
			"custom",
		]);
	});

	test("主会话 prompt 在无可选片段时不会插入空 section", () => {
		const sections = buildMainPromptSections({
			skills: [],
			hasStatePrompt: false,
			renderedStatePrompt: "",
			session: createSession(),
			rememberedTodos: null,
		});

		expect(sections.map((section) => section.id)).toEqual([
			"identity",
			"workflow",
			"start_reminder",
			"skills",
			"end_reminder",
		]);
	});

	test("subagent prompt 片段顺序固定", () => {
		const sections = buildSubagentPromptSections({
			skills: [{ name: "skill-a", description: "desc" }],
			hasStatePrompt: true,
			renderedStatePrompt: "state prompt",
		});

		expect(sections.map((section) => section.id)).toEqual([
			"identity",
			"subagent_identity",
			"subagent_constraints",
			"workflow",
			"skills",
			"state",
		]);
	});

	test("renderPromptSections 会按双换行拼接各片段", () => {
		expect(
			renderPromptSections([
				{ id: "identity", content: "a" },
				{ id: "workflow", content: "b" },
			]),
		).toBe("a\n\nb");
	});

	test("composeMainSystemPrompt 会保留 compact 和 custom 内容", () => {
		const prompt = composeMainSystemPrompt({
			customPrompt: "custom rules",
			skills: [],
			hasStatePrompt: false,
			renderedStatePrompt: "",
			session: createSession({
				compactSummary: "continuity summary",
			}),
			rememberedTodos: null,
		});

		expect(prompt).toContain("Compacted context:");
		expect(prompt).toContain("continuity summary");
		expect(prompt).toContain("Additional runtime instructions:");
		expect(prompt).toContain("custom rules");
	});

	test("core prompt reminder 不混入宿主侧 prompt 片段", () => {
		const prompt = composeMainSystemPrompt({
			skills: [],
			hasStatePrompt: false,
			renderedStatePrompt: "",
			session: createSession(),
			rememberedTodos: null,
		});

		expect(prompt).not.toContain("check-new-topic");
		expect(prompt).not.toContain("summarize-previous-conversation");
		expect(prompt).not.toContain("ide-opened-file");
	});
});
