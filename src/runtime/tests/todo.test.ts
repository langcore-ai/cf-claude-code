import { describe, expect, test } from "bun:test";

import { applyTodoWrite, hasOpenTodos, renderTodos } from "../domain";

describe("todo", () => {
	test("校验最多一个 in_progress", () => {
		expect(() =>
			applyTodoWrite({
				items: [
					{ id: "1", content: "a", status: "in_progress", activeForm: "doing a" },
					{ id: "2", content: "b", status: "in_progress", activeForm: "doing b" },
				],
			}),
		).toThrow("Only one todo item can be in progress");
	});

	test("渲染文本列表", () => {
		const todos = applyTodoWrite({
			items: [
				{ id: "1", content: "build core", status: "pending" },
				{ id: "2", content: "ship phase", status: "in_progress", activeForm: "writing tests" },
				{ id: "3", content: "announce", status: "completed" },
			],
		});

		const rendered = renderTodos(todos);
		expect(rendered).toContain("[ ] #1: build core");
		expect(rendered).toContain("[>] #2: ship phase <- writing tests");
		expect(rendered).toContain("[x] #3: announce");
		expect(rendered).toContain("(1/3 completed)");
		expect(hasOpenTodos(todos)).toBe(true);
	});

	test("进行中 todo 缺失 activeForm 时失败", () => {
		expect(() =>
			applyTodoWrite({
				items: [{ id: "1", content: "build core", status: "in_progress" }],
			}),
		).toThrow("In-progress todo item must include activeForm");
	});
});
