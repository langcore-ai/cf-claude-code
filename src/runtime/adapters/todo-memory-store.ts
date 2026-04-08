import type { TodoItem, TodoMemoryStore } from "../types";

/**
 * 基于内存的 TodoMemoryStore。
 * 用于保留会话最近一次非空 Todo 快照，模拟 Claude Code 的短期 Todo 记忆。
 */
export class InMemoryTodoMemoryStore implements TodoMemoryStore {
	private readonly todos = new Map<string, TodoItem[]>();

	/**
	 * 保存最新 Todo 快照
	 * @param sessionId 会话 id
	 * @param todos Todo 列表
	 */
	async saveLatestTodos(sessionId: string, todos: TodoItem[]): Promise<void> {
		this.todos.set(sessionId, structuredClone(todos));
	}

	/**
	 * 读取最新 Todo 快照
	 * @param sessionId 会话 id
	 * @returns Todo 列表
	 */
	async loadLatestTodos(sessionId: string): Promise<TodoItem[] | null> {
		const todos = this.todos.get(sessionId);
		return todos ? structuredClone(todos) : null;
	}
}
