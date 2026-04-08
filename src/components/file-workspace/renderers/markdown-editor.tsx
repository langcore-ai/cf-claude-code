import { useEffect, useMemo } from "react";
import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor } from "@tiptap/react";
import { marked } from "marked";
import TurndownService from "turndown";
import { LoaderCircleIcon, SaveIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

import "../file-workspace.css";

/** Markdown 编辑器输入 */
interface MarkdownEditorProps {
	/** 文件路径 */
	path: string;
	/** 原始 Markdown 文本 */
	content: string;
	/** 是否正在加载 */
	isLoading: boolean;
	/** 是否正在保存 */
	isSaving: boolean;
	/** 局部错误 */
	errorMessage?: string | null;
	/** 脏状态变化回调 */
	onDirtyChange?: (dirty: boolean) => void;
	/** 保存内容 */
	onSave: (content: string) => Promise<void>;
}

/**
 * Markdown 所见即所得编辑器。
 * 首版通过 `marked` 把 Markdown 转成 HTML，再用 `turndown` 在保存时转回 Markdown。
 * @param props 组件输入
 * @returns Markdown 编辑器
 */
export function MarkdownEditor({
	path,
	content,
	isLoading,
	isSaving,
	errorMessage,
	onDirtyChange,
	onSave,
}: MarkdownEditorProps) {
	const turndown = useMemo(() => new TurndownService(), []);
	const editor = useEditor({
		editorProps: {
			attributes: {
				class: "markdown-editor-content min-h-full px-4 py-4 focus:outline-none",
			},
		},
		extensions: [StarterKit],
		immediatelyRender: false,
		content: markdownToHtml(content),
	});

	/**
	 * 文件切换或外部内容更新后，重置编辑器内容。
	 */
	useEffect(() => {
		if (!editor) {
			return;
		}

		const html = markdownToHtml(content);
		if (editor.getHTML() === html) {
			return;
		}

		// 用 setContent 同步外部最新内容，并标记当前为非脏状态。
		editor.commands.setContent(html, { emitUpdate: false });
		onDirtyChange?.(false);
	}, [content, editor, onDirtyChange, path]);

	/**
	 * 监听编辑器更新，向外同步脏状态。
	 */
	useEffect(() => {
		if (!editor) {
			return;
		}

		const handleUpdate = () => {
			const currentMarkdown = normalizeMarkdown(turndown.turndown(editor.getHTML()));
			onDirtyChange?.(currentMarkdown !== normalizeMarkdown(content));
		};

		editor.on("update", handleUpdate);
		handleUpdate();
		return () => {
			editor.off("update", handleUpdate);
		};
	}, [content, editor, onDirtyChange, turndown]);

	/**
	 * 保存当前编辑内容。
	 */
	async function handleSave() {
		if (!editor) {
			return;
		}

		const nextMarkdown = normalizeMarkdown(turndown.turndown(editor.getHTML()));
		await onSave(nextMarkdown);
		onDirtyChange?.(false);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
				<div className="min-w-0">
					<p className="truncate text-sm font-medium text-foreground">{path}</p>
					<p className="text-xs text-muted-foreground">Markdown 所见即所得编辑</p>
				</div>
				<Button disabled={!editor || isLoading || isSaving} onClick={() => void handleSave()} size="sm">
					{isSaving ? (
						<>
							<LoaderCircleIcon className="size-4 animate-spin" />
							Saving...
						</>
					) : (
						<>
							<SaveIcon className="size-4" />
							Save
						</>
					)}
				</Button>
			</div>

			{errorMessage ? (
				<div className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">
					{errorMessage}
				</div>
			) : null}

			<div className="min-h-0 flex-1 p-4">
				<ScrollArea className="h-full rounded-2xl border border-border bg-background" type="always">
					{isLoading || !editor ? (
						<div className="flex min-h-[240px] items-center justify-center text-sm text-muted-foreground">
							{isLoading ? "正在加载 Markdown..." : "正在初始化编辑器..."}
						</div>
					) : (
						<EditorContent className="min-h-full" editor={editor} />
					)}
				</ScrollArea>
			</div>
		</div>
	);
}

/**
 * 将 Markdown 转成 HTML，用于初始化编辑器内容。
 * @param markdown Markdown 文本
 * @returns HTML 字符串
 */
function markdownToHtml(markdown: string): string {
	return marked.parse(markdown) as string;
}

/**
 * 统一清洗 Markdown 文本，减少末尾空白差异对脏状态判断的影响。
 * @param markdown Markdown 文本
 * @returns 规范化结果
 */
function normalizeMarkdown(markdown: string): string {
	return markdown.trimEnd();
}
