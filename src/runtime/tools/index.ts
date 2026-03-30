import { nanoid } from "nanoid";
import { tool } from "ai";
import type { Tool } from "@ai-sdk/provider-utils";
import { z } from "zod";

import { applyTodoWrite, createTask, getTask, renderTodos, updateTask } from "../domain";
import type { SkillProvider } from "../skills";
import type { ToolCall, ToolResult, SessionState } from "../types";
import type { Workspace } from "../workspace";

/** 默认工具上下文 */
export interface DefaultToolContext {
	/** 当前工作区 */
	workspace: Workspace;
	/** 当前 skill provider */
	skills: SkillProvider;
	/** 获取当前会话 */
	getSession(): Promise<SessionState>;
	/** 覆写当前会话 */
	updateSession(updater: (session: SessionState) => SessionState): Promise<void>;
	/** 同步执行 subagent */
	runSubagent?(prompt: string, options?: { description?: string }): Promise<{
		summary: string;
		turnCount: number;
		messageCount: number;
		jobId?: string;
	}>;
	/** 创建异步 subagent job */
	startSubagent?(prompt: string, options?: { description?: string }): Promise<{
		id: string;
		status: string;
		mode: string;
	}>;
	/** 查询 subagent job */
	getSubagentJob?(jobId: string): Promise<unknown>;
	/** 列出当前会话的全部 subagent jobs */
	listSubagentJobs?(): Promise<unknown[]>;
	/**
	 * 执行结构化 `state.*` 代码
	 * @param code JavaScript 源码
	 * @param options 可选元信息
	 */
	executeState?(code: string, options?: { description?: string }): Promise<{
		value: unknown;
		resultType: string;
	}>;
}

/** Runtime 工具定义 */
export type RuntimeTool = Tool & {
	/** 工具名称 */
	name: string;
	/** runtime 内部执行逻辑 */
	runtimeExecute(call: ToolCall, context: DefaultToolContext): Promise<ToolResult>;
};

/**
 * 为官方 Tool 记录 runtime 所需的名称和执行逻辑。
 * @param name 工具名称
 * @param sdkTool AI SDK 官方工具对象
 * @param runtimeExecute runtime 内部执行逻辑
 * @returns 原始 Tool 对象
 */
export function createRuntimeTool(
	name: string,
	sdkTool: Tool,
	runtimeExecute: (call: ToolCall, context: DefaultToolContext) => Promise<ToolResult>,
): RuntimeTool {
	return Object.assign(sdkTool, {
		name,
		runtimeExecute,
	});
}

/**
 * 创建 Phase 1 默认工具集合。
 * @returns 可注册工具列表
 */
export function createDefaultTools(): RuntimeTool[] {
	return [
		createRuntimeTool(
			"state_exec",
			tool({
				description:
					"执行一段可访问 state.* 的完整 JavaScript，用于复杂文件和工作区操作。必须传入 code，且 code 必须是完整的 async () => { ... } 函数；不要空调用，也不要只返回待执行代码。",
				inputSchema: z.object({
					code: z.string(),
					description: z.string().optional(),
				}),

			}),
			async (call, context) => {
				if (!context.executeState) {
					throw new Error("state_exec is not available");
				}

				const description = call.input.description ? String(call.input.description) : undefined;
				const execution = await context.executeState(String(call.input.code ?? ""), {
					description,
				});
				let content = "undefined";
				if (typeof execution.value === "string") {
					content = execution.value;
				} else if (execution.value !== undefined) {
					content = JSON.stringify(execution.value, null, 2);
				}

				return {
					toolUseId: call.id,
					name: call.name,
					content,
					meta: {
						description,
						resultType: execution.resultType,
					},
				};
			},
		),
		createRuntimeTool(
			"subagent_run",
			tool({
				description: "同步执行一个 fresh-context subagent，并返回摘要",
				inputSchema: z.object({
					prompt: z.string(),
					description: z.string().optional(),
				}),

			}),
			async (call, context) => {
				if (!context.runSubagent) {
					throw new Error("Subagent runtime is not available");
				}
				const result = await context.runSubagent(String(call.input.prompt ?? ""), {
					description: call.input.description ? String(call.input.description) : undefined,
				});
				return {
					toolUseId: call.id,
					name: call.name,
					content: result.summary,
					meta: {
						jobId: result.jobId,
						turnCount: result.turnCount,
						messageCount: result.messageCount,
					},
				};
			},
		),
		createRuntimeTool(
			"subagent_start",
			tool({
				description: "创建异步 subagent job 骨架",
				inputSchema: z.object({
					prompt: z.string(),
					description: z.string().optional(),
				}),

			}),
			async (call, context) => {
				if (!context.startSubagent) {
					throw new Error("Subagent runtime is not available");
				}
				const job = await context.startSubagent(String(call.input.prompt ?? ""), {
					description: call.input.description ? String(call.input.description) : undefined,
				});
				return {
					toolUseId: call.id,
					name: call.name,
					content: `Subagent job ${job.id} is ${job.status}`,
					meta: job,
				};
			},
		),
		createRuntimeTool(
			"subagent_status",
			tool({
				description: "读取单个 subagent job 状态",
				inputSchema: z.object({
					jobId: z.string(),
				}),

			}),
			async (call, context) => {
				if (!context.getSubagentJob) {
					throw new Error("Subagent runtime is not available");
				}
				const job = await context.getSubagentJob(String(call.input.jobId ?? ""));
				return {
					toolUseId: call.id,
					name: call.name,
					content: job ? JSON.stringify(job, null, 2) : "Subagent job not found",
				};
			},
		),
		createRuntimeTool(
			"subagent_list",
			tool({
				description: "列出当前会话下的 subagent jobs",
				inputSchema: z.object({}),

			}),
			async (call, context) => {
				if (!context.listSubagentJobs) {
					throw new Error("Subagent runtime is not available");
				}
				const jobs = await context.listSubagentJobs();
				return {
					toolUseId: call.id,
					name: call.name,
					content: jobs.length > 0 ? JSON.stringify(jobs, null, 2) : "No subagent jobs.",
				};
			},
		),
		createRuntimeTool(
			"read_file",
			tool({
				description: "读取工作区中的文本文件",
				inputSchema: z.object({
					path: z.string(),
				}),

			}),
			async (call, context) => {
				const path = String(call.input.path ?? "");
				const file = await context.workspace.files.readFile(path);
				return {
					toolUseId: call.id,
					name: call.name,
					content: file.content,
				};
			},
		),
		createRuntimeTool(
			"write_file",
			tool({
				description:
					"向工作区写入文本文件。path 必须是具体文件路径，例如 /README.md；不要把 / 当成文件路径。如果用户要求在根目录创建文件，应写成 /<文件名>。",
				inputSchema: z.object({
					path: z
						.string()
						.describe("文件路径，必须是具体文件路径，例如 /README.md；不要把 / 当成文件路径。如果用户要求在根目录创建文件，应写成 /<文件名>。"),
					content: z.string().describe("文件内容"),
				}),

			}),
			async (call, context) => {
				const path = String(call.input.path ?? "");
				const content = String(call.input.content ?? "");
				await context.workspace.files.writeFile(path, content);
				return {
					toolUseId: call.id,
					name: call.name,
					content: `Wrote file: ${path}`,
				};
			},
		),
		createRuntimeTool(
			"list_files",
			tool({
				description: "列出工作区目录的直接子节点",
				inputSchema: z.object({
					path: z.string().optional(),
				}),

			}),
			async (call, context) => {
				const path = call.input.path ? String(call.input.path) : "/";
				const entries = await context.workspace.files.list(path);
				return {
					toolUseId: call.id,
					name: call.name,
					content: entries.map((entry) => `${entry.type}: ${entry.path}`).join("\n") || "No files.",
				};
			},
		),
		createRuntimeTool(
			"TodoWrite",
			tool({
				description:
					"整体更新当前 todo 列表。每个 todo 必须是一个最小可执行步骤，一项只做一件事；不要把多个文件、端点、依赖或页面改动塞进同一项。复杂需求必须拆成多条 items。",
				inputSchema: z.object({
					items: z.array(
						z.object({
							id: z.string().optional(),
							content: z.string(),
							status: z.enum(["pending", "in_progress", "completed"]),
							activeForm: z.string().optional(),
						}),
					),
				}),

			}),
			async (call, context) => {
				const items = Array.isArray(call.input.items) ? call.input.items : [];
				const todos = applyTodoWrite({
					items: items.map((item) => ({
						id: String((item as Record<string, unknown>).id ?? nanoid()),
						content: String((item as Record<string, unknown>).content ?? ""),
						status: ((item as Record<string, unknown>).status ?? "pending") as SessionState["todos"][number]["status"],
						activeForm: (item as Record<string, unknown>).activeForm
							? String((item as Record<string, unknown>).activeForm)
							: undefined,
					})),
				});

				await context.updateSession((session) => ({
					...session,
					todos,
					todoIdleTurns: 0,
				}));

				return {
					toolUseId: call.id,
					name: call.name,
					content: renderTodos(todos),
				};
			},
		),
		createRuntimeTool(
			"load_skill",
			tool({
				description: "读取某个 skill 的入口文件",
				inputSchema: z.object({
					name: z.string(),
				}),

			}),
			async (call, context) => {
				const name = String(call.input.name ?? "");
				const skill = await context.skills.open(name);
				if (!skill) {
					throw new Error(`Skill not found: ${name}`);
				}

				return {
					toolUseId: call.id,
					name: call.name,
					content: await skill.readEntry(),
				};
			},
		),
		createRuntimeTool(
			"list_skill_files",
			tool({
				description: "列出 skill 根目录下的文件",
				inputSchema: z.object({
					name: z.string(),
				}),

			}),
			async (call, context) => {
				const name = String(call.input.name ?? "");
				const skill = await context.skills.open(name);
				if (!skill) {
					throw new Error(`Skill not found: ${name}`);
				}

				const files = await skill.workspace.files.list("/");
				return {
					toolUseId: call.id,
					name: call.name,
					content: files.map((file) => `${file.type}: ${file.path}`).join("\n") || "No files.",
				};
			},
		),
		createRuntimeTool(
			"read_skill_file",
			tool({
				description: "读取 skill 内的任意文本文件",
				inputSchema: z.object({
					name: z.string(),
					path: z.string(),
				}),

			}),
			async (call, context) => {
				const name = String(call.input.name ?? "");
				const path = String(call.input.path ?? "");
				const skill = await context.skills.open(name);
				if (!skill) {
					throw new Error(`Skill not found: ${name}`);
				}

				const file = await skill.workspace.files.readFile(path);
				return {
					toolUseId: call.id,
					name: call.name,
					content: file.content,
				};
			},
		),
		createRuntimeTool(
			"compact",
			tool({
				description: "手动触发会话压缩",
				inputSchema: z.object({}),

			}),
			async (call) => ({
				toolUseId: call.id,
				name: call.name,
				content: "__COMPACT__",
				meta: {
					action: "compact",
				},
			}),
		),
		createRuntimeTool(
			"task_create",
			tool({
				description: "创建最小 task",
				inputSchema: z.object({
					title: z.string(),
					description: z.string().optional(),
				}),

			}),
			async (call, context) => {
				const task = createTask({
					title: String(call.input.title ?? ""),
					description: call.input.description ? String(call.input.description) : undefined,
				});
				await context.updateSession((session) => ({
					...session,
					tasks: [...session.tasks, task],
				}));
				return {
					toolUseId: call.id,
					name: call.name,
					content: `Created task ${task.id}: ${task.title}`,
				};
			},
		),
		createRuntimeTool(
			"task_list",
			tool({
				description: "列出当前会话 task",
				inputSchema: z.object({}),

			}),
			async (call, context) => {
				const session = await context.getSession();
				return {
					toolUseId: call.id,
					name: call.name,
					content:
						session.tasks
							.map((task) => {
								const marker = {
									open: "[ ]",
									in_progress: "[>]",
									done: "[x]",
								}[task.status];
								const blockedBy = task.blockedBy.length > 0 ? ` (blocked by: ${task.blockedBy.join(", ")})` : "";
								return `${marker} #${task.id}: ${task.title}${blockedBy}`;
							})
							.join("\n") || "No tasks.",
				};
			},
		),
		createRuntimeTool(
			"task_update",
			tool({
				description: "更新最小 task 状态或内容",
				inputSchema: z.object({
					id: z.string(),
					title: z.string().optional(),
					description: z.string().optional(),
					status: z.string().optional(),
					addBlockedBy: z.array(z.string()).optional(),
					addBlocks: z.array(z.string()).optional(),
				}),

			}),
			async (call, context) => {
				await context.updateSession((session) => ({
					...session,
					tasks: updateTask(session.tasks, {
						id: String(call.input.id ?? ""),
						title: call.input.title ? String(call.input.title) : undefined,
						description: call.input.description ? String(call.input.description) : undefined,
						status: call.input.status as SessionState["tasks"][number]["status"] | undefined,
						addBlockedBy: Array.isArray(call.input.addBlockedBy)
							? call.input.addBlockedBy.map((value) => String(value))
							: undefined,
						addBlocks: Array.isArray(call.input.addBlocks)
							? call.input.addBlocks.map((value) => String(value))
							: undefined,
					}),
				}));

				return {
					toolUseId: call.id,
					name: call.name,
					content: `Updated task ${String(call.input.id ?? "")}`,
				};
			},
		),
		createRuntimeTool(
			"task_get",
			tool({
				description: "获取单个 task 的完整信息",
				inputSchema: z.object({
					id: z.string(),
				}),

			}),
			async (call, context) => {
				const session = await context.getSession();
				const task = getTask(session.tasks, String(call.input.id ?? ""));
				return {
					toolUseId: call.id,
					name: call.name,
					content: JSON.stringify(task, null, 2),
				};
			},
		),
	];
}

/** Phase 1 默认工具集合常量 */
export const DEFAULT_TOOLS = createDefaultTools();
