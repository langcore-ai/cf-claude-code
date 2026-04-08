import { nanoid } from "nanoid";
import { STATE_SYSTEM_PROMPT, STATE_TYPES } from "@cloudflare/shell";

import {
	InMemorySessionStore,
	InMemorySubagentStore,
	InMemoryTodoMemoryStore,
	InMemoryTranscriptStore,
	type TranscriptStore,
} from "../adapters";
import { autoCompactSession, compactSession, microCompactMessages } from "./compact";
import { composeMainSystemPrompt, composeSubagentSystemPrompt } from "./prompt-composer";
import { buildTodoIdleReminder, buildToolFailureReminder } from "./reminders";
import type { StateExecutor } from "./state-executor";
import { SubagentRunner } from "./subagent-runner";
import { hasOpenTodos } from "../domain";
import { InMemorySkillProvider, type SkillProvider } from "../skills";
import {
	DEFAULT_TOOLS,
	PLAN_MODE_ALLOWED_TOOL_NAMES,
	type DefaultToolContext,
	type RuntimeTool,
} from "../tools";
import { ToolDispatcher } from "./tool-dispatcher";
import type {
	AgentEvent,
	AgentRuntime,
	AIClient,
	Message,
	SessionConfig,
	SessionHandle,
	SessionState,
	SessionStore,
	StartSessionInput,
	SubagentJob,
	SubagentResult,
	SubagentStore,
	TodoMemoryStore,
	ToolCall,
	ToolResult,
} from "../types";
import { InMemoryWorkspace, type Workspace } from "../workspace";

/** Todo nag 触发阈值 */
const TODO_NAG_THRESHOLD = 3;

/** 默认会话配置 */
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
	systemPrompt: "",
	tokenThreshold: 4000,
	maxTurnsPerMessage: 6,
};

/** Session 事件队列控制器 */
interface SessionController {
	/** 会话事件流 */
	stream: AsyncIterable<AgentEvent>;
	/** 推送事件 */
	push(event: AgentEvent): void;
	/** 结束事件流 */
	close(): void;
}

/** Runtime 依赖 */
export interface RuntimeDependencies {
	/** AI 客户端 */
	aiClient: AIClient;
	/** 工作区 */
	workspace?: Workspace;
	/** skill provider */
	skillProvider?: SkillProvider;
	/** session store */
	sessionStore?: SessionStore;
	/** transcript store */
	transcriptStore?: TranscriptStore;
	/** subagent store */
	subagentStore?: SubagentStore;
	/** Todo 短期记忆 store */
	todoMemoryStore?: TodoMemoryStore;
	/** 结构化 state 执行器 */
	stateExecutor?: StateExecutor;
	/** 工具集合 */
	tools?: RuntimeTool[];
	/** WebFetch 相关配置 */
	webFetch?: {
		/** Jina Reader API Key */
		jinaApiKey?: string;
	};
}

/** shell 官方 state prompt */
const RENDERED_STATE_SYSTEM_PROMPT = STATE_SYSTEM_PROMPT.replace("{{types}}", STATE_TYPES);

/**
 * 创建一个可推送的事件流。
 * @returns 事件控制器
 */
function createSessionController(): SessionController {
	const queue: AgentEvent[] = [];
	const waiting: Array<(value: IteratorResult<AgentEvent>) => void> = [];
	let closed = false;

	return {
		stream: {
			[Symbol.asyncIterator]() {
				return {
					next() {
						if (queue.length > 0) {
							return Promise.resolve({
								value: queue.shift()!,
								done: false,
							});
						}

						if (closed) {
							return Promise.resolve({
								value: undefined,
								done: true,
							});
						}

						return new Promise<IteratorResult<AgentEvent>>((resolve) => {
							waiting.push(resolve);
						});
					},
				};
			},
		},
		push(event) {
			if (waiting.length > 0) {
				waiting.shift()!({
					value: event,
					done: false,
				});
				return;
			}

			queue.push(event);
		},
		close() {
			closed = true;
			while (waiting.length > 0) {
				waiting.shift()!({
					value: undefined,
					done: true,
				});
			}
		},
	};
}

/**
 * 生成工具调用签名，用于识别“同一个工具 + 同一组参数”的重复失败。
 * @param call 工具调用
 * @returns 可稳定比较的签名
 */
function buildToolCallSignature(call: ToolCall): string {
	return JSON.stringify({
		name: call.name,
		input: call.input,
	});
}

/**
 * 统计当前会话里相同工具调用签名的失败次数。
 * 这里基于 assistant 的 tool_use 与后续 user tool_result 配对做最小推断。
 * @param session 当前会话
 * @param call 当前工具调用
 * @returns 历史失败次数
 */
function countFailedToolCallAttempts(session: SessionState, call: ToolCall): number {
	const targetSignature = buildToolCallSignature(call);
	const toolUseSignatureById = new Map<string, string>();
	let failures = 0;

	for (const message of session.messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "tool_use") {
					toolUseSignatureById.set(
						block.id,
						JSON.stringify({
							name: block.name,
							input: block.input,
						}),
					);
				}
			}
			continue;
		}

		for (const block of message.content) {
			if (block.type !== "tool_result" || !block.isError) {
				continue;
			}

			if (toolUseSignatureById.get(block.toolUseId) === targetSignature) {
				failures += 1;
			}
		}
	}

	return failures;
}

/**
 * Phase 1 内存态 Agent Runtime。
 * 它先固定 Claude Code 风格的会话循环，再逐步替换存储和工作区后端。
 */
export class MemoryAgentRuntime implements AgentRuntime {
	private readonly sessionStore: SessionStore;
	private readonly workspace: Workspace;
	private readonly skillProvider: SkillProvider;
	private readonly dispatcher: ToolDispatcher;
	private readonly transcriptStore: TranscriptStore;
	private readonly subagentStore: SubagentStore;
	private readonly todoMemoryStore: TodoMemoryStore;
	private readonly subagentRunner: SubagentRunner;
	private readonly controllers = new Map<string, SessionController>();
	private readonly hasStateExec: boolean;

	/**
	 * @param deps runtime 依赖
	 */
	constructor(private readonly deps: RuntimeDependencies) {
		this.sessionStore = deps.sessionStore ?? new InMemorySessionStore();
		this.transcriptStore = deps.transcriptStore ?? new InMemoryTranscriptStore();
		this.subagentStore = deps.subagentStore ?? new InMemorySubagentStore();
		this.todoMemoryStore = deps.todoMemoryStore ?? new InMemoryTodoMemoryStore();
		this.workspace = deps.workspace ?? new InMemoryWorkspace("phase-1-runtime");
		this.skillProvider = deps.skillProvider ?? new InMemorySkillProvider();
		const tools = deps.tools ?? DEFAULT_TOOLS;
		this.hasStateExec = Boolean(deps.stateExecutor) && tools.some((tool) => tool.name === "state_exec");
		this.dispatcher = new ToolDispatcher(tools);
		this.subagentRunner = new SubagentRunner({
			aiClient: deps.aiClient,
			subagentStore: this.subagentStore,
			tools,
			buildSystemPrompt: async () =>
				this.buildSubagentSystemPrompt(),
			createToolContext: (sessionId) => this.createToolContext(sessionId, false),
			emit: (event) => {
				const controller = this.controllers.get(event.sessionId);
				controller?.push(event);
			},
		});
	}

	/**
	 * 启动新会话
	 * @param input 启动参数
	 * @returns 会话句柄
	 */
	async startSession(input: StartSessionInput): Promise<SessionHandle> {
		const id = input.sessionId ?? nanoid();
		const now = new Date().toISOString();
		const session: SessionState = {
			id,
			mode: input.mode ?? "normal",
			config: {
				...DEFAULT_SESSION_CONFIG,
				...input.config,
			},
			messages: [],
			todos: [],
			tasks: [],
			todoIdleTurns: 0,
			createdAt: now,
			updatedAt: now,
		};

		await this.sessionStore.save(session);
		const controller = createSessionController();
		this.controllers.set(id, controller);
		controller.push(this.createEvent(id, "session_started"));
		return {
			id,
			events: controller.stream,
		};
	}

	/**
	 * 恢复会话
	 * @param sessionId 会话 id
	 * @returns 会话句柄
	 */
	async resumeSession(sessionId: string): Promise<SessionHandle> {
		const session = await this.requireSession(sessionId);
		let controller = this.controllers.get(session.id);
		if (!controller) {
			controller = createSessionController();
			this.controllers.set(session.id, controller);
		}

		return {
			id: session.id,
			events: controller.stream,
		};
	}

	/**
	 * 发送用户消息并驱动工具闭环
	 * @param sessionId 会话 id
	 * @param content 用户消息
	 */
	async sendUserMessage(sessionId: string, content: string): Promise<void> {
		let session = await this.requireSession(sessionId);
		const controller = this.requireController(sessionId);

		session = this.appendMessage(session, "user", [{ type: "text", text: content }]);
		await this.sessionStore.save(session);

		for (let turn = 0; turn < session.config.maxTurnsPerMessage; turn += 1) {
			session = await this.requireSession(sessionId);
			session = {
				...session,
				messages: microCompactMessages(session.messages),
			};
			const compacted = await autoCompactSession(session, {
				aiClient: this.deps.aiClient,
				transcriptStore: this.transcriptStore,
			});
			session = compacted.session;

			if (compacted.compacted) {
				controller.push(
					this.createEvent(sessionId, "compact", {
						reason: "auto",
						summary: session.compactSummary,
						transcriptRef: session.transcriptRef,
					}),
				);
				await this.sessionStore.save(session);
			}

			const systemPrompt = await this.buildSystemPrompt(session);
			const result = await this.deps.aiClient.generateTurn({
				systemPrompt,
				messages: session.messages,
				tools: this.listAvailableToolSchemas(session),
				config: session.config,
				modelRole: "main",
			});

			if (result.stopReason === "tool_use" && result.content.length === 0) {
				throw new Error("Model returned tool_use without any tool blocks");
			}

			session = this.appendMessage(session, "assistant", result.content);
			await this.sessionStore.save(session);

			if (result.stopReason !== "tool_use") {
				controller.push(
					this.createEvent(sessionId, "assistant_message", {
						content: result.content,
					}),
				);
				return;
			}

			const toolBlocks = result.content.filter((block) => block.type === "tool_use");
			for (const block of toolBlocks) {
				const failedAttempts = countFailedToolCallAttempts(session, {
					id: block.id,
					name: block.name,
					input: block.input,
				});
				const toolResult = await this.invokeTool(sessionId, {
					id: block.id,
					name: block.name,
					input: block.input,
				});

				session = await this.requireSession(sessionId);
				session = this.appendMessage(session, "user", [
					{
						type: "tool_result",
						toolUseId: toolResult.toolUseId,
						content: toolResult.content,
						isError: toolResult.isError,
					},
				]);
				await this.sessionStore.save(session);

				controller.push(
					this.createEvent(sessionId, "tool_result", {
						name: toolResult.name,
						content: toolResult.content,
						isError: toolResult.isError ?? false,
					}),
				);

				if (toolResult.isError) {
					const reminder = buildToolFailureReminder(
						{
							id: block.id,
							name: block.name,
							input: block.input,
						},
						toolResult,
						failedAttempts + 1,
					);
					session = this.appendRuntimeReminder(session, reminder.content);
					await this.sessionStore.save(session);
				}

				if (toolResult.meta?.action === "compact") {
					const manualCompact = await compactSession(
						session,
						{
							aiClient: this.deps.aiClient,
							transcriptStore: this.transcriptStore,
						},
						"manual",
					);
					session = manualCompact.session;
					await this.sessionStore.save(session);
					controller.push(
						this.createEvent(sessionId, "compact", {
							reason: "manual",
							summary: session.compactSummary,
							transcriptRef: session.transcriptRef,
						}),
					);
				}
			}

			session = await this.requireSession(sessionId);
			if (hasOpenTodos(session.todos)) {
				const idleTurns = session.todoIdleTurns + 1;
				session = {
					...session,
					todoIdleTurns: idleTurns,
				};

				if (idleTurns >= TODO_NAG_THRESHOLD) {
					session = this.appendRuntimeReminder(session, buildTodoIdleReminder().content);
				}
			}

			await this.sessionStore.save(session);
		}

		controller.push(
			this.createEvent(sessionId, "error", {
				message: "Reached max turns per message",
			}),
		);
	}

	/**
	 * 直接执行单个工具
	 * @param sessionId 会话 id
	 * @param call 工具调用
	 * @returns 工具结果
	 */
	async invokeTool(sessionId: string, call: ToolCall): Promise<ToolResult> {
		try {
			const session = await this.requireSession(sessionId);
			if (!this.isToolAllowedForSession(session, call.name)) {
				return {
					toolUseId: call.id,
					name: call.name,
					content: `Tool ${call.name} is not available while session mode is ${session.mode}`,
					isError: true,
				};
			}
			return await this.dispatcher.execute(call, this.createToolContext(sessionId, true));
		} catch (error) {
			return {
				toolUseId: call.id,
				name: call.name,
				content: error instanceof Error ? error.message : "Unknown tool error",
				isError: true,
			};
		}
	}

	/**
	 * 同步执行 subagent
	 * @param sessionId 会话 id
	 * @param prompt 子任务 prompt
	 * @param options 可选参数
	 * @returns 子任务摘要和元信息
	 */
	async runSubagent(
		sessionId: string,
		prompt: string,
		options?: { description?: string },
	): Promise<SubagentResult> {
		await this.requireSession(sessionId);
		return this.subagentRunner.runSync(sessionId, prompt, options);
	}

	/**
	 * 创建异步子任务骨架
	 * @param sessionId 会话 id
	 * @param prompt 子任务 prompt
	 * @param options 可选参数
	 * @returns queued job
	 */
	async startSubagent(
		sessionId: string,
		prompt: string,
		options?: { description?: string },
	): Promise<SubagentJob> {
		await this.requireSession(sessionId);
		return this.subagentRunner.startAsync(sessionId, prompt, options);
	}

	/**
	 * 读取单个 subagent job
	 * @param jobId 子任务 id
	 * @returns 子任务对象
	 */
	async getSubagentJob(jobId: string): Promise<SubagentJob | null> {
		return this.subagentStore.getJob(jobId);
	}

	/**
	 * 列出会话下的全部 subagent jobs
	 * @param sessionId 会话 id
	 * @returns 子任务列表
	 */
	async listSubagentJobs(sessionId: string): Promise<SubagentJob[]> {
		return this.subagentStore.listJobsForSession(sessionId);
	}

	/**
	 * 关闭会话
	 * @param sessionId 会话 id
	 */
	async shutdownSession(sessionId: string): Promise<void> {
		const session = await this.requireSession(sessionId);
		await this.sessionStore.save({
			...session,
			closedAt: new Date().toISOString(),
		});

		const controller = this.requireController(sessionId);
		controller.push(this.createEvent(sessionId, "session_ended"));
		controller.close();
		this.controllers.delete(sessionId);
	}

	/**
	 * 暴露当前会话快照，供测试与后续接线使用。
	 * @param sessionId 会话 id
	 * @returns 会话状态
	 */
	async getSession(sessionId: string): Promise<SessionState> {
		return this.requireSession(sessionId);
	}

	/**
	 * 列出全部会话快照。
	 * 主要给 Worker API 和前端 sidebar 恢复最近会话用。
	 * @returns 会话列表
	 */
	async listSessions(): Promise<SessionState[]> {
		return this.sessionStore.list();
	}

	/**
	 * 列出工作区目录的直接子节点。
	 * @param sessionId 会话 id
	 * @param path 目录路径
	 * @returns 文件节点列表
	 */
	async listWorkspace(sessionId: string, path = "/") {
		await this.requireSession(sessionId);
		return this.workspace.files.list(path);
	}

	/**
	 * 读取工作区文本文件。
	 * @param sessionId 会话 id
	 * @param path 文件路径
	 * @returns 文件读取结果
	 */
	async readWorkspaceFile(sessionId: string, path: string) {
		await this.requireSession(sessionId);
		return this.workspace.files.readFile(path);
	}

	/**
	 * 写入工作区文本文件。
	 * @param sessionId 会话 id
	 * @param path 文件路径
	 * @param content 文件内容
	 */
	async writeWorkspaceFile(sessionId: string, path: string, content: string): Promise<void> {
		await this.requireSession(sessionId);
		if (path === "/") {
			throw new Error("path must point to a file, not the workspace root");
		}
		await this.workspace.files.writeFile(path, content);
	}

	/**
	 * 在工作区中创建目录。
	 * @param sessionId 会话 id
	 * @param path 目录路径
	 */
	async createWorkspaceDirectory(sessionId: string, path: string): Promise<void> {
		await this.requireSession(sessionId);
		if (path === "/") {
			return;
		}
		await this.workspace.files.mkdir(path);
	}

	/**
	 * 检查工作区路径是否存在。
	 * @param sessionId 会话 id
	 * @param path 文件或目录路径
	 * @returns 是否存在
	 */
	async workspaceExists(sessionId: string, path: string): Promise<boolean> {
		await this.requireSession(sessionId);
		return this.workspace.files.exists(path);
	}

	/**
	 * 复制工作区中的文件或目录。
	 * @param sessionId 会话 id
	 * @param from 源路径
	 * @param to 目标路径
	 */
	async copyWorkspaceEntry(sessionId: string, from: string, to: string): Promise<void> {
		await this.requireSession(sessionId);
		await this.workspace.files.copy(from, to);
	}

	/**
	 * 移动工作区中的文件或目录。
	 * `rename` 语义也统一走这里，避免在 runtime 内再拆一层概念。
	 * @param sessionId 会话 id
	 * @param from 源路径
	 * @param to 目标路径
	 */
	async moveWorkspaceEntry(sessionId: string, from: string, to: string): Promise<void> {
		await this.requireSession(sessionId);
		await this.workspace.files.move(from, to);
	}

	/**
	 * 删除工作区中的文件或目录。
	 * @param sessionId 会话 id
	 * @param path 目标路径
	 */
	async deleteWorkspaceEntry(sessionId: string, path: string): Promise<void> {
		await this.requireSession(sessionId);
		await this.workspace.files.remove(path);
	}

	/**
	 * 构建 system prompt。
	 * 这里把 skill 摘要和摘要压缩结果一起串进 prompt，保持模型输入稳定。
	 * @param session 当前会话
	 * @returns system prompt 文本
	 */
	private async buildSystemPrompt(session: SessionState): Promise<string> {
		const skills = await this.skillProvider.list();
		const rememberedTodos = session.todos.length === 0
			? await this.todoMemoryStore.loadLatestTodos(session.id)
			: null;
		return composeMainSystemPrompt({
			customPrompt: session.config.systemPrompt,
			skills,
			hasStatePrompt: this.hasStateExec,
			renderedStatePrompt: RENDERED_STATE_SYSTEM_PROMPT,
			session,
			rememberedTodos,
		});
	}

	/**
	 * 构建 subagent system prompt。
	 * 语义上仍复用 skill 摘要，但会明确这是一个 fresh-context 的子执行器。
	 * @returns 子 agent system prompt
	 */
	private async buildSubagentSystemPrompt(): Promise<string> {
		const skills = await this.skillProvider.list();
		return composeSubagentSystemPrompt({
			skills,
			hasStatePrompt: this.hasStateExec,
			renderedStatePrompt: RENDERED_STATE_SYSTEM_PROMPT,
		});
	}

	/**
	 * 根据当前会话模式列出可用工具 schema。
	 * @param session 当前会话
	 * @returns 当前可见工具 schema
	 */
	private listAvailableToolSchemas(session: SessionState) {
		if (session.mode !== "plan") {
			return this.dispatcher.listSchemas();
		}

		return this.dispatcher
			.listSchemas()
			.filter((schema) => PLAN_MODE_ALLOWED_TOOL_NAMES.has(schema.name));
	}

	/**
	 * 创建工具上下文
	 * @param sessionId 会话 id
	 * @returns 工具上下文
	 */
	private createToolContext(sessionId: string, allowSubagentApis: boolean): DefaultToolContext {
		let snapshot: SessionState | null = null;
		return {
			workspace: this.workspace,
			skills: this.skillProvider,
			getSession: async () => {
				if (snapshot) {
					return snapshot;
				}
				snapshot = await this.requireSession(sessionId);
				return snapshot;
			},
			updateSession: async (updater) => {
				const current = await this.requireSession(sessionId);
				snapshot = current;
				const next = {
					...updater(current),
					updatedAt: new Date().toISOString(),
				};
				snapshot = next;
				await this.sessionStore.save(next);
			},
			saveTodoMemory: async (todos) => {
				await this.todoMemoryStore.saveLatestTodos(sessionId, todos);
			},
			loadTodoMemory: async () => this.todoMemoryStore.loadLatestTodos(sessionId),
			runSubagent: allowSubagentApis
				? async (prompt, options) => this.runSubagent(sessionId, prompt, options)
				: undefined,
			startSubagent: allowSubagentApis
				? async (prompt, options) => this.startSubagent(sessionId, prompt, options)
				: undefined,
			getSubagentJob: allowSubagentApis
				? async (jobId) => this.getSubagentJob(jobId)
				: undefined,
			listSubagentJobs: allowSubagentApis
				? async () => this.listSubagentJobs(sessionId)
				: undefined,
			executeState: this.deps.stateExecutor
				? async (code) => this.deps.stateExecutor!.execute(code)
				: undefined,
			runPrompt: async (input) => {
				const response = await this.deps.aiClient.generateTurn({
					systemPrompt: input.systemPrompt ?? "",
					messages: [
						{
							id: nanoid(),
							role: "user",
							content: [{ type: "text", text: input.prompt }],
							createdAt: new Date().toISOString(),
						},
					],
					tools: [],
					config: {
						systemPrompt: "",
						tokenThreshold: Number.MAX_SAFE_INTEGER,
						maxTurnsPerMessage: 1,
					},
					modelRole: input.modelRole ?? "main",
				});
				if (response.stopReason === "tool_use") {
					throw new Error("Prompt-only inference must not request tools");
				}

				return response.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n")
					.trim();
			},
			webFetch: this.deps.webFetch,
		};
	}

	/**
	 * 判断当前会话模式下是否允许调用某个工具。
	 * @param session 当前会话
	 * @param toolName 工具名称
	 * @returns 是否允许
	 */
	private isToolAllowedForSession(session: SessionState, toolName: string): boolean {
		if (session.mode !== "plan") {
			return true;
		}

		return PLAN_MODE_ALLOWED_TOOL_NAMES.has(toolName);
	}

	/**
	 * 读取会话并校验存在性
	 * @param sessionId 会话 id
	 * @returns 会话状态
	 */
	private async requireSession(sessionId: string): Promise<SessionState> {
		const session = await this.sessionStore.load(sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		return session;
	}

	/**
	 * 读取事件控制器
	 * @param sessionId 会话 id
	 * @returns 控制器
	 */
	private requireController(sessionId: string): SessionController {
		const controller = this.controllers.get(sessionId);
		if (controller) {
			return controller;
		}

		// Worker API 以无状态 HTTP 请求驱动 runtime 时，请求可能落到新的实例上。
		// 这时 session 已经持久化在 store 里，但内存事件控制器不会随之恢复。
		// 由于当前 HTTP 主链路并不依赖历史事件流重放，因此这里按需重建 controller，
		// 优先保证同一 session 的后续消息和工具循环可以继续执行。
		const nextController = createSessionController();
		this.controllers.set(sessionId, nextController);
		return nextController;
	}

	/**
	 * 追加一条会话消息
	 * @param session 会话
	 * @param role 角色
	 * @param content 内容块
	 * @returns 新会话
	 */
	private appendMessage(session: SessionState, role: Message["role"], content: Message["content"]): SessionState {
		return {
			...session,
			messages: [
				...session.messages,
				{
					id: nanoid(),
					role,
					content,
					createdAt: new Date().toISOString(),
				},
			],
			updatedAt: new Date().toISOString(),
		};
	}

	/**
	 * 追加 runtime 内部 system reminder。
	 * 为避免 reminder 在连续多轮里无限重复，这里对“最后一条同文案 system message”做最小去重。
	 * @param session 当前会话
	 * @param reminder reminder 文本
	 * @returns 更新后的会话
	 */
	private appendRuntimeReminder(session: SessionState, reminder: string): SessionState {
		const lastSystemMessage = [...session.messages]
			.reverse()
			.find(
				(message) =>
					message.role === "system" &&
					message.content.length === 1 &&
					message.content[0]?.type === "text",
			);
		const lastText =
			lastSystemMessage?.role === "system" && lastSystemMessage.content[0]?.type === "text"
				? lastSystemMessage.content[0].text
				: null;

		if (lastText === reminder) {
			return session;
		}

		return this.appendMessage(session, "system", [
			{
				type: "text",
				text: reminder,
			},
		]);
	}

	/**
	 * 创建标准事件对象
	 * @param sessionId 会话 id
	 * @param type 事件类型
	 * @param payload 事件载荷
	 * @returns 标准事件
	 */
	private createEvent(
		sessionId: string,
		type: AgentEvent["type"],
		payload?: Record<string, unknown>,
	): AgentEvent {
		return {
			type,
			sessionId,
			timestamp: new Date().toISOString(),
			payload,
		};
	}
}
