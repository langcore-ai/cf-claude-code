/** 文件渲染类型 */
export type FileRendererKind =
	| "editable_markdown"
	| "preview_image"
	| "preview_pdf"
	| "preview_text"
	| "unsupported";

/** 文件工作区组件输入 */
export interface FileWorkspaceProps {
	/** 当前文件路径 */
	path: string;
	/** 当前文件内容 */
	content: string;
	/** 是否正在加载 */
	isLoading: boolean;
	/** 是否正在保存 */
	isSaving: boolean;
	/** 局部错误信息 */
	errorMessage?: string | null;
	/** 内容变更时通知外层当前是否存在未保存修改 */
	onDirtyChange?: (dirty: boolean) => void;
	/** 保存文件 */
	onSave: (content: string) => Promise<void>;
}
