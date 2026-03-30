import type {
	Message,
	RuntimeTask,
	SessionConfig,
	TodoItem,
} from "@/runtime/types/runtime";

/** Session HTTP DTO */
export interface RuntimeSessionDto {
	/** 会话 id */
	id: string;
	/** 会话配置 */
	config: SessionConfig;
	/** 当前消息列表 */
	messages: Message[];
	/** Todo 列表 */
	todos: TodoItem[];
	/** Task 列表 */
	tasks: RuntimeTask[];
	/** compact 摘要 */
	compactSummary?: string;
	/** transcript 外部引用 */
	transcriptRef?: string;
	/** 创建时间 */
	createdAt: string;
	/** 更新时间 */
	updatedAt: string;
	/** 关闭时间 */
	closedAt?: string;
}

/** create/get session 的通用响应 */
interface SessionResponse {
	/** 会话 id */
	sessionId: string;
	/** 会话快照 */
	session: RuntimeSessionDto;
}

/** 列出 sessions 的响应 */
interface SessionListResponse {
	/** 会话快照列表 */
	sessions: RuntimeSessionDto[];
}

/** 关闭会话响应 */
interface ShutdownSessionResponse {
	/** 是否成功 */
	ok: true;
	/** 会话 id */
	sessionId: string;
}

/** Worker API 错误形状 */
interface ApiErrorResponse {
	error: {
		code: string;
		message: string;
	};
}

/** Runtime API 基础路径 */
const RUNTIME_API_BASE = "/api";

/** 工作区节点类型 */
export type WorkspaceEntryType = "file" | "directory" | "symlink";

/** Worker 返回的工作区条目 */
export interface WorkspaceEntryDto {
	/** 绝对路径 */
	path: string;
	/** 节点类型 */
	type: WorkspaceEntryType;
}

/** 列树响应 */
interface WorkspaceTreeResponse {
	/** 会话 id */
	sessionId: string;
	/** 当前列出的目录 */
	path: string;
	/** 目录直接子节点 */
	entries: WorkspaceEntryDto[];
}

/** 文件读取响应 */
interface WorkspaceFileResponse {
	/** 会话 id */
	sessionId: string;
	/** 文件路径 */
	path: string;
	/** 文件内容 */
	content: string;
}

/** 上传文件响应 */
interface WorkspaceUploadResponse {
	/** 是否成功 */
	ok: true;
	/** 会话 id */
	sessionId: string;
	/** 工作区路径 */
	path: string;
	/** 原始文件名 */
	filename: string;
}

/** 工作区路径操作响应 */
interface WorkspacePathOperationResponse {
	/** 是否成功 */
	ok: true;
	/** 会话 id */
	sessionId: string;
	/** 源路径 */
	from: string;
	/** 目标路径 */
	to: string;
}

/** 删除工作区节点响应 */
interface WorkspaceDeleteResponse {
	/** 是否成功 */
	ok: true;
	/** 会话 id */
	sessionId: string;
	/** 删除路径 */
	path: string;
}

/** 创建目录响应 */
interface WorkspaceMkdirResponse {
	/** 是否成功 */
	ok: true;
	/** 会话 id */
	sessionId: string;
	/** 目录路径 */
	path: string;
}

/**
 * 发起 JSON 请求，并在 Worker 返回错误时抛出带 message 的异常。
 * @param input 请求地址
 * @param init 请求参数
 * @returns 反序列化 JSON
 */
async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
	const response = await fetch(input, init);
	if (!response.ok) {
		const payload = await response.json().catch(() => null) as ApiErrorResponse | null;
		throw new Error(payload?.error.message ?? `Request failed with status ${response.status}`);
	}
	return response.json() as Promise<T>;
}

/**
 * 创建新 session。
 * @returns 创建后的会话响应
 */
export async function createSession(): Promise<SessionResponse> {
	return requestJson<SessionResponse>(`${RUNTIME_API_BASE}/sessions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify({}),
	});
}

/**
 * 获取 session 快照。
 * @param sessionId 会话 id
 * @returns 会话响应
 */
export async function getSession(sessionId: string): Promise<SessionResponse> {
	return requestJson<SessionResponse>(`${RUNTIME_API_BASE}/sessions/${sessionId}`);
}

/**
 * 列出全部 session。
 * @returns 会话列表
 */
export async function listSessions(): Promise<SessionListResponse> {
	return requestJson<SessionListResponse>(`${RUNTIME_API_BASE}/sessions`);
}

/**
 * 发送用户消息并同步拿回最新 session。
 * @param sessionId 会话 id
 * @param content 消息内容
 * @returns 最新会话响应
 */
export async function sendMessage(
	sessionId: string,
	content: string,
): Promise<SessionResponse> {
	return requestJson<SessionResponse>(`${RUNTIME_API_BASE}/sessions/${sessionId}/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify({ content }),
	});
}

/**
 * 关闭会话。
 * @param sessionId 会话 id
 * @returns 关闭结果
 */
export async function shutdownSession(
	sessionId: string,
): Promise<ShutdownSessionResponse> {
	return requestJson<ShutdownSessionResponse>(`${RUNTIME_API_BASE}/sessions/${sessionId}/shutdown`, {
		method: "POST",
	});
}

/**
 * 列出工作区目录的直接子节点。
 * @param sessionId 会话 id
 * @param path 目标目录
 * @returns 目录树结果
 */
export async function listWorkspaceTree(
	sessionId: string,
	path = "/",
): Promise<WorkspaceTreeResponse> {
	const search = new URLSearchParams({
		path,
	});
	return requestJson<WorkspaceTreeResponse>(
		`${RUNTIME_API_BASE}/sessions/${sessionId}/workspace/tree?${search.toString()}`,
	);
}

/**
 * 读取工作区文件内容。
 * @param sessionId 会话 id
 * @param path 文件路径
 * @returns 文件内容
 */
export async function readWorkspaceFile(
	sessionId: string,
	path: string,
): Promise<WorkspaceFileResponse> {
	const search = new URLSearchParams({
		path,
	});
	return requestJson<WorkspaceFileResponse>(
		`${RUNTIME_API_BASE}/sessions/${sessionId}/workspace/file?${search.toString()}`,
	);
}

/**
 * 手动写入工作区文件内容。
 * @param sessionId 会话 id
 * @param path 文件路径
 * @param content 文件内容
 * @returns 写入结果
 */
export async function writeWorkspaceFile(
	sessionId: string,
	path: string,
	content: string,
): Promise<{ ok: true; sessionId: string; path: string }> {
	return requestJson<{ ok: true; sessionId: string; path: string }>(
		`${RUNTIME_API_BASE}/sessions/${sessionId}/workspace/file`,
		{
			method: "PUT",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({ path, content }),
		},
	);
}

/**
 * 上传文件到当前工作区。
 * @param sessionId 会话 id
 * @param file 目标文件
 * @param path 可选目标路径
 * @returns 上传结果
 */
export async function uploadWorkspaceFile(
	sessionId: string,
	file: File,
	path?: string,
): Promise<WorkspaceUploadResponse> {
	const formData = new FormData();
	formData.set("file", file);
	if (path) {
		formData.set("path", path);
	}

	return requestJson<WorkspaceUploadResponse>(
		`${RUNTIME_API_BASE}/sessions/${sessionId}/workspace/upload`,
		{
			method: "POST",
			body: formData,
		},
	);
}

/**
 * 复制工作区节点。
 * @param sessionId 会话 id
 * @param from 源路径
 * @param to 目标路径
 * @returns 路径操作结果
 */
export async function copyWorkspaceEntry(
	sessionId: string,
	from: string,
	to: string,
): Promise<WorkspacePathOperationResponse> {
	return requestJson<WorkspacePathOperationResponse>(
		`${RUNTIME_API_BASE}/sessions/${sessionId}/workspace/copy`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({ from, to }),
		},
	);
}

/**
 * 移动工作区节点。
 * @param sessionId 会话 id
 * @param from 源路径
 * @param to 目标路径
 * @returns 路径操作结果
 */
export async function moveWorkspaceEntry(
	sessionId: string,
	from: string,
	to: string,
): Promise<WorkspacePathOperationResponse> {
	return requestJson<WorkspacePathOperationResponse>(
		`${RUNTIME_API_BASE}/sessions/${sessionId}/workspace/move`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({ from, to }),
		},
	);
}

/**
 * 重命名工作区节点。
 * @param sessionId 会话 id
 * @param from 源路径
 * @param to 目标路径
 * @returns 路径操作结果
 */
export async function renameWorkspaceEntry(
	sessionId: string,
	from: string,
	to: string,
): Promise<WorkspacePathOperationResponse> {
	return requestJson<WorkspacePathOperationResponse>(
		`${RUNTIME_API_BASE}/sessions/${sessionId}/workspace/rename`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({ from, to }),
		},
	);
}

/**
 * 删除工作区节点。
 * @param sessionId 会话 id
 * @param path 目标路径
 * @returns 删除结果
 */
export async function deleteWorkspaceEntry(
	sessionId: string,
	path: string,
): Promise<WorkspaceDeleteResponse> {
	const search = new URLSearchParams({ path });
	return requestJson<WorkspaceDeleteResponse>(
		`${RUNTIME_API_BASE}/sessions/${sessionId}/workspace/entry?${search.toString()}`,
		{
			method: "DELETE",
		},
	);
}

/**
 * 在工作区中创建目录。
 * @param sessionId 会话 id
 * @param path 目录路径
 * @returns 创建结果
 */
export async function createWorkspaceDirectory(
	sessionId: string,
	path: string,
): Promise<WorkspaceMkdirResponse> {
	return requestJson<WorkspaceMkdirResponse>(
		`${RUNTIME_API_BASE}/sessions/${sessionId}/workspace/mkdir`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({ path }),
		},
	);
}
