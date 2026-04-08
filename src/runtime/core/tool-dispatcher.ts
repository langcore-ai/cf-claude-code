import type { ToolCall, ToolResult, ToolSchema } from "../types";
import type { DefaultToolContext, RuntimeTool, ToolGroup } from "../tools";

/**
 * 工具调度器。
 * 负责注册工具 schema，并统一执行入口。
 */
export class ToolDispatcher {
	private readonly tools = new Map<string, RuntimeTool>();

	/**
	 * @param tools 初始工具集
	 */
	constructor(tools: RuntimeTool[]) {
		for (const tool of tools) {
			this.tools.set(tool.name, tool);
		}
	}

	/**
	 * 列出全部 schema
	 * @param groups 可选工具分组过滤
	 * @returns 工具 schema 列表
	 */
	listSchemas(groups?: ToolGroup[]): ToolSchema[] {
		const allowAll = !groups || groups.length === 0;
		const allowedGroups = new Set(groups ?? []);
		return [...this.tools.values()]
			.filter((tool) => allowAll || allowedGroups.has(tool.group))
			.map((tool) => ({
			name: tool.name,
			description: tool.description ?? "",
			inputSchema: tool.inputSchema as never,
			sdkTool: tool,
			}));
	}

	/**
	 * 执行单个工具
	 * @param call 工具调用
	 * @param context 工具上下文
	 * @returns 工具结果
	 */
	async execute(call: ToolCall, context: DefaultToolContext): Promise<ToolResult> {
		const tool = this.tools.get(call.name);
		if (!tool) {
			throw new Error(`Unknown tool: ${call.name}`);
		}

		return tool.runtimeExecute(call, context);
	}
}
