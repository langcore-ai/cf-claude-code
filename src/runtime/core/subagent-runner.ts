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
/** 子 agent 最大连续错误工具调用次数 */
const DEFAULT_SUBAGENT_MAX_CONSECUTIVE_TOOL_ERRORS = 2;
/** 子 agent summary 最大长度 */
const SUBAGENT_SUMMARY_LIMIT = 4_000;
/** 空 summary 的规范化回退文本 */
const EMPTY_SUBAGENT_SUMMARY = "Subagent finished without a usable final summary.";

/** 子 agent 可见工具名 */
export const SUBAGENT_TOOL_NAMES = new Set([
	"read_file",
	"write_file",
	"list_files",
	"glob",
	"grep",
	"edit",
	"multi_edit",
	"WebFetch",
	"WebSearch",
	"TodoWrite",
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

/** 归一化后的 subagent 任务 */
interface NormalizedSubagentTask {
	/** 简短任务描述 */
	description: string;
	/** 子任务 prompt */
	prompt: string;
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

	if (!summary) {
		return EMPTY_SUBAGENT_SUMMARY;
	}

	if (summary.length <= SUBAGENT_SUMMARY_LIMIT) {
		return summary;
	}

	return `${summary.slice(0, SUBAGENT_SUMMARY_LIMIT)}\n... summary truncated`;
}

/**
 * 规范化 subagent 任务输入。
 * @param prompt 原始子任务 prompt
 * @param options 可选参数
 * @returns 归一化后的任务
 */
function normalizeSubagentTask(
	prompt: string,
	options?: { description?: string },
): NormalizedSubagentTask {
	const trimmedPrompt = prompt.trim();
	const fallbackDescription = trimmedPrompt.split(/\s+/).slice(0, 5).join(" ").trim() || "subagent task";
	const description = (options?.description?.trim() || fallbackDescription).slice(0, 80);

	return {
		description,
		prompt: trimmedPrompt,
	};
}

/**
 * 统计当前批次工具结果中的错误数。
 * @param results 当前轮工具结果
 * @returns 错误数量
 */
function countToolErrors(results: Array<{ isError?: boolean }>): number {
	return results.filter((result) => result.isError).length;
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
		const task = normalizeSubagentTask(prompt, options);
		const now = new Date().toISOString();
		const job: SubagentJob = {
			id: nanoid(),
			sessionId,
			mode: "sync",
			description: task.description,
			prompt: task.prompt,
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
			const result = await this.executeLoop(sessionId, task, options?.config?.maxTurnsPerMessage);
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
		const task = normalizeSubagentTask(prompt, options);
		const now = new Date().toISOString();
		const job: SubagentJob = {
			id: nanoid(),
			sessionId,
			mode: "async",
			description: task.description,
			prompt: task.prompt,
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
	 * @param task 归一化后的子任务
	 * @param maxTurns 可选最大回合数
	 * @returns 摘要和元信息
	 */
	private async executeLoop(
		sessionId: string,
		task: NormalizedSubagentTask,
		maxTurns = DEFAULT_SUBAGENT_MAX_TURNS,
	): Promise<SubagentResult> {
		const messages: Message[] = [
			{
				id: nanoid(),
				role: "user",
				content: [{ type: "text", text: task.prompt }],
				createdAt: new Date().toISOString(),
			},
		];

		let finalContent: AssistantBlock[] = [{ type: "text", text: EMPTY_SUBAGENT_SUMMARY }];
		let consecutiveToolErrors = 0;
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
				modelRole: "subagent",
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
				let result;
				try {
					result = await this.dispatcher.execute(
						{
							id: block.id,
							name: block.name,
							input: block.input,
						} as ToolCall,
						this.deps.createToolContext(sessionId),
					);
				} catch (error) {
					result = {
						toolUseId: block.id,
						name: block.name,
						content: error instanceof Error ? error.message : "Unknown subagent tool error",
						isError: true,
					};
				}
				results.push({
					type: "tool_result" as const,
					toolUseId: result.toolUseId,
					content: result.content,
					isError: result.isError,
				});
			}

			const errorCount = countToolErrors(results);
			consecutiveToolErrors = errorCount > 0 ? consecutiveToolErrors + 1 : 0;
			if (consecutiveToolErrors > DEFAULT_SUBAGENT_MAX_CONSECUTIVE_TOOL_ERRORS) {
				throw new Error(`Subagent repeated failing tool calls for task: ${task.description}`);
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
