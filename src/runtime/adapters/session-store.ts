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
	 * 删除会话
	 * @param sessionId 会话 id
	 */
	async delete(sessionId: string): Promise<void> {
		this.sessions.delete(sessionId);
	}
}
