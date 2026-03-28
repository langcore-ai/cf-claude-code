import { nanoid } from "nanoid";
import { Hono, type Context } from "hono";

import { createOpenAiClient } from "../runtime/adapters";
import {
	createDurableRuntime,
	createMemoryRuntime,
	DEFAULT_SESSION_CONFIG,
	type MemoryAgentRuntime,
} from "../runtime";
import type { SessionState } from "../runtime";

/** Worker 侧 runtime 默认模型名 */
const DEFAULT_MODEL = "gpt-4.1-mini";

/** Worker 运行时 bindings */
export interface WorkerBindings {
	/** session / transcript / subagent jobs 的 D1 存储 */
	RUNTIME_DB: D1Database;
	/** OpenAI 兼容接口 API Key */
	OPENAI_API_KEY: string;
	/** OpenAI 兼容接口 Base URL */
	OPENAI_BASE_URL: string;
}

/** Worker 路由环境 */
type WorkerAppEnv<TBindings extends object> = {
	Bindings: TBindings;
};

/** Worker runtime 工厂 */
export type WorkerRuntimeFactory<TBindings extends object = WorkerBindings> = (
	env: TBindings,
	sessionId: string,
) => MemoryAgentRuntime;

/** 创建 session 请求体 */
interface CreateSessionBody {
	systemPrompt?: string;
	tokenThreshold?: number;
	maxTurnsPerMessage?: number;
}

/** 发送消息请求体 */
interface SendMessageBody {
	content: string;
}

/** 写文件请求体 */
interface WriteWorkspaceFileBody {
	path: string;
	content: string;
}

/** 复制/移动工作区节点请求体 */
interface WorkspacePathOperationBody {
	from: string;
	to: string;
}

/** 上传文件后的结果 */
interface UploadedWorkspaceFile {
	path: string;
	content: string;
	filename: string;
}

/** API 错误码 */
type ApiErrorCode = "SESSION_NOT_FOUND" | "INVALID_REQUEST" | "RUNTIME_ERROR";
/** 本地 dev 回退用的 memory runtime 注册表 */
const FALLBACK_MEMORY_RUNTIMES = new Map<string, MemoryAgentRuntime>();

/**
 * 为 session 派生稳定的 workspace 名称。
 * @param sessionId 会话 id
 * @returns workspace 名称
 */
function buildWorkspaceName(sessionId: string): string {
	return `session-${sessionId}`;
}

/**
 * 在本地 memory fallback 场景下聚合全部会话。
 *
 * `GET /api/sessions` 没有具体 sessionId，原本会用固定的 `__session_index__`
 * 去构造 runtime。对于 durable store 这没问题，但对按 sessionId 缓存的
 * memory fallback 来说，这个 runtime 看不到其他会话的内存 store。
 *
 * 因此在 dev fallback 时，需要把当前已缓存的 runtime 都扫一遍，再把 session 聚合出来。
 * @returns 会话快照列表
 */
async function listFallbackMemorySessions(): Promise<SessionState[]> {
	const sessions = await Promise.all(
		[...FALLBACK_MEMORY_RUNTIMES.entries()].map(async ([sessionId, runtime]) => {
			try {
				return await runtime.getSession(sessionId);
			} catch {
				return null;
			}
		}),
	);

	return sessions
		.filter((session): session is SessionState => session !== null)
		.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * 将 session 收敛为 HTTP 返回 DTO。
 * 首版刻意保持与 runtime 当前快照结构接近，避免无意义的二次映射。
 * @param session 会话快照
 * @returns session DTO
 */
function toSessionDto(session: SessionState) {
	return {
		id: session.id,
		config: session.config,
		messages: session.messages,
		todos: session.todos,
		tasks: session.tasks,
		compactSummary: session.compactSummary,
		transcriptRef: session.transcriptRef,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		closedAt: session.closedAt,
	};
}

/**
 * 返回统一错误响应。
 * @param c Hono context
 * @param status HTTP 状态码
 * @param code 错误码
 * @param message 错误信息
 */
function jsonError<TBindings extends object>(
	c: Context<WorkerAppEnv<TBindings>>,
	status: number,
	code: ApiErrorCode,
	message: string,
) {
	return c.json(
		{
			error: {
				code,
				message,
			},
		},
		status as 400 | 404 | 500,
	);
}

/**
 * 判断是否为会话不存在错误。
 * @param error 异常对象
 * @returns 是否匹配
 */
function isSessionNotFoundError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Session not found:");
}

/**
 * 读取并校验创建 session 的请求体。
 * @param body 原始 body
 * @returns 规范化后的配置
 */
function parseCreateSessionBody(body: unknown): CreateSessionBody {
	const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
	const parsed: CreateSessionBody = {};

	if (payload.systemPrompt !== undefined) {
		if (typeof payload.systemPrompt !== "string") {
			throw new Error("systemPrompt must be a string");
		}
		parsed.systemPrompt = payload.systemPrompt;
	}

	if (payload.tokenThreshold !== undefined) {
		if (typeof payload.tokenThreshold !== "number" || Number.isNaN(payload.tokenThreshold)) {
			throw new Error("tokenThreshold must be a number");
		}
		parsed.tokenThreshold = payload.tokenThreshold;
	}

	if (payload.maxTurnsPerMessage !== undefined) {
		if (typeof payload.maxTurnsPerMessage !== "number" || Number.isNaN(payload.maxTurnsPerMessage)) {
			throw new Error("maxTurnsPerMessage must be a number");
		}
		parsed.maxTurnsPerMessage = payload.maxTurnsPerMessage;
	}

	return parsed;
}

/**
 * 读取并校验发送消息请求体。
 * @param body 原始 body
 * @returns 规范化后的消息内容
 */
function parseSendMessageBody(body: unknown): SendMessageBody {
	const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : null;
	if (!payload || typeof payload.content !== "string" || payload.content.trim() === "") {
		throw new Error("content must be a non-empty string");
	}

	return {
		content: payload.content,
	};
}

/**
 * 读取并校验文件路径 query。
 * @param path 原始路径
 * @returns 规范化前的原始路径
 */
function parsePathQuery(path: string | undefined): string {
	if (!path || path.trim() === "") {
		throw new Error("path must be a non-empty string");
	}
	return path;
}

/**
 * 读取并校验写文件请求体。
 * @param body 原始 body
 * @returns 规范化后的文件写入参数
 */
function parseWriteWorkspaceFileBody(body: unknown): WriteWorkspaceFileBody {
	const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : null;
	if (!payload || typeof payload.path !== "string" || payload.path.trim() === "") {
		throw new Error("path must be a non-empty string");
	}
	if (typeof payload.content !== "string") {
		throw new Error("content must be a string");
	}

	return {
		path: payload.path,
		content: payload.content,
	};
}

/**
 * 读取并校验路径操作请求体。
 * @param body 原始 body
 * @returns 规范化后的源/目标路径
 */
function parseWorkspacePathOperationBody(body: unknown): WorkspacePathOperationBody {
	const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : null;
	if (!payload || typeof payload.from !== "string" || payload.from.trim() === "") {
		throw new Error("from must be a non-empty string");
	}
	if (typeof payload.to !== "string" || payload.to.trim() === "") {
		throw new Error("to must be a non-empty string");
	}

	return {
		from: payload.from,
		to: payload.to,
	};
}

/**
 * 将上传文件解析为工作区写入参数。
 * 当前首版只支持文本内容，后续如果需要二进制文件，可再扩展为 bytes 写入链路。
 * @param formData multipart form data
 * @returns 规范化后的上传结果
 */
async function parseWorkspaceUploadFormData(formData: FormData): Promise<UploadedWorkspaceFile> {
	const file = formData.get("file");
	if (!(file instanceof File)) {
		throw new Error("file is required");
	}

	const rawPath = formData.get("path");
	if (rawPath !== null && typeof rawPath !== "string") {
		throw new Error("path must be a string");
	}

	// 未显式指定路径时，默认把文件放到工作区根目录
	const path = rawPath && rawPath.trim() !== "" ? rawPath : `/${file.name}`;
	if (path.trim() === "") {
		throw new Error("path must be a non-empty string");
	}

	return {
		path,
		content: await file.text(),
		filename: file.name,
	};
}

/**
 * 创建默认 durable runtime。
 * @param env Worker bindings
 * @param sessionId 会话 id
 * @returns runtime 实例
 */
export function createWorkerRuntime(env: WorkerBindings, sessionId: string): MemoryAgentRuntime {
	const aiClient = createOpenAiClient({
		apiKey: env.OPENAI_API_KEY,
		baseURL: env.OPENAI_BASE_URL,
		model: DEFAULT_MODEL,
	});

	try {
		return createDurableRuntime({
			aiClient,
			sql: env.RUNTIME_DB,
			namespace: "runtime",
			workspaceName: buildWorkspaceName(sessionId),
		});
	} catch (error) {
		// 本地 dev 场景下，Cloudflare 绑定模拟偶尔会触发 `Invalid value used as weak map key`
		// 之类的初始化异常。这里退化到按 session 维度缓存的 memory runtime，保证 playground 可用。
		if (
			error instanceof Error &&
			error.message.includes("weak map key")
		) {
			const existing = FALLBACK_MEMORY_RUNTIMES.get(sessionId);
			if (existing) {
				return existing;
			}

			const runtime = createMemoryRuntime({
				aiClient,
				workspaceName: buildWorkspaceName(sessionId),
			});
			FALLBACK_MEMORY_RUNTIMES.set(sessionId, runtime);
			return runtime;
		}

		throw error;
	}
}

/**
 * 构建 Worker API。
 * @param runtimeFactory runtime 工厂；测试时可替换
 * @returns Hono 应用
 */
export function createApp<TBindings extends object = WorkerBindings>(
	runtimeFactory: WorkerRuntimeFactory<TBindings> = createWorkerRuntime as WorkerRuntimeFactory<TBindings>,
) {
	const app = new Hono<WorkerAppEnv<TBindings>>();

	app.get("/api/runtime/health", (c) =>
		c.json({
			ok: true,
			project: "cf-claude-code",
			stage: "phase-4a-worker-api",
			runtime: "durable-runtime",
		}),
	);

	app.post("/api/sessions", async (c) => {
		try {
			const sessionId = nanoid();
			const body = parseCreateSessionBody(await c.req.json().catch(() => ({})));
			const runtime = runtimeFactory(c.env, sessionId);
			await runtime.startSession({
				sessionId,
				config: {
					systemPrompt: body.systemPrompt ?? DEFAULT_SESSION_CONFIG.systemPrompt,
					tokenThreshold: body.tokenThreshold ?? DEFAULT_SESSION_CONFIG.tokenThreshold,
					maxTurnsPerMessage: body.maxTurnsPerMessage ?? DEFAULT_SESSION_CONFIG.maxTurnsPerMessage,
				},
			});
			const session = await runtime.getSession(sessionId);
			return c.json(
				{
					sessionId,
					session: toSessionDto(session),
				},
				201,
			);
		} catch (error) {
			if (error instanceof Error && /must be/.test(error.message)) {
				return jsonError(c, 400, "INVALID_REQUEST", error.message);
			}
			return jsonError(
				c,
				500,
				"RUNTIME_ERROR",
				error instanceof Error ? error.message : "Failed to create session",
			);
		}
	});

	app.get("/api/sessions", async (c) => {
		try {
			// session 列表不依赖某个已存在 sessionId，使用固定管理 workspace name 装配 runtime 即可。
			const runtime = runtimeFactory(c.env, "__session_index__");
			const sessions = await runtime.listSessions();
			const resolvedSessions =
				sessions.length > 0 ? sessions : await listFallbackMemorySessions();
			return c.json({
				sessions: resolvedSessions.map(toSessionDto),
			});
		} catch (error) {
			return jsonError(
				c,
				500,
				"RUNTIME_ERROR",
				error instanceof Error ? error.message : "Failed to list sessions",
			);
		}
	});

	app.get("/api/sessions/:sessionId", async (c) => {
		const sessionId = c.req.param("sessionId");
		try {
			const runtime = runtimeFactory(c.env, sessionId);
			const session = await runtime.getSession(sessionId);
			return c.json({
				sessionId,
				session: toSessionDto(session),
			});
		} catch (error) {
			if (isSessionNotFoundError(error)) {
				return jsonError(c, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
			}
			return jsonError(
				c,
				500,
				"RUNTIME_ERROR",
				error instanceof Error ? error.message : "Failed to fetch session",
			);
		}
	});

	app.post("/api/sessions/:sessionId/messages", async (c) => {
		const sessionId = c.req.param("sessionId");
		try {
			const body = parseSendMessageBody(await c.req.json().catch(() => null));
			const runtime = runtimeFactory(c.env, sessionId);
			await runtime.sendUserMessage(sessionId, body.content);
			const session = await runtime.getSession(sessionId);
			return c.json({
				sessionId,
				session: toSessionDto(session),
			});
		} catch (error) {
			if (error instanceof Error && error.message === "content must be a non-empty string") {
				return jsonError(c, 400, "INVALID_REQUEST", error.message);
			}
			if (isSessionNotFoundError(error)) {
				return jsonError(c, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
			}
			return jsonError(
				c,
				500,
				"RUNTIME_ERROR",
				error instanceof Error ? error.message : "Failed to send message",
			);
		}
	});

	app.post("/api/sessions/:sessionId/shutdown", async (c) => {
		const sessionId = c.req.param("sessionId");
		try {
			const runtime = runtimeFactory(c.env, sessionId);
			await runtime.shutdownSession(sessionId);
			return c.json({
				ok: true,
				sessionId,
			});
		} catch (error) {
			if (isSessionNotFoundError(error)) {
				return jsonError(c, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
			}
			return jsonError(
				c,
				500,
				"RUNTIME_ERROR",
				error instanceof Error ? error.message : "Failed to shutdown session",
			);
		}
	});

	app.get("/api/sessions/:sessionId/workspace/tree", async (c) => {
		const sessionId = c.req.param("sessionId");
		try {
			const path = parsePathQuery(c.req.query("path") ?? "/");
			const runtime = runtimeFactory(c.env, sessionId);
			const entries = await runtime.listWorkspace(sessionId, path);
			return c.json({
				sessionId,
				path,
				entries,
			});
		} catch (error) {
			if (error instanceof Error && error.message === "path must be a non-empty string") {
				return jsonError(c, 400, "INVALID_REQUEST", error.message);
			}
			if (isSessionNotFoundError(error)) {
				return jsonError(c, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
			}
			return jsonError(
				c,
				500,
				"RUNTIME_ERROR",
				error instanceof Error ? error.message : "Failed to list workspace",
			);
		}
	});

	app.get("/api/sessions/:sessionId/workspace/file", async (c) => {
		const sessionId = c.req.param("sessionId");
		try {
			const path = parsePathQuery(c.req.query("path"));
			const runtime = runtimeFactory(c.env, sessionId);
			const file = await runtime.readWorkspaceFile(sessionId, path);
			return c.json({
				sessionId,
				path: file.path,
				content: file.content,
			});
		} catch (error) {
			if (error instanceof Error && error.message === "path must be a non-empty string") {
				return jsonError(c, 400, "INVALID_REQUEST", error.message);
			}
			if (isSessionNotFoundError(error)) {
				return jsonError(c, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
			}
			return jsonError(
				c,
				500,
				"RUNTIME_ERROR",
				error instanceof Error ? error.message : "Failed to read workspace file",
			);
		}
	});

	app.put("/api/sessions/:sessionId/workspace/file", async (c) => {
		const sessionId = c.req.param("sessionId");
		try {
			const body = parseWriteWorkspaceFileBody(await c.req.json().catch(() => null));
			const runtime = runtimeFactory(c.env, sessionId);
			await runtime.writeWorkspaceFile(sessionId, body.path, body.content);
			return c.json({
				ok: true,
				sessionId,
				path: body.path,
			});
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message === "path must be a non-empty string" || error.message === "content must be a string")
			) {
				return jsonError(c, 400, "INVALID_REQUEST", error.message);
			}
			if (isSessionNotFoundError(error)) {
				return jsonError(c, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
			}
			return jsonError(
				c,
				500,
				"RUNTIME_ERROR",
				error instanceof Error ? error.message : "Failed to write workspace file",
			);
		}
	});

	app.get("/api/sessions/:sessionId/workspace/exists", async (c) => {
		const sessionId = c.req.param("sessionId");
		try {
			const path = parsePathQuery(c.req.query("path"));
			const runtime = runtimeFactory(c.env, sessionId);
			const exists = await runtime.workspaceExists(sessionId, path);
			return c.json({
				sessionId,
				path,
				exists,
			});
		} catch (error) {
			if (error instanceof Error && error.message === "path must be a non-empty string") {
				return jsonError(c, 400, "INVALID_REQUEST", error.message);
			}
			if (isSessionNotFoundError(error)) {
				return jsonError(c, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
			}
			return jsonError(
				c,
				500,
				"RUNTIME_ERROR",
				error instanceof Error ? error.message : "Failed to inspect workspace path",
			);
		}
	});

	app.post("/api/sessions/:sessionId/workspace/upload", async (c) => {
		const sessionId = c.req.param("sessionId");
		try {
			const upload = await parseWorkspaceUploadFormData(await c.req.formData());
			const runtime = runtimeFactory(c.env, sessionId);
			await runtime.writeWorkspaceFile(sessionId, upload.path, upload.content);
			return c.json({
				ok: true,
				sessionId,
				path: upload.path,
				filename: upload.filename,
			});
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message === "file is required" ||
					error.message === "path must be a string" ||
					error.message === "path must be a non-empty string")
			) {
				return jsonError(c, 400, "INVALID_REQUEST", error.message);
			}
			if (isSessionNotFoundError(error)) {
				return jsonError(c, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
			}
			return jsonError(
				c,
				500,
				"RUNTIME_ERROR",
				error instanceof Error ? error.message : "Failed to upload workspace file",
			);
		}
	});

	app.post("/api/sessions/:sessionId/workspace/copy", async (c) => {
		const sessionId = c.req.param("sessionId");
		try {
			const body = parseWorkspacePathOperationBody(await c.req.json().catch(() => null));
			const runtime = runtimeFactory(c.env, sessionId);
			await runtime.copyWorkspaceEntry(sessionId, body.from, body.to);
			return c.json({
				ok: true,
				sessionId,
				from: body.from,
				to: body.to,
			});
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message === "from must be a non-empty string" || error.message === "to must be a non-empty string")
			) {
				return jsonError(c, 400, "INVALID_REQUEST", error.message);
			}
			if (isSessionNotFoundError(error)) {
				return jsonError(c, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
			}
			return jsonError(
				c,
				500,
				"RUNTIME_ERROR",
				error instanceof Error ? error.message : "Failed to copy workspace entry",
			);
		}
	});

	app.post("/api/sessions/:sessionId/workspace/move", async (c) => {
		const sessionId = c.req.param("sessionId");
		try {
			const body = parseWorkspacePathOperationBody(await c.req.json().catch(() => null));
			const runtime = runtimeFactory(c.env, sessionId);
			await runtime.moveWorkspaceEntry(sessionId, body.from, body.to);
			return c.json({
				ok: true,
				sessionId,
				from: body.from,
				to: body.to,
			});
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message === "from must be a non-empty string" || error.message === "to must be a non-empty string")
			) {
				return jsonError(c, 400, "INVALID_REQUEST", error.message);
			}
			if (isSessionNotFoundError(error)) {
				return jsonError(c, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
			}
			return jsonError(
				c,
				500,
				"RUNTIME_ERROR",
				error instanceof Error ? error.message : "Failed to move workspace entry",
			);
		}
	});

	app.post("/api/sessions/:sessionId/workspace/rename", async (c) => {
		const sessionId = c.req.param("sessionId");
		try {
			const body = parseWorkspacePathOperationBody(await c.req.json().catch(() => null));
			const runtime = runtimeFactory(c.env, sessionId);
			await runtime.moveWorkspaceEntry(sessionId, body.from, body.to);
			return c.json({
				ok: true,
				sessionId,
				from: body.from,
				to: body.to,
			});
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message === "from must be a non-empty string" || error.message === "to must be a non-empty string")
			) {
				return jsonError(c, 400, "INVALID_REQUEST", error.message);
			}
			if (isSessionNotFoundError(error)) {
				return jsonError(c, 404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
			}
			return jsonError(
				c,
				500,
				"RUNTIME_ERROR",
				error instanceof Error ? error.message : "Failed to rename workspace entry",
			);
		}
	});

	return app;
}

export default createApp();
