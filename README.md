# cf-claude-code

基于 Cloudflare Workers / Pages / `@cloudflare/shell` 构建的边缘态 Agent Runtime 项目。

当前仓库已经完成 Phase 0 工程换轨，并完成了 Phase 3B 的 Runtime Core 与结构化执行面接线：`src/runtime/` 内已经具备会话主循环、工具调度、真实 `state_exec`、memory/durable workspace、memory/workspace merged skills、richer Todo、依赖型 task board、高保真 continuity compact、最小 subagent、D1-backed durable state 与测试覆盖；同时已补齐 edge 适配版 `Bash`、`WebFetch`、`WebSearch` 这批 Claude Code 核心工具，其中 `WebFetch` 当前通过 Jina Reader 获取页面文本，`WebSearch` 当前通过 Jina Search 获取搜索结果，二者都只向模型暴露高层语义参数。本 README 的重点仍然是定义为什么要做这个内存态 Runtime、要复现 Claude Code 的哪些核心能力、准备怎么实现，以及整个项目的宏观 TODO。

本地开发需要准备 `.env`，至少包含：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `JINA_API_KEY`

仓库提供了 [.env.example](/Users/igmainc/Projects/cf-claude-code/.env.example) 作为示例；Worker 部署时需要把这些值对应配置为 Cloudflare 环境变量或 secret，其中 `JINA_API_KEY` 用于 `WebFetch` / `WebSearch` 的 Jina 托管能力。

## 为什么要实现内存态 Agent Runtime

Claude Code 的很多高价值能力，本质上并不来自“终端长什么样”，而来自一套稳定的 agent harness：

- 会话主循环
- 工具调度
- 文件读写
- Todo / planning
- 技能按需加载
- 上下文压缩
- 子 Agent
- 任务系统
- 团队协作与协议
- 隔离执行

问题在于，Claude Code 的原始形态默认强依赖：

- 本地文件系统
- 本地 shell / PTY
- 本地 git 仓库
- 本地 worktree / 目录隔离
- 单机进程态会话

这套模型对个人开发机很自然，但对“跑在边缘环境、可多租户托管、可大规模并发、可治理审计”的 SaaS Runtime 不友好。核心困难不是 agent loop 本身，而是这些默认绑定操作系统的能力边界。

本项目要做的事情，是把这些能力重新表达成一套更适合 Cloudflare 平台的运行时模型：

- 会话、任务、消息、Todo 以内存态或可插拔存储管理
- 文件能力通过虚拟文件系统 / Workspace 暴露
- 执行能力通过 sandboxed JavaScript + `state.*` / `git.*` 暴露
- 模型不直接拿宿主机 shell，而拿结构化、可审计、可限权的能力面

其中有两个明确的基础设施前提：

- `agent session` 的持久化使用 Cloudflare D1
- AI 调用与工具循环的模型层抽象以 AI SDK 为底层核心

还有一个同样明确的状态约束：

- 虚拟文件系统 / 工作区最终必须具备 durable 持久化能力，不能只停留在纯内存视图

`@cloudflare/shell` 的出现，验证了这条路线是可行的：Agent 不必依赖 POSIX shell 才能获得接近 shell 的工作能力。文件、搜索、替换、JSON 操作、压缩、diff 这些能力，都可以被降级成结构化 API，而不是宿主机命令。`git` 在这里更像一个“虚拟文件系统和工作区抽象已经足够完备”的证明，而不是本项目的最终目标。

## 这个项目要复现的 Claude Code 核心能力

本项目不会追求 1:1 复刻 Claude Code 的宿主机行为，而是要保留它最重要的运行时语义。

### 1. Agent Loop

- 用户消息进入会话
- 模型决定回答文本，或请求工具
- Runtime 执行工具
- `tool_result` 回填给模型
- 循环直到模型结束

这是所有能力的底座。

### 2. Tool Dispatch

- 模型可见的是声明式工具 schema
- Runtime 负责参数校验、执行、错误包装、策略阻断
- 工具能力边界由 Runtime 控制，而不是由模型自由推断

### 3. Workspace / File Semantics

- 运行时要提供稳定的“文件语义”
- 既要支持内存态文件系统，也要支持 durable workspace
- 目标执行面优先使用 `@cloudflare/shell` 的 `state.*`
- 这个工作区要足够自由，能承载普通文件编辑，也能承载标准 skill 目录结构
- 内存态 VFS 只能作为运行时视图或临时层，最终要能落到可恢复的持久化工作区

### 4. Todo / Planning

- 模型需要能显式写计划
- Runtime 需要限制 Todo 结构，防止计划漂移
- 需要保留 nag reminder 这类轻量约束

### 5. Skills / Knowledge Loading

- 技能和知识不应全部塞进 system prompt
- 应以“知道有哪些技能 + 按需读取具体内容”的方式暴露给模型

### 6. Context Compaction

- 长会话必须可压缩
- 至少要有微压缩和手动 / 自动压缩策略
- 压缩后的会话要能继续工作，而不是简单清空

### 7. Subagent / Task Runtime

- 主 Agent 需要把任务拆给子 Agent
- 子 Agent 需要独立消息上下文
- 回传给主会话的是摘要，不是全部执行细节

### 8. Task Board / Team Collaboration

- 任务应该是显式对象，而不是全靠提示词记忆
- 队友协作、inbox、协议审批这类能力需要保留
- 但实现会优先走边缘友好的内存态 / durable object 语义，而不是本地进程模型

### 9. Isolation

- Claude Code 倾向用目录 / worktree 做隔离
- 本项目更可能采用“workspace 视图隔离 + 子上下文隔离 + durable state 隔离”
- 重点是隔离语义，而不是 worktree 本身

## 技术路线

本项目当前准备采用两层结构：

### 第一层：Memory-Native Agent Runtime Core

负责：

- session state
- message history
- tool loop
- todo state
- task board
- skill registry
- subagent orchestration
- team inbox / protocol
- compaction policy
- session mode / plan mode

这层是 Claude Code 运行时语义的核心，不直接依赖宿主机 shell。

在当前项目设定里：

- session 的 durable 持久化后端默认是 D1
- AI client 的底层实现默认是 AI SDK
- VFS / workspace 虽然可以以内存视图驱动执行，但最终要绑定到 durable backend

### 第二层：Cloudflare Execution Plane

负责：

- `@cloudflare/shell` 的 `state.*`
- in-memory / durable workspace
- sandboxed JavaScript execution
- secret injection
- timeout / network / permission boundary

这层提供“结构化执行能力”，相当于把传统 shell / filesystem 能力重建成边缘环境可托管的 ToolProvider。`git` 不是这层的中心，而是一个可选附加能力，用来证明工作区抽象已经足够强，而不是项目的核心叙事。

其中 workspace 的关键要求是：

- 运行时可以先在内存视图中操作文件
- 但这些文件最终要能落到 durable workspace
- 会话恢复后，agent 看到的工作区状态必须可重建

当前项目已经落地的最小 durable 形态是：

- `createMemoryRuntime(...)`：内存 stores + in-memory workspace + 内存 skills
- `createDurableRuntime(...)`：D1-backed session/transcript/subagent stores + `@cloudflare/shell Workspace({ sql, r2? })` + workspace-backed / merged skills
- subagent 保持 `s04` 语义：fresh context，但共享同一个 durable workspace
- 当 runtime 启用 `state_exec` 时，会按需将 `STATE_SYSTEM_PROMPT` + `STATE_TYPES` 注入主会话和 subagent prompt
- 当 durable workspace 配置了 R2 且文件大小超过 `inlineThreshold` 时，大文件会自动落到 R2，D1 只保留元数据和 `r2_key`

当前阶段还需要额外明确一条约束：

- session 已经是独立持久化对象
- 但 durable workspace 目前按“单共享测试工作区”运行，而不是按 session 隔离
- 未来真正的隔离边界应是 `project -> workspace`，即一个 project 对应一个工作区，project 下可以有多个 session 共享这份工作区

## 实现参考来源

本项目的实现会主要参考两个现有目录：

### `external/learn-claude-code`

用途：

- 作为 Claude Code 主体逻辑的教学拆解参考
- 用于提取哪些机制是 Claude Code 的核心 harness
- 用于确认最小 loop、工具分发、Todo、子 Agent、任务、协作等机制应如何分层

定位：

- 教学参考
- 不直接照搬成生产结构

### `external/my-claude-code`

用途：

- 作为“内存态 Claude Code Runtime”代码参考
- 用于参考哪些抽象已经适合边缘 / SaaS 化
- 用于参考 `SessionStore`、VFS、AutonomyOrchestrator、SkillProvider 等接口划分

定位：

- 运行时抽象参考
- 不直接照搬现有实现，而是迁移其思路到 Cloudflare 平台能力上

## 当前明确的基础设施选择

### Session Store：Cloudflare D1

`agent session` 不是临时缓存，而是 runtime 的核心事实源之一。当前项目明确选择 D1 作为 session 持久化后端，原因是：

- 天然适合 Cloudflare 平台部署形态
- 能提供结构化查询能力，而不只是对象存储式快照
- 适合承载 session metadata、message history、transcript index、task / protocol 等后续状态扩展

这意味着后续实现 `SessionStore` 时，应优先围绕 D1 schema 设计，而不是先做本地 JSON 文件持久化。

### Durable Workspace / VFS

虚拟文件系统不是单纯的内存辅助结构，而是 agent 可操作工作区的统一抽象。当前项目明确要求它最终具备持久化能力，原因是：

- agent 的文件操作结果不能随着 isolate 生命周期直接丢失
- skill 目录、生成文件、任务产物都需要跨会话恢复
- workspace 需要成为 session 之外的第二个核心事实源

这意味着后续 VFS / workspace 设计时，应显式区分：

- 内存态视图或缓存层
- durable backend
- 从 durable backend 重建 agent 工作区状态的机制

### AI Layer：AI SDK

模型调用层明确使用 AI SDK 作为底层核心，原因是：

- 它更适合作为统一模型抽象层，而不是把 Runtime 直接耦合到单一 provider SDK
- 便于后续切换模型、工具协议和流式返回策略
- 和 `@cloudflare/shell` / Cloudflare 侧的 sandbox 工具链组合更自然

这意味着后续实现 `AIClient` 时，应优先保持“runtime 协议 -> AI SDK”这一层适配，而不是直接把 provider 响应对象渗透到 runtime 核心。

## 当前项目状态

当前仓库已经进入 Agent Runtime 实现阶段：

- `src/worker/index.ts` 已接入最小 runtime Session API 主链路，并暴露 workspace tree / file / exists / upload / copy / move / rename 文件系统接口
- `src/react-app/` 已切换为最小 playground 壳
- `src/runtime/` 已实现 Phase 3B：runtime core + 真实 `state_exec` + memory/durable workspace + D1-backed durable state
- `wrangler.json` 是默认 Worker + SPA 资源配置

这意味着 Phase 0 的“工程换轨”、Phase 1 的“最小闭环”、Phase 3A“真实 workspace / durable state 接线”、Phase 3B“真实 `state_exec` 接线”和当前的 Phase 4A“Worker Session API 主链路接入”都已经完成，下一阶段工作将进入 tools / subagents / 事件流的 HTTP 面扩展、Cloudflare 专用 sandbox/provider 编排，以及前端 playground 联调。

## Development

默认使用 Bun：

```bash
bun install
bun run dev
```

常用命令：

```bash
bun run build
bun run check
bun run deploy
```

## 推荐目录演进方向

以下是建议中的目标结构，不代表当前已实现：

```text
src/
  runtime/
    core/           # agent loop / dispatch / compaction / orchestration
    domain/         # todo / tasks / protocol / team / session types
    skills/         # skill registry / loading
    workspace/      # workspace abstraction over @cloudflare/shell
    tools/          # tool schemas and handlers
    adapters/       # AI client / storage / cloudflare integrations
  worker/
    index.ts        # HTTP / RPC / Agent entry
  react-app/
    ...             # UI / playground / inspector
```

## 宏观 TODO

下面的 TODO 是顶层工程计划，不代表每一项都要在第一期完成。

**在 runtime core 初步可用前，前端不再承担功能探索任务；`src/react-app/` 仅维持当前最小 playground 壳，不继续扩展真实交互。**

### Phase 0：项目换轨

- [x] 用 Bun 替换当前默认 npm 工作流
- [x] 清理模板 README 与模板 UI 文案
- [x] 明确 `src/worker/`、`src/runtime/`、`src/react-app/` 的职责边界
- [x] 建立项目级 AI 文档和模块导航文档

### Phase 1：Runtime Core 最小闭环

- [x] 实现 session / message / tool loop
- [x] 定义基础工具协议与错误包装
- [x] 基于 AI SDK 实现模型客户端抽象
- [x] 提供最小可运行的内存态会话
- [x] 提供最小文件工具能力

### Phase 2：Workspace 与 `@cloudflare/shell`

- [ ] 接入 `@cloudflare/shell` 的 `stateTools`
- [ ] 抽象 in-memory workspace 与 durable workspace
- [ ] 用结构化 `state.*` 替代直接 shell 依赖
- [ ] 让工作区支持标准 skill 目录结构，并支持按需读取 skill 内容
- [ ] 明确 VFS 内存层与 durable workspace 的边界
- [ ] 评估是否需要“命令兼容层”，而不是直接暴露 bash

### Phase 2.5：D1 Session Persistence

- [ ] 设计 session / message / transcript 的 D1 schema
- [ ] 实现 D1-backed `SessionStore`
- [ ] 明确会话恢复、压缩归档、任务状态与 session 的关联方式
- [ ] 评估哪些状态留内存、哪些状态落 D1

### Phase 2.6：Durable Workspace Persistence

- [ ] 设计 workspace / VFS 的 durable 存储模型
- [ ] 明确 skill 文件、普通工程文件、生成文件如何持久化
- [ ] 明确 session 恢复时如何重新挂载工作区
- [ ] 明确哪些文件操作走内存缓冲，哪些操作直接写 durable backend

### Phase 3：Claude Code 核心能力补齐

- [ ] Todo / planning
- [ ] 技能按需加载
- [ ] context compaction
- [ ] 子 Agent 执行
- [ ] task board
- [ ] team inbox / protocol
- [ ] plan mode / policy gate

### Phase 4：工作区完备性与工程化能力

- [ ] 补齐工作区内高频工程操作能力
- [ ] 明确 skill 文件、项目文件、生成文件在工作区中的组织规则
- [ ] 视需要评估 `@cloudflare/shell/git` 接入方式
- [ ] secret injection 与权限边界设计

### Phase 5：边缘托管与产品化

- [ ] Worker / Durable Object / Workspace 状态模型设计
- [ ] 多会话 / 多租户隔离模型
- [ ] 审计、事件流和可观测性
- [ ] Playground / Inspect UI
- [ ] 最小 API / Web 界面闭环

## 非目标

当前阶段明确不做：

- 不追求完整 bash / POSIX 兼容
- 不追求完整 PTY 模拟
- 不先做复杂前端体验
- 不先做 1:1 复刻 Claude Code 的宿主机行为
- 不先做所有工具的全量覆盖
- 不把 git 当作项目主目标

## 开发原则

- 先做最小闭环，不做大而全复刻
- 优先保留 Claude Code 的运行时语义，而不是宿主机实现细节
- 优先结构化能力面，不优先字符串命令面
- 优先把工作区做好，再决定是否补 git 等附加能力
- 优先把 session 的 D1 持久化边界和 AI SDK 适配层固定下来
- 优先把 VFS 的 durable 边界设计清楚，避免后面从“纯内存 demo”返工
- 在 runtime core 初步可用前，不推进前端功能开发，避免 UI 反向牵引核心接口设计
- 优先内存态与抽象接口，持久化和 Durable 能力后接
- 优先边缘环境可运行，再考虑本地体验补齐

## 近期执行顺序

1. 写清楚项目文档与目录职责
2. 确定 runtime 核心目录结构
3. 定义基于 AI SDK 的最小 session + tool loop
4. 设计 D1 session schema 与 `SessionStore`
5. 接入 `@cloudflare/shell` 的 workspace / state 工具
6. 设计 durable workspace / VFS 边界
7. 让 runtime 能从工作区中读取标准 skill 结构
8. 再逐步补 Todo、skills、compaction、subagent、task board

---

如果你是从 `external/learn-claude-code` 或 `external/my-claude-code` 切过来看主项目，这个 README 就是当前主项目的实现导航，不是模板说明。
