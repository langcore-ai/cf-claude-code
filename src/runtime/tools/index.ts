import { nanoid } from "nanoid";
import { tool } from "ai";
import type { Tool } from "@ai-sdk/provider-utils";
import { z } from "zod";

import { applyTodoWrite, createTask, getTask, renderTodos, updateTask } from "../domain";
import type { SkillProvider } from "../skills";
import type { ModelRole, SessionState, TodoPriority, ToolCall, ToolResult } from "../types";
import type { Workspace } from "../workspace";

/** 工具分组 */
export type ToolGroup = "core" | "extended";

/** 默认工具上下文 */
export interface DefaultToolContext {
	/** 当前工作区 */
	workspace: Workspace;
	/** 当前 skill provider */
	skills: SkillProvider;
	/** 获取当前会话 */
	getSession(): Promise<SessionState>;
	/** 覆写当前会话 */
	updateSession(updater: (session: SessionState) => SessionState): Promise<void>;
	/** 读取当前会话的独立 task 快照 */
	loadTasks?(): Promise<SessionState["tasks"] | null>;
	/** 保存当前会话的独立 task 快照 */
	saveTasks?(tasks: SessionState["tasks"]): Promise<void>;
	/** 保存最近一次非空 Todo 快照 */
	saveTodoMemory?(todos: SessionState["todos"]): Promise<void>;
	/** 读取最近一次 Todo 快照 */
	loadTodoMemory?(): Promise<SessionState["todos"] | null>;
	/** 同步执行 subagent */
	runSubagent?(prompt: string, options?: { description?: string }): Promise<{
		summary: string;
		turnCount: number;
		messageCount: number;
		jobId?: string;
	}>;
	/** 创建异步 subagent job */
	startSubagent?(prompt: string, options?: { description?: string }): Promise<{
		id: string;
		status: string;
		mode: string;
	}>;
	/** 查询 subagent job */
	getSubagentJob?(jobId: string): Promise<unknown>;
	/** 列出当前会话的全部 subagent jobs */
	listSubagentJobs?(): Promise<unknown[]>;
	/** 执行结构化 `state.*` 代码 */
	executeState?(code: string, options?: { description?: string }): Promise<{
		value: unknown;
		resultType: string;
	}>;
	/** 使用指定模型角色运行一次无工具文本分析 */
	runPrompt?(input: {
		prompt: string;
		systemPrompt?: string;
		modelRole?: ModelRole;
	}): Promise<string>;
	/** WebFetch 相关配置 */
	webFetch?: {
		/** Jina Reader API Key */
		jinaApiKey?: string;
	};
}

/** Runtime 工具定义 */
export type RuntimeTool = Tool & {
	/** 工具名称 */
	name: string;
	/** 工具分组 */
	group: ToolGroup;
	/** runtime 内部执行逻辑 */
	runtimeExecute(call: ToolCall, context: DefaultToolContext): Promise<ToolResult>;
};

/** grep 结果最大返回条数 */
const GREP_RESULT_LIMIT = 200;
/** list_files 默认最大返回条数 */
const LIST_RESULT_LIMIT = 200;
/** Web 搜索最大返回条数 */
const WEB_SEARCH_RESULT_LIMIT = 8;
/** Bash 输出最大字符数 */
const BASH_OUTPUT_LIMIT = 30_000;
/** WebFetch 单页正文最大截断长度 */
const WEB_FETCH_CONTENT_LIMIT = 20_000;
/** WebFetch 默认 Accept */
const WEB_FETCH_ACCEPT_HEADER = "text/plain";
/** WebFetch 默认页面稳定时机 */
const WEB_FETCH_RESPOND_TIMING = "visible-content";
/** WebSearch 默认 Accept */
const WEB_SEARCH_ACCEPT_HEADER = "application/json";
/** WebSearch 默认 provider */
const WEB_SEARCH_PROVIDER = "google";
/** WebSearch 默认返回格式 */
const WEB_SEARCH_RESPOND_WITH = "markdown";
/** WebSearch 默认缓存容忍时间（秒） */
const WEB_SEARCH_CACHE_TOLERANCE = 300;

/**
 * 构建 Web 工具的环境摘要日志。
 * 这里只记录配置是否存在与最小请求上下文，不输出真实密钥内容。
 * @param toolName 工具名
 * @param input 工具输入
 * @param apiKey Jina API Key
 * @returns 可序列化日志对象
 */
function buildWebToolEnvLog(
	toolName: "WebFetch" | "WebSearch",
	input: ToolCall["input"],
	apiKey: string | undefined,
) {
	return {
		toolName,
		hasJinaApiKey: Boolean(apiKey),
		url: typeof input.url === "string" ? input.url : undefined,
		query: typeof input.query === "string" ? input.query : undefined,
		respondWith: typeof input.respondWith === "string" ? input.respondWith : undefined,
	};
}
/** plan mode 允许的核心工具 */
export const PLAN_MODE_ALLOWED_TOOL_NAMES = new Set([
	"read_file",
	"list_files",
	"glob",
	"grep",
	"WebFetch",
	"WebSearch",
	"TodoWrite",
	"compact",
	"ExitPlanMode",
	"load_skill",
	"list_skill_files",
	"read_skill_file",
]);

/** glob 输入 schema */
const GLOB_INPUT_SCHEMA = z.object({
	pattern: z.string().describe("The glob pattern to match, such as **/*.ts"),
	path: z.string().optional().describe("The absolute directory path to search from. Defaults to /."),
});

/** grep 输入 schema */
const GREP_INPUT_SCHEMA = z.object({
	query: z.string().describe("The plain-text query to search for"),
	path: z.string().optional().describe("The absolute directory path to search from. Defaults to /."),
	caseSensitive: z.boolean().optional().describe("Whether to match with case sensitivity"),
});

/** edit 操作 schema */
const EDIT_OPERATION_SCHEMA = z.object({
	oldString: z.string().describe("The exact text to replace"),
	newString: z.string().describe("The replacement text"),
	replaceAll: z.boolean().optional().describe("Replace every match instead of exactly one match"),
});

/** Todo 优先级 schema */
const TODO_PRIORITY_SCHEMA = z.enum(["high", "medium", "low"]);
/** WebFetch 可见输出格式 schema */
const WEB_FETCH_RESPONSE_SCHEMA = z.enum(["content", "markdown", "text", "html"]);

/** Todo 单项 schema */
const TODO_ITEM_SCHEMA = z.object({
	id: z.string().optional(),
	content: z.string(),
	status: z.enum(["pending", "in_progress", "completed"]),
	priority: TODO_PRIORITY_SCHEMA.optional(),
	activeForm: z.string().optional(),
});

/**
 * 为官方 Tool 记录 runtime 所需的名称、分组与执行逻辑。
 * @param name 工具名称
 * @param group 工具分组
 * @param sdkTool AI SDK 官方工具对象
 * @param runtimeExecute runtime 内部执行逻辑
 * @returns 带 runtime 元数据的工具对象
 */
export function createRuntimeTool(
	name: string,
	group: ToolGroup,
	sdkTool: Tool,
	runtimeExecute: (call: ToolCall, context: DefaultToolContext) => Promise<ToolResult>,
): RuntimeTool {
	return Object.assign(sdkTool, {
		name,
		group,
		runtimeExecute,
	});
}

/**
 * 递归列出目录下的全部节点。
 * @param workspace 当前工作区
 * @param root 根路径
 * @returns 所有子节点
 */
async function listWorkspaceTree(
	workspace: Workspace,
	root: string,
): Promise<Array<{ path: string; type: "file" | "directory" | "symlink" }>> {
	const results: Array<{ path: string; type: "file" | "directory" | "symlink" }> = [];
	const queue = [root];

	while (queue.length > 0) {
		const current = queue.shift()!;
		const entries = await workspace.files.list(current);
		for (const entry of entries) {
			results.push(entry);
			if (entry.type === "directory") {
				queue.push(entry.path);
			}
		}
	}

	return results;
}

/**
 * 把 glob 模式转换为正则表达式。
 * 这里只覆盖 runtime 当前需要的 `*`、`**`、`?` 语义。
 * @param pattern glob 模式
 * @returns 对应正则
 */
function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const current = pattern[index]!;
		const next = pattern[index + 1];

		if (current === "*" && next === "*") {
			source += ".*";
			index += 1;
			continue;
		}

		if (current === "*") {
			source += "[^/]*";
			continue;
		}

		if (current === "?") {
			source += ".";
			continue;
		}

		source += current.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	}

	return new RegExp(`${source}$`);
}

/**
 * 把目录裁剪提示附加到输出末尾。
 * @param items 文本项
 * @param total 总条数
 * @param limit 最大条数
 * @returns 渲染结果
 */
function renderLimitedLines(items: string[], total: number, limit: number): string {
	const visible = items.slice(0, limit);
	const suffix = total > limit ? `\n... truncated ${total - limit} more entries` : "";
	return `${visible.join("\n") || "No files."}${suffix}`;
}

/**
 * 截断过长输出，避免把整个上下文塞满。
 * @param value 原始文本
 * @returns 截断后的文本
 */
function limitOutput(value: string): string {
	if (value.length <= BASH_OUTPUT_LIMIT) {
		return value;
	}

	return `${value.slice(0, BASH_OUTPUT_LIMIT)}\n... output truncated`;
}

/**
 * 判断当前会话里是否已经成功读取过目标文件。
 * 这里用于对齐 Claude Code 的 read-before-write 约束。
 * @param session 当前会话
 * @param path 目标文件路径
 * @returns 是否已经读过
 */
function hasSuccessfulRead(session: SessionState, path: string): boolean {
	for (let index = 0; index < session.messages.length; index += 1) {
		const message = session.messages[index]!;
		for (const block of message.content) {
			if (block.type !== "tool_use" || block.name !== "read_file") {
				continue;
			}

			const readPath = typeof block.input.path === "string" ? block.input.path : "";
			if (readPath !== path) {
				continue;
			}

			const hasResult = session.messages
				.slice(index + 1)
				.some((nextMessage) =>
					nextMessage.content.some(
						(nextBlock) => nextBlock.type === "tool_result" && nextBlock.toolUseId === block.id && !nextBlock.isError,
					),
				);
			if (hasResult) {
				return true;
			}
		}
	}

	return false;
}

/**
 * 在写入现有文件前执行 read-before-write 校验。
 * @param context 工具上下文
 * @param path 目标路径
 */
async function assertWriteAllowed(context: DefaultToolContext, path: string): Promise<void> {
	if (path === "/") {
		throw new Error("path must point to a file, not the workspace root");
	}

	const exists = await context.workspace.files.exists(path);
	if (!exists) {
		return;
	}

	const session = await context.getSession();
	if (!hasSuccessfulRead(session, path)) {
		throw new Error(`Must read ${path} with read_file before overwriting it`);
	}
}

/**
 * 把简单 HTML 转成可读 markdown 文本。
 * 这里只做最小规则，避免为 WebFetch 再引入额外解析依赖。
 * @param html 原始 HTML
 * @returns 近似 markdown
 */
function htmlToMarkdown(html: string): string {
	const withoutScripts = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "");
	const withLinks = withoutScripts.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
		return `[${stripHtml(text)}](${href})`;
	});
	const withStructure = withLinks
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<\/div>/gi, "\n")
		.replace(/<li[^>]*>/gi, "- ")
		.replace(/<\/li>/gi, "\n")
		.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, text) => `# ${stripHtml(text)}\n\n`)
		.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, text) => `## ${stripHtml(text)}\n\n`)
		.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, text) => `### ${stripHtml(text)}\n\n`);

	return decodeHtmlEntities(stripHtml(withStructure))
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * 去掉 HTML 标签。
 * @param value HTML 文本
 * @returns 纯文本
 */
function stripHtml(value: string): string {
	return value.replace(/<[^>]+>/g, " ");
}

/**
 * 解码常见 HTML 实体。
 * @param value 文本
 * @returns 解码后的文本
 */
function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'");
}

/**
 * 标准化 WebFetch URL。
 * HTTP 会自动提升到 HTTPS。
 * @param raw 原始 URL
 * @returns 标准 URL
 */
function normalizeUrl(raw: string): URL {
	const normalized = raw.startsWith("http://") ? `https://${raw.slice("http://".length)}` : raw;
	return new URL(normalized);
}

/**
 * 构建 Jina Reader 请求地址。
 * Jina Reader 通过把目标 URL 直接拼到固定前缀后面来返回可读文本。
 * @param target 目标 URL
 * @returns Reader 请求地址
 */
function buildJinaReaderUrl(target: URL): string {
	return `https://r.jina.ai/${target.toString()}`;
}

/**
 * 构建 Jina Reader 查询参数。
 * 这里仅暴露少量高层语义参数给模型，其余抓取策略由 runtime 内部控制。
 * @param input 工具输入
 * @returns 查询参数
 */
function buildWebFetchSearchParams(input: ToolCall["input"]): URLSearchParams {
	const params = new URLSearchParams();
	if (typeof input.respondWith === "string" && input.respondWith) {
		params.set("respondWith", input.respondWith);
	}
	if (typeof input.instruction === "string" && input.instruction.trim() !== "") {
		params.set("instruction", input.instruction);
	}
	if (input.jsonSchema !== undefined) {
		params.set("jsonSchema", JSON.stringify(input.jsonSchema));
	}
	if (typeof input.targetSelector === "string" && input.targetSelector.trim() !== "") {
		params.set("targetSelector", input.targetSelector);
	}
	if (typeof input.waitForSelector === "string" && input.waitForSelector.trim() !== "") {
		params.set("waitForSelector", input.waitForSelector);
	}
	return params;
}

/**
 * 构建 Jina Reader 请求头。
 * 鉴权、缓存和页面稳定策略都由 runtime 内部控制，不向模型暴露。
 * @param apiKey Jina API Key
 * @param input 工具输入
 * @returns 请求头
 */
function buildWebFetchHeaders(apiKey: string | undefined, input: ToolCall["input"]): HeadersInit {
	const headers: Record<string, string> = {
		Accept: WEB_FETCH_ACCEPT_HEADER,
		"X-Respond-Timing": WEB_FETCH_RESPOND_TIMING,
		"X-Remove-Overlay": "true",
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	if (typeof input.respondWith === "string" && input.respondWith) {
		headers["X-Respond-With"] = input.respondWith;
	}
	if (typeof input.targetSelector === "string" && input.targetSelector.trim() !== "") {
		headers["X-Target-Selector"] = input.targetSelector;
	}
	if (typeof input.waitForSelector === "string" && input.waitForSelector.trim() !== "") {
		headers["X-Wait-For-Selector"] = input.waitForSelector;
	}
	return headers;
}

/**
 * 构建 Jina Search 请求地址。
 * 这里只暴露搜索语义本身，provider 等策略由 runtime 内部控制。
 * @param input 工具输入
 * @returns Search 请求地址
 */
function buildJinaSearchUrl(input: ToolCall["input"]): string {
	const requestUrl = new URL("https://s.jina.ai/search");
	const params = requestUrl.searchParams;
	params.set("q", String(input.query ?? ""));
	params.set("provider", WEB_SEARCH_PROVIDER);
	if (typeof input.type === "string" && input.type) {
		params.set("type", input.type);
	}
	if (typeof input.count === "number") {
		params.set("count", String(input.count));
	}
	const allowedDomains = Array.isArray(input.allowed_domains) ? input.allowed_domains.map((item) => String(item)) : [];
	const sites = Array.isArray(input.site) ? input.site.map((item) => String(item)) : [];
	const dedupedDomains = Array.from(new Set([...sites, ...allowedDomains].map((item) => item.trim()).filter(Boolean)));
	for (const domain of dedupedDomains) {
		if (domain.trim() !== "") {
			params.append("site", domain);
		}
	}
	return requestUrl.toString();
}

/**
 * 构建 Jina Search 请求头。
 * 鉴权和返回格式由 runtime 内部控制，不直接暴露给模型。
 * @param apiKey Jina API Key
 * @returns 请求头
 */
function buildWebSearchHeaders(apiKey: string | undefined): HeadersInit {
	const headers: Record<string, string> = {
		Accept: WEB_SEARCH_ACCEPT_HEADER,
		"X-Respond-With": WEB_SEARCH_RESPOND_WITH,
		"X-Cache-Tolerance": String(WEB_SEARCH_CACHE_TOLERANCE),
		"X-Respond-Timing": WEB_FETCH_RESPOND_TIMING,
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

/**
 * 解析 Jina Search JSON 包装响应。
 * @param payload 原始 JSON
 * @returns 文本化搜索结果
 */
function parseJinaSearchPayload(payload: unknown): string {
	if (typeof payload === "string") {
		return payload.trim();
	}
	if (typeof payload === "object" && payload !== null && "data" in payload) {
		const data = (payload as Record<string, unknown>).data;
		if (typeof data === "string") {
			return data.trim();
		}
	}
	throw new Error("WebSearch returned an unexpected response shape");
}

/**
 * 根据 blocked_domains 对搜索结果文本做最小过滤。
 * 这里不重建结构化结果，只按段落级别做域名排除。
 * @param content 搜索结果文本
 * @param blockedDomains 要排除的域名
 * @returns 过滤后的结果
 */
function filterBlockedSearchResultText(content: string, blockedDomains: string[]): string {
	if (blockedDomains.length === 0) {
		return content;
	}

	const sections = content.split(/\n\s*\n/);
	const filtered = sections.filter((section) => {
		return !blockedDomains.some((domain) => {
			const normalizedDomain = domain.trim();
			return normalizedDomain !== "" && section.includes(normalizedDomain);
		});
	});

	return filtered.join("\n\n").trim();
}

/** Bash 片段 */
interface BashSegment {
	command: string;
	operatorBefore?: ";" | "&&";
}

/**
 * 将命令串按 `;` / `&&` 拆段，同时保留引号语义。
 * @param command 原始命令
 * @returns 拆分后的命令片段
 */
function splitBashSegments(command: string): BashSegment[] {
	const segments: BashSegment[] = [];
	let current = "";
	let quote: "'" | "\"" | null = null;
	let operatorBefore: BashSegment["operatorBefore"];

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;
		const next = command[index + 1];

		if ((char === "'" || char === "\"") && command[index - 1] !== "\\") {
			quote = quote === char ? null : quote ?? char;
			current += char;
			continue;
		}

		if (!quote && char === ";" ) {
			if (current.trim()) {
				segments.push({ command: current.trim(), operatorBefore });
			}
			current = "";
			operatorBefore = ";";
			continue;
		}

		if (!quote && char === "&" && next === "&") {
			if (current.trim()) {
				segments.push({ command: current.trim(), operatorBefore });
			}
			current = "";
			operatorBefore = "&&";
			index += 1;
			continue;
		}

		current += char;
	}

	if (current.trim()) {
		segments.push({ command: current.trim(), operatorBefore });
	}

	return segments;
}

/**
 * 将单条命令拆成 token，支持基本引号。
 * @param command 单条命令
 * @returns token 数组
 */
function tokenizeCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | "\"" | null = null;

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;
		if ((char === "'" || char === "\"") && command[index - 1] !== "\\") {
			quote = quote === char ? null : quote ?? char;
			continue;
		}

		if (!quote && /\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		if (!quote && char === ">") {
			if (current) {
				tokens.push(current);
				current = "";
			}
			if (command[index + 1] === ">") {
				tokens.push(">>");
				index += 1;
			} else {
				tokens.push(">");
			}
			continue;
		}

		current += char;
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * 渲染目录列表。
 * @param workspace 当前工作区
 * @param path 目录路径
 * @returns 类似 ls 的输出
 */
async function renderLsOutput(workspace: Workspace, path: string): Promise<string> {
	const entries = await workspace.files.list(path);
	if (entries.length === 0) {
		return "";
	}

	return entries.map((entry) => `${entry.type === "directory" ? "d" : "-"} ${entry.path}`).join("\n");
}

/**
 * 执行 edge 适配后的 Bash 命令。
 * 这里只覆盖 workspace 内最常见的文件系统命令，不模拟完整 POSIX shell。
 * @param workspace 当前工作区
 * @param rawCommand 原始命令
 * @returns 输出文本
 */
async function executeBashCommand(workspace: Workspace, rawCommand: string): Promise<string> {
	const segments = splitBashSegments(rawCommand);
	const outputs: string[] = [];
	let previousSucceeded = true;

	for (const segment of segments) {
		if (segment.operatorBefore === "&&" && !previousSucceeded) {
			continue;
		}

		try {
			const output = await executeSingleBashCommand(workspace, segment.command);
			if (output) {
				outputs.push(output);
			}
			previousSucceeded = true;
		} catch (error) {
			previousSucceeded = false;
			throw error;
		}
	}

	return limitOutput(outputs.join("\n"));
}

/**
 * 执行单条 Bash 命令。
 * @param workspace 当前工作区
 * @param command 单条命令
 * @returns 输出文本
 */
async function executeSingleBashCommand(workspace: Workspace, command: string): Promise<string> {
	const tokens = tokenizeCommand(command);
	const [name, ...args] = tokens;
	if (!name) {
		return "";
	}

	switch (name) {
		case "pwd":
			return "/";
		case "ls":
			return renderLsOutput(workspace, args[0] ?? "/");
		case "cat": {
			const path = args[0];
			if (!path) {
				throw new Error("cat requires a path");
			}
			const file = await workspace.files.readFile(path);
			return file.content;
		}
		case "mkdir": {
			const targets = args.filter((arg) => !arg.startsWith("-"));
			if (targets.length === 0) {
				throw new Error("mkdir requires at least one path");
			}
			for (const target of targets) {
				await workspace.files.mkdir(target);
			}
			return "";
		}
		case "rm": {
			const targets = args.filter((arg) => !arg.startsWith("-"));
			if (targets.length === 0) {
				throw new Error("rm requires at least one path");
			}
			for (const target of targets) {
				await workspace.files.remove(target);
			}
			return "";
		}
		case "cp": {
			if (args.length < 2) {
				throw new Error("cp requires a source and destination");
			}
			await workspace.files.copy(args[0]!, args[1]!);
			return "";
		}
		case "mv": {
			if (args.length < 2) {
				throw new Error("mv requires a source and destination");
			}
			await workspace.files.move(args[0]!, args[1]!);
			return "";
		}
		case "touch": {
			if (args.length === 0) {
				throw new Error("touch requires at least one path");
			}
			for (const path of args) {
				if (!(await workspace.files.exists(path))) {
					await workspace.files.writeFile(path, "");
				}
			}
			return "";
		}
		case "echo": {
			const redirectIndex = args.findIndex((arg) => arg === ">" || arg === ">>");
			if (redirectIndex === -1) {
				return args.join(" ");
			}

			const operator = args[redirectIndex]!;
			const targetPath = args[redirectIndex + 1];
			if (!targetPath) {
				throw new Error("echo redirection requires a target path");
			}
			const text = args.slice(0, redirectIndex).join(" ");
			const existing = operator === ">>" && (await workspace.files.exists(targetPath))
				? (await workspace.files.readFile(targetPath)).content
				: "";
			await workspace.files.writeFile(targetPath, operator === ">>" ? `${existing}${text}\n` : `${text}\n`);
			return "";
		}
		case "find":
		case "grep":
		case "rg":
			throw new Error(`Use the dedicated ${name === "find" ? "glob" : "grep"} tool instead of Bash for search tasks`);
		case "python":
		case "python3":
		case "node":
		case "npm":
		case "pnpm":
		case "bun":
		case "git":
		case "pytest":
		case "uv":
		case "cargo":
			throw new Error(`Unsupported in edge Bash adapter: ${name}. This runtime only supports workspace-scoped filesystem commands.`);
		default:
			throw new Error(`Unsupported Bash command in edge runtime: ${name}`);
	}
}

/**
 * 读取文本文件并按行切片输出。
 * @param workspace 当前工作区
 * @param path 文件路径
 * @param offset 起始偏移
 * @param limit 最大行数
 * @returns 带行号的文本
 */
async function readFileSlice(
	workspace: Workspace,
	path: string,
	offset = 0,
	limit?: number,
): Promise<string> {
	const file = await workspace.files.readFile(path);
	const lines = file.content.split("\n");
	const start = Math.max(0, offset);
	const end = typeof limit === "number" ? Math.min(lines.length, start + limit) : lines.length;

	return lines
		.slice(start, end)
		.map((line, index) => `${start + index + 1}\t${line}`)
		.join("\n");
}

/**
 * 创建 Claude Code 兼容核心工具集合。
 * @returns 核心工具列表
 */
export function createCoreTools(): RuntimeTool[] {
	return [
		createRuntimeTool(
			"read_file",
			"core",
			tool({
				description:
					"Reads a file from the workspace filesystem.\n\nUse this to inspect file contents before making changes. Prefer reading the whole file unless you deliberately need a slice. When working with existing files, read them before using write_file, edit, or multi_edit.",
				inputSchema: z.object({
					path: z.string().describe("The absolute path to the file to read"),
					offset: z.number().int().nonnegative().optional().describe("Optional starting line offset"),
					limit: z.number().int().positive().optional().describe("Optional maximum number of lines to return"),
				}),
			}),
			async (call, context) => {
				const path = String(call.input.path ?? "");
				const offset = typeof call.input.offset === "number" ? call.input.offset : 0;
				const limit = typeof call.input.limit === "number" ? call.input.limit : undefined;
				return {
					toolUseId: call.id,
					name: call.name,
					content: await readFileSlice(context.workspace, path, offset, limit),
				};
			},
		),
		createRuntimeTool(
			"write_file",
			"core",
			tool({
				description:
					"Writes a file to the workspace filesystem.\n\nUsage:\n- This tool overwrites the target file if it already exists.\n- If the target file already exists, you MUST read it with read_file before writing.\n- path must be a specific file path such as /README.md. Never use / as a file path.",
				inputSchema: z.object({
					path: z.string().describe("The absolute file path to write"),
					content: z.string().describe("The complete file contents"),
				}),
			}),
			async (call, context) => {
				const path = String(call.input.path ?? "");
				const content = String(call.input.content ?? "");
				await assertWriteAllowed(context, path);
				await context.workspace.files.writeFile(path, content);
				return {
					toolUseId: call.id,
					name: call.name,
					content: `Wrote file: ${path}`,
				};
			},
		),
		createRuntimeTool(
			"list_files",
			"core",
			tool({
				description:
					"Lists files and directories in a given workspace path. Use this when you need directory structure rather than file contents.",
				inputSchema: z.object({
					path: z.string().optional().describe("The absolute directory path to list. Defaults to /."),
					ignore: z.array(z.string()).optional().describe("Optional path prefixes to omit from the output"),
				}),
			}),
			async (call, context) => {
				const path = call.input.path ? String(call.input.path) : "/";
				const ignore = Array.isArray(call.input.ignore)
					? call.input.ignore.map((item) => String(item))
					: [];
				const entries = (await context.workspace.files.list(path)).filter(
					(entry) => !ignore.some((prefix) => entry.path.startsWith(prefix)),
				);
				return {
					toolUseId: call.id,
					name: call.name,
					content: renderLimitedLines(
						entries.map((entry) => `${entry.type}: ${entry.path}`),
						entries.length,
						LIST_RESULT_LIMIT,
					),
				};
			},
		),
		createRuntimeTool(
			"Bash",
			"core",
			tool({
				description:
					"Executes a bash-like command in the edge runtime adapter.\n\nThis runtime does not provide a full POSIX shell. It supports a restricted workspace-scoped subset such as pwd, ls, cat, mkdir, rm, cp, mv, touch, and echo redirection. Prefer dedicated tools like Read, LS, Grep, Glob, Edit, and MultiEdit whenever they match the task.",
				inputSchema: z.object({
					command: z.string().describe("The bash command to execute"),
					timeout: z.number().int().positive().max(600_000).optional().describe("Optional timeout in milliseconds"),
					description: z.string().optional().describe("Clear, concise description of what the command does"),
				}),
			}),
			async (call, context) => {
				const command = String(call.input.command ?? "");
				const content = await executeBashCommand(context.workspace, command);
				return {
					toolUseId: call.id,
					name: call.name,
					content: content || "(no output)",
					meta: {
						description: call.input.description ? String(call.input.description) : undefined,
						timeout: typeof call.input.timeout === "number" ? call.input.timeout : undefined,
						adapter: "edge-workspace",
					},
				};
			},
		),
		createRuntimeTool(
			"glob",
			"core",
			tool({
				description:
					"Find files whose paths match a glob pattern. Use this when you know the file naming pattern but not the exact path.",
				inputSchema: GLOB_INPUT_SCHEMA,
			}),
			async (call, context) => {
				const pattern = String(call.input.pattern ?? "");
				const path = call.input.path ? String(call.input.path) : "/";
				const matcher = globToRegExp(pattern);
				const entries = await listWorkspaceTree(context.workspace, path);
				const matches = entries
					.filter((entry) => entry.type === "file" && matcher.test(entry.path))
					.map((entry) => entry.path);
				return {
					toolUseId: call.id,
					name: call.name,
					content: matches.join("\n") || "No matches.",
				};
			},
		),
		createRuntimeTool(
			"grep",
			"core",
			tool({
				description:
					"Search file contents for a plain-text query across the workspace. Use this when you know what text you need to find but not which file contains it.",
				inputSchema: GREP_INPUT_SCHEMA,
			}),
			async (call, context) => {
				const query = String(call.input.query ?? "");
				const path = call.input.path ? String(call.input.path) : "/";
				const caseSensitive = Boolean(call.input.caseSensitive);
				const entries = await listWorkspaceTree(context.workspace, path);
				const needle = caseSensitive ? query : query.toLowerCase();
				const matches: string[] = [];

				for (const entry of entries) {
					if (entry.type !== "file") {
						continue;
					}

					const file = await context.workspace.files.readFile(entry.path);
					const lines = file.content.split("\n");
					for (let index = 0; index < lines.length; index += 1) {
						const line = lines[index]!;
						const haystack = caseSensitive ? line : line.toLowerCase();
						if (haystack.includes(needle)) {
							matches.push(`${entry.path}:${index + 1}:${line}`);
							if (matches.length >= GREP_RESULT_LIMIT) {
								return {
									toolUseId: call.id,
									name: call.name,
									content: `${matches.join("\n")}\n... truncated more matches`,
								};
							}
						}
					}
				}

				return {
					toolUseId: call.id,
					name: call.name,
					content: matches.join("\n") || "No matches.",
				};
			},
		),
		createRuntimeTool(
			"edit",
			"core",
			tool({
				description:
					"Apply a precise string replacement to an existing file. Read the file first, then provide the exact oldString you want to replace.",
				inputSchema: z.object({
					path: z.string().describe("The absolute path to the file to edit"),
					oldString: z.string().describe("The exact text to replace"),
					newString: z.string().describe("The replacement text"),
					replaceAll: z.boolean().optional().describe("Replace every match instead of exactly one match"),
				}),
			}),
			async (call, context) => {
				const path = String(call.input.path ?? "");
				const oldString = String(call.input.oldString ?? "");
				const newString = String(call.input.newString ?? "");
				const replaceAll = Boolean(call.input.replaceAll);
				await assertWriteAllowed(context, path);
				const file = await context.workspace.files.readFile(path);
				const matchCount = file.content.split(oldString).length - 1;
				if (matchCount === 0) {
					throw new Error("oldString not found");
				}
				if (!replaceAll && matchCount !== 1) {
					throw new Error("oldString must match exactly once unless replaceAll is true");
				}

				const nextContent = replaceAll
					? file.content.split(oldString).join(newString)
					: file.content.replace(oldString, newString);
				await context.workspace.files.writeFile(path, nextContent);
				return {
					toolUseId: call.id,
					name: call.name,
					content: `Edited file: ${path}`,
				};
			},
		),
		createRuntimeTool(
			"multi_edit",
			"core",
			tool({
				description:
					"Apply multiple exact replacements to one file atomically. Read the file first, then provide edits in the order they should be applied.",
				inputSchema: z.object({
					path: z.string().describe("The absolute path to the file to edit"),
					edits: z.array(EDIT_OPERATION_SCHEMA).min(1).describe("The ordered replacement operations"),
				}),
			}),
			async (call, context) => {
				const path = String(call.input.path ?? "");
				const edits = Array.isArray(call.input.edits) ? call.input.edits : [];
				await assertWriteAllowed(context, path);
				const file = await context.workspace.files.readFile(path);
				let nextContent = file.content;

				for (const rawEdit of edits) {
					const edit = EDIT_OPERATION_SCHEMA.parse(rawEdit);
					const matchCount = nextContent.split(edit.oldString).length - 1;
					if (matchCount === 0) {
						throw new Error(`oldString not found: ${edit.oldString}`);
					}
					if (!edit.replaceAll && matchCount !== 1) {
						throw new Error(`oldString must match exactly once unless replaceAll is true: ${edit.oldString}`);
					}

					nextContent = edit.replaceAll
						? nextContent.split(edit.oldString).join(edit.newString)
						: nextContent.replace(edit.oldString, edit.newString);
				}

				await context.workspace.files.writeFile(path, nextContent);
				return {
					toolUseId: call.id,
					name: call.name,
					content: `Applied ${edits.length} edits to ${path}`,
				};
			},
		),
		createRuntimeTool(
			"WebFetch",
			"core",
			tool({
				description:
					"Fetch a web page through the runtime's managed reader pipeline, then answer an extraction prompt about that content using a fast analysis model. Only provide high-level extraction intent; fetch policy, authentication, and crawl tuning are controlled internally by the runtime.",
				inputSchema: z.object({
					url: z.string().url().describe("The fully qualified URL to fetch"),
					prompt: z.string().describe("What information to extract from the fetched content"),
					instruction: z.string().optional().describe("Optional page extraction instruction passed to the managed reader"),
					jsonSchema: z.any().optional().describe("Optional JSON schema that constrains the extracted page content before analysis"),
					targetSelector: z.string().optional().describe("Optional CSS selector that scopes extraction to a specific page region"),
					waitForSelector: z.string().optional().describe("Optional CSS selector that should appear before content is captured"),
					respondWith: WEB_FETCH_RESPONSE_SCHEMA.optional().describe("Preferred fetched representation. Defaults to content."),
				}),
			}),
			async (call, context) => {
				if (!context.runPrompt) {
					throw new Error("WebFetch requires runtime model access");
				}
				console.info("[runtime] WebFetch:env", buildWebToolEnvLog("WebFetch", call.input, context.webFetch?.jinaApiKey));

				const url = normalizeUrl(String(call.input.url ?? ""));
				const requestUrl = new URL(buildJinaReaderUrl(url));
				requestUrl.search = buildWebFetchSearchParams(call.input).toString();
				const response = await fetch(requestUrl.toString(), {
					headers: buildWebFetchHeaders(context.webFetch?.jinaApiKey, call.input),
				});
				if (!response.ok) {
					throw new Error(`WebFetch failed with status ${response.status}`);
				}

				const contentType = response.headers.get("content-type") ?? "text/plain";
				const rawBody = await response.text();
				const document = contentType.includes("text/html") ? htmlToMarkdown(rawBody) : rawBody;
				const analyzed = await context.runPrompt({
					systemPrompt: "You analyze fetched web content and answer the extraction prompt precisely.",
					prompt: [
						`URL: ${url.toString()}`,
						"",
						`Extraction prompt: ${String(call.input.prompt ?? "")}`,
						"",
						"Fetched content:",
						document.slice(0, WEB_FETCH_CONTENT_LIMIT),
					].join("\n"),
					modelRole: "lightweight",
				});
				return {
					toolUseId: call.id,
					name: call.name,
					content: analyzed,
					meta: {
						url: url.toString(),
						requestUrl: requestUrl.toString(),
						contentType,
						respondWith: typeof call.input.respondWith === "string" ? call.input.respondWith : "content",
					},
				};
			},
		),
		createRuntimeTool(
			"WebSearch",
			"core",
			tool({
				description:
					"Search the web through the runtime's managed search pipeline and return textual search results. Only provide high-level search intent; provider selection, authentication, and response format are controlled internally by the runtime.",
				inputSchema: z.object({
					query: z.string().min(2).describe("The search query to use"),
					type: z.enum(["web", "images", "news"]).optional().describe("Optional result type. Defaults to web."),
					count: z.number().int().min(1).max(WEB_SEARCH_RESULT_LIMIT).optional().describe("Maximum number of results to request. Defaults to a runtime-managed value."),
					site: z.array(z.string()).optional().describe("Optional domains to scope the search to"),
					allowed_domains: z.array(z.string()).optional().describe("Backward-compatible alias of site; only include results from these domains"),
					blocked_domains: z.array(z.string()).optional().describe("Best-effort domain filtering applied after the managed search returns"),
				}),
			}),
			async (call, context) => {
				console.info(
					"[runtime] WebSearch:env",
					buildWebToolEnvLog("WebSearch", call.input, context.webFetch?.jinaApiKey),
				);
				const query = String(call.input.query ?? "");
				const blockedDomains = Array.isArray(call.input.blocked_domains)
					? call.input.blocked_domains.map((item) => String(item))
					: [];
				const requestUrl = buildJinaSearchUrl(call.input);
				const response = await fetch(requestUrl, {
					headers: buildWebSearchHeaders(context.webFetch?.jinaApiKey),
				});
				if (!response.ok) {
					throw new Error(`WebSearch failed with status ${response.status}`);
				}

				const payload = await response.json();
				const rawContent = parseJinaSearchPayload(payload);
				const filteredContent = filterBlockedSearchResultText(rawContent, blockedDomains);

				return {
					toolUseId: call.id,
					name: call.name,
					content: filteredContent || "No search results.",
					meta: {
						query,
						requestUrl,
						type: typeof call.input.type === "string" ? call.input.type : "web",
					},
				};
			},
		),
		createRuntimeTool(
			"TodoWrite",
			"core",
			tool({
				description:
					"Use this tool to create and maintain a structured task list for the current coding session.\n\nUse it proactively for complex work, multi-step implementation, or whenever the plan changes.\n- Keep tasks small and executable.\n- Keep exactly one task in_progress.\n- Mark tasks completed immediately after finishing them.\n- Break large requests into multiple todo items instead of one summary item.\n- Preserve priority when it is useful for sequencing.\n- Reverse-compatible callers may send either items or todos; both represent the full replacement list.",
				inputSchema: z.object({
					items: z.array(TODO_ITEM_SCHEMA).optional(),
					todos: z.array(TODO_ITEM_SCHEMA).optional(),
				}),
			}),
			async (call, context) => {
				const rawItems = Array.isArray(call.input.items)
					? call.input.items
					: Array.isArray(call.input.todos)
						? call.input.todos
						: [];
				const todos = applyTodoWrite({
					items: rawItems.map((item) => ({
						id: String((item as Record<string, unknown>).id ?? nanoid()),
						content: String((item as Record<string, unknown>).content ?? ""),
						status: ((item as Record<string, unknown>).status ?? "pending") as SessionState["todos"][number]["status"],
						priority: normalizeTodoPriority((item as Record<string, unknown>).priority),
						activeForm: (item as Record<string, unknown>).activeForm
							? String((item as Record<string, unknown>).activeForm)
							: undefined,
					})),
				});

				await context.updateSession((session) => ({
					...session,
					todos,
					todoIdleTurns: 0,
				}));
				if (todos.length > 0) {
					await context.saveTodoMemory?.(todos);
				}

				return {
					toolUseId: call.id,
					name: call.name,
					content: renderTodos(todos),
				};
			},
		),
		createRuntimeTool(
			"Task",
			"core",
			tool({
				description:
					"Launch a general-purpose stateless subagent in fresh context for independent, multi-step work. Use it for research or autonomous execution that can be summarized cleanly. Do not use it for simple single-file reads or small grep/read tasks. Provide a complete prompt and a short description. The subagent returns only its final concise summary, which is generally trusted.",
				inputSchema: z.object({
					description: z.string().describe("A short summary of the delegated task"),
					prompt: z.string().describe("The full task prompt for the subagent"),
					subagent_type: z.string().describe("The subagent type. Only general-purpose is supported in this runtime."),
				}),
			}),
			async (call, context) => {
				if (!context.runSubagent) {
					throw new Error("Subagent runtime is not available");
				}
				const subagentType = String(call.input.subagent_type ?? "");
				if (subagentType !== "general-purpose") {
					throw new Error(`Unsupported subagent_type: ${subagentType}`);
				}

				const result = await context.runSubagent(String(call.input.prompt ?? ""), {
					description: String(call.input.description ?? ""),
				});
				return {
					toolUseId: call.id,
					name: call.name,
					content: result.summary,
					meta: {
						jobId: result.jobId,
						turnCount: result.turnCount,
						messageCount: result.messageCount,
						description: String(call.input.description ?? ""),
						subagentType,
					},
				};
			},
		),
		createRuntimeTool(
			"subagent_run",
			"core",
			tool({
				description:
					"Launch a fresh-context stateless subagent for complex research or autonomous multi-step work. Do not use it for simple single-file reads or small grep/read tasks. The subagent only returns a concise final summary, so provide a complete task description and whether it should research or make changes.",
				inputSchema: z.object({
					prompt: z.string(),
					description: z.string().optional(),
				}),
			}),
			async (call, context) => {
				if (!context.runSubagent) {
					throw new Error("Subagent runtime is not available");
				}
				const result = await context.runSubagent(String(call.input.prompt ?? ""), {
					description: call.input.description ? String(call.input.description) : undefined,
				});
				return {
					toolUseId: call.id,
					name: call.name,
					content: result.summary,
					meta: {
						jobId: result.jobId,
						turnCount: result.turnCount,
						messageCount: result.messageCount,
						description: call.input.description ? String(call.input.description) : undefined,
					},
				};
			},
		),
		createRuntimeTool(
			"compact",
			"core",
			tool({
				description: "Manually compact the current conversation into a continuity summary when the context becomes too large.",
				inputSchema: z.object({}),
			}),
			async (call) => ({
				toolUseId: call.id,
				name: call.name,
				content: "__COMPACT__",
				meta: {
					action: "compact",
				},
			}),
		),
		createRuntimeTool(
			"ExitPlanMode",
			"core",
			tool({
				description: "Exit plan mode and return the session to normal execution mode once planning is complete.",
				inputSchema: z.object({}),
			}),
			async (call, context) => {
				await context.updateSession((session) => ({
					...session,
					mode: "normal",
				}));
				return {
					toolUseId: call.id,
					name: call.name,
					content: "Exited plan mode. Normal execution tools are available again.",
				};
			},
		),
	];
}

/**
 * 创建平台增强工具集合。
 * @returns 扩展工具列表
 */
export function createExtendedTools(): RuntimeTool[] {
	return [
		createRuntimeTool(
			"state_exec",
			"extended",
			tool({
				description:
					"Executes complete JavaScript code with access to state.* for structured workspace operations. Use this for platform-specific structured tasks when the core primitive tools are not enough.",
				inputSchema: z.object({
					code: z.string(),
					description: z.string().optional(),
				}),
			}),
			async (call, context) => {
				if (!context.executeState) {
					throw new Error("state_exec is not available");
				}

				const description = call.input.description ? String(call.input.description) : undefined;
				const execution = await context.executeState(String(call.input.code ?? ""), {
					description,
				});
				let content = "undefined";
				if (typeof execution.value === "string") {
					content = execution.value;
				} else if (execution.value !== undefined) {
					content = JSON.stringify(execution.value, null, 2);
				}

				return {
					toolUseId: call.id,
					name: call.name,
					content,
					meta: {
						description,
						resultType: execution.resultType,
					},
				};
			},
		),
		createRuntimeTool(
			"subagent_start",
			"extended",
			tool({
				description:
					"Create an asynchronous subagent job handle for later status checks. This is a platform extension, not part of the core Claude Code task flow.",
				inputSchema: z.object({
					prompt: z.string(),
					description: z.string().optional(),
				}),
			}),
			async (call, context) => {
				if (!context.startSubagent) {
					throw new Error("Subagent runtime is not available");
				}
				const job = await context.startSubagent(String(call.input.prompt ?? ""), {
					description: call.input.description ? String(call.input.description) : undefined,
				});
				return {
					toolUseId: call.id,
					name: call.name,
					content: `Subagent job ${job.id} is ${job.status}`,
					meta: job,
				};
			},
		),
		createRuntimeTool(
			"subagent_status",
			"extended",
			tool({
				description: "Read the current status and summary information for a single asynchronous subagent job.",
				inputSchema: z.object({
					jobId: z.string(),
				}),
			}),
			async (call, context) => {
				if (!context.getSubagentJob) {
					throw new Error("Subagent runtime is not available");
				}
				const job = await context.getSubagentJob(String(call.input.jobId ?? ""));
				return {
					toolUseId: call.id,
					name: call.name,
					content: job ? JSON.stringify(job, null, 2) : "Subagent job not found",
				};
			},
		),
		createRuntimeTool(
			"subagent_list",
			"extended",
			tool({
				description: "List all asynchronous subagent jobs for the current session.",
				inputSchema: z.object({}),
			}),
			async (call, context) => {
				if (!context.listSubagentJobs) {
					throw new Error("Subagent runtime is not available");
				}
				const jobs = await context.listSubagentJobs();
				return {
					toolUseId: call.id,
					name: call.name,
					content: jobs.length > 0 ? JSON.stringify(jobs, null, 2) : "No subagent jobs.",
				};
			},
		),
		createRuntimeTool(
			"load_skill",
			"extended",
			tool({
				description: "读取某个 skill 的入口文件 SKILL.md。",
				inputSchema: z.object({
					name: z.string(),
				}),
			}),
			async (call, context) => {
				const name = String(call.input.name ?? "");
				const skill = await context.skills.open(name);
				if (!skill) {
					throw new Error(`Skill not found: ${name}`);
				}

				return {
					toolUseId: call.id,
					name: call.name,
					content: await skill.readEntry(),
				};
			},
		),
		createRuntimeTool(
			"list_skill_files",
			"extended",
			tool({
				description: "列出某个 skill 根目录下的文件和目录。",
				inputSchema: z.object({
					name: z.string(),
				}),
			}),
			async (call, context) => {
				const name = String(call.input.name ?? "");
				const skill = await context.skills.open(name);
				if (!skill) {
					throw new Error(`Skill not found: ${name}`);
				}

				const files = await skill.workspace.files.list("/");
				return {
					toolUseId: call.id,
					name: call.name,
					content: files.map((file) => `${file.type}: ${file.path}`).join("\n") || "No files.",
				};
			},
		),
		createRuntimeTool(
			"read_skill_file",
			"extended",
			tool({
				description: "读取某个 skill 目录内的任意文本文件。",
				inputSchema: z.object({
					name: z.string(),
					path: z.string(),
				}),
			}),
			async (call, context) => {
				const name = String(call.input.name ?? "");
				const path = String(call.input.path ?? "");
				const skill = await context.skills.open(name);
				if (!skill) {
					throw new Error(`Skill not found: ${name}`);
				}

				const file = await skill.workspace.files.readFile(path);
				return {
					toolUseId: call.id,
					name: call.name,
					content: file.content,
				};
			},
		),
		createRuntimeTool(
			"task_create",
			"extended",
			tool({
				description: "创建一个 task，用于记录当前会话中的平台级工作项。",
				inputSchema: z.object({
					title: z.string(),
					description: z.string().optional(),
				}),
			}),
			async (call, context) => {
				const task = createTask({
					title: String(call.input.title ?? ""),
					description: call.input.description ? String(call.input.description) : undefined,
				});
				const tasks = context.loadTasks ? ((await context.loadTasks()) ?? []) : (await context.getSession()).tasks;
				if (context.saveTasks) {
					await context.saveTasks([...tasks, task]);
				} else {
					await context.updateSession((session) => ({
						...session,
						tasks: [...session.tasks, task],
					}));
				}
				return {
					toolUseId: call.id,
					name: call.name,
					content: `Created task ${task.id}: ${task.title}`,
				};
			},
		),
		createRuntimeTool(
			"task_list",
			"extended",
			tool({
				description: "列出当前会话中的全部 task board 项。",
				inputSchema: z.object({}),
			}),
			async (call, context) => {
				const tasks = context.loadTasks ? ((await context.loadTasks()) ?? []) : (await context.getSession()).tasks;
				return {
					toolUseId: call.id,
					name: call.name,
					content:
						tasks
							.map((task) => {
								const marker = {
									open: "[ ]",
									in_progress: "[>]",
									done: "[x]",
								}[task.status];
								const blockedBy = task.blockedBy.length > 0 ? ` (blocked by: ${task.blockedBy.join(", ")})` : "";
								return `${marker} #${task.id}: ${task.title}${blockedBy}`;
							})
							.join("\n") || "No tasks.",
				};
			},
		),
		createRuntimeTool(
			"task_update",
			"extended",
			tool({
				description: "更新 task board 条目的状态、标题、描述或依赖关系。",
				inputSchema: z.object({
					id: z.string(),
					title: z.string().optional(),
					description: z.string().optional(),
					status: z.string().optional(),
					addBlockedBy: z.array(z.string()).optional(),
					addBlocks: z.array(z.string()).optional(),
				}),
			}),
			async (call, context) => {
				const tasks = context.loadTasks ? ((await context.loadTasks()) ?? []) : (await context.getSession()).tasks;
				const nextTasks = updateTask(tasks, {
					id: String(call.input.id ?? ""),
					title: call.input.title ? String(call.input.title) : undefined,
					description: call.input.description ? String(call.input.description) : undefined,
					status: call.input.status as SessionState["tasks"][number]["status"] | undefined,
					addBlockedBy: Array.isArray(call.input.addBlockedBy)
						? call.input.addBlockedBy.map((value) => String(value))
						: undefined,
					addBlocks: Array.isArray(call.input.addBlocks)
						? call.input.addBlocks.map((value) => String(value))
						: undefined,
				});
				if (context.saveTasks) {
					await context.saveTasks(nextTasks);
				} else {
					await context.updateSession((session) => ({
						...session,
						tasks: nextTasks,
					}));
				}

				return {
					toolUseId: call.id,
					name: call.name,
					content: `Updated task ${String(call.input.id ?? "")}`,
				};
			},
		),
		createRuntimeTool(
			"task_get",
			"extended",
			tool({
				description: "读取单个 task board 条目的完整信息。",
				inputSchema: z.object({
					id: z.string(),
				}),
			}),
			async (call, context) => {
				const tasks = context.loadTasks ? ((await context.loadTasks()) ?? []) : (await context.getSession()).tasks;
				const task = getTask(tasks, String(call.input.id ?? ""));
				return {
					toolUseId: call.id,
					name: call.name,
					content: JSON.stringify(task, null, 2),
				};
			},
		),
	];
}

/**
 * 创建默认工具集合。
 * 默认集合会同时暴露 Claude Code 核心工具和当前平台扩展工具。
 * @returns 可注册工具列表
 */
export function createDefaultTools(): RuntimeTool[] {
	return [...createCoreTools(), ...createExtendedTools()];
}

/** Phase 1 默认工具集合常量 */
export const DEFAULT_TOOLS = createDefaultTools();

/**
 * 归一化 Todo 优先级输入。
 * @param value 原始输入
 * @returns 规范化优先级
 */
function normalizeTodoPriority(value: unknown): TodoPriority | undefined {
	if (value === "high" || value === "medium" || value === "low") {
		return value;
	}
	return undefined;
}
