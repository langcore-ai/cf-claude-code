"use client";

import {
	hotkeysCoreFeature,
	selectionFeature,
	syncDataLoaderFeature,
} from "@headless-tree/core";
import { AssistiveTreeDescription, useTree } from "@headless-tree/react";
import {
	FileCode2Icon,
	FileCogIcon,
	FileIcon,
	FileJsonIcon,
	FileTextIcon,
	FolderIcon,
} from "lucide-react";
import * as React from "react";

import { Tree, TreeItem, TreeItemLabel } from "@/components/tree";
import { cn } from "@/lib/utils";

/** 业务树根节点 id */
const WORKSPACE_TREE_ROOT_ID = "__workspace_root__";
/** 文件树缩进宽度 */
const DEFAULT_TREE_INDENT = 18;

/** 工作区节点类型 */
export type WorkspaceTreeNodeType = "file" | "directory" | "symlink";

/** 工作区文件树节点 */
export interface WorkspaceTreeNode {
	/** 节点绝对路径 */
	path: string;
	/** 节点展示名 */
	name: string;
	/** 节点类型 */
	type: WorkspaceTreeNodeType;
	/** 子节点；仅目录使用 */
	children?: WorkspaceTreeNode[];
}

/** 内部树节点数据 */
interface WorkspaceTreeItemData {
	/** 节点绝对路径 */
	path: string;
	/** 节点名称 */
	name: string;
	/** 节点类型 */
	type: WorkspaceTreeNodeType;
	/** 子节点 id 列表 */
	children?: string[];
	/** 文件扩展名 */
	extension?: string;
}

/** 业务文件树组件参数 */
export interface WorkspaceFileTreeProps {
	/** 根节点子树 */
	nodes: WorkspaceTreeNode[];
	/** 当前选中路径 */
	selectedPath?: string;
	/** 默认展开路径 */
	defaultExpandedPaths?: string[];
	/** 空树文案 */
	emptyLabel?: string;
	/** 节点选中回调 */
	onSelectPath?: (path: string, node: WorkspaceTreeNode) => void;
	/** 自定义 className */
	className?: string;
}

/**
 * 获取文件扩展名。
 * @param name 文件名
 * @returns 去掉点号后的扩展名；无扩展名时返回 undefined
 */
function getFileExtension(name: string): string | undefined {
	const segments = name.split(".");
	return segments.length > 1 ? segments[segments.length - 1]?.toLowerCase() : undefined;
}

/**
 * 将嵌套节点转换为 `headless-tree` 使用的扁平结构。
 * @param nodes 根节点列表
 * @returns 扁平 item map
 */
function buildWorkspaceTreeItems(nodes: WorkspaceTreeNode[]): Record<string, WorkspaceTreeItemData> {
	const items: Record<string, WorkspaceTreeItemData> = {
		[WORKSPACE_TREE_ROOT_ID]: {
			path: "/",
			name: "Workspace Root",
			type: "directory",
			children: nodes.map((node) => node.path),
		},
	};

	/**
	 * 递归登记节点
	 * @param node 当前节点
	 */
	const registerNode = (node: WorkspaceTreeNode) => {
		items[node.path] = {
			path: node.path,
			name: node.name,
			type: node.type,
			children: node.children?.map((child) => child.path),
			extension: node.type === "file" ? getFileExtension(node.name) : undefined,
		};

		node.children?.forEach(registerNode);
	};

	nodes.forEach(registerNode);
	return items;
}

/**
 * 根据节点类型和扩展名选择图标。
 * @param item 节点数据
 * @returns 图标节点
 */
function renderWorkspaceNodeIcon(item: WorkspaceTreeItemData) {
	const iconClassName = "size-4 text-muted-foreground";

	if (item.type === "directory") {
		return <FolderIcon className={iconClassName} />;
	}

	switch (item.extension) {
		case "ts":
		case "tsx":
		case "js":
		case "jsx":
			return <FileCode2Icon className={iconClassName} />;
		case "json":
			return <FileJsonIcon className={iconClassName} />;
		case "md":
		case "txt":
			return <FileTextIcon className={iconClassName} />;
		case "yml":
		case "yaml":
		case "toml":
			return <FileCogIcon className={iconClassName} />;
		default:
			return <FileIcon className={iconClassName} />;
	}
}

/**
 * 工作区业务文件树。
 * 这里把工作区节点结构、图标和选中行为收敛成单一业务组件，后续接真实 API 时只需要喂数据。
 * @param props 组件参数
 * @returns 工作区文件树
 */
export function WorkspaceFileTree({
	nodes,
	selectedPath,
	defaultExpandedPaths,
	emptyLabel = "当前工作区还没有文件",
	onSelectPath,
	className,
}: WorkspaceFileTreeProps) {
	const items = React.useMemo(() => buildWorkspaceTreeItems(nodes), [nodes]);
	const [activePath, setActivePath] = React.useState<string | undefined>(selectedPath);

	React.useEffect(() => {
		setActivePath(selectedPath);
	}, [selectedPath]);

	const tree = useTree<WorkspaceTreeItemData>({
		dataLoader: {
			getChildren: (itemId) => items[itemId]?.children ?? [],
			getItem: (itemId) => items[itemId],
		},
		features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
		getItemName: (item) => item.getItemData()?.name ?? "Unknown",
		indent: DEFAULT_TREE_INDENT,
		initialState: {
			expandedItems: [
				WORKSPACE_TREE_ROOT_ID,
				...(defaultExpandedPaths ?? nodes.filter((node) => node.type === "directory").map((node) => node.path)),
			],
			selectedItems: selectedPath ? [selectedPath] : [],
		},
		isItemFolder: (item) => item.getItemData()?.type === "directory",
		rootItemId: WORKSPACE_TREE_ROOT_ID,
	});

	/**
	 * 处理节点选择。
	 * @param node 节点数据
	 */
	const handleSelectPath = (node: WorkspaceTreeItemData) => {
		setActivePath(node.path);
		const matchedNode = findWorkspaceNodeByPath(nodes, node.path);
		if (matchedNode && onSelectPath) {
			onSelectPath(node.path, matchedNode);
		}
	};

	if (nodes.length === 0) {
		return (
			<div className={cn("rounded-xl border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground", className)}>
				{emptyLabel}
			</div>
		);
	}

	return (
		<div className={cn("rounded-2xl border border-border bg-background/70 p-2 shadow-sm", className)}>
			<Tree indent={DEFAULT_TREE_INDENT} tree={tree}>
				<AssistiveTreeDescription tree={tree} />
				{tree.getItems().map((item) => {
					const itemData = item.getItemData();
					if (!itemData || item.getId() === WORKSPACE_TREE_ROOT_ID) {
						return null;
					}

					return (
						<TreeItem className="pb-0!" item={item} key={item.getId()}>
							<TreeItemLabel
								className={cn(
									"rounded-lg py-1.5",
									activePath === itemData.path && "bg-accent text-accent-foreground",
								)}
								onClick={() => handleSelectPath(itemData)}
							>
								<span className="flex min-w-0 items-center gap-2">
									{renderWorkspaceNodeIcon(itemData)}
									<span className="truncate">{itemData.name}</span>
								</span>
							</TreeItemLabel>
						</TreeItem>
					);
				})}
			</Tree>
		</div>
	);
}

/**
 * 根据路径在嵌套节点中查找业务节点。
 * @param nodes 节点列表
 * @param path 目标路径
 * @returns 匹配到的节点；不存在时返回 undefined
 */
function findWorkspaceNodeByPath(
	nodes: WorkspaceTreeNode[],
	path: string,
): WorkspaceTreeNode | undefined {
	for (const node of nodes) {
		if (node.path === path) {
			return node;
		}
		const matched = node.children ? findWorkspaceNodeByPath(node.children, path) : undefined;
		if (matched) {
			return matched;
		}
	}
	return undefined;
}
