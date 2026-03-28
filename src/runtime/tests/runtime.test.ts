import { describe, expect, test } from "bun:test";

import { createMemoryRuntime, MemoryAgentRuntime, SUBAGENT_TOOL_NAMES } from "../core";
import { InMemorySkillProvider } from "../skills";
import type { AIClient, GenerateTurnInput, ModelTurnResult } from "../types";
import { InMemoryWorkspace } from "../workspace";

/** 测试用 AI client */
class StubAiClient implements AIClient {
	constructor(private readonly handler: (input: GenerateTurnInput) => Promise<ModelTurnResult>) {}

	async generateTurn(input: GenerateTurnInput): Promise<ModelTurnResult> {
		return this.handler(input);
	}
}

describe("MemoryAgentRuntime", () => {
	test("tool_use -> tool_result -> end_turn 闭环", async () => {
		let turn = 0;
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async () => {
				turn += 1;
				if (turn === 1) {
					return {
						stopReason: "tool_use",
						content: [
							{
								type: "tool_use",
								id: "tool-1",
								name: "write_file",
								input: {
									path: "/notes.txt",
									content: "hello",
								},
							},
						],
					};
				}

				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "done" }],
				};
			}),
			workspace: new InMemoryWorkspace("test"),
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 4,
			},
		});

		await runtime.sendUserMessage(session.id, "create note");
		const snapshot = await runtime.getSession(session.id);

		expect(snapshot.messages.some((message) => message.role === "assistant")).toBe(true);
		expect(snapshot.messages.some((message) => message.content.some((block) => block.type === "tool_result"))).toBe(
			true,
		);
	});

	test("普通文本直接结束本轮", async () => {
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async () => ({
				stopReason: "end_turn",
				content: [{ type: "text", text: "hello" }],
			})),
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 2,
			},
		});

		await runtime.sendUserMessage(session.id, "hi");
		const snapshot = await runtime.getSession(session.id);

		expect(snapshot.messages.at(-1)?.role).toBe("assistant");
	});

	test("tool_use 但没有工具块时失败", async () => {
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async () => ({
				stopReason: "tool_use",
				content: [],
			})),
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 2,
			},
		});

		await expect(runtime.sendUserMessage(session.id, "hi")).rejects.toThrow(
			"Model returned tool_use without any tool blocks",
		);
	});

	test("system prompt 暴露 available skills", async () => {
		let capturedSystemPrompt = "";
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async (input) => {
				capturedSystemPrompt = input.systemPrompt;
				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "ok" }],
				};
			}),
			skillProvider: new InMemorySkillProvider([
				{
					name: "readme-ai-docs",
					description: "doc helper",
					files: {
						"/SKILL.md": "# Skill",
					},
				},
			]),
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 2,
			},
		});

		await runtime.sendUserMessage(session.id, "list skills");
		expect(capturedSystemPrompt).toContain("Available skills");
		expect(capturedSystemPrompt).toContain("readme-ai-docs");
	});

	test("手动 compact 会产生摘要", async () => {
		let turn = 0;
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async (input) => {
				if (input.tools.length === 0) {
					return {
						stopReason: "end_turn",
						content: [{ type: "text", text: "continuity summary" }],
					};
				}

				turn += 1;
				if (turn === 1) {
					return {
						stopReason: "tool_use",
						content: [{ type: "tool_use", id: "tool-1", name: "compact", input: {} }],
					};
				}

				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "done" }],
				};
			}),
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 4,
			},
		});

		await runtime.sendUserMessage(session.id, "compact now");
		const snapshot = await runtime.getSession(session.id);
		expect(snapshot.compactSummary).toBe("continuity summary");
		expect(snapshot.transcriptRef).toContain("memory://");
		expect(snapshot.messages).toHaveLength(3);
	});

	test("Todo 长时间未更新会注入 nag", async () => {
		let turn = 0;
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async () => {
				turn += 1;
				if (turn === 1) {
					return {
						stopReason: "tool_use",
						content: [
							{
								type: "tool_use",
								id: "tool-1",
								name: "TodoWrite",
								input: {
									items: [{ id: "todo-1", content: "do thing", status: "pending" }],
								},
							},
						],
					};
				}

				if (turn < 5) {
					return {
						stopReason: "tool_use",
						content: [{ type: "tool_use", id: `tool-${turn}`, name: "task_list", input: {} }],
					};
				}

				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "done" }],
				};
			}),
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 8,
			},
		});

		await runtime.sendUserMessage(session.id, "start");
		const snapshot = await runtime.getSession(session.id);
		expect(
			snapshot.messages.some((message) =>
				message.role === "system" &&
				message.content.some(
					(block) => block.type === "text" && block.text.includes("unfinished todos"),
				),
			),
		).toBe(true);
	});

	test("TodoWrite 会使用增强渲染格式", async () => {
		let turn = 0;
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async () => {
				turn += 1;
				if (turn === 1) {
					return {
						stopReason: "tool_use",
						content: [
							{
								type: "tool_use",
								id: "tool-1",
								name: "TodoWrite",
								input: {
									items: [{ id: "todo-1", content: "do thing", status: "in_progress", activeForm: "doing thing" }],
								},
							},
						],
					};
				}

				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "done" }],
				};
			}),
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 4,
			},
		});

		await runtime.sendUserMessage(session.id, "start");
		const snapshot = await runtime.getSession(session.id);
		expect(
			snapshot.messages.some((message) =>
				message.content.some(
					(block) => block.type === "tool_result" && block.content.includes("[>] #todo-1: do thing <- doing thing"),
				),
			),
		).toBe(true);
	});

	test("task 工具可建立依赖并通过 task_get 读取", async () => {
		let turn = 0;
		let firstTaskId = "";
		let secondTaskId = "";
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async () => {
				turn += 1;
				if (turn === 1) {
					return {
						stopReason: "tool_use",
						content: [{ type: "tool_use", id: "tool-1", name: "task_create", input: { title: "task-a" } }],
					};
				}
				if (turn === 2) {
					return {
						stopReason: "tool_use",
						content: [{ type: "tool_use", id: "tool-2", name: "task_create", input: { title: "task-b" } }],
					};
				}
				if (turn === 3) {
					const snapshot = await runtime.getSession(session.id);
					firstTaskId = snapshot.tasks[0]!.id;
					secondTaskId = snapshot.tasks[1]!.id;
					return {
						stopReason: "tool_use",
						content: [
							{
								type: "tool_use",
								id: "tool-3",
								name: "task_update",
								input: { id: firstTaskId, addBlocks: [secondTaskId] },
							},
						],
					};
				}
				if (turn === 4) {
					return {
						stopReason: "tool_use",
						content: [{ type: "tool_use", id: "tool-4", name: "task_get", input: { id: secondTaskId } }],
					};
				}
				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "done" }],
				};
			}),
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 8,
			},
		});

		await runtime.sendUserMessage(session.id, "build task graph");
		const snapshot = await runtime.getSession(session.id);
		expect(snapshot.tasks[0]?.blocks).toContain(snapshot.tasks[1]!.id);
		expect(snapshot.tasks[1]?.blockedBy).toContain(snapshot.tasks[0]!.id);
		const taskGetResult = await runtime.invokeTool(session.id, {
			id: "verify-task-get",
			name: "task_get",
			input: { id: snapshot.tasks[1]!.id },
		});
		expect(taskGetResult.content).toContain(`"id": "${snapshot.tasks[1]!.id}"`);
	});

	test("subagent_run 使用 fresh context 并只回传摘要", async () => {
		const seenUserPayloads: string[] = [];
		let mainTurn = 0;
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async (input) => {
				const firstUserText = input.messages
					.find((message) => message.role === "user")
					?.content.find((block) => block.type === "text");
				seenUserPayloads.push(firstUserText?.type === "text" ? firstUserText.text : "");

				if (input.tools.some((tool) => tool.name === "subagent_run")) {
					mainTurn += 1;
					if (mainTurn === 1) {
						return {
							stopReason: "tool_use",
							content: [
								{
									type: "tool_use",
									id: "sub-1",
									name: "subagent_run",
									input: {
										prompt: "inspect /notes.txt",
										description: "inspect notes",
									},
								},
							],
						};
					}

					return {
						stopReason: "end_turn",
						content: [{ type: "text", text: "parent done" }],
					};
				}

				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "child summary" }],
				};
			}),
			workspace: new InMemoryWorkspace("test", {
				"/notes.txt": "hello",
			}),
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 4,
			},
		});

		await runtime.sendUserMessage(session.id, "main task with context");
		const snapshot = await runtime.getSession(session.id);
		expect(seenUserPayloads).toContain("main task with context");
		expect(seenUserPayloads).toContain("inspect /notes.txt");
		expect(seenUserPayloads).not.toContain("main task with context\ninspect /notes.txt");
		expect(
			snapshot.messages.some((message) =>
				message.content.some((block) => block.type === "tool_result" && block.content === "child summary"),
			),
		).toBe(true);
	});

	test("启用 state_exec 时主会话 prompt 会注入官方 state prompt", async () => {
		let capturedSystemPrompt = "";
		const runtime = createMemoryRuntime({
			aiClient: new StubAiClient(async (input) => {
				capturedSystemPrompt = input.systemPrompt;
				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "ok" }],
				};
			}),
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 2,
			},
		});

		await runtime.sendUserMessage(session.id, "use state");
		expect(capturedSystemPrompt).toContain("virtual filesystem");
		expect(capturedSystemPrompt).toContain("type StateEntryType");
	});

	test("未装配 stateExecutor 时不注入 state prompt", async () => {
		let capturedSystemPrompt = "";
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async (input) => {
				capturedSystemPrompt = input.systemPrompt;
				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "ok" }],
				};
			}),
			tools: [],
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 2,
			},
		});

		await runtime.sendUserMessage(session.id, "hi");
		expect(capturedSystemPrompt).not.toContain("virtual filesystem");
		expect(capturedSystemPrompt).not.toContain("type StateEntryType");
	});

	test("state_exec 可通过默认工具修改多个文件", async () => {
		const runtime = createMemoryRuntime({
			aiClient: new StubAiClient(async () => ({
				stopReason: "end_turn",
				content: [{ type: "text", text: "noop" }],
			})),
			files: {
				"/src/a.ts": 'export const a = "foo";',
				"/src/b.ts": 'export const b = "foo";',
			},
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 2,
			},
		});

		const result = await runtime.invokeTool(session.id, {
			id: "state-1",
			name: "state_exec",
			input: {
				code: `async () => {
					const preview = await state.replaceInFiles("/src/*.ts", "foo", "bar");
					return { totalFiles: preview.totalFiles, totalReplacements: preview.totalReplacements };
				}`,
				description: "replace foo with bar",
			},
		});

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain('"totalFiles": 2');
		const file = await runtime.invokeTool(session.id, {
			id: "verify-state",
			name: "read_file",
			input: { path: "/src/a.ts" },
		});
		expect(file.content).toContain("bar");
	});

	test("subagent 工具集不允许递归 spawn", () => {
		expect(SUBAGENT_TOOL_NAMES.has("subagent_run")).toBe(false);
		expect(SUBAGENT_TOOL_NAMES.has("subagent_start")).toBe(false);
		expect(SUBAGENT_TOOL_NAMES.has("state_exec")).toBe(true);
		expect(SUBAGENT_TOOL_NAMES.has("read_file")).toBe(true);
	});

	test("subagent 协议错误会失败并记录 job", async () => {
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async (input) => {
				if (input.tools.some((tool) => tool.name === "subagent_run")) {
					return {
						stopReason: "tool_use",
						content: [{ type: "tool_use", id: "sub-1", name: "subagent_run", input: { prompt: "child" } }],
					};
				}

				return {
					stopReason: "tool_use",
					content: [],
				};
			}),
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 3,
			},
		});

		const result = await runtime.invokeTool(session.id, {
			id: "manual-subagent",
			name: "subagent_run",
			input: { prompt: "child" },
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Protocol error: subagent returned tool_use without calls");

		const jobs = await runtime.listSubagentJobs(session.id);
		expect(jobs[0]?.status).toBe("failed");
	});

	test("subagent_start / subagent_status / subagent_list 提供 async 骨架", async () => {
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async () => ({
				stopReason: "end_turn",
				content: [{ type: "text", text: "ok" }],
			})),
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 2,
			},
		});

		const job = await runtime.startSubagent(session.id, "child async", { description: "queued only" });
		expect(job.status).toBe("queued");

		const queried = await runtime.getSubagentJob(job.id);
		expect(queried?.status).toBe("queued");

		const listed = await runtime.listSubagentJobs(session.id);
		expect(listed.some((item) => item.id === job.id)).toBe(true);
	});
});
