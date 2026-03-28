import type { SessionState, SessionStore } from "../types";

/**
 * 基于内存的 SessionStore。
 * Phase 1 用它固定持久化接口形状，后续再替换为 D1 实现。
 */
export class InMemorySessionStore implements SessionStore {
	private readonly sessions = new Map<string, SessionState>();

	/**
	 * 保存会话快照
	 * @param session 会话状态
	 */
	async save(session: SessionState): Promise<void> {
		this.sessions.set(session.id, structuredClone(session));
	}

	/**
	 * 读取会话快照
	 * @param sessionId 会话 id
	 * @returns 会话状态副本
	 */
	async load(sessionId: string): Promise<SessionState | null> {
		const session = this.sessions.get(sessionId);
		return session ? structuredClone(session) : null;
	}

	/**
	 * 列出全部会话。
	 * 当前先固定按 id 排序，避免本地/持久化后端出现不一致顺序。
	 * @returns 会话快照列表
	 */
	async list(): Promise<SessionState[]> {
		return [...this.sessions.values()]
			.map((session) => structuredClone(session))
			.sort((left, right) => left.id.localeCompare(right.id));
	}

	/**
	 * 删除会话
	 * @param sessionId 会话 id
	 */
	async delete(sessionId: string): Promise<void> {
		this.sessions.delete(sessionId);
	}
}
