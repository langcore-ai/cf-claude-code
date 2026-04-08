import type { TodoItem, TodoPriority, TodoStatus } from "../types";

/** Todo 上限 */
const TODO_LIMIT = 20;

/** Todo write 输入 */
export interface TodoWriteInput {
	/** 新的 todo 列表 */
	items: Array<{
		/** 条目 id */
		id: string;
		/** 内容 */
		content: string;
		/** 状态 */
		status: TodoStatus;
		/** 优先级 */
		priority?: TodoPriority;
		/** 进行中任务的主动描述 */
		activeForm?: string;
	}>;
}

/**
 * 校验并归一化 Todo 列表。
 * @param input TodoWrite 输入
 * @returns 归一化后的 Todo 列表
 */
export function applyTodoWrite(input: TodoWriteInput): TodoItem[] {
	if (input.items.length > TODO_LIMIT) {
		throw new Error(`Todo item count exceeds limit: ${TODO_LIMIT}`);
	}

	let inProgressCount = 0;
	const items = input.items.map((item) => {
		if (!item.content.trim()) {
			throw new Error("Todo item content cannot be empty");
		}

		if (item.status === "in_progress") {
			inProgressCount += 1;
			if (!item.activeForm?.trim()) {
				throw new Error("In-progress todo item must include activeForm");
			}
		}

		return {
			id: item.id,
			content: item.content.trim(),
			status: item.status,
			priority: item.priority,
			activeForm: item.activeForm?.trim() || undefined,
		};
	});

	if (inProgressCount > 1) {
		throw new Error("Only one todo item can be in progress");
	}

	return items;
}

/**
 * 将 Todo 列表渲染为可读文本。
 * @param items Todo 列表
 * @returns 文本表示
 */
export function renderTodos(items: TodoItem[]): string {
	if (items.length === 0) {
		return "No todos.";
	}

	const lines = items.map((item) => {
		const marker = {
			pending: "[ ]",
			in_progress: "[>]",
			completed: "[x]",
		}[item.status];
		const priority = item.priority ? ` (${item.priority})` : "";
		const suffix = item.status === "in_progress" && item.activeForm ? ` <- ${item.activeForm}` : "";
		return `${marker} #${item.id}: ${item.content}${priority}${suffix}`;
	});

	const done = items.filter((item) => item.status === "completed").length;
	lines.push(`\n(${done}/${items.length} completed)`);
	return lines.join("\n");
}

/**
 * 判断是否存在未完成任务。
 * @param items Todo 列表
 * @returns 是否有未完成项
 */
export function hasOpenTodos(items: TodoItem[]): boolean {
	return items.some((item) => item.status !== "completed");
}
