import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
	D1SessionStore,
	D1SubagentStore,
	D1TaskStore,
	D1TodoMemoryStore,
	D1TodoStore,
	D1TranscriptStore,
} from "../adapters";
import { createDurableRuntime as createDurableRuntimeFactory, WorkspaceStateExecutor } from "../core";
import { WorkspaceSkillProvider } from "../skills";
import type { AIClient, GenerateTurnInput, Message, ModelTurnResult, SessionState } from "../types";
import { DurableWorkspaceAdapter, InMemoryWorkspaceAdapter } from "../workspace";

/** 测试用 AI client */
class StubAiClient implements AIClient {
	constructor(private readonly handler: (input: GenerateTurnInput) => Promise<ModelTurnResult>) {}

	async generateTurn(input: GenerateTurnInput): Promise<ModelTurnResult> {
		return this.handler(input);
	}
}

/**
 * 把 bun sqlite 包装成 shell 期望的 SqlBackend。
 * @param database sqlite 数据库
 * @returns query/run 风格 backend
 */
function createSqlBackend(database: Database) {
	return {
		query<T = Record<string, string | number | boolean | null>>(sql: string, ...params: Array<string | number | boolean | null>) {
			return database.query(sql).all(...params) as T[];
		},
		run(sql: string, ...params: Array<string | number | boolean | null>) {
			database.query(sql).run(...params);
		},
	};
}

function createSession(): SessionState {
	return {
		id: "session-1",
		mode: "normal",
		config: {
			systemPrompt: "test",
			tokenThreshold: 9999,
			maxTurnsPerMessage: 4,
		},
		messages: [],
		todos: [],
		tasks: [],
		todoIdleTurns: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

/**
 * 判断当前消息历史里是否已经存在子任务工具结果。
 * @param messages 会话消息
 * @returns 是否已经执行过子任务工具
 */
function hasToolResult(messages: Message[]): boolean {
	return messages.some((message) => message.content.some((block) => block.type === "tool_result"));
}

/**
 * 最小 R2 模拟实现。
 * 这里只覆盖 workspace 落大文件到 R2 所需的最小方法。
 */
class FakeR2Bucket {
	/** 对象存储内容 */
	private readonly objects = new Map<string, Uint8Array>();

	/**
	 * 写入对象
	 * @param key 对象 key
	 * @param value 对象内容
	 */
	async put(key: string, value: ArrayBuffer | ArrayBufferView): Promise<void> {
		const bytes = value instanceof ArrayBuffer
			? new Uint8Array(value)
			: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		this.objects.set(key, new Uint8Array(bytes));
	}

	/**
	 * 读取对象
	 * @param key 对象 key
	 * @returns 只包含 arrayBuffer 的最小对象
	 */
	async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null> {
		const bytes = this.objects.get(key);
		if (!bytes) {
			return null;
		}

		return {
			arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			httpMetadata: {},
		};
	}

	/**
	 * 删除对象
	 * @param keys 对象 key 或 key 列表
	 */
	async delete(keys: string | string[]): Promise<void> {
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			this.objects.delete(key);
		}
	}

	/**
	 * 判断对象是否存在
	 * @param key 对象 key
	 * @returns 是否存在
	 */
	has(key: string): boolean {
		return this.objects.has(key);
	}
}

describe("durable workspace and stores", () => {
	test("内存与 durable workspace 适配器具备一致的最小语义", async () => {
		const database = new Database(":memory:");
		const sql = createSqlBackend(database);
		const memoryWorkspace = new InMemoryWorkspaceAdapter("memory", {
			"/skills/readme-ai-docs/SKILL.md": "# Skill",
		});
		const durableWorkspace = new DurableWorkspaceAdapter({
			sql,
			name: "durable",
			namespace: "runtime",
		});

		await durableWorkspace.files.writeFile("/skills/readme-ai-docs/SKILL.md", "# Skill");

		const [memoryRoot, durableRoot] = await Promise.all([
			memoryWorkspace.files.list("/skills"),
			durableWorkspace.files.list("/skills"),
		]);

		expect(memoryRoot[0]?.path).toBe("/skills/readme-ai-docs");
		expect(durableRoot[0]?.path).toBe("/skills/readme-ai-docs");
		expect(memoryWorkspace.backend.kind).toBe("memory");
		expect(durableWorkspace.backend.kind).toBe("durable");
	});

	test("D1-backed stores 可 round-trip session / transcript / subagent jobs", async () => {
		const database = new Database(":memory:");
		const sql = createSqlBackend(database);
		const sessionStore = new D1SessionStore(sql, { namespace: "runtime" });
		const transcriptStore = new D1TranscriptStore(sql, { namespace: "runtime" });
		const subagentStore = new D1SubagentStore(sql, { namespace: "runtime" });
		const taskStore = new D1TaskStore(sql, { namespace: "runtime" });
		const todoStore = new D1TodoStore(sql, { namespace: "runtime" });
		const todoMemoryStore = new D1TodoMemoryStore(sql, { namespace: "runtime" });

		const session = createSession();
		await sessionStore.save(session);
		const loadedSession = await sessionStore.load(session.id);
		expect(loadedSession?.id).toBe(session.id);

		const transcriptRef = await transcriptStore.saveTranscript(session.id, [
			{
				id: "m1",
				role: "user",
				content: [{ type: "text", text: "hello" }],
				createdAt: new Date().toISOString(),
			},
		]);
		const transcript = await transcriptStore.loadTranscript(transcriptRef);
		expect(transcript?.[0]?.id).toBe("m1");

		await subagentStore.createJob({
			id: "job-1",
			sessionId: session.id,
			mode: "async",
			prompt: "do thing",
			status: "queued",
			turnCount: 0,
			messageCount: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		const job = await subagentStore.getJob("job-1");
		expect(job?.status).toBe("queued");
		expect((await subagentStore.listJobsForSession(session.id)).length).toBe(1);

		await taskStore.saveTasks(session.id, [
			{
				id: "task-1",
				title: "ship auth",
				status: "in_progress",
				blockedBy: [],
				blocks: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		]);
		const persistedTasks = await taskStore.loadTasks(session.id);
		expect(persistedTasks?.[0]?.status).toBe("in_progress");

		await todoStore.saveTodos(session.id, [
			{
				id: "todo-1",
				content: "ship auth",
				status: "pending",
				priority: "high",
			},
		]);
		const persistedTodos = await todoStore.loadTodos(session.id);
		expect(persistedTodos?.[0]?.content).toBe("ship auth");

		await todoMemoryStore.saveLatestTodos(session.id, [
			{
				id: "todo-1",
				content: "ship auth",
				status: "pending",
				priority: "high",
			},
		]);
		const rememberedTodos = await todoMemoryStore.loadLatestTodos(session.id);
		expect(rememberedTodos?.[0]?.priority).toBe("high");
	});

	test("WorkspaceSkillProvider 可从真实 workspace 发现 skill", async () => {
		const database = new Database(":memory:");
		const sql = createSqlBackend(database);
		const workspace = new DurableWorkspaceAdapter({
			sql,
			name: "durable",
			namespace: "runtime",
		});
		await workspace.files.writeFile(
			"/skills/readme-ai-docs/SKILL.md",
			"---\ndescription: doc helper\n---\n# Skill",
		);

		const provider = new WorkspaceSkillProvider({ workspace });
		const skills = await provider.list();
		expect(skills[0]?.name).toBe("readme-ai-docs");
		expect(skills[0]?.description).toBe("doc helper");

		const skill = await provider.open("readme-ai-docs");
		expect(await skill?.readEntry()).toContain("# Skill");
	});

	test("durable workspace 在配置 R2 且超过阈值时会把大文件落到 R2", async () => {
		const database = new Database(":memory:");
		const sql = createSqlBackend(database);
		const bucket = new FakeR2Bucket();
		const workspace = new DurableWorkspaceAdapter({
			sql,
			r2: bucket as unknown as R2Bucket,
			r2Prefix: "workspace",
			inlineThreshold: 8,
			name: "durable-r2",
			namespace: "runtime_r2",
		});

		await workspace.files.writeFile("/large.txt", "this content is definitely larger than eight bytes");
		const rows = sql.query<Array<{
			path: string;
			storage_backend: string;
			r2_key: string | null;
		}>[number]>(
			"SELECT path, storage_backend, r2_key FROM cf_workspace_runtime_r2 WHERE path = ?",
			"/large.txt",
		);

		expect(rows[0]?.storage_backend).toBe("r2");
		expect(rows[0]?.r2_key).toBeString();
		expect(bucket.has(rows[0]!.r2_key!)).toBe(true);
	});

	test("durable runtime 恢复后仍可看到 workspace 与 subagent job", async () => {
		const database = new Database(":memory:");
		const sql = createSqlBackend(database);
		let mainTurns = 0;
		const aiClient = new StubAiClient(async (input) => {
			// 父会话先调用 subagent，第二轮结束主链路。
			if (input.tools.some((tool) => tool.name === "subagent_run")) {
				mainTurns += 1;
				if (mainTurns === 1) {
					return {
						stopReason: "tool_use",
						content: [
							{
								type: "tool_use",
								id: "sub-1",
								name: "subagent_run",
								input: {
									prompt: "write /notes.txt",
									description: "write note",
								},
							},
						],
					};
				}
				return {
					stopReason: "end_turn",
					content: [{ type: "text", text: "done" }],
				};
			}

			// 子会话第一轮先写文件，拿到 tool_result 后第二轮返回摘要。
			if (!hasToolResult(input.messages)) {
				return {
					stopReason: "tool_use",
					content: [
						{
							type: "tool_use",
							id: "child-write",
							name: "write_file",
							input: {
								path: "/notes.txt",
								content: "hello durable",
							},
						},
					],
				};
			}

			return {
				stopReason: "end_turn",
				content: [{ type: "text", text: "child summary" }],
			};
		});

		const runtime = createDurableRuntimeFactory({
			aiClient,
			sql,
			namespace: "runtime",
			workspaceName: "durable",
		});
		const session = await runtime.startSession({
			config: {
				systemPrompt: "test",
				tokenThreshold: 9999,
				maxTurnsPerMessage: 4,
			},
		});

		await runtime.sendUserMessage(session.id, "main");
		const firstSnapshot = await runtime.getSession(session.id);
		expect(firstSnapshot.messages.some((message) =>
			message.content.some((block) => block.type === "tool_result" && block.content === "child summary"),
		)).toBe(true);

		const runtimeReloaded = createDurableRuntimeFactory({
			aiClient: new StubAiClient(async () => ({
				stopReason: "end_turn",
				content: [{ type: "text", text: "noop" }],
			})),
			sql,
			namespace: "runtime",
			workspaceName: "durable",
		});

		const resumed = await runtimeReloaded.getSession(session.id);
		expect(resumed.id).toBe(session.id);
		const readResult = await runtimeReloaded.invokeTool(session.id, {
			id: "read-after-reload",
			name: "read_file",
			input: {
				path: "/notes.txt",
			},
		});
		expect(readResult.content).toContain("hello durable");

		const jobs = await runtimeReloaded.listSubagentJobs(session.id);
		expect(jobs.length).toBeGreaterThan(0);
		expect(jobs[0]?.summary).toBe("child summary");
	});

	test("WorkspaceStateExecutor 可在 durable workspace 中真实执行 state.*", async () => {
		const database = new Database(":memory:");
		const sql = createSqlBackend(database);
		const workspace = new DurableWorkspaceAdapter({
			sql,
			name: "durable",
			namespace: "runtime_exec",
		});
		const executor = new WorkspaceStateExecutor(workspace);

		const result = await executor.execute(`async () => {
			await state.writeFile("/notes.txt", "hello from state");
			return await state.readFile("/notes.txt");
		}`);

		expect(result.value).toBe("hello from state");
		const file = await workspace.files.readFile("/notes.txt");
		expect(file.content).toBe("hello from state");
	});
});
