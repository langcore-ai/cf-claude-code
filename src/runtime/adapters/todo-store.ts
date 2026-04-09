import type { TodoItem, TodoStore } from "../types";

/**
 * 基于内存的 TodoStore。
 * 用于把当前 todo 列表从 session 快照中拆出后，保持内存态和 durable 边界一致。
 */
export class InMemoryTodoStore implements TodoStore {
	private readonly todos = new Map<string, TodoItem[]>();

	/**
	 * 保存会话 todo 快照
	 * @param sessionId 会话 id
	 * @param todos todo 列表
	 */
	async saveTodos(sessionId: string, todos: TodoItem[]): Promise<void> {
		this.todos.set(sessionId, structuredClone(todos));
	}

	/**
	 * 读取会话 todo 快照
	 * @param sessionId 会话 id
	 * @returns todo 列表；不存在时返回 null
	 */
	async loadTodos(sessionId: string): Promise<TodoItem[] | null> {
		const todos = this.todos.get(sessionId);
		return todos ? structuredClone(todos) : null;
	}

	/**
	 * 删除会话 todo 快照
	 * @param sessionId 会话 id
	 */
	async deleteTodos(sessionId: string): Promise<void> {
		this.todos.delete(sessionId);
	}
}
