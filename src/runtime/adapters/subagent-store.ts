import type { SubagentJob, SubagentStore } from "../types";

/**
 * 基于内存的 SubagentStore。
 * Phase 2B 先固定 job 协议和查询形状，后续再换成 durable backend。
 */
export class InMemorySubagentStore implements SubagentStore {
	private readonly jobs = new Map<string, SubagentJob>();

	/**
	 * 创建子任务
	 * @param job 子任务对象
	 */
	async createJob(job: SubagentJob): Promise<void> {
		this.jobs.set(job.id, structuredClone(job));
	}

	/**
	 * 获取子任务
	 * @param jobId 子任务 id
	 * @returns 子任务副本
	 */
	async getJob(jobId: string): Promise<SubagentJob | null> {
		const job = this.jobs.get(jobId);
		return job ? structuredClone(job) : null;
	}

	/**
	 * 列出会话下的全部子任务
	 * @param sessionId 会话 id
	 * @returns 子任务列表
	 */
	async listJobsForSession(sessionId: string): Promise<SubagentJob[]> {
		return [...this.jobs.values()]
			.filter((job) => job.sessionId === sessionId)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
			.map((job) => structuredClone(job));
	}

	/**
	 * 更新子任务
	 * @param job 子任务对象
	 */
	async updateJob(job: SubagentJob): Promise<void> {
		this.jobs.set(job.id, structuredClone(job));
	}
}
