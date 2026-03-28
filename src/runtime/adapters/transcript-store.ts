import type { Message } from "../types";

/** transcript 存储接口 */
export interface TranscriptStore {
	/**
	 * 保存一份 transcript 快照
	 * @param sessionId 会话 id
	 * @param messages 消息列表
	 * @returns 可回读的 transcript 引用
	 */
	saveTranscript(sessionId: string, messages: Message[]): Promise<string>;
	/**
	 * 读取一份 transcript 快照
	 * @param ref transcript 引用
	 * @returns 原始消息快照
	 */
	loadTranscript(ref: string): Promise<Message[] | null>;
}

/**
 * 内存 transcript store。
 * Phase 2A 只固定外部引用语义，后续再切 durable backend。
 */
export class InMemoryTranscriptStore implements TranscriptStore {
	private readonly transcripts = new Map<string, Message[]>();

	/**
	 * 保存 transcript
	 * @param sessionId 会话 id
	 * @param messages 消息列表
	 * @returns transcript 引用
	 */
	async saveTranscript(sessionId: string, messages: Message[]): Promise<string> {
		const ref = `memory://${sessionId}/${Date.now()}`;
		this.transcripts.set(ref, structuredClone(messages));
		return ref;
	}

	/**
	 * 读取 transcript
	 * @param ref transcript 引用
	 * @returns 消息快照
	 */
	async loadTranscript(ref: string): Promise<Message[] | null> {
		const transcript = this.transcripts.get(ref);
		return transcript ? structuredClone(transcript) : null;
	}
}
