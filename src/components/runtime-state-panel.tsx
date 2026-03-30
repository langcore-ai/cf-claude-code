import type { RuntimeSessionDto } from "@/react-app/lib/runtime-api";
import type { RuntimeTask, TodoItem } from "@/runtime/types/runtime";

import { Button } from "@/components/ui/button";

/** runtime 状态面板标签 */
export type RuntimePanelTab = "messages" | "todos" | "tasks" | "runtime";

/** 标签标题映射 */
const RUNTIME_TAB_LABELS: Record<RuntimePanelTab, string> = {
	messages: "Messages",
	runtime: "Runtime",
	tasks: "Tasks",
	todos: "Todos",
};

/**
 * 渲染 Todo 状态前缀。
 * @param todo Todo 项
 * @returns 文本前缀
 */
function renderTodoPrefix(todo: TodoItem): string {
	if (todo.status === "completed") {
		return "[x]";
	}
	if (todo.status === "in_progress") {
		return "[>]";
	}
	return "[ ]";
}

/**
 * 渲染 Task 状态前缀。
 * @param task Task 项
 * @returns 文本前缀
 */
function renderTaskPrefix(task: RuntimeTask): string {
	if (task.status === "done") {
		return "[x]";
	}
	if (task.status === "in_progress") {
		return "[>]";
	}
	return "[ ]";
}

/**
 * Runtime 状态观察面板。
 * @param props 组件参数
 * @returns tabs + 当前 tab 内容
 */
export function RuntimeStatePanel({
	activeTab,
	onChangeTab,
	runtimeError,
	session,
}: {
	activeTab: RuntimePanelTab;
	onChangeTab: (tab: RuntimePanelTab) => void;
	runtimeError: string | null;
	session: RuntimeSessionDto | null;
}) {
	return (
		<div className="flex min-h-0 flex-col rounded-2xl border border-border bg-card/60 p-3 shadow-sm">
			<div className="mb-3 flex flex-wrap gap-2">
				{(Object.keys(RUNTIME_TAB_LABELS) as RuntimePanelTab[]).map((tab) => (
					<Button
						className="rounded-full"
						key={tab}
						onClick={() => onChangeTab(tab)}
						size="sm"
						variant={activeTab === tab ? "secondary" : "ghost"}
					>
						{RUNTIME_TAB_LABELS[tab]}
					</Button>
				))}
			</div>

			{activeTab !== "messages" ? (
				<div className="min-h-0 flex-1">
					{activeTab === "todos" ? <TodoPanel todos={session?.todos ?? []} /> : null}
					{activeTab === "tasks" ? <TaskPanel tasks={session?.tasks ?? []} /> : null}
					{activeTab === "runtime" ? (
						<RuntimePanel runtimeError={runtimeError} session={session} />
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * Todo 面板。
 * @param props Todo 数据
 * @returns Todo 列表
 */
function TodoPanel({ todos }: { todos: TodoItem[] }) {
	if (todos.length === 0) {
		return <EmptyState text="当前没有 Todo。等 agent 触发 TodoWrite 后，这里会展示计划状态。" />;
	}

	return (
		<div className="space-y-2">
			{todos.map((todo) => (
				<div className="rounded-xl border border-border bg-background px-3 py-2" key={todo.id}>
					<p className="text-sm font-medium text-foreground">
						{renderTodoPrefix(todo)} {todo.content}
					</p>
					{todo.activeForm ? (
						<p className="mt-1 text-xs text-muted-foreground">active: {todo.activeForm}</p>
					) : null}
				</div>
			))}
		</div>
	);
}

/**
 * Task 面板。
 * @param props Task 数据
 * @returns Task 列表
 */
function TaskPanel({ tasks }: { tasks: RuntimeTask[] }) {
	if (tasks.length === 0) {
		return <EmptyState text="当前没有 Task。agent 更新任务看板后，这里会展示状态。" />;
	}

	return (
		<div className="space-y-2">
			{tasks.map((task) => (
				<div className="rounded-xl border border-border bg-background px-3 py-2" key={task.id}>
					<p className="text-sm font-medium text-foreground">
						{renderTaskPrefix(task)} {task.title}
					</p>
					{task.description ? (
						<p className="mt-1 text-xs text-muted-foreground">{task.description}</p>
					) : null}
					<p className="mt-1 text-xs text-muted-foreground">
						blockedBy: {task.blockedBy.length > 0 ? task.blockedBy.join(", ") : "none"}
					</p>
				</div>
			))}
		</div>
	);
}

/**
 * runtime 侧状态面板。
 * @param props runtime 数据
 * @returns runtime 状态块
 */
function RuntimePanel({
	runtimeError,
	session,
}: {
	runtimeError: string | null;
	session: RuntimeSessionDto | null;
}) {
	return (
		<div className="space-y-3">
			{runtimeError ? (
				<div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{runtimeError}
				</div>
			) : null}
			<div className="rounded-xl border border-border bg-background px-3 py-2">
				<p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
					Session
				</p>
				<p className="mt-2 text-sm text-foreground">
					{session?.closedAt ? "Closed" : "Active"}
				</p>
				{session?.closedAt ? (
					<p className="mt-1 text-xs text-muted-foreground">{session.closedAt}</p>
				) : null}
			</div>
			<div className="rounded-xl border border-border bg-background px-3 py-2">
				<p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
					Compact Summary
				</p>
				<p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">
					{session?.compactSummary ?? "当前还没有 compact summary。"}
				</p>
			</div>
			<div className="rounded-xl border border-border bg-background px-3 py-2">
				<p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
					Transcript Ref
				</p>
				<p className="mt-2 break-all text-sm text-foreground">
					{session?.transcriptRef ?? "当前还没有 transcript ref。"}
				</p>
			</div>
		</div>
	);
}

/**
 * 通用空状态。
 * @param props 文本内容
 * @returns 空态块
 */
function EmptyState({ text }: { text: string }) {
	return (
		<div className="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
			{text}
		</div>
	);
}
