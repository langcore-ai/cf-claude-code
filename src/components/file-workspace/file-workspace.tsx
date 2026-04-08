import { FileWarningIcon } from "lucide-react";

import { resolveFileRendererKind } from "./registry";
import type { FileWorkspaceProps } from "./types";
import { FallbackPreview } from "./renderers/fallback-preview";
import { MarkdownEditor } from "./renderers/markdown-editor";

/**
 * 文件编辑/预览统一入口。
 * 由它决定当前文件应该进入哪种渲染模式，避免把文件类型判断散落到页面层。
 * @param props 组件输入
 * @returns 文件工作区组件
 */
export function FileWorkspace(props: FileWorkspaceProps) {
	const rendererKind = resolveFileRendererKind(props.path);

	if (rendererKind === "editable_markdown") {
		return <MarkdownEditor {...props} />;
	}

	if (rendererKind === "preview_text") {
		return <FallbackPreview content={props.content} isLoading={props.isLoading} />;
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between border-b border-border px-5 py-4">
				<div className="min-w-0">
					<p className="truncate text-sm font-semibold text-foreground">{props.path}</p>
					<p className="text-xs text-muted-foreground">预留文件预览类型</p>
				</div>
			</div>
			<div className="flex flex-1 items-center justify-center p-6">
				<div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-muted/20 px-6 py-8 text-center">
					<FileWarningIcon className="size-8 text-muted-foreground" />
					<div>
						<p className="text-sm font-medium text-foreground">该文件类型暂未实现预览器</p>
						<p className="mt-1 text-xs text-muted-foreground">
							当前仅完整支持 Markdown 编辑和普通文本预览；图片与 PDF 会在后续补齐。
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}
