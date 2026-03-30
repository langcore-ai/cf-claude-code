import type { Message, MessageBlock, TextBlock, ToolResultBlock, ToolUseBlock } from "@/runtime/types/runtime";

/** 角色文案映射 */
const ROLE_LABELS: Record<Message["role"], string> = {
	assistant: "Assistant",
	system: "System",
	user: "User",
};

/**
 * 将结构化输入格式化为可读 JSON。
 * @param value 任意结构化值
 * @returns 适合展示的 JSON 字符串
 */
function stringifyBlockValue(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/**
 * 格式化消息时间。
 * @param createdAt ISO 时间戳
 * @returns 简短时间文本
 */
function formatMessageTime(createdAt: string): string {
	try {
		return new Intl.DateTimeFormat("zh-CN", {
			hour: "2-digit",
			minute: "2-digit",
			month: "2-digit",
			day: "2-digit",
		}).format(new Date(createdAt));
	} catch {
		return createdAt;
	}
}

/**
 * 渲染文本块。
 * @param block 文本块
 * @returns 文本内容节点
 */
function renderTextBlock(block: TextBlock) {
	return (
		<div className="whitespace-pre-wrap break-words text-sm leading-6">
			{block.text}
		</div>
	);
}

/**
 * 渲染工具调用块。
 * @param block 工具调用块
 * @returns 工具调用视图
 */
function renderToolUseBlock(block: ToolUseBlock) {
	return (
		<div className="rounded-xl border border-sky-200 bg-sky-50/80 p-3 text-sky-950 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-100">
			<div className="flex items-center justify-between gap-3">
				<p className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-700 dark:text-sky-300">
					Tool Use
				</p>
				<p className="truncate text-xs text-sky-700/80 dark:text-sky-300/80">
					{block.name}
				</p>
			</div>
			<pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-background/80 p-3 text-xs leading-5 text-foreground">
				<code>{stringifyBlockValue(block.input)}</code>
			</pre>
		</div>
	);
}

/**
 * 渲染工具结果块。
 * @param block 工具结果块
 * @returns 工具结果视图
 */
function renderToolResultBlock(block: ToolResultBlock) {
	return (
		<div
			className={block.isError
				? "rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-destructive"
				: "rounded-xl border border-emerald-200 bg-emerald-50/80 p-3 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100"}
		>
			<div className="flex items-center justify-between gap-3">
				<p className="text-xs font-semibold uppercase tracking-[0.14em]">
					{block.isError ? "Tool Error" : "Tool Result"}
				</p>
				<p className="truncate text-xs opacity-80">{block.toolUseId}</p>
			</div>
			<pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-background/80 p-3 text-xs leading-5 text-foreground">
				<code>{block.content}</code>
			</pre>
		</div>
	);
}

/**
 * 渲染单个消息块。
 * @param block 消息块
 * @returns 对应块视图
 */
function renderMessageBlock(block: MessageBlock) {
	if (block.type === "text") {
		return renderTextBlock(block);
	}

	if (block.type === "tool_use") {
		return renderToolUseBlock(block);
	}

	return renderToolResultBlock(block);
}

/**
 * 结构化消息卡片。
 * @param props 组件参数
 * @returns 消息卡片节点
 */
export function ChatMessageCard({ message }: { message: Message }) {
	const isUser = message.role === "user";
	const isSystem = message.role === "system";

	return (
		<div className={isUser ? "ml-auto w-full max-w-[80%]" : "w-full max-w-[82%]"}>
			<div
				className={isSystem
					? "rounded-2xl border border-dashed border-border bg-muted/30 px-4 py-3 text-muted-foreground"
					: isUser
						? "rounded-2xl rounded-tr-sm bg-primary px-4 py-3 text-primary-foreground shadow-sm"
						: "rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3 text-card-foreground shadow-sm"}
			>
				<div className="mb-3 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.12em] opacity-80">
					<span>{ROLE_LABELS[message.role]}</span>
					<span>{formatMessageTime(message.createdAt)}</span>
				</div>
				<div className="space-y-3">
					{message.content.length > 0 ? (
						message.content.map((block, index) => (
							<div key={`${message.id}-${block.type}-${index}`}>
								{renderMessageBlock(block)}
							</div>
						))
					) : (
						<div className="text-sm opacity-80">(empty message)</div>
					)}
				</div>
			</div>
		</div>
	);
}
