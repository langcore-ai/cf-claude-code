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
- v7：收敛 Claude Code 核心语义：引入 prompt composer、核心/扩展工具分层、`glob/grep/edit/multi_edit`，并为 `main/compact` 增加模型角色路由。
- v8：补齐 Todo / Task / Subagent 差异：增加 Todo 短期记忆持久化、`TodoWrite.todos` reverse 兼容输入、`Task` 核心工具别名，并把相关持久化落到 D1。
- v9：补齐 core 范围内的模型路由使用，把 subagent 也显式路由到独立 `subagent` 模型角色。
- v10：增加 plan mode 核心机制：`SessionState.mode`、plan prompt section、plan-mode 工具过滤以及 `ExitPlanMode`。
- v11：补齐剩余工具能力的 edge 适配首版：新增 `Bash`、`WebFetch`、`WebSearch`，并让 `lightweight` 模型角色开始服务 `WebFetch` 的页面内容提取。

## 3. 模块结构（Module Structure）

- `core/`：当前已实现 agent loop、对齐 Claude Code 片段式系统提示的 prompt composer、dispatch、compaction、subagent runner 和 memory/durable runtime factory。
- `domain/`：当前已实现 richer todo 规则与带依赖图的 task board。
- `types/`：当前已定义 session / message / tool / event 公共协议。
- `adapters/`：当前已实现 AI SDK adapter，以及内存 / D1 双实现的 SessionStore、TranscriptStore、SubagentStore、TodoMemoryStore。
- `workspace/`：当前已实现对齐 `@cloudflare/shell` 的 memory/durable 双后端工作区适配器。
- `skills/`：当前已实现内存、workspace-backed 与 merged skill provider。
- `tools/`：当前已拆成 Claude Code 核心工具和平台扩展工具两层。

## 4. 核心逻辑（Core Logic）

- runtime core 的核心不是“有哪些具体工具”，而是：
  - 模型能稳定地产生 `tool_use`
  - runtime 能稳定执行工具
  - 工具结果能以 `tool_result` 正确回注到下一轮推理
  - prompt、mode、compact、subagent 都围绕这条 tool-calling 主链路工作
- 因此需要明确分层：
  - core：agent loop、prompt composer、tool-calling 协议、tool dispatcher、tool result 回注、plan mode、compact、subagent、模型路由
  - 非 core：某个具体工具本身的内容与能力面，例如 `Bash`、`WebFetch`、`WebSearch`
- 这也意味着：
  - `NotebookRead` / `NotebookEdit` 不属于 runtime core
  - `Bash` / `WebFetch` / `WebSearch` 也不属于 runtime core
  - 这些工具只是挂接在 tool-calling 主链路上的能力插件；是否存在会影响能力覆盖，但不改变 runtime core 的定义
- 当前已实现的核心流：
  - 用户消息进入会话
  - runtime 通过 prompt composer 组合 identity / workflow / start reminder / end reminder / compact / skills / state prompt
  - AIClient 返回文本或 `tool_use`
  - tool dispatcher 执行工具并回填 `tool_result`
  - runtime 按阈值执行微压缩 / 自动 compact / 手动 compact
  - auto/manual compact 会保存 transcript 引用，并调用 AIClient 生成结构化 continuity summary
  - task board 支持 `task_get`、`blockedBy`、`blocks` 和完成态清依赖
  - Todo 支持 `activeForm` 和更强的渲染语义
  - Todo 现在还会保留最近一次非空 Todo 快照，作为 runtime 范围内的短期 Todo 记忆
  - subagent 支持 fresh context 的同步子会话执行，只把摘要文本回给父会话
  - subagent orchestration 当前已按同步阶段收敛：
    - 先归一化任务描述与 prompt
    - 再创建 sync job 并发出 started 事件
    - 子循环只暴露受限核心工具面
    - 结束后把 summary 与 turn/message 统计写回 job，并作为 tool_result meta 回注给父会话
  - subagent 当前会对空 summary、超长 summary 和连续重复错误工具调用做治理，避免把低质量结果直接回注给父会话
  - 核心工具增加了 reverse 风格的 `Task` 别名；当前只接受 `subagent_type="general-purpose"`
  - 会话现在支持 `normal | plan` 两种 mode；plan mode 只暴露只读规划工具，并通过 `ExitPlanMode` 显式退出
  - 异步 subagent 当前只提供 queued job 骨架和状态查询接口，不运行后台 loop
  - `state_exec` 可真实执行结构化 `state.*` JavaScript，并共享当前 workspace
  - 主会话和 subagent 会在 `state_exec` 可用时按需注入 `STATE_SYSTEM_PROMPT` + `STATE_TYPES`
- 默认工具当前通过 `createRuntimeTool(...)` 以 AI SDK 官方 `tool({...})` 为基底创建；runtime 直接在工具对象上维护名称、分组与执行逻辑，adapter 侧优先直接复用这些官方 Tool 对象
- prompt composer 当前已主动吸收 reverse 仓库中最核心且属于 runtime 范围的片段：
  - `system-identity.prompt.md`
  - `system-workflow.prompt.md`
  - `system-reminder-start.prompt.md`
  - `system-reminder-end.prompt.md`
  - `system-compact.prompt.md`
  - `compact.prompt.md` 的核心摘要目标
- 当前已进一步增强这些片段的“强约束语气”：
  - workflow 现在会更明确约束短输出、禁止多余解释、禁止未请求的提交、工具失败后的修正重试，以及 `<system-reminder>` / hook 反馈的权威性
  - start/end reminder 现在会更明确约束最小改动、Todo 高频更新和计划变更时的即时同步
  - compact prompt 现在会更明确要求保留用户纠偏、风险、开放问题和 runtime 状态，避免 compact 后只剩弱摘要
- runtime 还新增了 tool-calling 稳定性策略：
  - 任一工具返回错误后，runtime 会自动追加一个内部 `<system-reminder>`，明确告诉模型上一个工具为什么失败、下一次必须修正参数而不是重复同一错误调用
  - 如果模型连续两次以上重复相同的错误工具调用，runtime 会注入更强的重复失败提醒，用来打断无效重试
- runtime 的 reminder 体系当前已按 agent core 分成两层：
  - prompt-level reminder：由 `prompt-composer.ts` 通过 `core/reminders.ts` 装配 `system-reminder-start`、`system-reminder-end`、`plan mode reminder`
  - runtime event reminder：由 `runtime.ts` 在工具失败、重复失败、todo 长时间未更新时注入内部 `<system-reminder>`
- 当前这样拆分的目的是把“长期状态提示”和“本轮事件纠偏”分开：
  - 长期状态：todo、todo memory、task continuity、plan mode
  - 本轮事件：tool failure、repeated tool failure、todo idle nag
- `prompt-composer.ts` 当前已从“直接拼字符串”收敛成“两段式装配”：
  - 先构建 `PromptSection[]`
  - 再通过统一 `renderPromptSections(...)` 渲染
- 当前这样做的目的是把 prompt 的职责、顺序、可选性和测试边界固定下来，避免后续新增 mode / reminder / state prompt 时再次把逻辑散落回 `composeMainSystemPrompt(...)`
- 当前仍明确不纳入 runtime core 的 prompt 片段：
  - `check-new-topic.prompt.md`
  - `summarize-previous-conversation.prompt.md`
  - `ide-opened-file.prompt.md`
  - output style 的 explanatory / learning 产品化切换
- 当前工具已经分为两层：
  - 核心工具：`read_file`、`write_file`、`list_files`、`Bash`、`glob`、`grep`、`edit`、`multi_edit`、`WebFetch`、`WebSearch`、`TodoWrite`、`Task`、`subagent_run`、`compact`
  - 扩展工具：`state_exec`、skill 工具、task board 工具、异步 subagent 工具
  - plan mode 允许的核心工具：`read_file`、`list_files`、`glob`、`grep`、`WebFetch`、`WebSearch`、`TodoWrite`、`compact`、`ExitPlanMode`
  - plan mode 会屏蔽所有写工具和 subagent/tooling 扩展能力
- subagent 的可见工具面当前故意比主会话更窄：
  - 保留：`read_file`、`write_file`、`list_files`、`glob`、`grep`、`edit`、`multi_edit`、`WebFetch`、`WebSearch`、`TodoWrite`、`compact`
  - 排除：`state_exec`、task board 工具、async subagent 工具、skill 工具
  - 目标是把 subagent 收敛成“独立研究 / 搜索 / 必要编辑”的一次性 worker，而不是再扩张上下文和工具面
- 默认工具描述当前优先参考 `external/claude-code-reverse/results/tools/*.tool.yaml`，尤其是 `Read`、`Write`、`TodoWrite`、`Task`、`Ls` 这些最接近的官方 prompt 语义
  - 默认 system prompt 会强约束文件操作必须走真实工具，不能只返回伪代码或口头声称已完成
  - `write_file` / `edit` / `multi_edit` 当前会对现有文件执行 read-before-write 校验
  - `AIClient` 当前已支持 `main` / `compact` / `subagent` / `lightweight` 模型角色；runtime core 现在实际使用 `main`、`compact`、`subagent`，而 `WebFetch` 会优先走 `lightweight`
  - `Bash` 当前不是 POSIX shell，而是基于 workspace 文件语义做的 edge 适配层；优先覆盖 `pwd`、`ls`、`cat`、`mkdir`、`rm`、`cp`、`mv`、`touch`、`echo > file`
  - `WebFetch` 第一版不做浏览器自动化，而是通过 Jina Reader 抓取单页内容，再用 fast model 按提示抽取信息
  - `WebFetch` 只向模型暴露高层提取参数：`url`、`prompt`、`instruction`、`jsonSchema`、`targetSelector`、`waitForSelector`、`respondWith`
  - `WebFetch` 的鉴权、Accept、页面稳定时机、覆盖层移除等抓取策略由 runtime 内部控制，不直接暴露给模型
  - `WebFetch` 使用的 Jina Reader API Key 通过 runtime 配置透传；在 Worker 宿主下对应环境变量 `JINA_API_KEY`
  - `WebSearch` 当前通过 Jina Search 获取结果；只向模型暴露 `query`、`type`、`count`、`site` 以及兼容性的域名过滤参数
  - `WebSearch` 的 provider、Accept 和鉴权由 runtime 内部控制，不直接暴露给模型
  - 本地开发需要在仓库根目录 `.env` 中提供 `JINA_API_KEY`；部署到 Worker 时则应配置同名 secret 或环境变量
  - skill 默认可来自 workspace 和 memory，冲突时 workspace 覆盖 memory
  - runtime 已支持 `createMemoryRuntime(...)` 和 `createDurableRuntime(...)`
  - durable runtime 当前会共享同一个 `@cloudflare/shell Workspace({ sql })` 作为测试工作区，而不是按 session 隔离
  - durable workspace 现在已支持可选 R2：当配置 `r2` 且文件大小超过 `inlineThreshold` 时，`@cloudflare/shell` 会把文件内容落到 R2，只在 D1 中保留元数据与 `r2_key`
  - durable state 当前覆盖 `SessionStore`、`TranscriptStore`、`SubagentStore`、`TodoMemoryStore`
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
- 当前 prompt 与工具描述会明确禁止把 `/` 当成文件路径；在根目录创建文件时，必须使用 `/<filename>` 这种具体路径。
- 当前 durable state 已覆盖 session / transcript / subagent jobs / todo short-term memory / task board。
- task board 现在以独立 `TaskStore` 持久化；`SessionState.tasks` 仍然保留，但主要承担 Worker/API 兼容返回结构，不再是 task 的唯一持久化来源。
- continuity compact 当前会要求模型按 reverse 风格输出结构化摘要段落，并优先提取 `<summary>...</summary>` 作为最终 `compactSummary`；若模型额外输出 `<analysis>`，runtime 会在持久化前剥离。
- `SessionState.mode` 当前也会随 session snapshot 一起持久化，因此 compact 和 session 恢复后仍会保留 `plan` / `normal` 状态。
- D1 持久化表当前包括：
  - `${namespace}_sessions`：整份 `SessionState` 快照
  - `${namespace}_transcripts`：compact 前的消息快照
  - `${namespace}_subagent_jobs`：subagent job 记录
  - `runtime_todo_memory`：最近一次非空 Todo 快照；字段为 `namespace`、`session_id`、`payload`、`updated_at`
- `runtime_tasks`：当前会话的 task board 快照；字段为 `namespace`、`session_id`、`payload`、`updated_at`
- 正式迁移文件当前位于：
  - [migrations/0001_runtime_todo_memory.sql](/Users/igmainc/Projects/cf-claude-code/migrations/0001_runtime_todo_memory.sql)
  - [migrations/0002_runtime_tasks.sql](/Users/igmainc/Projects/cf-claude-code/migrations/0002_runtime_tasks.sql)
- `runtime_todo_memory` 通过 `(namespace, session_id)` 复合主键隔离不同 runtime 命名空间，只服务 runtime 内部的 Todo 连续性提示，不承担宿主级启动恢复或 project 级任务管理语义。
- `runtime_tasks` 同样通过 `(namespace, session_id)` 复合主键隔离不同 runtime 命名空间；runtime 恢复旧 session 时，会把历史 `SessionState.tasks` 回填进独立表，避免升级后丢失旧 task 数据。
- `Bash` / `WebFetch` / `WebSearch` 当前首版不新增 D1 表：
  - Bash 不保留跨请求 shell session，也不持久化最近命令结果
  - WebFetch / WebSearch 不做 durable cache；如果未来要跨请求复用网页内容，再考虑新增 `runtime_web_cache`
- 当前 session 与 workspace 的边界是“不对称”的：session 已持久化且相互独立，但 durable workspace 目前仍是共享测试工作区。未来如果引入 `project`，更合理的模型应是 `project -> workspace`，session 共享所属 project 的工作区。
- 当前 subagent 与父会话共享同一 workspace，不做隔离副本，也不做 lane/worktree。
- 异步 subagent 还只有 queued job 骨架，没有真正后台执行能力。
- 在 runtime core 初步可用前，前端不应倒逼 runtime 接口；先完成 runtime，再回到 UI。
