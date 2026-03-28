import { nanoid } from "nanoid";

import type { RuntimeTask, TaskStatus } from "../types";

/** task 创建输入 */
export interface CreateTaskInput {
	/** 标题 */
	title: string;
	/** 描述 */
	description?: string;
}

/** task 更新输入 */
export interface UpdateTaskInput {
	/** 任务 id */
	id: string;
	/** 标题 */
	title?: string;
	/** 描述 */
	description?: string;
	/** 状态 */
	status?: TaskStatus;
	/** 新增 blockedBy 依赖 */
	addBlockedBy?: string[];
	/** 新增 blocks 依赖 */
	addBlocks?: string[];
}

/**
 * 创建一个最小 task。
 * @param input 创建输入
 * @returns 新 task
 */
export function createTask(input: CreateTaskInput): RuntimeTask {
	const now = new Date().toISOString();
	return {
		id: nanoid(),
		title: input.title.trim(),
		description: input.description?.trim(),
		status: "open",
		blockedBy: [],
		blocks: [],
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * 获取单个任务
 * @param tasks 任务列表
 * @param taskId 任务 id
 * @returns 任务对象
 */
export function getTask(tasks: RuntimeTask[], taskId: string): RuntimeTask {
	const task = tasks.find((item) => item.id === taskId);
	if (!task) {
		throw new Error(`Task not found: ${taskId}`);
	}
	return task;
}

/**
 * 更新最小 task。
 * @param tasks 任务列表
 * @param input 更新输入
 * @returns 更新后的任务列表
 */
export function updateTask(tasks: RuntimeTask[], input: UpdateTaskInput): RuntimeTask[] {
	let found = false;
	const updated = tasks.map((task) => {
		if (task.id !== input.id) {
			return task;
		}

		found = true;
		const addBlockedBy = [...new Set([...(task.blockedBy ?? []), ...(input.addBlockedBy ?? [])])];
		const addBlocks = [...new Set([...(task.blocks ?? []), ...(input.addBlocks ?? [])])];
		return {
			...task,
			title: input.title?.trim() || task.title,
			description: input.description === undefined ? task.description : input.description.trim(),
			status: input.status ?? task.status,
			blockedBy: addBlockedBy,
			blocks: addBlocks,
			updatedAt: new Date().toISOString(),
		};
	});

	if (!found) {
		throw new Error(`Task not found: ${input.id}`);
	}

	const linked = updated.map((task) => {
		if (!input.addBlocks?.includes(task.id)) {
			return task;
		}

		return {
			...task,
			blockedBy: [...new Set([...(task.blockedBy ?? []), input.id])],
			updatedAt: new Date().toISOString(),
		};
	});

	if (input.status !== "done") {
		return linked;
	}

	return linked.map((task) => ({
		...task,
		blockedBy: task.blockedBy.filter((taskId) => taskId !== input.id),
	}));
}
