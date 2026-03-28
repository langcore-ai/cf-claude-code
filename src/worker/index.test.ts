import { describe, expect, test } from "bun:test";

import { createMemoryRuntime, DEFAULT_SESSION_CONFIG, type MemoryAgentRuntime } from "../runtime";
import { createApp, type WorkerRuntimeFactory } from "./index";

/** 测试用 bindings */
type TestBindings = {
	TEST_ONLY?: true;
};

/**
 * 创建测试用 runtime factory。
 * 为了模拟 Worker 多次请求间的恢复行为，这里复用同一个 runtime 实例。
 * 这样 `GET /api/sessions` 才能看到同一 store 中保存的全部会话。
 * @returns 可复用 runtime 工厂
 */
function createTestRuntimeFactory(): WorkerRuntimeFactory<TestBindings> {
	let runtime: MemoryAgentRuntime | null = null;
	let turn = 0;
	return (_env, sessionId) => {
		if (runtime) {
			return runtime;
		}

		runtime = createMemoryRuntime({
			aiClient: {
				async generateTurn() {
					turn += 1;
					if (turn === 1) {
						return {
							stopReason: "tool_use",
							content: [
								{
									type: "tool_use" as const,
									id: "tool-1",
									name: "write_file",
									input: {
										path: "/notes.txt",
										content: "hello from api",
									},
								},
							],
						};
					}

					return {
						stopReason: "end_turn" as const,
						content: [{ type: "text" as const, text: "done" }],
					};
				},
			},
			workspaceName: `session-${sessionId}`,
		});
		return runtime;
	};
}

describe("worker api", () => {
	test("POST /api/sessions 使用默认配置创建 session", async () => {
		const app = createApp(createTestRuntimeFactory());
		const response = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		expect(response.status).toBe(201);
		const payload = await response.json() as { sessionId: string; session: { config: { systemPrompt: string } } };
		expect(payload.sessionId).toBeString();
		expect(payload.session.config.systemPrompt).toBe(DEFAULT_SESSION_CONFIG.systemPrompt);
	});

	test("POST /api/sessions 接受自定义配置", async () => {
		const app = createApp(createTestRuntimeFactory());
		const response = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				systemPrompt: "custom",
				tokenThreshold: 111,
				maxTurnsPerMessage: 9,
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		expect(response.status).toBe(201);
		const payload = await response.json() as {
			session: { config: { systemPrompt: string; tokenThreshold: number; maxTurnsPerMessage: number } };
		};
		expect(payload.session.config.systemPrompt).toBe("custom");
		expect(payload.session.config.tokenThreshold).toBe(111);
		expect(payload.session.config.maxTurnsPerMessage).toBe(9);
	});

	test("GET /api/sessions/:id 返回已存在 session", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		const response = await app.request(`http://local/api/sessions/${created.sessionId}`, {}, {
			TEST_ONLY: true,
		});

		expect(response.status).toBe(200);
		const payload = await response.json() as { session: { id: string } };
		expect(payload.session.id).toBe(created.sessionId);
	});

	test("GET /api/sessions 返回已持久化的 session 列表", async () => {
		const app = createApp(createTestRuntimeFactory());

		const firstCreateResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const firstSession = await firstCreateResponse.json() as { sessionId: string };

		const secondCreateResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				systemPrompt: "second",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const secondSession = await secondCreateResponse.json() as { sessionId: string };

		const response = await app.request("http://local/api/sessions", {}, {
			TEST_ONLY: true,
		});

		expect(response.status).toBe(200);
		const payload = await response.json() as {
			sessions: Array<{ id: string }>;
		};
		expect(payload.sessions.length).toBe(2);
		expect(payload.sessions.map((session) => session.id)).toContain(firstSession.sessionId);
		expect(payload.sessions.map((session) => session.id)).toContain(secondSession.sessionId);
	});

	test("GET /api/sessions/:id 对不存在 session 返回 404", async () => {
		const app = createApp(createTestRuntimeFactory());
		const response = await app.request("http://local/api/sessions/missing", {}, {
			TEST_ONLY: true,
		});

		expect(response.status).toBe(404);
		const payload = await response.json() as { error: { code: string } };
		expect(payload.error.code).toBe("SESSION_NOT_FOUND");
	});

	test("POST /api/sessions/:id/messages 同步驱动 loop 并返回快照", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		const response = await app.request(`http://local/api/sessions/${created.sessionId}/messages`, {
			method: "POST",
			body: JSON.stringify({
				content: "create note",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		expect(response.status).toBe(200);
		const payload = await response.json() as {
			session: { messages: Array<{ content: Array<{ type: string }> }> };
		};
		expect(
			payload.session.messages.some((message: { content: Array<{ type: string }> }) =>
				message.content.some((block) => block.type === "tool_result"),
			),
		).toBe(true);
	});

	test("POST /api/sessions/:id/messages 对空 content 返回 400", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		const response = await app.request(`http://local/api/sessions/${created.sessionId}/messages`, {
			method: "POST",
			body: JSON.stringify({
				content: "",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		expect(response.status).toBe(400);
		const payload = await response.json() as { error: { code: string } };
		expect(payload.error.code).toBe("INVALID_REQUEST");
	});

	test("POST /api/sessions/:id/messages 对不存在 session 返回 404", async () => {
		const app = createApp(createTestRuntimeFactory());
		const response = await app.request("http://local/api/sessions/missing/messages", {
			method: "POST",
			body: JSON.stringify({
				content: "hi",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		expect(response.status).toBe(404);
		const payload = await response.json() as { error: { code: string } };
		expect(payload.error.code).toBe("SESSION_NOT_FOUND");
	});

	test("POST /api/sessions/:id/shutdown 可关闭 session", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		const response = await app.request(`http://local/api/sessions/${created.sessionId}/shutdown`, {
			method: "POST",
		}, {
			TEST_ONLY: true,
		});

		expect(response.status).toBe(200);
		const payload = await response.json() as { ok: boolean };
		expect(payload.ok).toBe(true);
	});

	test("同一 session 在多次请求之间保持状态", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		await app.request(`http://local/api/sessions/${created.sessionId}/messages`, {
			method: "POST",
			body: JSON.stringify({
				content: "persist note",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		const response = await app.request(`http://local/api/sessions/${created.sessionId}`, {}, {
			TEST_ONLY: true,
		});
		const payload = await response.json() as {
			session: { messages: Array<{ content: Array<{ type: string; content?: string }> }> };
		};
		expect(
			payload.session.messages.some((message: { content: Array<{ type: string; content?: string }> }) =>
				message.content.some((block) => block.type === "tool_result" && block.content?.includes("Wrote file")),
			),
		).toBe(true);
	});

	test("GET /api/sessions/:id/workspace/tree 返回目录子节点", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		await app.request(`http://local/api/sessions/${created.sessionId}/workspace/file`, {
			method: "PUT",
			body: JSON.stringify({
				path: "/docs/guide.txt",
				content: "workspace docs",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		const response = await app.request(
			`http://local/api/sessions/${created.sessionId}/workspace/tree?path=${encodeURIComponent("/")}`,
			{},
			{ TEST_ONLY: true },
		);

		expect(response.status).toBe(200);
		const payload = await response.json() as {
			sessionId: string;
			path: string;
			entries: Array<{ path: string; type: string }>;
		};
		expect(payload.sessionId).toBe(created.sessionId);
		expect(payload.path).toBe("/");
		expect(payload.entries).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "/docs", type: "directory" })]),
		);
	});

	test("GET /api/sessions/:id/workspace/file 读取文件内容", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		await app.request(`http://local/api/sessions/${created.sessionId}/workspace/file`, {
			method: "PUT",
			body: JSON.stringify({
				path: "/notes.txt",
				content: "draft v1",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		const response = await app.request(
			`http://local/api/sessions/${created.sessionId}/workspace/file?path=${encodeURIComponent("/notes.txt")}`,
			{},
			{ TEST_ONLY: true },
		);

		expect(response.status).toBe(200);
		const payload = await response.json() as {
			sessionId: string;
			path: string;
			content: string;
		};
		expect(payload.sessionId).toBe(created.sessionId);
		expect(payload.path).toBe("/notes.txt");
		expect(payload.content).toBe("draft v1");
	});

	test("PUT /api/sessions/:id/workspace/file 手动写入文件内容", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		const writeResponse = await app.request(`http://local/api/sessions/${created.sessionId}/workspace/file`, {
			method: "PUT",
			body: JSON.stringify({
				path: "/notes.txt",
				content: "saved by editor",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		expect(writeResponse.status).toBe(200);
		expect(await writeResponse.json()).toEqual({
			ok: true,
			sessionId: created.sessionId,
			path: "/notes.txt",
		});

		const readResponse = await app.request(
			`http://local/api/sessions/${created.sessionId}/workspace/file?path=${encodeURIComponent("/notes.txt")}`,
			{},
			{ TEST_ONLY: true },
		);
		const readPayload = await readResponse.json() as { content: string };
		expect(readPayload.content).toBe("saved by editor");
	});

	test("GET /api/sessions/:id/workspace/exists 返回文件存在状态", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		await app.request(`http://local/api/sessions/${created.sessionId}/workspace/file`, {
			method: "PUT",
			body: JSON.stringify({
				path: "/notes.txt",
				content: "exists",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		const response = await app.request(
			`http://local/api/sessions/${created.sessionId}/workspace/exists?path=${encodeURIComponent("/notes.txt")}`,
			{},
			{ TEST_ONLY: true },
		);

		expect(response.status).toBe(200);
		const payload = await response.json() as {
			sessionId: string;
			path: string;
			exists: boolean;
		};
		expect(payload.sessionId).toBe(created.sessionId);
		expect(payload.path).toBe("/notes.txt");
		expect(payload.exists).toBe(true);
	});

	test("workspace API 对非法请求返回 400", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		const readResponse = await app.request(
			`http://local/api/sessions/${created.sessionId}/workspace/file`,
			{},
			{ TEST_ONLY: true },
		);
		expect(readResponse.status).toBe(400);
		expect(await readResponse.json()).toEqual({
			error: { message: "path must be a non-empty string", code: "INVALID_REQUEST" },
		});

		const writeResponse = await app.request(`http://local/api/sessions/${created.sessionId}/workspace/file`, {
			method: "PUT",
			body: JSON.stringify({
				path: "/notes.txt",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		expect(writeResponse.status).toBe(400);
		expect(await writeResponse.json()).toEqual({
			error: { message: "content must be a string", code: "INVALID_REQUEST" },
		});
	});

	test("workspace API 对不存在 session 返回 404", async () => {
		const app = createApp(createTestRuntimeFactory());
		const response = await app.request(
			`http://local/api/sessions/missing/workspace/file?path=${encodeURIComponent("/notes.txt")}`,
			{},
			{ TEST_ONLY: true },
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: { message: "Session not found: missing", code: "SESSION_NOT_FOUND" },
		});
	});

	test("POST /api/sessions/:id/workspace/upload 上传文本文件到工作区", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		const formData = new FormData();
		formData.set("file", new File(["uploaded content"], "upload.txt", { type: "text/plain" }));
		formData.set("path", "/uploads/upload.txt");

		const uploadResponse = await app.request(
			`http://local/api/sessions/${created.sessionId}/workspace/upload`,
			{
				method: "POST",
				body: formData,
			},
			{ TEST_ONLY: true },
		);

		expect(uploadResponse.status).toBe(200);
		expect(await uploadResponse.json()).toEqual({
			ok: true,
			sessionId: created.sessionId,
			path: "/uploads/upload.txt",
			filename: "upload.txt",
		});

		const readResponse = await app.request(
			`http://local/api/sessions/${created.sessionId}/workspace/file?path=${encodeURIComponent("/uploads/upload.txt")}`,
			{},
			{ TEST_ONLY: true },
		);
		expect(readResponse.status).toBe(200);
		const readPayload = await readResponse.json() as { content: string };
		expect(readPayload.content).toBe("uploaded content");
	});

	test("workspace upload 缺少文件时返回 400", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		const formData = new FormData();
		formData.set("path", "/uploads/missing.txt");

		const response = await app.request(
			`http://local/api/sessions/${created.sessionId}/workspace/upload`,
			{
				method: "POST",
				body: formData,
			},
			{ TEST_ONLY: true },
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: { message: "file is required", code: "INVALID_REQUEST" },
		});
	});

	test("POST /api/sessions/:id/workspace/copy 复制文件", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		await app.request(`http://local/api/sessions/${created.sessionId}/workspace/file`, {
			method: "PUT",
			body: JSON.stringify({
				path: "/docs/source.txt",
				content: "copy me",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		const copyResponse = await app.request(`http://local/api/sessions/${created.sessionId}/workspace/copy`, {
			method: "POST",
			body: JSON.stringify({
				from: "/docs/source.txt",
				to: "/docs/copied.txt",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		expect(copyResponse.status).toBe(200);

		const sourceResponse = await app.request(
			`http://local/api/sessions/${created.sessionId}/workspace/file?path=${encodeURIComponent("/docs/source.txt")}`,
			{},
			{ TEST_ONLY: true },
		);
		const copiedResponse = await app.request(
			`http://local/api/sessions/${created.sessionId}/workspace/file?path=${encodeURIComponent("/docs/copied.txt")}`,
			{},
			{ TEST_ONLY: true },
		);

		expect(sourceResponse.status).toBe(200);
		expect(copiedResponse.status).toBe(200);
		expect((await copiedResponse.json() as { content: string }).content).toBe("copy me");
	});

	test("POST /api/sessions/:id/workspace/move 移动文件", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		await app.request(`http://local/api/sessions/${created.sessionId}/workspace/file`, {
			method: "PUT",
			body: JSON.stringify({
				path: "/docs/source.txt",
				content: "move me",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		const moveResponse = await app.request(`http://local/api/sessions/${created.sessionId}/workspace/move`, {
			method: "POST",
			body: JSON.stringify({
				from: "/docs/source.txt",
				to: "/archive/source.txt",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		expect(moveResponse.status).toBe(200);

		const sourceExistsResponse = await app.request(
			`http://local/api/sessions/${created.sessionId}/workspace/exists?path=${encodeURIComponent("/docs/source.txt")}`,
			{},
			{ TEST_ONLY: true },
		);
		const targetReadResponse = await app.request(
			`http://local/api/sessions/${created.sessionId}/workspace/file?path=${encodeURIComponent("/archive/source.txt")}`,
			{},
			{ TEST_ONLY: true },
		);

		expect((await sourceExistsResponse.json() as { exists: boolean }).exists).toBe(false);
		expect(targetReadResponse.status).toBe(200);
		expect((await targetReadResponse.json() as { content: string }).content).toBe("move me");
	});

	test("POST /api/sessions/:id/workspace/rename 重命名文件", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		await app.request(`http://local/api/sessions/${created.sessionId}/workspace/file`, {
			method: "PUT",
			body: JSON.stringify({
				path: "/notes.txt",
				content: "rename me",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		const renameResponse = await app.request(`http://local/api/sessions/${created.sessionId}/workspace/rename`, {
			method: "POST",
			body: JSON.stringify({
				from: "/notes.txt",
				to: "/notes-renamed.txt",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		expect(renameResponse.status).toBe(200);

		const renamedResponse = await app.request(
			`http://local/api/sessions/${created.sessionId}/workspace/file?path=${encodeURIComponent("/notes-renamed.txt")}`,
			{},
			{ TEST_ONLY: true },
		);
		expect(renamedResponse.status).toBe(200);
		expect((await renamedResponse.json() as { content: string }).content).toBe("rename me");
	});

	test("workspace path operation 缺少 from/to 时返回 400", async () => {
		const app = createApp(createTestRuntimeFactory());
		const createResponse = await app.request("http://local/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});
		const created = await createResponse.json() as { sessionId: string };

		const response = await app.request(`http://local/api/sessions/${created.sessionId}/workspace/move`, {
			method: "POST",
			body: JSON.stringify({
				from: "/a.txt",
			}),
			headers: {
				"content-type": "application/json",
			},
		}, {
			TEST_ONLY: true,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: { message: "to must be a non-empty string", code: "INVALID_REQUEST" },
		});
	});
});
