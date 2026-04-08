import type { SessionState, TodoItem, ToolCall, ToolResult } from "../types";

/** Prompt 级 reminder 类型 */
export type PromptReminderKind = "start" | "end" | "plan_mode";

/** Runtime 事件级 reminder 类型 */
export type RuntimeEventReminderKind = "tool_failure" | "repeated_tool_failure" | "todo_idle";

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

/** plan mode 的 prompt reminder */
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

/** Todo 长时间未更新时的事件 reminder */
const TODO_IDLE_REMINDER = [
	"<system-reminder>",
	"Reminder: there are unfinished todos. Update TodoWrite if the plan changed.",
	"</system-reminder>",
].join("\n");

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
 * 构建 start reminder。
 * 这里只保留 runtime core 范围内的权威上下文，不混入宿主预检或 IDE 注入提示。
 * @returns reminder 文本
 */
export function buildStartReminder(): string {
	return START_REMINDER_PROMPT;
}

/**
 * 构建 plan mode reminder。
 * @returns reminder 文本
 */
export function buildPlanModeReminder(): string {
	return PLAN_MODE_PROMPT;
}

/**
 * 构建 end reminder。
 * end reminder 只表达 runtime 内的长期状态，如 todos、todo memory、task continuity。
 * @param session 当前会话
 * @param rememberedTodos 最近 todo memory
 * @returns reminder 文本
 */
export function buildEndReminder(session: SessionState, rememberedTodos?: TodoItem[] | null): string {
	if (session.todos.length === 0 && (!rememberedTodos || rememberedTodos.length === 0)) {
		return EMPTY_TODO_END_REMINDER_PROMPT;
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

	return [
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
		.join("\n");
}

/**
 * 构造工具失败后的 runtime event reminder。
 * 这个提醒只服务下一轮模型纠偏，不直接作为用户可见说明。
 * @param call 失败的工具调用
 * @param toolResult 工具结果
 * @param repeatedFailures 相同调用的历史失败次数
 * @returns reminder 类型与文本
 */
export function buildToolFailureReminder(
	call: ToolCall,
	toolResult: ToolResult,
	repeatedFailures: number,
): { kind: RuntimeEventReminderKind; content: string } {
	const isRepeated = repeatedFailures >= 2;
	const repeatedWarning = isRepeated
		? "You have repeated the same invalid tool call multiple times. Do not repeat it again without changing the arguments."
		: "Do not repeat the same invalid tool call. Change the arguments before retrying.";

	return {
		kind: isRepeated ? "repeated_tool_failure" : "tool_failure",
		content: [
			"<system-reminder>",
			`The last tool call failed: ${call.name}.`,
			`Error: ${toolResult.content}`,
			"Inspect the error carefully and correct the next tool call instead of describing hypothetical success.",
			"Ensure required arguments are present and non-empty before retrying.",
			repeatedWarning,
			"</system-reminder>",
		].join("\n"),
	};
}

/**
 * 构造 todo 长时间未更新时的 runtime event reminder。
 * @returns reminder 类型与文本
 */
export function buildTodoIdleReminder(): { kind: RuntimeEventReminderKind; content: string } {
	return {
		kind: "todo_idle",
		content: TODO_IDLE_REMINDER,
	};
}
