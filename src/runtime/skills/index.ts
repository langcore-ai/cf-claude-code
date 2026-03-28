import { createScopedWorkspace, InMemoryWorkspace, type Workspace } from "../workspace";

/** skill 元信息 */
export interface SkillMeta {
	/** skill 名称 */
	name: string;
	/** skill 简介 */
	description: string;
}

/** skill 句柄 */
export interface SkillHandle {
	/** skill 元信息 */
	meta: SkillMeta;
	/** skill 工作区视图 */
	workspace: Workspace;
	/**
	 * 读取 skill 入口文件
	 */
	readEntry(): Promise<string>;
}

/** skill provider 接口 */
export interface SkillProvider {
	/**
	 * 列出所有可用 skill
	 */
	list(): Promise<SkillMeta[]>;
	/**
	 * 打开某个 skill
	 * @param name skill 名称
	 */
	open(name: string): Promise<SkillHandle | null>;
}

/** 内存 skill 初始化数据 */
export interface InMemorySkillSeed {
	/** skill 名称 */
	name: string;
	/** 描述 */
	description: string;
	/** 文件树 */
	files: Record<string, string>;
}

/** workspace-backed skill provider 配置 */
export interface WorkspaceSkillProviderOptions {
	/** 根工作区 */
	workspace: Workspace;
	/** skill 根目录 */
	skillsRoot?: string;
}

/** 多来源 skill provider */
export interface MergedSkillProviderOptions {
	/** provider 列表，越靠前优先级越高 */
	providers: SkillProvider[];
}

/** 默认入口文件 */
export const SKILL_ENTRY_PATH = "/SKILL.md";

/** 默认 skill 根目录 */
const DEFAULT_SKILLS_ROOT = "/skills";

/**
 * 解析 skill 正文头部，提取可选的 frontmatter 描述字段。
 * @param content skill 正文
 * @returns 描述文本
 */
function parseSkillDescription(content: string): string {
	const matched = content.match(/^---\n([\s\S]*?)\n---/);
	if (!matched) {
		return "";
	}

	const descriptionLine = matched[1]
		.split("\n")
		.find((line) => line.trim().startsWith("description:"));
	return descriptionLine ? descriptionLine.split(":").slice(1).join(":").trim() : "";
}

/**
 * 通用 skill handle。
 */
class DefaultSkillHandle implements SkillHandle {
	/**
	 * @param meta skill 元信息
	 * @param workspace skill 工作区
	 */
	constructor(
		public readonly meta: SkillMeta,
		public readonly workspace: Workspace,
	) {}

	/**
	 * 读取 skill 入口内容
	 * @returns 入口文件文本
	 */
	async readEntry(): Promise<string> {
		const entry = await this.workspace.files.readFile(SKILL_ENTRY_PATH);
		return entry.content;
	}
}

/**
 * 内存 skill provider。
 */
export class InMemorySkillProvider implements SkillProvider {
	private readonly skills = new Map<string, InMemorySkillSeed>();

	/**
	 * @param seed 初始 skill 列表
	 */
	constructor(seed: InMemorySkillSeed[] = []) {
		for (const skill of seed) {
			this.skills.set(skill.name, skill);
		}
	}

	/**
	 * 列出所有 skill 摘要
	 * @returns skill 元信息列表
	 */
	async list(): Promise<SkillMeta[]> {
		return [...this.skills.values()]
			.map((skill) => ({
				name: skill.name,
				description: skill.description,
			}))
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	/**
	 * 打开一个 skill
	 * @param name skill 名称
	 * @returns skill 句柄；不存在时返回 null
	 */
	async open(name: string): Promise<SkillHandle | null> {
		const skill = this.skills.get(name);
		if (!skill) {
			return null;
		}

		return new DefaultSkillHandle(
			{
				name: skill.name,
				description: skill.description,
			},
			new InMemoryWorkspace(`skill:${skill.name}`, skill.files),
		);
	}
}

/**
 * 从真实 workspace 读取 skill 目录结构的 provider。
 */
export class WorkspaceSkillProvider implements SkillProvider {
	private readonly skillsRoot: string;

	/**
	 * @param options provider 配置
	 */
	constructor(private readonly options: WorkspaceSkillProviderOptions) {
		this.skillsRoot = options.skillsRoot ?? DEFAULT_SKILLS_ROOT;
	}

	/**
	 * 列出 workspace 中的全部技能
	 * @returns skill 元信息列表
	 */
	async list(): Promise<SkillMeta[]> {
		if (!(await this.options.workspace.files.exists(this.skillsRoot))) {
			return [];
		}

		const entries = await this.options.workspace.files.list(this.skillsRoot);
		const skills: SkillMeta[] = [];
		for (const entry of entries) {
			if (entry.type !== "directory") {
				continue;
			}

			const skillName = entry.path.split("/").filter(Boolean).at(-1);
			if (!skillName) {
				continue;
			}

			const entryPath = `${entry.path}/SKILL.md`;
			if (!(await this.options.workspace.files.exists(entryPath))) {
				continue;
			}

			const file = await this.options.workspace.files.readFile(entryPath);
			skills.push({
				name: skillName,
				description: parseSkillDescription(file.content),
			});
		}

		return skills.sort((left, right) => left.name.localeCompare(right.name));
	}

	/**
	 * 打开一个 workspace-backed skill
	 * @param name skill 名称
	 * @returns skill 句柄
	 */
	async open(name: string): Promise<SkillHandle | null> {
		const skillRoot = `${this.skillsRoot}/${name}`;
		if (!(await this.options.workspace.files.exists(skillRoot))) {
			return null;
		}

		const entryPath = `${skillRoot}/SKILL.md`;
		if (!(await this.options.workspace.files.exists(entryPath))) {
			return null;
		}

		const entry = await this.options.workspace.files.readFile(entryPath);
		return new DefaultSkillHandle(
			{
				name,
				description: parseSkillDescription(entry.content),
			},
			createScopedWorkspace(this.options.workspace, skillRoot, `skill:${name}`),
		);
	}
}

/**
 * 合并多个 skill provider。
 * 同名 skill 采用前者覆盖后者的策略。
 */
export class MergedSkillProvider implements SkillProvider {
	/**
	 * @param options provider 配置
	 */
	constructor(private readonly options: MergedSkillProviderOptions) {}

	/**
	 * 合并列出 skill 元信息
	 * @returns 去重后的 skill 列表
	 */
	async list(): Promise<SkillMeta[]> {
		const merged = new Map<string, SkillMeta>();
		for (const provider of this.options.providers) {
			const skills = await provider.list();
			for (const skill of skills) {
				if (!merged.has(skill.name)) {
					merged.set(skill.name, skill);
				}
			}
		}

		return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	/**
	 * 依次尝试打开 skill，前者优先。
	 * @param name skill 名称
	 * @returns skill 句柄
	 */
	async open(name: string): Promise<SkillHandle | null> {
		for (const provider of this.options.providers) {
			const handle = await provider.open(name);
			if (handle) {
				return handle;
			}
		}

		return null;
	}
}
