import { nanoid } from "nanoid";
import { ToolDispatcher } from "./tool-dispatcher";
import type { DefaultToolContext, RuntimeTool } from "../tools";
import type {
	AIClient,
	AgentEvent,
	AssistantBlock,
	Message,
	SessionConfig,
	SubagentJob,
	SubagentResult,
	SubagentStore,
	ToolCall,
} from "../types";

/** 子 agent 最大回合数 */
const DEFAULT_SUBAGENT_MAX_TURNS = 24;

/** 子 agent 可见工具名 */
export const SUBAGENT_TOOL_NAMES = new Set([
	"read_file",
	"write_file",
	"list_files",
	"load_skill",
	"list_skill_files",
	"read_skill_file",
	"TodoWrite",
	"state_exec",
	"task_create",
	"task_list",
	"task_get",
	"task_update",
	"compact",
]);

/** SubagentRunner 依赖 */
export interface SubagentRunnerDependencies {
	/** AI 客户端 */
	aiClient: AIClient;
	/** 子任务存储 */
	subagentStore: SubagentStore;
	/** 全量工具 */
	tools: RuntimeTool[];
	/** 构建子 agent prompt */
	buildSystemPrompt(): Promise<string>;
	/** 创建共享工具上下文 */
	createToolContext(sessionId: string): DefaultToolContext;
	/** 事件发射 */
	emit(event: AgentEvent): void;
}

/**
 * 从 assistant 内容块中提取最终可读摘要。
 * @param content assistant 输出块
 * @returns 汇总后的文本
 */
function extractSummary(content: AssistantBlock[]): string {
	const summary = content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();

	return summary || "(no summary)";
}

/**
 * 一次性 subagent 执行器。
 * 负责 fresh context 子会话、过滤工具、摘要回传和 job 状态更新。
 */
export class SubagentRunner {
	private readonly dispatcher: ToolDispatcher;

	/**
	 * @param deps 子任务依赖
	 */
	constructor(private readonly deps: SubagentRunnerDependencies) {
		this.dispatcher = new ToolDispatcher(
			deps.tools.filter((tool) => SUBAGENT_TOOL_NAMES.has(tool.name)),
		);
	}

	/**
	 * 同步执行一个 subagent
	 * @param sessionId 父会话 id
	 * @param prompt 子任务 prompt
	 * @param options 可选参数
	 * @returns 子任务摘要和元信息
	 */
	async runSync(
		sessionId: string,
		prompt: string,
		options?: { description?: string; config?: Pick<SessionConfig, "maxTurnsPerMessage"> },
	): Promise<SubagentResult> {
		const now = new Date().toISOString();
		const job: SubagentJob = {
			id: nanoid(),
			sessionId,
			mode: "sync",
			description: options?.description,
			prompt,
			status: "running",
			turnCount: 0,
			messageCount: 1,
			createdAt: now,
			updatedAt: now,
		};
		await this.deps.subagentStore.createJob(job);
		this.deps.emit({
			type: "subagent_started",
			sessionId,
			timestamp: now,
			payload: {
				jobId: job.id,
				description: job.description,
			},
		});

		try {
			const result = await this.executeLoop(sessionId, prompt, options?.config?.maxTurnsPerMessage);
			const completedJob: SubagentJob = {
				...job,
				status: "completed",
				summary: result.summary,
				turnCount: result.turnCount,
				messageCount: result.messageCount,
				updatedAt: new Date().toISOString(),
			};
			await this.deps.subagentStore.updateJob(completedJob);
			this.deps.emit({
				type: "subagent_finished",
				sessionId,
				timestamp: completedJob.updatedAt,
				payload: {
					jobId: completedJob.id,
					turnCount: completedJob.turnCount,
					messageCount: completedJob.messageCount,
				},
			});
			return {
				...result,
				jobId: completedJob.id,
			};
		} catch (error) {
			const failedJob: SubagentJob = {
				...job,
				status: "failed",
				error: error instanceof Error ? error.message : "Unknown subagent error",
				updatedAt: new Date().toISOString(),
			};
			await this.deps.subagentStore.updateJob(failedJob);
			this.deps.emit({
				type: "subagent_failed",
				sessionId,
				timestamp: failedJob.updatedAt,
				payload: {
					jobId: failedJob.id,
					error: failedJob.error,
				},
			});
			throw error;
		}
	}

	/**
	 * 创建异步子任务骨架
	 * @param sessionId 父会话 id
	 * @param prompt 子任务 prompt
	 * @param options 可选参数
	 * @returns 新创建的 queued job
	 */
	async startAsync(
		sessionId: string,
		prompt: string,
		options?: { description?: string },
	): Promise<SubagentJob> {
		const now = new Date().toISOString();
		const job: SubagentJob = {
			id: nanoid(),
			sessionId,
			mode: "async",
			description: options?.description,
			prompt,
			status: "queued",
			turnCount: 0,
			messageCount: 0,
			createdAt: now,
			updatedAt: now,
		};
		await this.deps.subagentStore.createJob(job);
		return job;
	}

	/**
	 * 执行子会话工具循环
	 * @param sessionId 父会话 id
	 * @param prompt 子任务 prompt
	 * @param maxTurns 可选最大回合数
	 * @returns 摘要和元信息
	 */
	private async executeLoop(
		sessionId: string,
		prompt: string,
		maxTurns = DEFAULT_SUBAGENT_MAX_TURNS,
	): Promise<SubagentResult> {
		const messages: Message[] = [
			{
				id: nanoid(),
				role: "user",
				content: [{ type: "text", text: prompt }],
				createdAt: new Date().toISOString(),
			},
		];

		let finalContent: AssistantBlock[] = [{ type: "text", text: "(no summary)" }];
		for (let turn = 0; turn < maxTurns; turn += 1) {
			const response = await this.deps.aiClient.generateTurn({
				systemPrompt: await this.deps.buildSystemPrompt(),
				messages,
				tools: this.dispatcher.listSchemas(),
				config: {
					systemPrompt: "",
					tokenThreshold: Number.MAX_SAFE_INTEGER,
					maxTurnsPerMessage: 1,
				},
			});
			finalContent = response.content;
			messages.push({
				id: nanoid(),
				role: "assistant",
				content: response.content,
				createdAt: new Date().toISOString(),
			});

			if (response.stopReason !== "tool_use") {
				return {
					summary: extractSummary(response.content),
					turnCount: turn + 1,
					messageCount: messages.length,
				};
			}

			const toolBlocks = response.content.filter((block) => block.type === "tool_use");
			if (toolBlocks.length === 0) {
				throw new Error("Protocol error: subagent returned tool_use without calls");
			}

			const results = [];
			for (const block of toolBlocks) {
				const result = await this.dispatcher.execute(
					{
						id: block.id,
						name: block.name,
						input: block.input,
					} as ToolCall,
					this.deps.createToolContext(sessionId),
				);
				results.push({
					type: "tool_result" as const,
					toolUseId: result.toolUseId,
					content: result.content,
					isError: result.isError,
				});
			}

			messages.push({
				id: nanoid(),
				role: "user",
				content: results,
				createdAt: new Date().toISOString(),
			});
		}

		return {
			summary: extractSummary(finalContent),
			turnCount: maxTurns,
			messageCount: messages.length,
		};
	}
}
