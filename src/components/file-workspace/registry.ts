import type { FileRendererKind } from "./types";

/** Markdown 扩展名集合 */
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
/** 图片扩展名集合 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
/** PDF 扩展名集合 */
const PDF_EXTENSIONS = new Set(["pdf"]);

/**
 * 根据文件路径推断渲染模式。
 * 首版仅完整实现 Markdown 编辑和普通文本预览，图片/PDF 先保留扩展位。
 * @param path 文件路径
 * @returns 渲染模式
 */
export function resolveFileRendererKind(path: string): FileRendererKind {
	const extension = getFileExtension(path);
	if (!extension) {
		return "preview_text";
	}
	if (MARKDOWN_EXTENSIONS.has(extension)) {
		return "editable_markdown";
	}
	if (IMAGE_EXTENSIONS.has(extension)) {
		return "preview_image";
	}
	if (PDF_EXTENSIONS.has(extension)) {
		return "preview_pdf";
	}
	return "preview_text";
}

/**
 * 读取文件扩展名。
 * @param path 文件路径
 * @returns 小写扩展名；无扩展名时返回空字符串
 */
function getFileExtension(path: string): string {
	const basename = path.split("/").filter(Boolean).pop() ?? "";
	const dotIndex = basename.lastIndexOf(".");
	if (dotIndex < 0 || dotIndex === basename.length - 1) {
		return "";
	}
	return basename.slice(dotIndex + 1).toLowerCase();
}
