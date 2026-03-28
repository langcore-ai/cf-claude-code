import {
	InMemoryFs,
	Workspace as ShellWorkspace,
	WorkspaceFileSystem,
	type FileSystem,
	type InitialFiles,
	type SqlSource,
} from "@cloudflare/shell";

/** 文件节点类型 */
export type FileNodeType = "file" | "directory" | "symlink";
/** 工作区后端类型 */
export type WorkspaceBackendKind = "memory" | "durable";

/** 工作区后端句柄 */
export interface WorkspaceBackend {
	/** 后端类型 */
	kind: WorkspaceBackendKind;
	/** shell 文件系统句柄 */
	shellFileSystem: FileSystem;
	/** durable workspace 句柄；仅 durable 后端存在 */
	shellWorkspace?: ShellWorkspace;
}

/** 文件元数据 */
export interface FileNodeMeta {
	/** 规范化路径 */
	path: string;
	/** 节点类型 */
	type: FileNodeType;
}

/** 文件读取结果 */
export interface FileReadResult {
	/** 规范化路径 */
	path: string;
	/** 文件内容 */
	content: string;
}

/**
 * 面向 runtime 的文件系统视图。
 * 这里固定 runtime 需要的最小文件语义，不直接暴露 shell 的全部 `state.*`。
 */
export interface FileSystemView {
	/**
	 * 读取文本文件
	 * @param path 路径
	 */
	readFile(path: string): Promise<FileReadResult>;
	/**
	 * 写入文本文件
	 * @param path 路径
	 * @param content 文件内容
	 */
	writeFile(path: string, content: string): Promise<void>;
	/**
	 * 列出目录直接子节点
	 * @param path 目录路径
	 */
	list(path?: string): Promise<FileNodeMeta[]>;
	/**
	 * 检查路径是否存在
	 * @param path 路径
	 */
	exists(path: string): Promise<boolean>;
	/**
	 * 复制文件或目录
	 * @param from 源路径
	 * @param to 目标路径
	 */
	copy(from: string, to: string): Promise<void>;
	/**
	 * 移动文件或目录
	 * @param from 源路径
	 * @param to 目标路径
	 */
	move(from: string, to: string): Promise<void>;
}

/** Runtime 工作区 */
export interface Workspace {
	/** 工作区名称 */
	name: string;
	/** 文件系统视图 */
	readonly files: FileSystemView;
	/** 底层后端句柄 */
	readonly backend: WorkspaceBackend;
}

/** durable workspace 初始化参数 */
export interface DurableWorkspaceOptions {
	/** SQL 数据源 */
	sql: SqlSource;
	/** workspace 命名空间 */
	namespace?: string;
	/** 工作区名称 */
	name: string;
}

/** 根目录路径 */
const ROOT_PATH = "/";
/** durable workspace 进程内复用表 */
const SHELL_WORKSPACE_REGISTRY = new WeakMap<object, Map<string, ShellWorkspace>>();

/**
 * 规范化路径，统一收敛到绝对路径风格。
 * @param path 原始路径
 * @returns 规范化路径
 */
export function normalizePath(path: string): string {
	const parts = path
		.split("/")
		.map((part) => part.trim())
		.filter(Boolean);

	return parts.length === 0 ? ROOT_PATH : `/${parts.join("/")}`;
}

/**
 * 为同一个 SQL source + namespace/name 复用 shell workspace。
 * `@cloudflare/shell` 会在同进程里拒绝重复注册同名 namespace，这里在 adapter 层统一消化。
 * @param options durable workspace 配置
 * @returns 可复用的 shell workspace
 */
function resolveShellWorkspace(options: DurableWorkspaceOptions): ShellWorkspace {
	const source = options.sql;
	if (typeof source !== "object" || source === null) {
		return new ShellWorkspace({
			sql: options.sql,
			namespace: options.namespace,
			name: options.name,
		});
	}

	const identity = `${options.namespace ?? "default"}::${options.name}`;
	let scopedRegistry = SHELL_WORKSPACE_REGISTRY.get(source);
	if (!scopedRegistry) {
		scopedRegistry = new Map();
		SHELL_WORKSPACE_REGISTRY.set(source, scopedRegistry);
	}

	const existing = scopedRegistry.get(identity);
	if (existing) {
		return existing;
	}

	const workspace = new ShellWorkspace({
		sql: options.sql,
		namespace: options.namespace,
		name: options.name,
	});
	scopedRegistry.set(identity, workspace);
	return workspace;
}

/**
 * 将 shell FileSystem 适配到 runtime 的最小文件视图。
 */
class ShellFileSystemViewAdapter implements FileSystemView {
	/**
	 * @param fs shell 文件系统实现
	 */
	constructor(private readonly fs: FileSystem) {}

	/**
	 * 读取文本文件
	 * @param path 路径
	 * @returns 文件读取结果
	 */
	async readFile(path: string): Promise<FileReadResult> {
		const normalized = normalizePath(path);
		return {
			path: normalized,
			content: await this.fs.readFile(normalized),
		};
	}

	/**
	 * 写入文本文件
	 * @param path 路径
	 * @param content 文件内容
	 */
	async writeFile(path: string, content: string): Promise<void> {
		await this.fs.writeFile(normalizePath(path), content);
	}

	/**
	 * 列出目录直接子节点
	 * @param path 目录路径
	 * @returns 子节点元信息
	 */
	async list(path = ROOT_PATH): Promise<FileNodeMeta[]> {
		const normalized = normalizePath(path);
		const entries = await this.fs.readdirWithFileTypes(normalized);
		return entries
			.map((entry) => ({
				path: normalizePath(`${normalized}/${entry.name}`),
				type: entry.type,
			}))
			.sort((left, right) => left.path.localeCompare(right.path));
	}

	/**
	 * 检查路径是否存在
	 * @param path 路径
	 * @returns 是否存在
	 */
	async exists(path: string): Promise<boolean> {
		return this.fs.exists(normalizePath(path));
	}

	/**
	 * 复制文件或目录
	 * @param from 源路径
	 * @param to 目标路径
	 */
	async copy(from: string, to: string): Promise<void> {
		await this.fs.cp(normalizePath(from), normalizePath(to), { recursive: true });
	}

	/**
	 * 移动文件或目录
	 * @param from 源路径
	 * @param to 目标路径
	 */
	async move(from: string, to: string): Promise<void> {
		await this.fs.mv(normalizePath(from), normalizePath(to));
	}
}

/**
 * 作用域文件系统视图。
 * 用于把一个大工作区中的子目录映射为独立的 skill/workspace 视图。
 */
class ScopedFileSystemView implements FileSystemView {
	/**
	 * @param base 基础文件视图
	 * @param basePath 作用域根路径
	 */
	constructor(
		private readonly base: FileSystemView,
		private readonly basePath: string,
	) {}

	/**
	 * 读取文本文件
	 * @param path 相对路径
	 * @returns 文件结果
	 */
	async readFile(path: string): Promise<FileReadResult> {
		const result = await this.base.readFile(this.resolve(path));
		return {
			path: normalizePath(path),
			content: result.content,
		};
	}

	/**
	 * 写入文本文件
	 * @param path 相对路径
	 * @param content 文件内容
	 */
	async writeFile(path: string, content: string): Promise<void> {
		await this.base.writeFile(this.resolve(path), content);
	}

	/**
	 * 列目录
	 * @param path 相对路径
	 * @returns 子节点列表
	 */
	async list(path = ROOT_PATH): Promise<FileNodeMeta[]> {
		const entries = await this.base.list(this.resolve(path));
		return entries.map((entry) => ({
			...entry,
			path: normalizePath(entry.path.slice(this.basePath.length) || ROOT_PATH),
		}));
	}

	/**
	 * 检查路径是否存在
	 * @param path 相对路径
	 * @returns 是否存在
	 */
	async exists(path: string): Promise<boolean> {
		return this.base.exists(this.resolve(path));
	}

	/**
	 * 复制文件或目录
	 * @param from 相对源路径
	 * @param to 相对目标路径
	 */
	async copy(from: string, to: string): Promise<void> {
		await this.base.copy(this.resolve(from), this.resolve(to));
	}

	/**
	 * 移动文件或目录
	 * @param from 相对源路径
	 * @param to 相对目标路径
	 */
	async move(from: string, to: string): Promise<void> {
		await this.base.move(this.resolve(from), this.resolve(to));
	}

	/**
	 * 拼出真实路径
	 * @param path 相对路径
	 * @returns 真实路径
	 */
	private resolve(path: string): string {
		const normalizedBase = normalizePath(this.basePath);
		const normalizedPath = normalizePath(path);
		if (normalizedPath === ROOT_PATH) {
			return normalizedBase;
		}
		return normalizePath(`${normalizedBase}/${normalizedPath}`);
	}
}

/**
 * 内存工作区适配器。
 * 底层直接复用 `@cloudflare/shell` 的 `InMemoryFs`。
 */
export class InMemoryWorkspaceAdapter implements Workspace {
	/** 文件视图 */
	readonly files: FileSystemView;
	/** 工作区后端 */
	readonly backend: WorkspaceBackend;

	/**
	 * @param name 工作区名称
	 * @param seed 初始文件树
	 */
	constructor(
		public readonly name: string,
		seed?: Record<string, string>,
	) {
		const fs = new InMemoryFs(seed as InitialFiles | undefined);
		this.files = new ShellFileSystemViewAdapter(fs);
		this.backend = {
			kind: "memory",
			shellFileSystem: fs,
		};
	}
}

/**
 * durable workspace 适配器。
 * 底层直接使用 `@cloudflare/shell Workspace({ sql })`。
 */
export class DurableWorkspaceAdapter implements Workspace {
	/** shell workspace 实例 */
	readonly workspace: ShellWorkspace;
	/** 文件视图 */
	readonly files: FileSystemView;
	/** 工作区后端 */
	readonly backend: WorkspaceBackend;
	/** 工作区名称 */
	readonly name: string;

	/**
	 * @param options durable workspace 配置
	 */
	constructor(options: DurableWorkspaceOptions) {
		this.name = options.name;
		this.workspace = resolveShellWorkspace(options);
		const shellFileSystem = new WorkspaceFileSystem(this.workspace);
		this.files = new ShellFileSystemViewAdapter(shellFileSystem);
		this.backend = {
			kind: "durable",
			shellFileSystem,
			shellWorkspace: this.workspace,
		};
	}
}

/**
 * 基于父 workspace 构造子目录作用域视图。
 * @param workspace 父工作区
 * @param basePath 子目录路径
 * @param name 子工作区名称
 * @returns 作用域工作区
 */
export function createScopedWorkspace(workspace: Workspace, basePath: string, name: string): Workspace {
	return {
		name,
		files: new ScopedFileSystemView(workspace.files, basePath),
		backend: workspace.backend,
	};
}

/** 兼容旧名称导出 */
export const InMemoryWorkspace = InMemoryWorkspaceAdapter;
export const DurableWorkspace = DurableWorkspaceAdapter;
