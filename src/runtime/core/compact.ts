import type { TranscriptStore } from "../adapters";
import type { AIClient, Message, SessionConfig, SessionState } from "../types";

/** 微压缩保留的最近工具结果数量 */
const RECENT_TOOL_RESULTS_TO_KEEP = 3;

/** continuity compact 的 system prompt */
const CONTINUITY_COMPACT_SYSTEM_PROMPT = [
	"You summarize agent sessions for continuity.",
	"Preserve only the details needed to continue work correctly.",
	"Include:",
	"1) completed work",
	"2) current workspace and task state",
	"3) key decisions or constraints",
	"4) unfinished work and recommended next steps",
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
					text: `[Conversation compressed. Transcript: ${transcriptRef}]\n\n${summary}`,
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
							`Transcript ref: ${input.transcriptRef}`,
							`Todos:\n${todoLines}`,
							`Tasks:\n${taskLines}`,
							"Conversation to summarize:",
							JSON.stringify(input.messages),
						].join("\n\n"),
					},
				],
			},
		],
		tools: [],
		config: createCompactConfig(input.session.config),
	});

	if (response.stopReason === "tool_use") {
		throw new Error("Compact summarization must not request tools");
	}

	const summary = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();

	return summary || "No summary available.";
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
