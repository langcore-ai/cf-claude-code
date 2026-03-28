import { describe, expect, test } from "bun:test";

import { createTask, getTask, updateTask } from "../domain";

describe("tasks", () => {
	test("createTask 创建 open 状态任务", () => {
		const task = createTask({ title: "phase 1" });
		expect(task.title).toBe("phase 1");
		expect(task.status).toBe("open");
		expect(task.blockedBy).toEqual([]);
		expect(task.blocks).toEqual([]);
	});

	test("updateTask 更新状态", () => {
		const task = createTask({ title: "phase 1" });
		const tasks = updateTask([task], {
			id: task.id,
			status: "done",
		});

		expect(tasks[0]?.status).toBe("done");
	});

	test("addBlocks 会双向建立依赖", () => {
		const taskA = createTask({ title: "task a" });
		const taskB = createTask({ title: "task b" });

		const tasks = updateTask([taskA, taskB], {
			id: taskA.id,
			addBlocks: [taskB.id],
		});

		expect(getTask(tasks, taskA.id).blocks).toContain(taskB.id);
		expect(getTask(tasks, taskB.id).blockedBy).toContain(taskA.id);
	});

	test("done 会清理其他任务里的 blockedBy", () => {
		const taskA = createTask({ title: "task a" });
		const taskB = createTask({ title: "task b" });
		const linked = updateTask([taskA, taskB], {
			id: taskA.id,
			addBlocks: [taskB.id],
		});

		const completed = updateTask(linked, {
			id: taskA.id,
			status: "done",
		});

		expect(getTask(completed, taskB.id).blockedBy).not.toContain(taskA.id);
	});
});
