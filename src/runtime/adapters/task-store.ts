import type { RuntimeTask, TaskStore } from "../types";

/**
 * 基于内存的 TaskStore。
 * 用于把 task 从 session 快照中拆出后，保持本地运行时的持久化边界一致。
 */
export class InMemoryTaskStore implements TaskStore {
	private readonly tasks = new Map<string, RuntimeTask[]>();

	/**
	 * 保存会话 task 快照
	 * @param sessionId 会话 id
	 * @param tasks task 列表
	 */
	async saveTasks(sessionId: string, tasks: RuntimeTask[]): Promise<void> {
		this.tasks.set(sessionId, structuredClone(tasks));
	}

	/**
	 * 读取会话 task 快照
	 * @param sessionId 会话 id
	 * @returns task 列表；不存在时返回 null
	 */
	async loadTasks(sessionId: string): Promise<RuntimeTask[] | null> {
		const tasks = this.tasks.get(sessionId);
		return tasks ? structuredClone(tasks) : null;
	}

	/**
	 * 删除会话 task 快照
	 * @param sessionId 会话 id
	 */
	async deleteTasks(sessionId: string): Promise<void> {
		this.tasks.delete(sessionId);
	}
}
