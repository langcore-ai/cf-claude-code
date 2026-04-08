import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { generateText, tool } from "ai";
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
	model: string | {
		main: string;
		compact?: string;
		subagent?: string;
		lightweight?: string;
	};
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
 * runtime 内部仍维护自己的工具协议；这里只在 adapter 边界转换为 AI SDK 官方 `tool({...})` 形态，
 * 避免把 provider / SDK 细节反向渗透到 runtime core。
 * @param tools runtime 工具列表
 * @returns AI SDK ToolSet
 */
export function toAiTools(tools: ToolSchema[]): ToolSet {
	const mapped: ToolSet = {};
	for (const toolSchema of tools) {
		if (toolSchema.sdkTool) {
			mapped[toolSchema.name] = toolSchema.sdkTool as ToolSet[string];
			continue;
		}

		mapped[toolSchema.name] = tool({
			description: toolSchema.description,
			// runtime 当前统一使用 zod schema；这里直接透传即可。
			inputSchema: toolSchema.inputSchema as never,
			// 实际工具执行仍由 runtime loop 负责；这里提供最小 execute 以符合 AI SDK 官方工具形态。
			execute: async () => "",
		}) as ToolSet[string];
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
		input?: unknown;
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
			input:
				typeof toolCall.input === "object" && toolCall.input !== null
					? (toolCall.input as Record<string, unknown>)
					: {},
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
	 * @param models AI SDK 模型实例集合
	 */
	constructor(
		private readonly models: {
			main: LanguageModel;
			compact?: LanguageModel;
			subagent?: LanguageModel;
			lightweight?: LanguageModel;
		},
	) {}

	/**
	 * 选择当前调用应使用的模型。
	 * @param role 模型角色
	 * @returns 对应模型
	 */
	private getModel(role: GenerateTurnInput["modelRole"]): LanguageModel {
		if (role === "compact" && this.models.compact) {
			return this.models.compact;
		}

		if (role === "subagent" && this.models.subagent) {
			return this.models.subagent;
		}

		if (role === "lightweight" && this.models.lightweight) {
			return this.models.lightweight;
		}

		return this.models.main;
	}

	/**
	 * 生成一轮模型输出
	 * @param input runtime 输入
	 * @returns 标准化结果
	 */
	async generateTurn(input: GenerateTurnInput): Promise<ModelTurnResult> {
		const result = await generateText({
			model: this.getModel(input.modelRole),
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

	if (typeof config.model === "string") {
		return new AiSdkClient({
			main: provider(config.model),
		});
	}

	return new AiSdkClient({
		main: provider(config.model.main),
		compact: config.model.compact ? provider(config.model.compact) : undefined,
		subagent: config.model.subagent ? provider(config.model.subagent) : undefined,
		lightweight: config.model.lightweight ? provider(config.model.lightweight) : undefined,
	});
}
