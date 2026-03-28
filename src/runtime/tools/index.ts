import { nanoid } from "nanoid";

import { applyTodoWrite, createTask, getTask, renderTodos, updateTask } from "../domain";
import type { SkillProvider } from "../skills";
import type { ToolCall, ToolResult, ToolSchema, SessionState } from "../types";
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
export interface RuntimeTool {
	/** schema 定义 */
	schema: ToolSchema;
	/**
	 * 执行工具
	 * @param call 工具调用
	 * @param context 上下文
	 */
	execute(call: ToolCall, context: DefaultToolContext): Promise<ToolResult>;
}

/**
 * 创建 Phase 1 默认工具集合。
 * @returns 可注册工具列表
 */
export function createDefaultTools(): RuntimeTool[] {
	return [
		{
			schema: {
				name: "state_exec",
				description: "执行一段可访问 state.* 的 JavaScript，用于复杂文件和工作区操作",
				inputSchema: {
					type: "object",
					properties: {
						code: { type: "string" },
						description: { type: "string" },
					},
					required: ["code"],
				},
			},
			execute: async (call, context) => {
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
		},
		{
			schema: {
				name: "subagent_run",
				description: "同步执行一个 fresh-context subagent，并返回摘要",
				inputSchema: {
					type: "object",
					properties: {
						prompt: { type: "string" },
						description: { type: "string" },
					},
					required: ["prompt"],
				},
			},
			execute: async (call, context) => {
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
		},
		{
			schema: {
				name: "subagent_start",
				description: "创建异步 subagent job 骨架",
				inputSchema: {
					type: "object",
					properties: {
						prompt: { type: "string" },
						description: { type: "string" },
					},
					required: ["prompt"],
				},
			},
			execute: async (call, context) => {
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
		},
		{
			schema: {
				name: "subagent_status",
				description: "读取单个 subagent job 状态",
				inputSchema: {
					type: "object",
					properties: {
						jobId: { type: "string" },
					},
					required: ["jobId"],
				},
			},
			execute: async (call, context) => {
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
		},
		{
			schema: {
				name: "subagent_list",
				description: "列出当前会话下的 subagent jobs",
				inputSchema: {
					type: "object",
					properties: {},
				},
			},
			execute: async (call, context) => {
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
		},
		{
			schema: {
				name: "read_file",
				description: "读取工作区中的文本文件",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string" },
					},
					required: ["path"],
				},
			},
			execute: async (call, context) => {
				const path = String(call.input.path ?? "");
				const file = await context.workspace.files.readFile(path);
				return {
					toolUseId: call.id,
					name: call.name,
					content: file.content,
				};
			},
		},
		{
			schema: {
				name: "write_file",
				description: "向工作区写入文本文件",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string" },
						content: { type: "string" },
					},
					required: ["path", "content"],
				},
			},
			execute: async (call, context) => {
				const path = String(call.input.path ?? "");
				const content = String(call.input.content ?? "");
				await context.workspace.files.writeFile(path, content);
				return {
					toolUseId: call.id,
					name: call.name,
					content: `Wrote file: ${path}`,
				};
			},
		},
		{
			schema: {
				name: "list_files",
				description: "列出工作区目录的直接子节点",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string" },
					},
				},
			},
			execute: async (call, context) => {
				const path = call.input.path ? String(call.input.path) : "/";
				const entries = await context.workspace.files.list(path);
				return {
					toolUseId: call.id,
					name: call.name,
					content: entries.map((entry) => `${entry.type}: ${entry.path}`).join("\n") || "No files.",
				};
			},
		},
		{
			schema: {
				name: "TodoWrite",
				description: "整体更新当前 todo 列表",
				inputSchema: {
					type: "object",
					properties: {
						items: { type: "array" },
					},
					required: ["items"],
				},
			},
			execute: async (call, context) => {
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
		},
		{
			schema: {
				name: "load_skill",
				description: "读取某个 skill 的入口文件",
				inputSchema: {
					type: "object",
					properties: {
						name: { type: "string" },
					},
					required: ["name"],
				},
			},
			execute: async (call, context) => {
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
		},
		{
			schema: {
				name: "list_skill_files",
				description: "列出 skill 根目录下的文件",
				inputSchema: {
					type: "object",
					properties: {
						name: { type: "string" },
					},
					required: ["name"],
				},
			},
			execute: async (call, context) => {
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
		},
		{
			schema: {
				name: "read_skill_file",
				description: "读取 skill 内的任意文本文件",
				inputSchema: {
					type: "object",
					properties: {
						name: { type: "string" },
						path: { type: "string" },
					},
					required: ["name", "path"],
				},
			},
			execute: async (call, context) => {
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
		},
		{
			schema: {
				name: "compact",
				description: "手动触发会话压缩",
				inputSchema: {
					type: "object",
					properties: {},
				},
			},
			execute: async (call) => ({
				toolUseId: call.id,
				name: call.name,
				content: "__COMPACT__",
				meta: {
					action: "compact",
				},
			}),
		},
		{
			schema: {
				name: "task_create",
				description: "创建最小 task",
				inputSchema: {
					type: "object",
					properties: {
						title: { type: "string" },
						description: { type: "string" },
					},
					required: ["title"],
				},
			},
			execute: async (call, context) => {
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
		},
		{
			schema: {
				name: "task_list",
				description: "列出当前会话 task",
				inputSchema: {
					type: "object",
					properties: {},
				},
			},
			execute: async (call, context) => {
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
		},
		{
			schema: {
				name: "task_update",
				description: "更新最小 task 状态或内容",
				inputSchema: {
					type: "object",
					properties: {
						id: { type: "string" },
						title: { type: "string" },
						description: { type: "string" },
						status: { type: "string" },
						addBlockedBy: { type: "array" },
						addBlocks: { type: "array" },
					},
					required: ["id"],
				},
			},
			execute: async (call, context) => {
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
		},
		{
			schema: {
				name: "task_get",
				description: "获取单个 task 的完整信息",
				inputSchema: {
					type: "object",
					properties: {
						id: { type: "string" },
					},
					required: ["id"],
				},
			},
			execute: async (call, context) => {
				const session = await context.getSession();
				const task = getTask(session.tasks, String(call.input.id ?? ""));
				return {
					toolUseId: call.id,
					name: call.name,
					content: JSON.stringify(task, null, 2),
				};
			},
		},
	];
}

/** Phase 1 默认工具集合常量 */
export const DEFAULT_TOOLS = createDefaultTools();
