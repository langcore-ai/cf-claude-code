import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

import type {
	AIClient,
	AssistantBlock,
	GenerateTurnInput,
	Message,
	ModelTurnResult,
	ToolSchema,
} from "../types";

/** OpenAI 兼容服务配置 */
export interface OpenAiClientConfig {
	/** API key */
	apiKey: string;
	/** 模型名称 */
	model: string;
	/** 可选 baseURL */
	baseURL?: string;
}

/**
 * 将 runtime 消息映射为 AI SDK 消息。
 * 这里保持结构简单，避免 runtime 依赖 provider 专有类型。
 * @param messages runtime 消息列表
 * @returns AI SDK 消息数组
 */
export function toAiMessages(messages: Message[]): ModelMessage[] {
	return messages.map((message) => ({
		role: message.role,
		content: message.content
			.map((block) => {
				if (block.type === "text") {
					return block.text;
				}

				if (block.type === "tool_use") {
					return `[tool_use:${block.name}] ${JSON.stringify(block.input)}`;
				}

				return `[tool_result${block.isError ? ":error" : ""}] ${block.content}`;
			})
			.join("\n"),
	}));
}

/**
 * 将 runtime 工具 schema 转成 AI SDK tool set。
 * Phase 1 只需要工具描述和空执行器，因为实际执行由 runtime 完成。
 * @param tools runtime 工具列表
 * @returns AI SDK ToolSet
 */
export function toAiTools(tools: ToolSchema[]): ToolSet {
	const mapped: ToolSet = {};
	for (const tool of tools) {
		mapped[tool.name] = {
			description: tool.description,
			inputSchema: tool.inputSchema as never,
			execute: async () => "",
		};
	}
	return mapped;
}

/**
 * 将 AI SDK 返回归一化为 runtime 结果。
 * @param output generateText 结果
 * @returns runtime 可识别的模型结果
 */
export function toModelTurnResult(output: {
	toolCalls?: Array<{
		toolCallId?: string;
		toolName: string;
		args?: Record<string, unknown>;
	}>;
	text?: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
	};
}): ModelTurnResult {
	const toolCalls = output.toolCalls ?? [];
	if (toolCalls.length > 0) {
		const content: AssistantBlock[] = toolCalls.map((toolCall, index) => ({
			type: "tool_use",
			id: toolCall.toolCallId ?? `${toolCall.toolName}-${index}`,
			name: toolCall.toolName,
			input: toolCall.args ?? {},
		}));

		return {
			content,
			stopReason: "tool_use",
			usage: output.usage,
		};
	}

	return {
		content: [
			{
				type: "text",
				text: output.text ?? "",
			},
		],
		stopReason: "end_turn",
		usage: output.usage,
	};
}

/**
 * AI SDK 适配器。
 * runtime 只看标准化后的 `ModelTurnResult`，不直接接触 provider 响应。
 */
export class AiSdkClient implements AIClient {
	/**
	 * @param model AI SDK 模型实例
	 */
	constructor(private readonly model: LanguageModel) {}

	/**
	 * 生成一轮模型输出
	 * @param input runtime 输入
	 * @returns 标准化结果
	 */
	async generateTurn(input: GenerateTurnInput): Promise<ModelTurnResult> {
		const result = await generateText({
			model: this.model,
			system: input.systemPrompt,
			messages: toAiMessages(input.messages),
			tools: toAiTools(input.tools),
		});

		return toModelTurnResult(result);
	}
}

/**
 * 基于 OpenAI 兼容接口创建 AI SDK client。
 * @param config provider 配置
 * @returns runtime 可用客户端
 */
export function createOpenAiClient(config: OpenAiClientConfig): AiSdkClient {
	const provider = createOpenAI({
		apiKey: config.apiKey,
		baseURL: config.baseURL,
	});

	return new AiSdkClient(provider(config.model));
}
