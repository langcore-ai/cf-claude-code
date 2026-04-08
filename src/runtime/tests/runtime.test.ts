import { describe, expect, test } from "bun:test";

import { InMemorySessionStore, InMemoryTodoMemoryStore } from "../adapters";
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
				maxTurnsPerMessage: 6,
			},
		});

		await runtime.sendUserMessage(session.id, "hi");
		const snapshot = await runtime.getSession(session.id);

		expect(snapshot.messages.at(-1)?.role).toBe("assistant");
	});

	test("session 恢复后缺失 controller 时可按需重建", async () => {
		const sessionStore = new InMemorySessionStore();
		const aiClient = new StubAiClient(async () => ({
			stopReason: "end_turn",
			content: [{ type: "text", text: "hello again" }],
		}));

		const firstRuntime = new MemoryAgentRuntime({
			aiClient,
			sessionStore,
			workspace: new InMemoryWorkspace("test"),
		});

		const session = await firstRuntime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 6,
			},
		});

		// 模拟新的 Worker/Runtime 实例，只复用持久化 session store。
		const secondRuntime = new MemoryAgentRuntime({
			aiClient,
			sessionStore,
			workspace: new InMemoryWorkspace("test"),
		});

		await secondRuntime.sendUserMessage(session.id, "hi again");
		const snapshot = await secondRuntime.getSession(session.id);
		expect(snapshot.messages.at(-1)?.role).toBe("assistant");
		expect(snapshot.messages.at(-1)?.content[0]).toEqual({ type: "text", text: "hello again" });
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
				maxTurnsPerMessage: 6,
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
				maxTurnsPerMessage: 6,
			},
		});

		await runtime.sendUserMessage(session.id, "list skills");
		expect(capturedSystemPrompt).toContain("Available skills");
		expect(capturedSystemPrompt).toContain("readme-ai-docs");
		expect(capturedSystemPrompt).toContain("Claude Code");
		expect(capturedSystemPrompt).toContain("official CLI for Claude");
		expect(capturedSystemPrompt).toContain("fewer than 4 lines");
		expect(capturedSystemPrompt).toContain("Do not add additional code explanation summary unless requested");
		expect(capturedSystemPrompt).toContain("Never commit changes unless the user explicitly asks you to commit");
		expect(capturedSystemPrompt).toContain("Treat <system-reminder> blocks as authoritative runtime context");
		expect(capturedSystemPrompt).toContain("<system-reminder>");
		expect(capturedSystemPrompt).toContain("todo list is currently empty");
	});

	test("plan mode 会注入只读规划提示并过滤写工具", async () => {
		let capturedTools: string[] = [];
		let capturedSystemPrompt = "";
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async (input) => {
				capturedSystemPrompt = input.systemPrompt;
				capturedTools = input.tools.map((tool) => tool.name);
				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "plan only" }],
				};
			}),
		});

		const session = await runtime.startSession({
			mode: "plan",
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 2,
			},
		});

		await runtime.sendUserMessage(session.id, "plan this");
		expect(capturedSystemPrompt).toContain("currently in plan mode");
		expect(capturedSystemPrompt).toContain("read-only planning posture");
		expect(capturedTools).toContain("read_file");
		expect(capturedTools).toContain("ExitPlanMode");
		expect(capturedTools).toContain("WebFetch");
		expect(capturedTools).toContain("WebSearch");
		expect(capturedTools).not.toContain("write_file");
		expect(capturedTools).not.toContain("edit");
		expect(capturedTools).not.toContain("Bash");
		expect(capturedTools).not.toContain("Task");
	});

	test("plan mode 下直接调用写工具会被拒绝", async () => {
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async () => ({
				stopReason: "end_turn",
				content: [{ type: "text", text: "ok" }],
			})),
		});

		const session = await runtime.startSession({
			mode: "plan",
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 2,
			},
		});

		const result = await runtime.invokeTool(session.id, {
			id: "write-in-plan",
			name: "write_file",
			input: {
				path: "/notes.txt",
				content: "hello",
			},
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("not available while session mode is plan");
	});

	test("ExitPlanMode 会把会话切回 normal", async () => {
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async () => ({
				stopReason: "end_turn",
				content: [{ type: "text", text: "ok" }],
			})),
		});

		const session = await runtime.startSession({
			mode: "plan",
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 2,
			},
		});

		const before = await runtime.getSession(session.id);
		expect(before.mode).toBe("plan");

		const result = await runtime.invokeTool(session.id, {
			id: "exit-plan",
			name: "ExitPlanMode",
			input: {},
		});
		expect(result.isError).toBeUndefined();

		const after = await runtime.getSession(session.id);
		expect(after.mode).toBe("normal");
	});

	test("WebFetch 使用 lightweight 模型角色分析页面内容", async () => {
		const originalFetch = globalThis.fetch;
		let capturedFetchUrl = "";
		let capturedAuthorization = "";
		let capturedAccept = "";
		let capturedRespondTiming = "";
		let capturedRespondWith = "";
		let capturedTargetSelector = "";
		let capturedWaitForSelector = "";
		globalThis.fetch = (async (input, init) => {
			capturedFetchUrl = typeof input === "string" ? input : input.toString();
			const headers = new Headers(init?.headers);
			capturedAuthorization = headers.get("Authorization") ?? "";
			capturedAccept = headers.get("Accept") ?? "";
			capturedRespondTiming = headers.get("X-Respond-Timing") ?? "";
			capturedRespondWith = headers.get("X-Respond-With") ?? "";
			capturedTargetSelector = headers.get("X-Target-Selector") ?? "";
			capturedWaitForSelector = headers.get("X-Wait-For-Selector") ?? "";
			return new Response("<html><body><h1>Title</h1><p>Hello edge world.</p></body></html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		}) as typeof fetch;

		try {
			let capturedRole: GenerateTurnInput["modelRole"] | undefined;
			let capturedPrompt = "";
			const runtime = new MemoryAgentRuntime({
				aiClient: new StubAiClient(async (input) => {
					capturedRole = input.modelRole;
					capturedPrompt =
						input.messages[0]?.content[0]?.type === "text" ? input.messages[0].content[0].text : "";
					return {
						stopReason: "end_turn",
						content: [{ type: "text", text: "edge summary" }],
					};
				}),
				webFetch: {
					jinaApiKey: "test-jina-key",
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
				id: "webfetch-1",
				name: "WebFetch",
				input: {
					url: "https://example.com",
					prompt: "Summarize the page",
					respondWith: "markdown",
					targetSelector: "main article",
					waitForSelector: "#content",
					instruction: "Focus on the main article content",
					jsonSchema: {
						type: "object",
						properties: {
							summary: { type: "string" },
						},
					},
				},
			});

			expect(result.isError).toBeUndefined();
			expect(result.content).toBe("edge summary");
			expect(capturedRole).toBe("lightweight");
			expect(capturedFetchUrl).toContain("https://r.jina.ai/https://example.com/");
			expect(capturedFetchUrl).toContain("respondWith=markdown");
			expect(capturedFetchUrl).toContain("targetSelector=main+article");
			expect(capturedFetchUrl).toContain("waitForSelector=%23content");
			expect(capturedFetchUrl).toContain("instruction=Focus+on+the+main+article+content");
			expect(capturedFetchUrl).toContain("jsonSchema=");
			expect(capturedAuthorization).toBe("Bearer test-jina-key");
			expect(capturedAccept).toBe("text/plain");
			expect(capturedRespondTiming).toBe("visible-content");
			expect(capturedRespondWith).toBe("markdown");
			expect(capturedTargetSelector).toBe("main article");
			expect(capturedWaitForSelector).toBe("#content");
			expect(capturedPrompt).toContain("Summarize the page");
			expect(capturedPrompt).toContain("Hello edge world.");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("WebSearch 使用 Jina Search 并应用域名过滤", async () => {
		const originalFetch = globalThis.fetch;
		let capturedFetchUrl = "";
		let capturedAuthorization = "";
		let capturedAccept = "";
		let capturedRespondWith = "";
		let capturedCacheTolerance = "";
		let capturedRespondTiming = "";
		globalThis.fetch = (async (input, init) => {
			capturedFetchUrl = typeof input === "string" ? input : input.toString();
			const headers = new Headers(init?.headers);
			capturedAuthorization = headers.get("Authorization") ?? "";
			capturedAccept = headers.get("Accept") ?? "";
			capturedRespondWith = headers.get("X-Respond-With") ?? "";
			capturedCacheTolerance = headers.get("X-Cache-Tolerance") ?? "";
			capturedRespondTiming = headers.get("X-Respond-Timing") ?? "";
			return new Response(
				JSON.stringify({
					code: 200,
					status: 20000,
					data: [
						"1. Allowed title",
						"URL: https://allowed.com/doc",
						"Snippet: Allowed snippet",
						"",
						"2. Blocked title",
						"URL: https://blocked.com/doc",
						"Snippet: Blocked snippet",
					].join("\n"),
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}) as typeof fetch;

		try {
			const runtime = new MemoryAgentRuntime({
				aiClient: new StubAiClient(async () => ({
					stopReason: "end_turn",
					content: [{ type: "text", text: "ok" }],
				})),
				webFetch: {
					jinaApiKey: "test-jina-key",
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
				id: "websearch-1",
				name: "WebSearch",
				input: {
					query: "edge runtime",
					type: "news",
					count: 5,
					site: ["docs.example.com"],
					allowed_domains: ["allowed.com"],
					blocked_domains: ["blocked.com"],
				},
			});

			expect(capturedFetchUrl).toContain("https://s.jina.ai/search?");
			expect(capturedFetchUrl).toContain("q=edge+runtime");
			expect(capturedFetchUrl).toContain("provider=google");
			expect(capturedFetchUrl).toContain("type=news");
			expect(capturedFetchUrl).toContain("count=5");
			expect(capturedFetchUrl).toContain("site=docs.example.com");
			expect(capturedFetchUrl).toContain("site=allowed.com");
			expect(capturedAuthorization).toBe("Bearer test-jina-key");
			expect(capturedAccept).toBe("application/json");
			expect(capturedRespondWith).toBe("markdown");
			expect(capturedCacheTolerance).toBe("300");
			expect(capturedRespondTiming).toBe("visible-content");
			expect(result.content).toContain("Allowed title");
			expect(result.content).not.toContain("Blocked title");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("Bash 在 edge 适配层执行 workspace 文件命令", async () => {
		const runtime = createMemoryRuntime({
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

		const success = await runtime.invokeTool(session.id, {
			id: "bash-1",
			name: "Bash",
			input: {
				command: "mkdir -p /tmp && echo hello > /tmp/a.txt && cat /tmp/a.txt",
			},
		});
		expect(success.content).toContain("hello");

		const unsupported = await runtime.invokeTool(session.id, {
			id: "bash-2",
			name: "Bash",
			input: {
				command: "npm test",
			},
		});
		expect(unsupported.isError).toBe(true);
		expect(unsupported.content).toContain("Unsupported in edge Bash adapter");
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

	test("Todo nag 不会在后续轮次里无限重复注入同一文案", async () => {
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

				if (turn < 7) {
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
		const nagMessages = snapshot.messages.filter(
			(message) =>
				message.role === "system" &&
				message.content.some(
					(block) => block.type === "text" && block.text.includes("unfinished todos"),
				),
		);
		expect(nagMessages).toHaveLength(1);
	});

	test("存在 todo 时 prompt 会注入 end reminder 而不是空 todo 提醒", async () => {
		let capturedSystemPrompt = "";
		let turn = 0;
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async (input) => {
				capturedSystemPrompt = input.systemPrompt;
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
									items: [{ id: "todo-1", content: "ship feature", status: "in_progress", activeForm: "shipping feature" }],
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
		expect(capturedSystemPrompt).toContain("There are active todos");
		expect(capturedSystemPrompt).toContain("ship feature");
		expect(capturedSystemPrompt).not.toContain("todo list is currently empty");
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

	test("TodoWrite 兼容 reverse 风格 todos 输入并保留 priority", async () => {
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
									todos: [{ content: "write auth flow", status: "in_progress", priority: "high", activeForm: "writing auth flow" }],
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
		expect(snapshot.todos[0]?.priority).toBe("high");
		expect(
			snapshot.messages.some((message) =>
				message.content.some(
					(block) => block.type === "tool_result" && block.content.includes("(high)"),
				),
			),
		).toBe(true);
	});

	test("当前 todo 为空时会注入最近 todo memory", async () => {
		let capturedSystemPrompt = "";
		const todoMemoryStore = new InMemoryTodoMemoryStore();
		await todoMemoryStore.saveLatestTodos("session-remembered", [
			{
				id: "todo-1",
				content: "ship login page",
				status: "pending",
				priority: "high",
			},
		]);
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async (input) => {
				capturedSystemPrompt = input.systemPrompt;
				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "ok" }],
				};
			}),
			todoMemoryStore,
		});

		const session = await runtime.startSession({
			sessionId: "session-remembered",
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 2,
			},
		});

		await runtime.sendUserMessage(session.id, "continue");
		expect(capturedSystemPrompt).toContain("Recent todo memory");
		expect(capturedSystemPrompt).toContain("ship login page");
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
		const seenRoles: Array<GenerateTurnInput["modelRole"] | undefined> = [];
		let mainTurn = 0;
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async (input) => {
				seenRoles.push(input.modelRole);
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
		expect(seenRoles).toContain("main");
		expect(seenRoles).toContain("subagent");
		expect(
			snapshot.messages.some((message) =>
				message.content.some((block) => block.type === "tool_result" && block.content === "child summary"),
			),
		).toBe(true);
	});

	test("Task 工具别名会按 Claude Code 风格调用 subagent", async () => {
		let mainTurn = 0;
		const runtime = new MemoryAgentRuntime({
			aiClient: new StubAiClient(async (input) => {
				if (input.tools.some((tool) => tool.name === "Task")) {
					mainTurn += 1;
					if (mainTurn === 1) {
						return {
							stopReason: "tool_use",
							content: [
								{
									type: "tool_use",
									id: "task-1",
									name: "Task",
									input: {
										description: "inspect notes",
										prompt: "inspect /notes.txt",
										subagent_type: "general-purpose",
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

		await runtime.sendUserMessage(session.id, "delegate");
		const snapshot = await runtime.getSession(session.id);
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
		expect(SUBAGENT_TOOL_NAMES.has("state_exec")).toBe(false);
		expect(SUBAGENT_TOOL_NAMES.has("read_file")).toBe(true);
		expect(SUBAGENT_TOOL_NAMES.has("grep")).toBe(true);
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

	test("write_file 覆写现有文件前必须先 read_file", async () => {
		let turn = 0;
		const runtime = createMemoryRuntime({
			aiClient: new StubAiClient(async () => {
				turn += 1;
				if (turn === 1) {
					return {
						stopReason: "tool_use",
						content: [{ type: "tool_use", id: "read-tool", name: "read_file", input: { path: "/notes.txt" } }],
					};
				}
				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "noop" }],
				};
			}),
			files: {
				"/notes.txt": "hello",
			},
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 2,
			},
		});

		const denied = await runtime.invokeTool(session.id, {
			id: "write-without-read",
			name: "write_file",
			input: { path: "/notes.txt", content: "world" },
		});
		expect(denied.isError).toBe(true);
		expect(denied.content).toContain("Must read /notes.txt");

		await runtime.sendUserMessage(session.id, "read it first");
		const allowed = await runtime.invokeTool(session.id, {
			id: "write-after-read",
			name: "write_file",
			input: { path: "/notes.txt", content: "world" },
		});
		expect(allowed.isError).toBeUndefined();
	});

	test("工具失败后会注入纠偏 system reminder", async () => {
		let turn = 0;
		const runtime = createMemoryRuntime({
			aiClient: new StubAiClient(async () => {
				turn += 1;
				if (turn === 1) {
					return {
						stopReason: "tool_use",
						content: [{ type: "tool_use", id: "bad-write", name: "write_file", input: { path: "/" } }],
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
				maxTurnsPerMessage: 3,
			},
		});

		await runtime.sendUserMessage(session.id, "create a file");
		const snapshot = await runtime.getSession(session.id);
		const systemTexts = snapshot.messages
			.filter((message) => message.role === "system")
			.flatMap((message) =>
				message.content
					.filter((block) => block.type === "text")
					.map((block) => ("text" in block ? block.text : "")),
			);

		expect(systemTexts.some((text) => text.includes("The last tool call failed: write_file."))).toBe(true);
		expect(systemTexts.some((text) => text.includes("Ensure required arguments are present and non-empty before retrying."))).toBe(true);
	});

	test("重复相同错误工具调用时会注入更强提醒", async () => {
		let turn = 0;
		const runtime = createMemoryRuntime({
			aiClient: new StubAiClient(async () => {
				turn += 1;
				if (turn <= 2) {
					return {
						stopReason: "tool_use",
						content: [{ type: "tool_use", id: `bad-write-${turn}`, name: "write_file", input: { path: "/" } }],
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

		await runtime.sendUserMessage(session.id, "create a file");
		const snapshot = await runtime.getSession(session.id);
		const systemTexts = snapshot.messages
			.filter((message) => message.role === "system")
			.flatMap((message) =>
				message.content
					.filter((block) => block.type === "text")
					.map((block) => ("text" in block ? block.text : "")),
			);

		expect(systemTexts.some((text) => text.includes("You have repeated the same invalid tool call multiple times."))).toBe(true);
	});

	test("重复失败提醒不会用相同文案无限重复注入", async () => {
		let turn = 0;
		const runtime = createMemoryRuntime({
			aiClient: new StubAiClient(async () => {
				turn += 1;
				if (turn <= 3) {
					return {
						stopReason: "tool_use",
						content: [{ type: "tool_use", id: `bad-write-${turn}`, name: "write_file", input: { path: "/" } }],
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
				maxTurnsPerMessage: 5,
			},
		});

		await runtime.sendUserMessage(session.id, "create a file");
		const snapshot = await runtime.getSession(session.id);
		const repeatedWarnings = snapshot.messages.filter(
			(message) =>
				message.role === "system" &&
				message.content.some(
					(block) =>
						block.type === "text" &&
						block.text.includes("You have repeated the same invalid tool call multiple times."),
				),
		);

		expect(repeatedWarnings).toHaveLength(1);
	});

	test("glob / grep / edit / multi_edit 走核心工具链", async () => {
		let turn = 0;
		const runtime = createMemoryRuntime({
			aiClient: new StubAiClient(async () => {
				turn += 1;
				if (turn === 1) {
					return {
						stopReason: "tool_use",
						content: [
							{ type: "tool_use", id: "read-a", name: "read_file", input: { path: "/src/a.ts" } },
							{ type: "tool_use", id: "read-b", name: "read_file", input: { path: "/src/b.ts" } },
						],
					};
				}
				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "noop" }],
				};
			}),
			files: {
				"/src/a.ts": 'export const a = "foo";',
				"/src/b.ts": 'export const b = "foo";',
				"/docs/readme.md": "# Hello\nfoo",
			},
		});

		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 2,
			},
		});

		const glob = await runtime.invokeTool(session.id, {
			id: "glob-1",
			name: "glob",
			input: { pattern: "/src/*.ts" },
		});
		expect(glob.content).toContain("/src/a.ts");
		expect(glob.content).toContain("/src/b.ts");

		const grep = await runtime.invokeTool(session.id, {
			id: "grep-1",
			name: "grep",
			input: { query: "foo", path: "/src" },
		});
		expect(grep.content).toContain("/src/a.ts:1:");

		await runtime.sendUserMessage(session.id, "read files");
		const edit = await runtime.invokeTool(session.id, {
			id: "edit-a",
			name: "edit",
			input: {
				path: "/src/a.ts",
				oldString: '"foo"',
				newString: '"bar"',
			},
		});
		expect(edit.content).toContain("Edited file");

		const multiEdit = await runtime.invokeTool(session.id, {
			id: "multi-edit-b",
			name: "multi_edit",
			input: {
				path: "/src/b.ts",
				edits: [
					{ oldString: '"foo"', newString: '"bar"' },
					{ oldString: "const", newString: "let" },
				],
			},
		});
		expect(multiEdit.content).toContain("Applied 2 edits");
	});
});
