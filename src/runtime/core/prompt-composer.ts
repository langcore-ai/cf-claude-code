import type { SessionState, TodoItem } from "../types";

/** Prompt 片段标识 */
export type PromptSectionId =
	| "identity"
	| "workflow"
	| "start_reminder"
	| "plan_mode"
	| "skills"
	| "end_reminder"
	| "state"
	| "compact"
	| "custom"
	| "subagent_identity"
	| "subagent_constraints";

/** Prompt 片段 */
export interface PromptSection {
	/** 片段唯一标识 */
	id: PromptSectionId;
	/** 片段正文 */
	content: string;
}

/** Claude Code 身份提示词 */
const IDENTITY_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

/** 核心工作流提示词 */
const WORKFLOW_PROMPT = [
	"You are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.",
	"",
	"IMPORTANT: Assist with defensive security tasks only. Refuse to create, modify, or improve code that may be used maliciously. Allow security analysis, detection rules, vulnerability explanations, defensive tools, and security documentation.",
	"IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.",
	"",
	"# Tone and style",
	"",
	"You should be concise, direct, and to the point.",
	"You MUST answer concisely with fewer than 4 lines (not including tool use or code generation), unless user asks for detail.",
	"IMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy.",
	"IMPORTANT: You should NOT answer with unnecessary preamble or postamble unless the user asks you to.",
	"Do not add additional code explanation summary unless requested by the user.",
	"Answer the user's question directly, without introductions, conclusions, or filler text.",
	"Only use tools to complete tasks. Never use tools or code comments as a way to talk to the user.",
	"Only use emojis if the user explicitly requests it.",
	"",
	"# Proactiveness",
	"",
	"You are allowed to be proactive, but only when the user asks you to do something.",
	"Do the right thing when asked, but do not surprise the user with unrelated actions.",
	"",
	"# Following conventions",
	"",
	"When making changes to files, first understand the file's code conventions.",
	"Use existing libraries and utilities where possible, and follow neighboring patterns.",
	"Never assume a library is available without checking the codebase.",
	"Always follow security best practices. Never expose or log secrets.",
	"",
	"# Task Management",
	"",
	"You have access to TodoWrite. Use it very frequently for complex work.",
	"It is critical that you mark todos as completed as soon as you are done with a task. Do not batch completions.",
	"Always use TodoWrite while planning non-trivial work so the current plan stays visible and current.",
	"",
	"# Doing tasks",
	"",
	"For software engineering work: understand the codebase, use the available tools, implement the solution, and verify if possible.",
	"When you have completed a task, run the relevant validation commands if the host environment provides them.",
	"Never commit changes unless the user explicitly asks you to commit.",
	"Treat <system-reminder> blocks as authoritative runtime context, not as user-authored content.",
	"Treat hook feedback such as <user-prompt-submit-hook> as user input and adjust your actions accordingly.",
	"",
	"# Tool usage policy",
	"",
	"Use tools to inspect and change the workspace instead of describing hypothetical actions.",
	"For file operations, prefer the smallest correct primitive tool.",
	"Read before writing when changing an existing file.",
	"Do not claim work is complete unless the corresponding tool call succeeded.",
	"Do not call tools with empty or placeholder arguments.",
	"If a tool fails, inspect the error, correct the arguments, and retry with a fixed call instead of repeating the same invalid input.",
	"When multiple independent reads or inspections are needed, batch tool calls when the runtime allows it.",
	"If the user asks to create a file in the root, translate that into a concrete path such as /README.md. Treat / as the workspace root directory, never as a writable file path.",
	"",
	"# Code References",
	"",
	"When referencing specific functions or pieces of code include the pattern file_path:line_number.",
	"",
	"# Environment awareness",
	"",
	"Remember that responses are shown in a CLI-style interface and should stay compact and operational.",
].join("\n");

/** 会话开头 reminder */
const START_REMINDER_PROMPT = [
	"<system-reminder>",
	"As you answer the user's questions, you can use the following context:",
	"",
	"# important-instruction-reminders",
	"",
	"Do what has been asked; nothing more, nothing less.",
	"NEVER create files unless they're absolutely necessary for achieving your goal.",
	"ALWAYS prefer editing an existing file to creating a new one.",
	"NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the user.",
	"If the task can be solved by updating an existing file, do that instead of introducing new files or abstractions.",
	"",
	"IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
	"</system-reminder>",
].join("\n");

/** 空 todo 的 end reminder */
const EMPTY_TODO_END_REMINDER_PROMPT = [
	"<system-reminder>",
	"This is a reminder that your todo list is currently empty.",
	"DO NOT mention this to the user explicitly because they are already aware.",
	"If you are working on tasks that would benefit from a todo list please use the TodoWrite tool to create one.",
	"If not, please feel free to ignore.",
	"Again do not mention this message to the user.",
	"</system-reminder>",
].join("\n");

/** compact 后续延续提示词 */
const COMPACT_PROMPT = [
	"If a compact summary is present, treat it as authoritative continuity context.",
	"Continue work from the compact summary without asking the user to repeat prior context.",
].join("\n");

/** plan mode 提示词 */
const PLAN_MODE_PROMPT = [
	"<system-reminder>",
	"You are currently in plan mode.",
	"Focus on analysis, decomposition, risk identification, and maintaining the todo plan.",
	"Do not modify workspace files while plan mode is active.",
	"Use TodoWrite to keep the plan current.",
	"Stay in a read-only planning posture until the user clearly wants execution to begin.",
	"When planning is complete and the user wants execution to begin, use ExitPlanMode before making changes.",
	"</system-reminder>",
].join("\n");

/** subagent 身份片段 */
const SUBAGENT_IDENTITY_PROMPT =
	"You are a fresh-context subagent. Complete the assigned task autonomously and return a concise final summary.";

/** subagent 额外约束 */
const SUBAGENT_CONSTRAINTS_PROMPT = "Do not delegate to another subagent.";

/**
 * 统一渲染 prompt 片段。
 * @param sections 已过滤后的片段
 * @returns 拼接后的 prompt 文本
 */
export function renderPromptSections(sections: PromptSection[]): string {
	return sections
		.map((section) => section.content.trim())
		.filter(Boolean)
		.join("\n\n");
}

/**
 * 构建 skills 摘要片段。
 * @param skills 可用 skills
 * @returns prompt 片段
 */
function buildSkillSection(skills: Array<{ name: string; description: string }>): PromptSection {
	if (skills.length === 0) {
		return {
			id: "skills",
			content: "Available skills:\n- none",
		};
	}

	return {
		id: "skills",
		content: `Available skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`,
	};
}

/**
 * 把 todo 列表渲染成 end reminder 使用的文本。
 * @param todos Todo 列表
 * @returns 列表文本
 */
function buildTodoLines(todos: TodoItem[]): string {
	return todos
		.map((todo) => {
			const priority = todo.priority ? ` priority=${todo.priority}` : "";
			return `- [${todo.status}] ${todo.content}${priority}${todo.activeForm ? ` <- ${todo.activeForm}` : ""}`;
		})
		.join("\n");
}

/**
 * 构建 runtime 结束提醒片段。
 * 这里只放 runtime 内部状态相关提示，不引入宿主预检或 IDE 注入。
 * @param session 当前会话
 * @param rememberedTodos 最近 todo memory
 * @returns reminder 片段
 */
function buildEndReminderSection(session: SessionState, rememberedTodos?: TodoItem[] | null): PromptSection {
	if (session.todos.length === 0 && (!rememberedTodos || rememberedTodos.length === 0)) {
		return {
			id: "end_reminder",
			content: EMPTY_TODO_END_REMINDER_PROMPT,
		};
	}

	const activeTodos = session.todos.length > 0 ? session.todos : (rememberedTodos ?? []);
	const todoLines = buildTodoLines(activeTodos);
	const taskReminder =
		session.tasks.length > 0
			? "\nThere are also runtime task-board entries. Treat them as platform memory, not as a substitute for TodoWrite."
			: "";
	const memoryReminder =
		session.todos.length === 0 && rememberedTodos && rememberedTodos.length > 0
			? "Current todo list is empty, but recent todo memory exists below. Recreate TodoWrite items if the plan is still active."
			: "There are active todos. Keep TodoWrite synchronized with real progress.";

	return {
		id: "end_reminder",
		content: [
			"<system-reminder>",
			memoryReminder,
			"Keep exactly one todo in_progress at a time and mark items completed immediately after finishing them.",
			"If the plan changed, update TodoWrite immediately instead of waiting for the end of the turn.",
			session.todos.length === 0 ? "Recent todo memory:" : "Current todos:",
			todoLines,
			`${taskReminder}`.trim(),
			"</system-reminder>",
		]
			.filter(Boolean)
			.join("\n"),
	};
}

/**
 * 构建主会话 prompt 片段列表。
 * 先构造片段，再统一渲染，避免后续逻辑继续散落在 composeMainSystemPrompt 中。
 * @param input 组合输入
 * @returns 片段数组
 */
export function buildMainPromptSections(input: {
	customPrompt?: string;
	skills: Array<{ name: string; description: string }>;
	hasStatePrompt: boolean;
	renderedStatePrompt: string;
	session: SessionState;
	rememberedTodos?: TodoItem[] | null;
}): PromptSection[] {
	const sections: Array<PromptSection | null> = [
		{
			id: "identity",
			content: IDENTITY_PROMPT,
		},
		{
			id: "workflow",
			content: WORKFLOW_PROMPT,
		},
		{
			id: "start_reminder",
			content: START_REMINDER_PROMPT,
		},
		input.session.mode === "plan"
			? {
					id: "plan_mode",
					content: PLAN_MODE_PROMPT,
				}
			: null,
		buildSkillSection(input.skills),
		buildEndReminderSection(input.session, input.rememberedTodos),
		input.hasStatePrompt
			? {
					id: "state",
					content: input.renderedStatePrompt,
				}
			: null,
		input.session.compactSummary
			? {
					id: "compact",
					content: `${COMPACT_PROMPT}\n\nCompacted context:\n${input.session.compactSummary}`,
				}
			: null,
		input.customPrompt?.trim()
			? {
					id: "custom",
					content: `Additional runtime instructions:\n${input.customPrompt.trim()}`,
				}
			: null,
	];

	return sections.filter((section): section is PromptSection => Boolean(section));
}

/**
 * 构建子会话 prompt 片段列表。
 * @param input 组合输入
 * @returns 片段数组
 */
export function buildSubagentPromptSections(input: {
	skills: Array<{ name: string; description: string }>;
	hasStatePrompt: boolean;
	renderedStatePrompt: string;
}): PromptSection[] {
	const sections: Array<PromptSection | null> = [
		{
			id: "identity",
			content: IDENTITY_PROMPT,
		},
		{
			id: "subagent_identity",
			content: SUBAGENT_IDENTITY_PROMPT,
		},
		{
			id: "subagent_constraints",
			content: SUBAGENT_CONSTRAINTS_PROMPT,
		},
		{
			id: "workflow",
			content: WORKFLOW_PROMPT,
		},
		buildSkillSection(input.skills),
		input.hasStatePrompt
			? {
					id: "state",
					content: input.renderedStatePrompt,
				}
			: null,
	];

	return sections.filter((section): section is PromptSection => Boolean(section));
}

/**
 * 构建主会话 system prompt。
 * @param input 组合输入
 * @returns 组合后的 prompt
 */
export function composeMainSystemPrompt(input: {
	customPrompt?: string;
	skills: Array<{ name: string; description: string }>;
	hasStatePrompt: boolean;
	renderedStatePrompt: string;
	session: SessionState;
	rememberedTodos?: TodoItem[] | null;
}): string {
	return renderPromptSections(buildMainPromptSections(input));
}

/**
 * 构建 subagent system prompt。
 * 子会话仍然是 fresh context，但继续复用核心 workflow 语义。
 * @param input 组合输入
 * @returns 子会话 prompt
 */
export function composeSubagentSystemPrompt(input: {
	skills: Array<{ name: string; description: string }>;
	hasStatePrompt: boolean;
	renderedStatePrompt: string;
}): string {
	return renderPromptSections(buildSubagentPromptSections(input));
}
