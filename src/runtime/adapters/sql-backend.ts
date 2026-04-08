import type { SqlBackend, SqlParam, SqlSource } from "@cloudflare/shell";

import type {
	Message,
	RuntimeTask,
	SessionState,
	SessionStore,
	SubagentJob,
	SubagentStore,
	TaskStore,
	TodoItem,
	TodoMemoryStore,
} from "../types";
import type { TranscriptStore } from "./transcript-store";

/** 运行时 SQL 命名空间配置 */
export interface SqlNamespaceOptions {
	/** 表名前缀 */
	namespace?: string;
}

/** 最小 D1 预处理语句接口 */
interface D1PreparedStatementLike {
	bind(...values: unknown[]): D1PreparedStatementLike;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
	run(): Promise<unknown>;
}

/** 最小 D1 数据库接口 */
interface D1DatabaseLike {
	prepare(query: string): D1PreparedStatementLike;
}

/** 规范化后的 SQL backend */
export interface RuntimeSqlBackend {
	query<T = Record<string, SqlParam>>(sql: string, ...params: SqlParam[]): Promise<T[]>;
	run(sql: string, ...params: SqlParam[]): Promise<void>;
}

/** 默认 namespace */
const DEFAULT_NAMESPACE = "runtime";

/**
 * 规范化 namespace，确保表名前缀合法。
 * @param namespace 原始 namespace
 * @returns 规范化前缀
 */
export function normalizeNamespace(namespace?: string): string {
	const value = (namespace ?? DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE;
	return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * 判断数据源是否已经是 shell SqlBackend。
 * @param source SQL 数据源
 * @returns 是否为 query/run 风格 backend
 */
function isSqlBackend(source: SqlSource): source is SqlBackend {
	return typeof source === "object" && source !== null && "query" in source && "run" in source;
}

/**
 * 判断数据源是否为 D1 风格接口。
 * @param source SQL 数据源
 * @returns 是否为 D1 接口
 */
function isD1DatabaseLike(source: SqlSource): boolean {
	return typeof source === "object" && source !== null && "prepare" in source;
}

/**
 * 将 shell `SqlSource` 统一适配为 Promise 风格 query/run backend。
 * @param source SQL 数据源
 * @returns 统一后的 backend
 */
export function adaptSqlSource(source: SqlSource): RuntimeSqlBackend {
	if (isSqlBackend(source)) {
		return {
			query: async (sql, ...params) => source.query(sql, ...params),
			run: async (sql, ...params) => source.run(sql, ...params),
		};
	}

	if (isD1DatabaseLike(source)) {
		const d1Source = source as D1DatabaseLike;
		return {
			query: async <T = Record<string, SqlParam>>(sql: string, ...params: SqlParam[]) => {
				const result = await d1Source.prepare(sql).bind(...params).all<T>();
				return (result.results ?? []) as T[];
			},
			run: async (sql, ...params) => {
				await d1Source.prepare(sql).bind(...params).run();
			},
		};
	}

	throw new Error("Unsupported SQL source");
}

/**
 * D1-backed SessionStore。
 * 会话快照保持 JSON 整存，避免本阶段过早拆表。
 */
export class D1SessionStore implements SessionStore {
	private readonly sql: RuntimeSqlBackend;
	private readonly tableName: string;
	private initialized = false;

	/**
	 * @param source SQL 数据源
	 * @param options namespace 配置
	 */
	constructor(source: SqlSource, options: SqlNamespaceOptions = {}) {
		this.sql = adaptSqlSource(source);
		this.tableName = `${normalizeNamespace(options.namespace)}_sessions`;
	}

	async save(session: SessionState): Promise<void> {
		await this.ensureInit();
		await this.sql.run(
			`INSERT OR REPLACE INTO ${this.tableName} (session_id, payload, updated_at) VALUES (?, ?, ?)`,
			session.id,
			JSON.stringify(session),
			session.updatedAt,
		);
	}

	async load(sessionId: string): Promise<SessionState | null> {
		await this.ensureInit();
		const rows = await this.sql.query<{ payload: string }>(
			`SELECT payload FROM ${this.tableName} WHERE session_id = ?`,
			sessionId,
		);
		const payload = rows[0]?.payload;
		return payload ? JSON.parse(payload) : null;
	}

	/**
	 * 列出全部会话快照。
	 * @returns 会话列表，按 id 升序排列
	 */
	async list(): Promise<SessionState[]> {
		await this.ensureInit();
		const rows = await this.sql.query<{ payload: string }>(
			`SELECT payload FROM ${this.tableName} ORDER BY session_id ASC`,
		);
		return rows.map((row) => JSON.parse(row.payload));
	}

	async delete(sessionId: string): Promise<void> {
		await this.ensureInit();
		await this.sql.run(`DELETE FROM ${this.tableName} WHERE session_id = ?`, sessionId);
	}

	private async ensureInit(): Promise<void> {
		if (this.initialized) {
			return;
		}

		await this.sql.run(
			`CREATE TABLE IF NOT EXISTS ${this.tableName} (
				session_id TEXT PRIMARY KEY,
				payload TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		);
		this.initialized = true;
	}
}

/**
 * D1-backed TranscriptStore。
 */
export class D1TranscriptStore implements TranscriptStore {
	private readonly sql: RuntimeSqlBackend;
	private readonly tableName: string;
	private initialized = false;

	/**
	 * @param source SQL 数据源
	 * @param options namespace 配置
	 */
	constructor(source: SqlSource, options: SqlNamespaceOptions = {}) {
		this.sql = adaptSqlSource(source);
		this.tableName = `${normalizeNamespace(options.namespace)}_transcripts`;
	}

	async saveTranscript(sessionId: string, messages: Message[]): Promise<string> {
		await this.ensureInit();
		const ref = `d1://${sessionId}/${Date.now()}`;
		await this.sql.run(
			`INSERT OR REPLACE INTO ${this.tableName} (transcript_ref, session_id, payload, created_at) VALUES (?, ?, ?, ?)`,
			ref,
			sessionId,
			JSON.stringify(messages),
			new Date().toISOString(),
		);
		return ref;
	}

	async loadTranscript(ref: string): Promise<Message[] | null> {
		await this.ensureInit();
		const rows = await this.sql.query<{ payload: string }>(
			`SELECT payload FROM ${this.tableName} WHERE transcript_ref = ?`,
			ref,
		);
		const payload = rows[0]?.payload;
		return payload ? JSON.parse(payload) : null;
	}

	private async ensureInit(): Promise<void> {
		if (this.initialized) {
			return;
		}

		await this.sql.run(
			`CREATE TABLE IF NOT EXISTS ${this.tableName} (
				transcript_ref TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				created_at TEXT NOT NULL
			)`,
		);
		this.initialized = true;
	}
}

/**
 * D1-backed SubagentStore。
 */
export class D1SubagentStore implements SubagentStore {
	private readonly sql: RuntimeSqlBackend;
	private readonly tableName: string;
	private initialized = false;

	/**
	 * @param source SQL 数据源
	 * @param options namespace 配置
	 */
	constructor(source: SqlSource, options: SqlNamespaceOptions = {}) {
		this.sql = adaptSqlSource(source);
		this.tableName = `${normalizeNamespace(options.namespace)}_subagent_jobs`;
	}

	async createJob(job: SubagentJob): Promise<void> {
		await this.ensureInit();
		await this.sql.run(
			`INSERT OR REPLACE INTO ${this.tableName} (job_id, session_id, payload, updated_at) VALUES (?, ?, ?, ?)`,
			job.id,
			job.sessionId,
			JSON.stringify(job),
			job.updatedAt,
		);
	}

	async getJob(jobId: string): Promise<SubagentJob | null> {
		await this.ensureInit();
		const rows = await this.sql.query<{ payload: string }>(
			`SELECT payload FROM ${this.tableName} WHERE job_id = ?`,
			jobId,
		);
		const payload = rows[0]?.payload;
		return payload ? JSON.parse(payload) : null;
	}

	async listJobsForSession(sessionId: string): Promise<SubagentJob[]> {
		await this.ensureInit();
		const rows = await this.sql.query<{ payload: string }>(
			`SELECT payload FROM ${this.tableName} WHERE session_id = ? ORDER BY updated_at ASC`,
			sessionId,
		);
		return rows.map((row) => JSON.parse(row.payload));
	}

	async updateJob(job: SubagentJob): Promise<void> {
		await this.createJob(job);
	}

	private async ensureInit(): Promise<void> {
		if (this.initialized) {
			return;
		}

		await this.sql.run(
			`CREATE TABLE IF NOT EXISTS ${this.tableName} (
				job_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		);
		this.initialized = true;
	}
}

/**
 * D1-backed TodoMemoryStore。
 * 这里仅保留最近一次非空 Todo 快照，作为 runtime 的短期 Todo 记忆。
 */
export class D1TodoMemoryStore implements TodoMemoryStore {
	private readonly sql: RuntimeSqlBackend;
	private readonly tableName: string;
	private readonly namespace: string;
	private initialized = false;

	/**
	 * @param source SQL 数据源
	 * @param options namespace 配置
	 */
	constructor(source: SqlSource, options: SqlNamespaceOptions = {}) {
		this.sql = adaptSqlSource(source);
		this.tableName = "runtime_todo_memory";
		this.namespace = normalizeNamespace(options.namespace);
	}

	/**
	 * 保存最近一次 Todo 快照
	 * @param sessionId 会话 id
	 * @param todos Todo 列表
	 */
	async saveLatestTodos(sessionId: string, todos: TodoItem[]): Promise<void> {
		await this.ensureInit();
		await this.sql.run(
			`INSERT OR REPLACE INTO ${this.tableName} (namespace, session_id, payload, updated_at) VALUES (?, ?, ?, ?)`,
			this.namespace,
			sessionId,
			JSON.stringify(todos),
			new Date().toISOString(),
		);
	}

	/**
	 * 读取最近一次 Todo 快照
	 * @param sessionId 会话 id
	 * @returns Todo 列表
	 */
	async loadLatestTodos(sessionId: string): Promise<TodoItem[] | null> {
		await this.ensureInit();
		const rows = await this.sql.query<{ payload: string }>(
			`SELECT payload FROM ${this.tableName} WHERE namespace = ? AND session_id = ?`,
			this.namespace,
			sessionId,
		);
		const payload = rows[0]?.payload;
		return payload ? JSON.parse(payload) : null;
	}

	/**
	 * 初始化表结构
	 */
	private async ensureInit(): Promise<void> {
		if (this.initialized) {
			return;
		}

		await this.sql.run(
			`CREATE TABLE IF NOT EXISTS ${this.tableName} (
				namespace TEXT NOT NULL,
				session_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (namespace, session_id)
			)`,
		);
		this.initialized = true;
	}
}

/**
 * D1-backed TaskStore。
 * task 从 session 快照中拆出后，统一以会话维度做独立持久化。
 */
export class D1TaskStore implements TaskStore {
	private readonly sql: RuntimeSqlBackend;
	private readonly tableName: string;
	private readonly namespace: string;
	private initialized = false;

	/**
	 * @param source SQL 数据源
	 * @param options namespace 配置
	 */
	constructor(source: SqlSource, options: SqlNamespaceOptions = {}) {
		this.sql = adaptSqlSource(source);
		this.tableName = "runtime_tasks";
		this.namespace = normalizeNamespace(options.namespace);
	}

	/**
	 * 保存当前会话 task 快照
	 * @param sessionId 会话 id
	 * @param tasks task 列表
	 */
	async saveTasks(sessionId: string, tasks: RuntimeTask[]): Promise<void> {
		await this.ensureInit();
		await this.sql.run(
			`INSERT OR REPLACE INTO ${this.tableName} (namespace, session_id, payload, updated_at) VALUES (?, ?, ?, ?)`,
			this.namespace,
			sessionId,
			JSON.stringify(tasks),
			new Date().toISOString(),
		);
	}

	/**
	 * 读取当前会话 task 快照
	 * @param sessionId 会话 id
	 * @returns task 列表；不存在时返回 null
	 */
	async loadTasks(sessionId: string): Promise<RuntimeTask[] | null> {
		await this.ensureInit();
		const rows = await this.sql.query<{ payload: string }>(
			`SELECT payload FROM ${this.tableName} WHERE namespace = ? AND session_id = ?`,
			this.namespace,
			sessionId,
		);
		const payload = rows[0]?.payload;
		return payload ? JSON.parse(payload) : null;
	}

	/**
	 * 删除会话 task 快照
	 * @param sessionId 会话 id
	 */
	async deleteTasks(sessionId: string): Promise<void> {
		await this.ensureInit();
		await this.sql.run(
			`DELETE FROM ${this.tableName} WHERE namespace = ? AND session_id = ?`,
			this.namespace,
			sessionId,
		);
	}

	/**
	 * 初始化表结构
	 */
	private async ensureInit(): Promise<void> {
		if (this.initialized) {
			return;
		}

		await this.sql.run(
			`CREATE TABLE IF NOT EXISTS ${this.tableName} (
				namespace TEXT NOT NULL,
				session_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (namespace, session_id)
			)`,
		);
		this.initialized = true;
	}
}
