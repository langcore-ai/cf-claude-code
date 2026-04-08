import type { z } from "zod";

/** 会话内可用的消息角色 */
export type MessageRole = "system" | "user" | "assistant";

/** 普通文本内容块 */
export interface TextBlock {
	/** 内容块类型 */
	type: "text";
	/** 文本内容 */
	text: string;
}

/** 模型发起的工具调用块 */
export interface ToolUseBlock {
	/** 内容块类型 */
	type: "tool_use";
	/** 工具调用唯一标识 */
	id: string;
	/** 工具名称 */
	name: string;
	/** 工具输入参数 */
	input: Record<string, unknown>;
}

/** 工具执行结果块 */
export interface ToolResultBlock {
	/** 内容块类型 */
	type: "tool_result";
	/** 对应的工具调用 id */
	toolUseId: string;
	/** 工具结果文本 */
	content: string;
	/** 是否为错误 */
	isError?: boolean;
}

/** assistant 可输出的内容块 */
export type AssistantBlock = TextBlock | ToolUseBlock;

/** 会话消息块 */
export type MessageBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/** Runtime 内部消息模型 */
export interface Message {
	/** 消息唯一标识 */
	id: string;
	/** 消息角色 */
	role: MessageRole;
	/** 消息内容块 */
	content: MessageBlock[];
	/** 创建时间戳 */
	createdAt: string;
}

/** Tool schema 的简化定义 */
export interface ToolSchema {
	/** 工具名称 */
	name: string;
	/** 工具说明 */
	description: string;
	/** Zod 风格的输入定义 */
	inputSchema: z.ZodTypeAny;
	/** 可选的 AI SDK 官方工具对象；仅在 adapter 边界使用 */
	sdkTool?: unknown;
}

/** runtime 内部模型角色 */
export type ModelRole = "main" | "compact" | "subagent" | "lightweight";

/** 一次工具调用请求 */
export interface ToolCall {
	/** 工具调用唯一标识 */
	id: string;
	/** 工具名称 */
	name: string;
	/** 工具输入 */
	input: Record<string, unknown>;
}

/** 一次工具调用结果 */
export interface ToolResult {
	/** 对应工具调用 id */
	toolUseId: string;
	/** 工具名称 */
	name: string;
	/** 返回文本 */
	content: string;
	/** 是否执行失败 */
	isError?: boolean;
	/** 额外结构化元数据 */
	meta?: Record<string, unknown>;
}

/** 模型停机原因 */
export type StopReason = "end_turn" | "tool_use" | "max_turns" | "error";

/** 模型调用输入 */
export interface GenerateTurnInput {
	/** 当前 system prompt */
	systemPrompt: string;
	/** 当前消息历史 */
	messages: Message[];
	/** 当前可用工具 */
	tools: ToolSchema[];
	/** 当前会话配置 */
	config: SessionConfig;
	/** 当前调用使用的模型角色 */
	modelRole?: ModelRole;
}

/** 模型返回结果 */
export interface ModelTurnResult {
	/** assistant 输出块 */
	content: AssistantBlock[];
	/** 停机原因 */
	stopReason: StopReason;
	/** 可选 usage 信息 */
	usage?: {
		/** 输入 token 数 */
		inputTokens?: number;
		/** 输出 token 数 */
		outputTokens?: number;
		/** 总 token 数 */
		totalTokens?: number;
	};
}

/** Session 运行配置 */
export interface SessionConfig {
	/** 基础 system prompt */
	systemPrompt: string;
	/** 触发自动压缩的粗粒度阈值 */
	tokenThreshold: number;
	/** 单条用户消息允许的最大模型循环轮数 */
	maxTurnsPerMessage: number;
}

/** 会话运行模式 */
export type SessionMode = "normal" | "plan";

/** 启动会话时的输入 */
export interface StartSessionInput {
	/** 会话 id；不传则自动生成 */
	sessionId?: string;
	/** 会话模式；默认 normal */
	mode?: SessionMode;
	/** 会话配置 */
	config: SessionConfig;
}

/** Todo 状态 */
export type TodoStatus = "pending" | "in_progress" | "completed";
/** Todo 优先级 */
export type TodoPriority = "high" | "medium" | "low";

/** Todo 项 */
export interface TodoItem {
	/** Todo 唯一标识 */
	id: string;
	/** 条目内容 */
	content: string;
	/** 当前状态 */
	status: TodoStatus;
	/** 可选优先级 */
	priority?: TodoPriority;
	/** 进行中任务的主动描述 */
	activeForm?: string;
}

/** 最小 task 状态 */
export type TaskStatus = "open" | "in_progress" | "done";

/** subagent 执行模式 */
export type SubagentMode = "sync" | "async";

/** subagent 任务状态 */
export type SubagentStatus = "queued" | "running" | "completed" | "failed";

/** 最小 task 实体 */
export interface RuntimeTask {
	/** 任务唯一标识 */
	id: string;
	/** 标题 */
	title: string;
	/** 描述 */
	description?: string;
	/** 状态 */
	status: TaskStatus;
	/** 当前任务被哪些任务阻塞 */
	blockedBy: string[];
	/** 当前任务会阻塞哪些任务 */
	blocks: string[];
	/** 创建时间 */
	createdAt: string;
	/** 更新时间 */
	updatedAt: string;
}

/** subagent 任务记录 */
export interface SubagentJob {
	/** 子任务唯一标识 */
	id: string;
	/** 所属会话 id */
	sessionId: string;
	/** 执行模式 */
	mode: SubagentMode;
	/** 简短描述 */
	description?: string;
	/** 原始 prompt */
	prompt: string;
	/** 当前状态 */
	status: SubagentStatus;
	/** 子任务摘要 */
	summary?: string;
	/** 错误信息 */
	error?: string;
	/** 子任务回合数 */
	turnCount: number;
	/** 子任务消息数 */
	messageCount: number;
	/** 创建时间 */
	createdAt: string;
	/** 更新时间 */
	updatedAt: string;
}

/** subagent 执行结果 */
export interface SubagentResult {
	/** 文本摘要 */
	summary: string;
	/** 子会话回合数 */
	turnCount: number;
	/** 子会话消息数 */
	messageCount: number;
	/** 子任务 id */
	jobId?: string;
}

/** 会话状态 */
export interface SessionState {
	/** 会话唯一标识 */
	id: string;
	/** 会话运行模式 */
	mode: SessionMode;
	/** 会话配置 */
	config: SessionConfig;
	/** 消息历史 */
	messages: Message[];
	/** 当前 todo 列表 */
	todos: TodoItem[];
	/** 当前 task 列表 */
	tasks: RuntimeTask[];
	/** 已压缩摘要 */
	compactSummary?: string;
	/** transcript 外部引用 */
	transcriptRef?: string;
	/** 连续未更新 todo 的轮数 */
	todoIdleTurns: number;
	/** 当前是否已关闭 */
	closedAt?: string;
	/** 会话创建时间 */
	createdAt: string;
	/** 会话更新时间 */
	updatedAt: string;
}

/** 对外暴露的会话句柄 */
export interface SessionHandle {
	/** 会话 id */
	id: string;
	/** 会话事件流 */
	events: AsyncIterable<AgentEvent>;
}

/** 事件类型 */
export type AgentEventType =
	| "session_started"
	| "assistant_message"
	| "tool_result"
	| "compact"
	| "subagent_started"
	| "subagent_finished"
	| "subagent_failed"
	| "error"
	| "session_ended";

/** Runtime 事件 */
export interface AgentEvent {
	/** 事件类型 */
	type: AgentEventType;
	/** 会话 id */
	sessionId: string;
	/** 事件时间 */
	timestamp: string;
	/** 事件载荷 */
	payload?: Record<string, unknown>;
}

/** 模型客户端 */
export interface AIClient {
	/**
	 * 生成一轮模型输出
	 * @param input 模型输入
	 * @returns 标准化后的模型输出
	 */
	generateTurn(input: GenerateTurnInput): Promise<ModelTurnResult>;
}

/** Session 存储接口 */
export interface SessionStore {
	/**
	 * 保存会话
	 * @param session 会话状态
	 */
	save(session: SessionState): Promise<void>;
	/**
	 * 获取会话
	 * @param sessionId 会话 id
	 * @returns 会话状态；不存在时返回 null
	 */
	load(sessionId: string): Promise<SessionState | null>;
	/**
	 * 列出全部会话快照。
	 * 默认按更新时间倒序返回，方便前端优先恢复最近一次会话。
	 */
	list(): Promise<SessionState[]>;
	/**
	 * 删除会话
	 * @param sessionId 会话 id
	 */
	delete(sessionId: string): Promise<void>;
}

/** Todo 短期记忆存储接口 */
export interface TodoMemoryStore {
	/**
	 * 保存最近一次非空 Todo 快照
	 * @param sessionId 会话 id
	 * @param todos Todo 列表
	 */
	saveLatestTodos(sessionId: string, todos: TodoItem[]): Promise<void>;
	/**
	 * 读取最近一次 Todo 快照
	 * @param sessionId 会话 id
	 * @returns Todo 列表；不存在时返回 null
	 */
	loadLatestTodos(sessionId: string): Promise<TodoItem[] | null>;
}

/** Task 独立持久化存储接口 */
export interface TaskStore {
	/**
	 * 保存会话当前 task 快照
	 * @param sessionId 会话 id
	 * @param tasks task 列表
	 */
	saveTasks(sessionId: string, tasks: RuntimeTask[]): Promise<void>;
	/**
	 * 读取会话当前 task 快照
	 * @param sessionId 会话 id
	 * @returns task 列表；不存在时返回 null
	 */
	loadTasks(sessionId: string): Promise<RuntimeTask[] | null>;
	/**
	 * 删除会话的 task 快照
	 * @param sessionId 会话 id
	 */
	deleteTasks(sessionId: string): Promise<void>;
}

/** Subagent 任务存储接口 */
export interface SubagentStore {
	/**
	 * 创建一个子任务
	 * @param job 子任务对象
	 */
	createJob(job: SubagentJob): Promise<void>;
	/**
	 * 获取单个子任务
	 * @param jobId 子任务 id
	 * @returns 子任务；不存在时返回 null
	 */
	getJob(jobId: string): Promise<SubagentJob | null>;
	/**
	 * 列出会话下的全部子任务
	 * @param sessionId 会话 id
	 * @returns 子任务列表
	 */
	listJobsForSession(sessionId: string): Promise<SubagentJob[]>;
	/**
	 * 更新子任务
	 * @param job 子任务对象
	 */
	updateJob(job: SubagentJob): Promise<void>;
}

/** Agent Runtime 最小接口 */
export interface AgentRuntime {
	/**
	 * 启动新会话
	 * @param input 启动参数
	 */
	startSession(input: StartSessionInput): Promise<SessionHandle>;
	/**
	 * 恢复已存在的会话
	 * @param sessionId 会话 id
	 */
	resumeSession(sessionId: string): Promise<SessionHandle>;
	/**
	 * 发送用户消息并驱动一次最小闭环
	 * @param sessionId 会话 id
	 * @param content 用户消息文本
	 */
	sendUserMessage(sessionId: string, content: string): Promise<void>;
	/**
	 * 直接调用单个工具
	 * @param sessionId 会话 id
	 * @param call 工具调用
	 */
	invokeTool(sessionId: string, call: ToolCall): Promise<ToolResult>;
	/**
	 * 同步执行 subagent
	 * @param sessionId 会话 id
	 * @param prompt 子任务 prompt
	 * @param options 可选参数
	 */
	runSubagent(
		sessionId: string,
		prompt: string,
		options?: { description?: string },
	): Promise<SubagentResult>;
	/**
	 * 创建异步 subagent job 骨架
	 * @param sessionId 会话 id
	 * @param prompt 子任务 prompt
	 * @param options 可选参数
	 */
	startSubagent(
		sessionId: string,
		prompt: string,
		options?: { description?: string },
	): Promise<SubagentJob>;
	/**
	 * 读取单个 subagent job
	 * @param jobId 子任务 id
	 */
	getSubagentJob(jobId: string): Promise<SubagentJob | null>;
	/**
	 * 列出会话下所有 subagent jobs
	 * @param sessionId 会话 id
	 */
	listSubagentJobs(sessionId: string): Promise<SubagentJob[]>;
	/**
	 * 关闭会话
	 * @param sessionId 会话 id
	 */
	shutdownSession(sessionId: string): Promise<void>;
}
