import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { FileUpIcon, LoaderCircleIcon, PanelLeftIcon, RefreshCwIcon, SparklesIcon, XIcon } from "lucide-react";
import { useLocalStorage } from "react-use";

import { ChatMessageCard } from "@/components/chat-message-card";
import { RuntimeStatePanel, type RuntimePanelTab } from "@/components/runtime-state-panel";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	type WorkspaceTreeNode,
	WorkspaceFileTree,
} from "@/components/workspace-file-tree";
import { formatBytes, useFileUpload } from "@/hooks/use-file-upload";
import {
	createSession,
	getSession,
	listWorkspaceTree,
	listSessions,
	readWorkspaceFile,
	sendMessage,
	shutdownSession,
	type RuntimeSessionDto,
	type WorkspaceEntryDto,
	uploadWorkspaceFile,
} from "@/react-app/lib/runtime-api";

/** 右侧分栏布局的 localStorage key */
const PREVIEW_LAYOUT_STORAGE_KEY = "playground-preview-layout";
/** 右侧文件预览面板默认宽度 */
const DEFAULT_PREVIEW_PANEL_SIZE = 50;
/** 右侧聊天面板默认宽度 */
const DEFAULT_CHAT_PANEL_SIZE = 50;
/** 文件预览面板最小宽度 */
const PREVIEW_PANEL_MIN_SIZE = "360px";
/** 聊天面板最小宽度 */
const CHAT_PANEL_MIN_SIZE = "420px";
/** session 列表面板最小高度 */
const SESSION_LIST_PANEL_MIN_SIZE = "180px";
/** 文件树面板最小高度 */
const FILE_TREE_PANEL_MIN_SIZE = "240px";
/** 左侧 sidebar 最小宽度 */
const SIDEBAR_PANEL_MIN_SIZE = "280px";
/** 左侧 sidebar 最大宽度 */
const SIDEBAR_PANEL_MAX_SIZE = "420px";
/** 左侧 sidebar 默认宽度 */
const SIDEBAR_PANEL_DEFAULT_SIZE = "320px";

/** session 演示数据 */
interface SessionListItem {
	/** 会话 id */
	id: string;
	/** 展示标题 */
	label: string;
	/** 当前状态 */
	status: "Active" | "Closed";
	/** 摘要 */
	summary: string;
}

/** 会话列表上限 */
const MAX_SESSION_ITEMS = 8;

/** 文件树默认展开目录 */
const DEFAULT_EXPANDED_PATHS = ["/skills", "/src"];

/** 文件上传大小上限 */
const FILE_UPLOAD_MAX_SIZE = 100 * 1024 * 1024;
/** 文件上传数量上限 */
const FILE_UPLOAD_MAX_FILES = 10;

function App() {
	const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
	const [sessionItems, setSessionItems] = useState<SessionListItem[]>([]);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
	const [currentSession, setCurrentSession] = useState<RuntimeSessionDto | null>(null);
	const [messageDraft, setMessageDraft] = useState("");
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const [isSendingMessage, setIsSendingMessage] = useState(false);
	const [isRefreshingSession, setIsRefreshingSession] = useState(false);
	const [isRefreshingWorkspace, setIsRefreshingWorkspace] = useState(false);
	const [workspaceTree, setWorkspaceTree] = useState<WorkspaceTreeNode[]>([]);
	const [selectedFileContent, setSelectedFileContent] = useState("");
	const [isLoadingSelectedFile, setIsLoadingSelectedFile] = useState(false);
	const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
	const [isUploadingFiles, setIsUploadingFiles] = useState(false);
	const [runtimeError, setRuntimeError] = useState<string | null>(null);
	const [activeRuntimeTab, setActiveRuntimeTab] = useState<RuntimePanelTab>("messages");
	const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
	const hasBootstrappedSessionRef = useRef(false);
	const messagesEndRef = useRef<HTMLDivElement | null>(null);
	const [previewLayout, setPreviewLayout] = useLocalStorage<{
		preview: number;
		chat: number;
	}>(PREVIEW_LAYOUT_STORAGE_KEY, {
		preview: DEFAULT_PREVIEW_PANEL_SIZE,
		chat: DEFAULT_CHAT_PANEL_SIZE,
	});

	/** 当前是否处于三分栏模式 */
	const isPreviewMode = Boolean(selectedFilePath);
	const previewSize = previewLayout?.preview ?? DEFAULT_PREVIEW_PANEL_SIZE;
	const chatSize = previewLayout?.chat ?? DEFAULT_CHAT_PANEL_SIZE;
	const previewDefaultLayout = {
		preview: previewSize,
		chat: chatSize,
	};
	const [
		uploadState,
		{
			clearErrors: clearUploadErrors,
			clearFiles: clearUploadFiles,
			getInputProps,
			handleDragEnter,
			handleDragLeave,
			handleDragOver,
			handleDrop,
			openFileDialog,
			removeFile,
		},
	] = useFileUpload({
		maxFiles: FILE_UPLOAD_MAX_FILES,
		maxSize: FILE_UPLOAD_MAX_SIZE,
		multiple: true,
	});
	const hasUploadFiles = uploadState.files.length > 0;

	/**
	 * 关闭上传模态框时，顺手清理已选文件和错误，避免下次打开仍是旧状态。
	 */
	useEffect(() => {
		if (isUploadDialogOpen) {
			return;
		}

		clearUploadErrors();
		clearUploadFiles();
	}, [clearUploadErrors, clearUploadFiles, isUploadDialogOpen]);

	/**
	 * 当消息列表发生变化时，自动滚动到底部，方便观察 tool_result 和 compact 后的新状态。
	 */
	useEffect(() => {
		if (activeRuntimeTab !== "messages") {
			return;
		}

		messagesEndRef.current?.scrollIntoView({
			behavior: "smooth",
			block: "end",
		});
	}, [activeRuntimeTab, currentSession?.compactSummary, currentSession?.messages, pendingUserMessage]);

	/**
	 * 首次进入 playground 时自动创建一个 session，避免页面空跑。
	 */
	useEffect(() => {
		if (selectedSessionId || isCreatingSession || hasBootstrappedSessionRef.current) {
			return;
		}

		hasBootstrappedSessionRef.current = true;
		void bootstrapSessions();
	}, [isCreatingSession, selectedSessionId]);

	/**
	 * 更新当前会话的列表项。
	 * @param session 最新会话快照
	 */
	function upsertSessionItem(session: RuntimeSessionDto) {
		setSessionItems((previous) => {
			const nextItem = buildSessionListItem(session);
			const filtered = previous.filter((item) => item.id !== session.id);
			return [...filtered, nextItem]
				.sort((left, right) => left.id.localeCompare(right.id))
				.slice(0, MAX_SESSION_ITEMS);
		});
	}

	/**
	 * 创建一个新 session，并切到该 session。
	 */
	async function handleCreateSession() {
		try {
			setRuntimeError(null);
			setIsCreatingSession(true);
			const response = await createSession();
			setCurrentSession(response.session);
			setSelectedSessionId(response.sessionId);
			upsertSessionItem(response.session);
			setSelectedFilePath(null);
			setSelectedFileContent("");
			setActiveRuntimeTab("messages");
			await refreshWorkspaceTree(response.sessionId);
		} catch (error) {
			setRuntimeError(error instanceof Error ? error.message : "Failed to create session");
		} finally {
			setIsCreatingSession(false);
		}
	}

	/**
	 * 页面首次进入时优先恢复已有 session；只有列表为空时才创建新 session。
	 */
	async function bootstrapSessions() {
		try {
			setRuntimeError(null);
			setIsCreatingSession(true);
			const response = await listSessions();

			if (response.sessions.length > 0) {
				setSessionItems(response.sessions.map(buildSessionListItem).slice(0, MAX_SESSION_ITEMS));
				const latestSession = response.sessions[0];
				setCurrentSession(latestSession);
				setSelectedSessionId(latestSession.id);
				setSelectedFilePath(null);
				setSelectedFileContent("");
				setActiveRuntimeTab("messages");
				await refreshWorkspaceTree(latestSession.id);
				return;
			}

			const created = await createSession();
			setCurrentSession(created.session);
			setSelectedSessionId(created.sessionId);
			upsertSessionItem(created.session);
			setSelectedFilePath(null);
			setSelectedFileContent("");
			setActiveRuntimeTab("messages");
			await refreshWorkspaceTree(created.sessionId);
		} catch (error) {
			setRuntimeError(error instanceof Error ? error.message : "Failed to bootstrap sessions");
		} finally {
			setIsCreatingSession(false);
		}
	}

	/**
	 * 切换到指定 session，并刷新快照。
	 * @param sessionId 会话 id
	 */
	async function handleSelectSession(sessionId: string) {
		try {
			setRuntimeError(null);
			setIsRefreshingSession(true);
			const response = await getSession(sessionId);
			setCurrentSession(response.session);
			setSelectedSessionId(response.sessionId);
			upsertSessionItem(response.session);
			setSelectedFilePath(null);
			setSelectedFileContent("");
			setActiveRuntimeTab("messages");
			await refreshWorkspaceTree(response.sessionId);
		} catch (error) {
			setRuntimeError(error instanceof Error ? error.message : "Failed to fetch session");
		} finally {
			setIsRefreshingSession(false);
		}
	}

	/**
	 * 发送消息并刷新当前会话。
	 */
	async function handleSendMessage() {
		if (!selectedSessionId || messageDraft.trim() === "") {
			return;
		}

		try {
			setRuntimeError(null);
			setIsSendingMessage(true);
			const nextMessage = messageDraft.trim();
			setPendingUserMessage(nextMessage);
			setActiveRuntimeTab("messages");
			const response = await sendMessage(selectedSessionId, nextMessage);
			setCurrentSession(response.session);
			upsertSessionItem(response.session);
			setMessageDraft("");
		} catch (error) {
			setRuntimeError(error instanceof Error ? error.message : "Failed to send message");
		} finally {
			setIsSendingMessage(false);
			setPendingUserMessage(null);
		}
	}

	/**
	 * 关闭当前会话。
	 */
	async function handleShutdownSession() {
		if (!selectedSessionId) {
			return;
		}

		try {
			setRuntimeError(null);
			await shutdownSession(selectedSessionId);
			const response = await getSession(selectedSessionId);
			setCurrentSession(response.session);
			upsertSessionItem(response.session);
		} catch (error) {
			setRuntimeError(error instanceof Error ? error.message : "Failed to shutdown session");
		}
	}

	/**
	 * 刷新当前 session 的整个工作区树。
	 * @param sessionId 会话 id
	 */
	async function refreshWorkspaceTree(sessionId: string) {
		try {
			setIsRefreshingWorkspace(true);
			const nextTree = await loadWorkspaceTree(sessionId);
			setWorkspaceTree(nextTree);
		} finally {
			setIsRefreshingWorkspace(false);
		}
	}

	/**
	 * 读取选中文件内容，并进入预览区。
	 * @param path 文件路径
	 */
	async function handleSelectFile(path: string) {
		if (!selectedSessionId) {
			return;
		}

		try {
			setRuntimeError(null);
			setIsLoadingSelectedFile(true);
			const response = await readWorkspaceFile(selectedSessionId, path);
			setSelectedFilePath(response.path);
			setSelectedFileContent(response.content);
		} catch (error) {
			setRuntimeError(error instanceof Error ? error.message : "Failed to read workspace file");
		} finally {
			setIsLoadingSelectedFile(false);
		}
	}

	/**
	 * 将上传区里的文件批量写入当前工作区。
	 */
	async function handleUploadFiles() {
		if (!selectedSessionId || !hasUploadFiles) {
			return;
		}

		try {
			setRuntimeError(null);
			setIsUploadingFiles(true);
			for (const item of uploadState.files) {
				if (!(item.file instanceof File)) {
					continue;
				}
				await uploadWorkspaceFile(selectedSessionId, item.file);
			}
			await refreshWorkspaceTree(selectedSessionId);
			setIsUploadDialogOpen(false);
		} catch (error) {
			setRuntimeError(error instanceof Error ? error.message : "Failed to upload files");
		} finally {
			setIsUploadingFiles(false);
		}
	}

	const workspaceHelperText = useMemo(() => {
		if (!selectedSessionId) {
			return "No active session";
		}
		if (isRefreshingWorkspace) {
			return "Refreshing workspace...";
		}
		return selectedSessionId;
	}, [isRefreshingWorkspace, selectedSessionId]);
	const workspaceTreeKey = useMemo(
		() => `${selectedSessionId ?? "no-session"}:${collectWorkspaceTreePaths(workspaceTree).join("|")}`,
		[selectedSessionId, workspaceTree],
	);

	return (
		<main className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.08),transparent_28%),linear-gradient(180deg,#f8fafc_0%,#e2e8f0_100%)]">
			<div className="h-screen w-screen overflow-hidden border border-border/60 bg-background/85 shadow-[0_30px_80px_rgba(15,23,42,0.14)] backdrop-blur">
				<ResizablePanelGroup className="h-full min-h-0" orientation="horizontal">
					<ResizablePanel
						defaultSize={SIDEBAR_PANEL_DEFAULT_SIZE}
						maxSize={SIDEBAR_PANEL_MAX_SIZE}
						minSize={SIDEBAR_PANEL_MIN_SIZE}
					>
						<aside className="flex h-full min-h-0 flex-col border-r border-border/70 bg-sidebar px-4 py-4">
						<div className="mb-4 flex items-center gap-3 border-b border-sidebar-border pb-4">
							<div className="flex size-10 items-center justify-center rounded-2xl bg-sidebar-primary text-sidebar-primary-foreground">
								<PanelLeftIcon className="size-4" />
							</div>
							<div className="min-w-0">
								<p className="truncate text-sm font-semibold text-sidebar-foreground">
									Workspace
								</p>
								<p className="truncate text-xs text-muted-foreground">
									session workspace explorer
								</p>
							</div>
						</div>

						<ResizablePanelGroup className="min-h-0 flex-1" orientation="vertical">
							<ResizablePanel defaultSize={34} minSize={SESSION_LIST_PANEL_MIN_SIZE}>
								<section className="flex h-full min-h-0 flex-col">
									<div className="mb-3">
										<p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
											Sessions
										</p>
										<p className="mt-1 text-xs text-muted-foreground">
											创建、切换和关闭当前 playground 会话
										</p>
									</div>

									<div className="mb-3">
										<Button
											className="w-full"
											disabled={isCreatingSession}
											onClick={() => void handleCreateSession()}
											variant="outline"
										>
											<SparklesIcon data-icon="inline-start" />
											{isCreatingSession ? "Creating..." : "New Session"}
										</Button>
									</div>

									<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto pr-1">
										{sessionItems.map((session) => {
											const isSelected = session.id === selectedSessionId;
											return (
												<Button
													className="h-auto flex-col items-start justify-start gap-1 rounded-2xl px-3 py-3 text-left"
													key={session.id}
													onClick={() => void handleSelectSession(session.id)}
													variant={isSelected ? "secondary" : "ghost"}
												>
													<span className="w-full truncate text-sm font-semibold">
														{session.label}
													</span>
													<span className="w-full truncate text-xs text-muted-foreground">
														{session.summary}
													</span>
													<span className="mt-1 inline-flex rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
														{session.status}
													</span>
												</Button>
											);
										})}

										{sessionItems.length === 0 ? (
											<div className="rounded-2xl border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
												当前还没有 session，点击上方按钮创建。
											</div>
										) : null}
									</div>
								</section>
							</ResizablePanel>

							<ResizableHandle />

							<ResizablePanel defaultSize={66} minSize={FILE_TREE_PANEL_MIN_SIZE}>
								<section className="flex h-full min-h-0 flex-col">
									<div className="mb-3 flex items-start justify-between gap-3">
										<div>
											<p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
												Files
											</p>
											<p className="mt-1 text-xs text-muted-foreground">
												{workspaceHelperText}
											</p>
										</div>
										<div className="flex items-center gap-2">
											<Button
												disabled={!selectedSessionId || isRefreshingWorkspace}
												onClick={() => {
													if (!selectedSessionId) {
														return;
													}
													void refreshWorkspaceTree(selectedSessionId);
												}}
												size="icon"
												variant="outline"
											>
												<RefreshCwIcon className={isRefreshingWorkspace ? "size-4 animate-spin" : "size-4"} />
												<span className="sr-only">Refresh workspace tree</span>
											</Button>
											<Button
												disabled={!selectedSessionId}
												onClick={() => setIsUploadDialogOpen(true)}
												size="sm"
												variant="outline"
											>
												<FileUpIcon className="size-4" />
												Upload
											</Button>
										</div>
									</div>

									<div className="min-h-0 flex-1 overflow-hidden">
										<WorkspaceFileTree
											className="h-full min-h-full border-sidebar-border bg-sidebar"
											defaultExpandedPaths={DEFAULT_EXPANDED_PATHS}
											key={workspaceTreeKey}
											nodes={workspaceTree}
											onSelectPath={(path, node) => {
												if (node.type !== "file") {
													setSelectedFilePath(null);
													return;
												}
												void handleSelectFile(path);
											}}
											selectedPath={selectedFilePath ?? undefined}
										/>
									</div>
								</section>
							</ResizablePanel>
						</ResizablePanelGroup>
						</aside>
					</ResizablePanel>

					<ResizableHandle />

					<ResizablePanel>
						<section className="flex h-full min-w-0 flex-col bg-background/70">
						{isPreviewMode ? (
							<ResizablePanelGroup
								className="h-full"
								defaultLayout={previewDefaultLayout}
								onLayoutChanged={(layout) => {
									setPreviewLayout({
										preview: layout.preview ?? DEFAULT_PREVIEW_PANEL_SIZE,
										chat: layout.chat ?? DEFAULT_CHAT_PANEL_SIZE,
									});
								}}
								orientation="horizontal"
							>
								<ResizablePanel
									id="preview"
									minSize={PREVIEW_PANEL_MIN_SIZE}
								>
									<section className="flex h-full min-h-0 flex-col">
										<div className="flex items-center justify-between border-b border-border px-5 py-4">
											<div className="min-w-0">
												<p className="truncate text-sm font-semibold text-foreground">
													{selectedFilePath}
												</p>
												<p className="text-xs text-muted-foreground">
													file preview
												</p>
											</div>
											<Button
												onClick={() => setSelectedFilePath(null)}
												size="icon"
												variant="ghost"
											>
												<XIcon data-icon="inline-start" />
											</Button>
										</div>
										<div className="min-h-0 flex-1 p-5">
											<ScrollArea className="h-full w-full rounded-2xl border border-border bg-muted/30" type="always">
												<pre className="min-h-full whitespace-pre-wrap break-words p-4 text-sm leading-6 text-foreground">
													<code>{isLoadingSelectedFile ? "// loading file..." : selectedFileContent}</code>
												</pre>
											</ScrollArea>
										</div>
									</section>
								</ResizablePanel>

								<ResizableHandle withHandle />

								<ResizablePanel
									id="chat"
									minSize={CHAT_PANEL_MIN_SIZE}
								>
									{renderChatPanel({
										activeRuntimeTab,
										currentSession,
										isRefreshingSession,
										isSendingMessage,
										messageDraft,
										messagesEndRef,
										onChangeMessageDraft: setMessageDraft,
										onChangeRuntimeTab: setActiveRuntimeTab,
										onSendMessage: handleSendMessage,
										onShutdownSession: handleShutdownSession,
										pendingUserMessage,
										runtimeError,
									})}
								</ResizablePanel>
							</ResizablePanelGroup>
						) : (
							renderChatPanel({
								activeRuntimeTab,
								currentSession,
								isRefreshingSession,
								isSendingMessage,
								messageDraft,
								messagesEndRef,
								onChangeMessageDraft: setMessageDraft,
								onChangeRuntimeTab: setActiveRuntimeTab,
								onSendMessage: handleSendMessage,
								onShutdownSession: handleShutdownSession,
								pendingUserMessage,
								runtimeError,
							})
						)}
						</section>
					</ResizablePanel>
				</ResizablePanelGroup>
			</div>

			<Dialog onOpenChange={setIsUploadDialogOpen} open={isUploadDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>上传文件到工作区</DialogTitle>
						<DialogDescription>
							当前首版默认把文件上传到工作区根目录，上传完成后会自动刷新左侧文件树。
						</DialogDescription>
					</DialogHeader>

					<div className="mt-4 flex flex-col gap-3">
						<div
							className="flex min-h-44 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-muted/20 p-6 text-center transition-colors hover:bg-accent/40 data-[dragging=true]:bg-accent/60"
							data-dragging={uploadState.isDragging || undefined}
							onClick={openFileDialog}
							onDragEnter={handleDragEnter}
							onDragLeave={handleDragLeave}
							onDragOver={handleDragOver}
							onDrop={handleDrop}
							role="button"
							tabIndex={-1}
						>
							<input
								{...getInputProps()}
								aria-label="Upload files"
								className="sr-only"
							/>

							<div className="mb-3 flex size-11 items-center justify-center rounded-full border border-border bg-background">
								<FileUpIcon className="size-4 text-muted-foreground" />
							</div>
							<p className="text-sm font-medium text-foreground">拖拽文件到这里，或点击选择文件</p>
							<p className="mt-1 text-xs text-muted-foreground">
								最多 {FILE_UPLOAD_MAX_FILES} 个文件，单个文件不超过 {formatBytes(FILE_UPLOAD_MAX_SIZE)}
							</p>
						</div>

						{uploadState.errors.length > 0 ? (
							<div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
								{uploadState.errors[0]}
							</div>
						) : null}

						{hasUploadFiles ? (
							<div className="space-y-2">
								{uploadState.files.map((item) => (
									<div
										className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 py-2"
										key={item.id}
									>
										<div className="min-w-0">
											<p className="truncate text-sm font-medium text-foreground">
												{item.file instanceof File ? item.file.name : item.file.name}
											</p>
											<p className="text-xs text-muted-foreground">
												{formatBytes(item.file instanceof File ? item.file.size : item.file.size)}
											</p>
										</div>
										<Button
											className="shrink-0"
											onClick={() => removeFile(item.id)}
											size="icon"
											variant="ghost"
										>
											<XIcon className="size-4" />
										</Button>
									</div>
								))}
							</div>
						) : null}
					</div>

					<DialogFooter>
						<Button
							onClick={() => setIsUploadDialogOpen(false)}
							variant="ghost"
						>
							取消
						</Button>
						<Button
							disabled={!selectedSessionId || !hasUploadFiles || isUploadingFiles}
							onClick={() => void handleUploadFiles()}
						>
							{isUploadingFiles ? (
								<>
									<LoaderCircleIcon className="size-4 animate-spin" />
									Uploading...
								</>
							) : (
								<>
									<FileUpIcon className="size-4" />
									上传文件
								</>
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</main>
	);
}

/**
 * 收集树中的全部路径，用作 React remount key。
 * `headless-tree` 在数据源变化后不会总是自动重建可见节点，
 * 这里用 key 强制重挂载，确保新上传的文件能立刻出现在树里。
 * @param nodes 文件树节点
 * @returns 扁平路径列表
 */
function collectWorkspaceTreePaths(nodes: WorkspaceTreeNode[]): string[] {
	return nodes.flatMap((node) => [
		node.path,
		...(node.children ? collectWorkspaceTreePaths(node.children) : []),
	]);
}

/**
 * 递归加载完整工作区树。
 * Worker 当前只返回“目录直接子节点”，所以前端要按目录递归展开成嵌套结构。
 * @param sessionId 会话 id
 * @param path 当前目录
 * @returns 嵌套文件树节点
 */
async function loadWorkspaceTree(
	sessionId: string,
	path = "/",
): Promise<WorkspaceTreeNode[]> {
	const response = await listWorkspaceTree(sessionId, path);

	return Promise.all(
		response.entries.map(async (entry) => {
			const children = entry.type === "directory"
				? await loadWorkspaceTree(sessionId, entry.path)
				: undefined;

			return createWorkspaceNode(entry, children);
		}),
	);
}

/**
 * 将 Worker 返回的扁平条目转换成业务文件树节点。
 * @param entry API 条目
 * @param children 子节点
 * @returns 业务树节点
 */
function createWorkspaceNode(
	entry: WorkspaceEntryDto,
	children?: WorkspaceTreeNode[],
): WorkspaceTreeNode {
	return {
		path: entry.path,
		name: getPathBasename(entry.path),
		type: entry.type,
		children,
	};
}

/**
 * 取路径最后一段作为展示名。
 * @param path 绝对路径
 * @returns basename
 */
function getPathBasename(path: string): string {
	if (path === "/") {
		return "/";
	}

	const segments = path.split("/").filter(Boolean);
	return segments[segments.length - 1] ?? path;
}

/**
 * 将会话快照转成 sidebar 里的 session 摘要项。
 * @param session 会话快照
 * @returns 列表项
 */
function buildSessionListItem(session: RuntimeSessionDto): SessionListItem {
	const lastMessage = [...session.messages].reverse().find((message) => message.role !== "system");
	const lastText = lastMessage?.content.find((block) => block.type === "text");

	return {
		id: session.id,
		label: session.id,
		status: session.closedAt ? "Closed" : "Active",
		summary: lastText?.type === "text" ? lastText.text.slice(0, 48) || "No messages yet" : "No messages yet",
	};
}

/** Chat 面板参数 */
interface ChatPanelProps {
	activeRuntimeTab: RuntimePanelTab;
	currentSession: RuntimeSessionDto | null;
	isRefreshingSession: boolean;
	isSendingMessage: boolean;
	messageDraft: string;
	messagesEndRef: RefObject<HTMLDivElement | null>;
	onChangeMessageDraft: (value: string) => void;
	onChangeRuntimeTab: (tab: RuntimePanelTab) => void;
	onSendMessage: () => void;
	onShutdownSession: () => void;
	pendingUserMessage: string | null;
	runtimeError: string | null;
}

/**
 * 渲染右侧聊天面板。
 * 当前已接入 session 主链路 API。
 */
function renderChatPanel({
	activeRuntimeTab,
	currentSession,
	isRefreshingSession,
	isSendingMessage,
	messageDraft,
	messagesEndRef,
	onChangeMessageDraft,
	onChangeRuntimeTab,
	onSendMessage,
	onShutdownSession,
	pendingUserMessage,
	runtimeError,
}: ChatPanelProps) {
	return (
		<section className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between border-b border-border px-5 py-4">
				<div>
					<p className="text-sm font-semibold text-foreground">Runtime Chat</p>
					<p className="text-xs text-muted-foreground">
						当前已接入 create/get/send/shutdown session 主链路。
					</p>
				</div>
				<div className="flex items-center gap-2">
					<div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
						<SparklesIcon className="size-3.5" />
						{currentSession?.id ?? "No session"}
					</div>
					<Button
						disabled={!currentSession || Boolean(currentSession.closedAt)}
						onClick={onShutdownSession}
						size="sm"
						variant="outline"
					>
						Close
					</Button>
				</div>
			</div>

			<div className="flex min-h-0 flex-1 flex-col p-5">
				<RuntimeStatePanel
					activeTab={activeRuntimeTab}
					onChangeTab={onChangeRuntimeTab}
					runtimeError={runtimeError}
					session={currentSession}
				/>
				{activeRuntimeTab === "messages" ? (
					<ScrollArea className="mt-4 min-h-0 flex-1 rounded-2xl border border-border bg-muted/20" type="always">
						<div className="flex min-h-full flex-col gap-4 p-4">
							{runtimeError ? (
								<div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
									{runtimeError}
								</div>
							) : null}

							{isRefreshingSession ? (
								<div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
									Loading session...
								</div>
							) : null}

							{currentSession?.messages.length ? (
								currentSession.messages.map((message) => (
									<ChatMessageCard key={message.id} message={message} />
								))
							) : (
								<div className="rounded-2xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
									当前 session 还没有消息。发送一条消息后，这里会展示真实 transcript。
								</div>
							)}

							{pendingUserMessage ? (
								<div className="ml-auto w-full max-w-[80%]">
									<div className="rounded-2xl rounded-tr-sm border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-foreground shadow-sm">
										<div className="mb-3 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
											<span>User</span>
											<span>sending...</span>
										</div>
										<div className="whitespace-pre-wrap break-words leading-6">
											{pendingUserMessage}
										</div>
									</div>
								</div>
							) : null}

							<div ref={messagesEndRef} />
						</div>
					</ScrollArea>
				) : null}
			</div>

			<div className="border-t border-border p-4">
				<div className="flex gap-3">
					<textarea
						className="min-h-24 flex-1 resize-none rounded-2xl border border-input bg-background px-4 py-3 text-sm text-foreground outline-none ring-0 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
						disabled={!currentSession || Boolean(currentSession.closedAt) || isSendingMessage}
						onChange={(event) => onChangeMessageDraft(event.target.value)}
						placeholder="Type a message to the agent runtime..."
						value={messageDraft}
					/>
					<Button
						className="self-end"
						disabled={!currentSession || Boolean(currentSession.closedAt) || isSendingMessage || messageDraft.trim() === ""}
						onClick={onSendMessage}
						size="lg"
					>
						<SparklesIcon data-icon="inline-start" />
						{isSendingMessage ? "Sending..." : "Send"}
					</Button>
				</div>
			</div>
		</section>
	);
}

export default App;
