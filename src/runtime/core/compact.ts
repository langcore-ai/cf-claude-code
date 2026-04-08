import type { TranscriptStore } from "../adapters";
import type { AIClient, Message, SessionConfig, SessionState } from "../types";

/** 微压缩保留的最近工具结果数量 */
const RECENT_TOOL_RESULTS_TO_KEEP = 3;

/** continuity compact 的 system prompt */
const CONTINUITY_COMPACT_SYSTEM_PROMPT =
	"You are Claude Code's continuity summarizer. Produce a precise implementation-focused summary that can be treated as authoritative context for continuing the same task without re-reading the entire conversation.";

/** continuity compact 的 task prompt */
const CONTINUITY_COMPACT_TASK_PROMPT = [
	"Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.",
	"This summary should preserve the current goal, completed work, unfinished work, file/tool context, runtime state, important user corrections, and the next useful step so implementation can continue without losing momentum.",
	"",
	"Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points.",
	"Then emit the final result in <summary> tags.",
	"",
	"Your summary should include the following sections:",
	"1. Current Goal",
	"2. Completed Work",
	"3. Remaining Work",
	"4. Files, Tools, and Evidence",
	"5. Current Runtime State",
	"6. Important User Feedback",
	"7. Risks or Open Questions",
	"8. Optional Next Step",
	"",
	"Be precise and thorough. Include concrete paths, tool names, and constraints when they matter.",
	"Focus on continuity for future implementation work, not on narrative storytelling.",
].join("\n");

/** compact acknowledgement 文本 */
const COMPACT_ACKNOWLEDGEMENT = "Understood. I will continue from the continuity summary.";

/** compact 结果 */
export interface CompactResult {
	/** 新会话 */
	session: SessionState;
	/** 是否发生压缩 */
	compacted: boolean;
	/** 压缩原因 */
	reason?: "auto" | "manual";
}

/** compact 依赖 */
export interface CompactDependencies {
	/** 当前 AI client */
	aiClient: AIClient;
	/** transcript 存储 */
	transcriptStore: TranscriptStore;
}

/**
 * 根据消息体积估算 token。
 * @param messages 消息列表
 * @returns 估算 token 数
 */
export function estimateTokenCount(messages: Message[]): number {
	return Math.ceil(JSON.stringify(messages).length / 4);
}

/**
 * 微压缩：替换较旧的 tool_result 文本，但保留最近若干条完整结果。
 * @param messages 消息列表
 * @returns 压缩后的消息
 */
export function microCompactMessages(messages: Message[]): Message[] {
	const toolNameMap = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "tool_use") {
				toolNameMap.set(block.id, block.name);
			}
		}
	}

	let seen = 0;
	return messages.map((message) => {
		if (message.role !== "user") {
			return message;
		}

		const compactedContent = [...message.content].reverse().map((block) => {
			if (block.type !== "tool_result") {
				return block;
			}

			seen += 1;
			if (seen <= RECENT_TOOL_RESULTS_TO_KEEP) {
				return block;
			}

			const toolName = toolNameMap.get(block.toolUseId) ?? "unknown_tool";
			return {
				...block,
				content: `[Previous: used ${toolName}]`,
			};
		}).reverse();

		return {
			...message,
			content: compactedContent,
		};
	});
}

/**
 * 自动压缩会话。
 * @param session 当前会话
 * @param deps compact 依赖
 * @returns 新会话和压缩结果
 */
export async function autoCompactSession(
	session: SessionState,
	deps: CompactDependencies,
): Promise<CompactResult> {
	if (estimateTokenCount(session.messages) <= session.config.tokenThreshold) {
		return {
			session,
			compacted: false,
		};
	}

	return compactSession(session, deps, "auto");
}

/**
 * 手动 compact 与自动 compact 共用的主链路。
 * @param session 当前会话
 * @param deps compact 依赖
 * @param reason 压缩原因
 * @returns 压缩结果
 */
export async function compactSession(
	session: SessionState,
	deps: CompactDependencies,
	reason: "auto" | "manual",
): Promise<CompactResult> {
	const originalMessages = structuredClone(session.messages);
	const transcriptRef = await deps.transcriptStore.saveTranscript(session.id, originalMessages);
	const summary = await summarizeForContinuity({
		aiClient: deps.aiClient,
		session,
		messages: originalMessages,
		transcriptRef,
	});

	return {
		compacted: true,
		reason,
		session: {
			...session,
			compactSummary: summary,
			transcriptRef,
			messages: createCompactedMessages(transcriptRef, summary),
		},
	};
}

/**
 * 构造 compact 后保留的最小 continuity 消息。
 * @param transcriptRef transcript 引用
 * @param summary continuity summary
 * @returns 替换后的消息数组
 */
export function createCompactedMessages(transcriptRef: string, summary: string): Message[] {
	const now = new Date().toISOString();
	return [
		{
			id: `compact-user-${Date.now()}`,
			role: "user",
			createdAt: now,
			content: [
				{
					type: "text",
					text: [
						`[Conversation compacted. Transcript ref: ${transcriptRef}]`,
						"Treat the following summary as authoritative continuity context.",
						"",
						summary,
					].join("\n"),
				},
			],
		},
		{
			id: `compact-assistant-${Date.now()}`,
			role: "assistant",
			createdAt: now,
			content: [
				{
					type: "text",
					text: COMPACT_ACKNOWLEDGEMENT,
				},
			],
		},
	];
}

/**
 * 调用 AIClient 生成 continuity summary。
 * @param input 摘要输入
 * @returns 摘要文本
 */
export async function summarizeForContinuity(input: {
	aiClient: AIClient;
	session: SessionState;
	messages: Message[];
	transcriptRef: string;
}): Promise<string> {
	const taskLines =
		input.session.tasks.length === 0
			? "No tasks."
			: input.session.tasks
					.map((task) => {
						const blockedBy = task.blockedBy.length > 0 ? ` blockedBy=${task.blockedBy.join(",")}` : "";
						const blocks = task.blocks.length > 0 ? ` blocks=${task.blocks.join(",")}` : "";
						return `- ${task.id} [${task.status}] ${task.title}${blockedBy}${blocks}`;
					})
					.join("\n");
	const todoLines =
		input.session.todos.length === 0
			? "No todos."
			: input.session.todos
					.map((todo) => `- ${todo.id} [${todo.status}] ${todo.content}${todo.activeForm ? ` <- ${todo.activeForm}` : ""}`)
					.join("\n");
	const currentWork =
		input.session.messages
			.slice(-8)
			.map((message) => {
				const text = message.content
					.map((block) => {
						if (block.type === "text") {
							return block.text;
						}
						if (block.type === "tool_use") {
							return `[tool_use:${block.name}] ${JSON.stringify(block.input)}`;
						}
						return `[tool_result${block.isError ? ":error" : ""}] ${block.content}`;
					})
					.join("\n");
				return `${message.role}: ${text}`;
			})
			.join("\n\n") || "No recent messages.";

	const response = await input.aiClient.generateTurn({
		systemPrompt: CONTINUITY_COMPACT_SYSTEM_PROMPT,
		messages: [
			{
				id: `compact-input-${Date.now()}`,
				role: "user",
				createdAt: new Date().toISOString(),
				content: [
					{
						type: "text",
						text: [
							CONTINUITY_COMPACT_TASK_PROMPT,
							"",
							`Transcript ref: ${input.transcriptRef}`,
							`Mode: ${input.session.mode}`,
							`Todos:\n${todoLines}`,
							`Tasks:\n${taskLines}`,
							input.session.compactSummary ? `Previous compact summary:\n${input.session.compactSummary}` : "Previous compact summary: none",
							`Recent work:\n${currentWork}`,
							"Conversation to summarize:",
							serializeMessagesForCompact(input.messages),
						].join("\n\n"),
					},
				],
			},
		],
		tools: [],
		config: createCompactConfig(input.session.config),
		modelRole: "compact",
	});

	if (response.stopReason === "tool_use") {
		throw new Error("Compact summarization must not request tools");
	}

	const summary = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();

	return extractCompactSummary(summary) || "No summary available.";
}

/**
 * 为 compact 摘要构造一个最小模型配置。
 * @param config 原始会话配置
 * @returns 摘要配置
 */
function createCompactConfig(config: SessionConfig): SessionConfig {
	return {
		...config,
		maxTurnsPerMessage: 1,
	};
}

/**
 * 将消息历史序列化为更稳定的 compact 输入文本。
 * 相比直接 JSON.stringify，这里保留角色、块类型与关键字段，便于模型生成可恢复摘要。
 * @param messages 会话消息
 * @returns 序列化文本
 */
function serializeMessagesForCompact(messages: Message[]): string {
	return messages
		.map((message, index) => {
			const content = message.content
				.map((block) => {
					if (block.type === "text") {
						return `text: ${block.text}`;
					}
					if (block.type === "tool_use") {
						return `tool_use(${block.name}): ${JSON.stringify(block.input)}`;
					}
					return `tool_result(${block.toolUseId})${block.isError ? " [error]" : ""}: ${block.content}`;
				})
				.join("\n");
			return `#${index + 1} ${message.role}\n${content}`;
		})
		.join("\n\n");
}

/**
 * 从模型返回中提取真正的 compact summary。
 * reverse prompt 会要求输出 <analysis> 与 <summary>；runtime 只持久化 summary 本体。
 * @param text 模型原始文本
 * @returns 去标签后的 summary
 */
function extractCompactSummary(text: string): string {
	const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i);
	if (summaryMatch?.[1]) {
		return summaryMatch[1].trim();
	}

	return text
		.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
		.replace(/<\/?summary>/gi, "")
		.trim();
}
