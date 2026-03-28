# runtime

## 1. 模块职责（Module Responsibility）

### 1.1 原始需求

`src/runtime/` 是主项目未来的 Agent Runtime 核心目录，用于承载 Claude Code 风格的运行时语义，而不是 Worker 路由或前端展示。

### 1.2 当前职责

- 当前已提供 Phase 3B 的 Runtime Core 闭环。
- 当前负责 session、tool loop、skills、workspace、Todo、依赖型 task board、continuity compact、最小 subagent、`state_exec` 和 runtime factory。
- 当前已经具备 D1-backed durable state 与 durable workspace 抽象，但仍不负责 HTTP API、前端交互和 lane/worktree 隔离。

## 2. 需求演进（Requirement Evolution）

- v1：Phase 0 建立目录骨架，固定模块边界。
- v2：Phase 1 落地 AI SDK adapter、内存 SessionStore、内存 workspace、skills、默认工具和测试。
- v3：Phase 2A 增强 Todo 语义、高保真 continuity compact、task 依赖图和 transcript store。
- v4：Phase 2B 落地同步 subagent、异步 job 骨架和 subagent store。
- v5：Phase 3A 将 workspace 升级为 memory/durable 双后端，并把 session / transcript / subagent jobs 接到 D1。
- v6：Phase 3B 落地真实 `state_exec`、官方 state prompt 按需注入，以及 merged skill provider。

## 3. 模块结构（Module Structure）

- `core/`：当前已实现 agent loop、dispatch、compaction、subagent runner 和 memory/durable runtime factory。
- `domain/`：当前已实现 richer todo 规则与带依赖图的 task board。
- `types/`：当前已定义 session / message / tool / event 公共协议。
- `adapters/`：当前已实现 AI SDK adapter，以及内存 / D1 双实现的 SessionStore、TranscriptStore、SubagentStore。
- `workspace/`：当前已实现对齐 `@cloudflare/shell` 的 memory/durable 双后端工作区适配器。
- `skills/`：当前已实现内存、workspace-backed 与 merged skill provider。
- `tools/`：当前已实现默认文件、`state_exec`、Todo、skills、compact、task 工具。

## 4. 核心逻辑（Core Logic）

- 当前已实现的核心流：
  - 用户消息进入会话
  - runtime 构建 system prompt，并注入 available skills
  - AIClient 返回文本或 `tool_use`
  - tool dispatcher 执行工具并回填 `tool_result`
  - runtime 按阈值执行微压缩 / 自动 compact / 手动 compact
  - auto/manual compact 会保存 transcript 引用，并调用 AIClient 生成 continuity summary
  - task board 支持 `task_get`、`blockedBy`、`blocks` 和完成态清依赖
  - Todo 支持 `activeForm` 和更强的渲染语义
  - subagent 支持 fresh context 的同步子会话执行，只把摘要文本回给父会话
  - 异步 subagent 当前只提供 queued job 骨架和状态查询接口，不运行后台 loop
  - `state_exec` 可真实执行结构化 `state.*` JavaScript，并共享当前 workspace
  - 主会话和 subagent 会在 `state_exec` 可用时按需注入 `STATE_SYSTEM_PROMPT` + `STATE_TYPES`
  - skill 默认可来自 workspace 和 memory，冲突时 workspace 覆盖 memory
  - runtime 已支持 `createMemoryRuntime(...)` 和 `createDurableRuntime(...)`
  - durable runtime 会共享同一个 `@cloudflare/shell Workspace({ sql })`
  - durable state 当前覆盖 `SessionStore`、`TranscriptStore`、`SubagentStore`
- 当前稳定边界已确定：
  - `SessionStore` -> D1
  - `AIClient` -> AI SDK adapter
  - `Workspace / VFS` -> durable backend + in-memory view

## 5. 关键入口（Entry Points）

- `index.ts`：runtime 顶层导出入口。
- `core/runtime.ts`：最小会话循环入口。
- `core/compact.ts`：continuity compact 主链路入口。
- `core/state-executor.ts`：结构化 `state.*` 执行入口。
- `core/subagent-runner.ts`：同步 subagent 和 async job 骨架入口。
- `core/factory.ts`：memory / durable runtime 装配入口。
- `workspace/`：工作区主模型与 shell adapter 入口。
- `adapters/`：AI SDK、内存存储、D1 存储入口。

## 6. 影响范围（Impact Scope）

- 后续新增 runtime 代码时，应优先落在本目录，不要继续堆在 `src/worker/`。
- 一旦目录职责发生变化，需要同步更新根 README 和本文件。
- 运行时测试当前位于 `tests/`，Phase 2A 的回归应优先补在这里。

## 7. 约束与注意事项（Constraints & Pitfalls）

- 不要把 `git` 作为本目录的核心叙事，工作区本身才是主目标。
- 当前 runtime 已通过 `state_exec` 暴露结构化 `state.*`，但还没有把 shell 的全部执行面扩展到 `git.*`、更完整的 sandbox/provider 编排。
- 当前 durable state 只覆盖 session / transcript / subagent jobs；task 和 todo 仍内嵌在 session snapshot 内。
- 当前 subagent 与父会话共享同一 workspace，不做隔离副本，也不做 lane/worktree。
- 异步 subagent 还只有 queued job 骨架，没有真正后台执行能力。
- 在 runtime core 初步可用前，前端不应倒逼 runtime 接口；先完成 runtime，再回到 UI。
