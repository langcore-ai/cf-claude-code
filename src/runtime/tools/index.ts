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
					"Executes complete JavaScript code with access to state.* for structured workspace operations.\n\nBefore executing the code, please follow these steps:\n\n1. Directory Verification:\n   - If the code will create new directories or files, first verify the parent directory exists and is the correct location.\n\n2. Code Execution:\n   - The code argument is required.\n   - code MUST be a complete async () => { ... } function.\n   - The function should perform the actual operation and return a final value.\n   - Do not return code for later execution. Execute the actual operation now.\n   - Use workspace-style absolute paths such as /README.md instead of relative paths.\n\nUsage notes:\n- Prefer this tool for complex multi-file work, search-and-replace, JSON operations, tree inspection, or other structured workspace actions.\n- If the execution result is not a string, it will be returned to you as JSON.\n- If you still need a simple one-file read, write, or directory listing, prefer the dedicated read_file, write_file, or list_files tools.",
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
				description:
					"Launch a new agent to handle complex, multi-step tasks autonomously.\n\nWhen using this tool:\n- Use it for complex research, code search, and multi-step tasks where you are not confident you will find the right match in the first few tries.\n- If you want to read a specific file path, use read_file instead.\n- If you want to inspect a specific directory, use list_files instead.\n- The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.\n- Each agent invocation is stateless. You will not be able to send additional messages to the agent, nor will the agent be able to communicate with you outside of its final report. Therefore, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.\n- The agent's outputs should generally be trusted.\n- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.\n- Launch multiple agents concurrently whenever possible, using multiple tool calls in a single response.",
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
				description:
					"Create an asynchronous subagent job handle for later status checks. Use this only when you explicitly need a queued job instead of an immediate final summary.",
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
				description: "Read the current status and summary information for a single subagent job.",
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
				description: "List all subagent jobs for the current session.",
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
				description:
					"Reads a file from the workspace filesystem. You can access any workspace file directly by using this tool.\n\nAssume this tool is able to read all files in the current workspace. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- The path parameter must be a workspace absolute path, not a relative path.\n- It is generally better to read the whole file rather than guess at its contents.\n- You have the capability to call multiple tools in a single response. It is often better to speculatively read multiple files as a batch when they are potentially useful.\n- If you are reading a file inside a skill directory, prefer read_skill_file. If you are reading a skill entry file, prefer load_skill.",
				inputSchema: z.object({
					path: z.string().describe("The absolute path to the file to read"),
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
					"Writes a file to the workspace filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the read_file tool first to read the file's contents.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.\n- path must be a specific file path such as /README.md. Do not use / as a file path. If the user wants a file in the root directory, use /<filename>.",
				inputSchema: z.object({
					path: z
						.string()
						.describe("The absolute path to the file to write. Must be a specific file path such as /README.md, not /."),
					content: z.string().describe("The content to write to the file"),
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
				description:
					"Lists files and directories in a given path. The path parameter must be a workspace absolute path, not a relative path. You can optionally inspect a directory root by omitting path, which defaults to /. You should generally prefer more targeted tools when you already know exactly which files to inspect.",
				inputSchema: z.object({
					path: z.string().optional().describe("The absolute path to the directory to list"),
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
					"Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user. It also helps the user understand the progress of the task and overall progress of their requests.\n\nWhen to Use This Tool\nUse this tool proactively in these scenarios:\n1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions\n2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations\n3. User explicitly requests todo list - When the user directly asks you to use the todo list\n4. User provides multiple tasks - When users provide a list of things to be done\n5. After receiving new instructions - Immediately capture user requirements as todos\n6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time\n7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation\n\nWhen NOT to Use This Tool\nSkip using this tool when:\n1. There is only a single, straightforward task\n2. The task is trivial and tracking it provides no organizational benefit\n3. The task can be completed in less than 3 trivial steps\n4. The task is purely conversational or informational\n\nTask States and Management\n- pending: Task not yet started\n- in_progress: Currently working on (limit to ONE task at a time)\n- completed: Task finished successfully\n\nTask Management:\n- Update task status in real-time as you work\n- Mark tasks complete IMMEDIATELY after finishing (don't batch completions)\n- Only have ONE task in_progress at any time\n- Complete current tasks before starting new ones\n- Remove tasks that are no longer relevant from the list entirely\n\nTask Completion Requirements:\n- ONLY mark a task as completed when you have FULLY accomplished it\n- If you encounter errors, blockers, or cannot finish, keep the task as in_progress\n- When blocked, create a new task describing what needs to be resolved\n\nTask Breakdown:\n- Create specific, actionable items\n- Break complex tasks into smaller, manageable steps\n- Use clear, descriptive task names\n- Each todo in this runtime must still be a minimal executable step; do not combine multiple files, endpoints, dependency changes, or page changes into one item.\n\nWhen in doubt, use this tool.",
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
				description: "读取某个 skill 的入口文件 SKILL.md。",
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
				description: "列出某个 skill 根目录下的文件和目录。",
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
				description: "读取某个 skill 目录内的任意文本文件。",
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
				description: "手动触发当前会话压缩，用于在上下文过长时保留连续性摘要。",
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
				description: "创建一个 task，用于记录当前会话中的独立工作项。",
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
				description: "列出当前会话中的全部 tasks。",
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
				description: "更新 task 的状态、标题、描述或依赖关系。",
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
				description: "读取单个 task 的完整信息。",
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
