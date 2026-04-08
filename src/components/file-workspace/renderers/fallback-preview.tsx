import { ScrollArea } from "@/components/ui/scroll-area";

/** 文本回退预览输入 */
interface FallbackPreviewProps {
	/** 文件内容 */
	content: string;
	/** 是否正在加载 */
	isLoading: boolean;
}

/**
 * 普通文本文件的回退预览器。
 * @param props 组件输入
 * @returns 只读文本预览
 */
export function FallbackPreview({
	content,
	isLoading,
}: FallbackPreviewProps) {
	return (
		<ScrollArea className="h-full w-full rounded-2xl border border-border bg-muted/30" type="always">
			<pre className="min-h-full whitespace-pre-wrap break-words p-4 text-sm leading-6 text-foreground">
				<code>{isLoading ? "// loading file..." : content}</code>
			</pre>
		</ScrollArea>
	);
}
