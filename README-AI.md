# cf-claude-code

## 1. 模块职责（Module Responsibility）

### 1.1 原始需求

这个项目要把 Claude Code 风格的核心运行时语义迁移到 Cloudflare 平台上，目标是实现一个跑在边缘环境中的内存态 Agent Runtime。

### 1.2 当前职责

- 当前仓库是未来 Agent Runtime 的主实现仓库。
- 当前根工程已经完成 Phase 0 换轨，并完成了 Phase 4A：Runtime Core、双后端 workspace、durable state、`state_exec` 与 Worker 主链路 API 接线。
- Worker 当前除了 session 主链路，还已经暴露 `GET /api/sessions` 列表接口，以及 workspace tree / file / exists / upload / copy / move / rename 文件系统 API，供前端 playground 查看、恢复和手动编辑工作区。
- `external/learn-claude-code` 用来理解 Claude Code 风格 harness 的主体逻辑。
- `external/my-claude-code` 用来参考内存态 runtime 的接口与分层方式。
- 不负责在当前阶段直接复刻完整 Claude Code CLI。
- 当前已经明确两项基础设施选择：session 持久化使用 D1，AI 层底座使用 AI SDK。
- 当前也已经明确：VFS / workspace 最终必须是 durable 的，不能只做纯内存 demo。

## 2. 需求演进（Requirement Evolution）

- v1：模板工程阶段，只具备最小 Cloudflare Worker + React 前端骨架。
- v2：需求明确为“在主项目中实现边缘态、内存优先的 Agent Runtime”。
- v3：引入 `@cloudflare/shell` 作为执行面候选方案，进一步收敛为“runtime core + execution plane”的双层结构。
- v4：Phase 1 在 `src/runtime/` 内落地最小会话循环、内存 workspace、skills、Todo、tasks 和测试闭环。
- v5：Phase 2A 在 `src/runtime/` 内增强 richer Todo、continuity compact、task 依赖图和 transcript store。
- v6：Phase 2B 在 `src/runtime/` 内增强最小 subagent：同步一次性子会话 + 异步 job 骨架。
- v7：Phase 3A 在 `src/runtime/` 内落地 `@cloudflare/shell` durable workspace、D1-backed stores、workspace-backed skills 和 runtime factory。
- v8：Phase 3B 在 `src/runtime/` 内落地真实 `state_exec`、官方 shell prompt 按需注入，以及 merged skill provider。
- v9：Phase 4A 在 `src/worker/` 内落地基于 durable runtime 的最小 Session API 主链路。
- v10：补充 Worker 文件系统 API，用于查看文件树、读取文件、上传文件以及直接操作工作区节点。

## 3. 模块结构（Module Structure）

- `src/worker/index.ts`：当前 Worker 主链路与 workspace 文件系统 API 入口，已接入 durable runtime。
- `src/react-app/`：当前 playground 前端入口，已落地 sidebar + chat / preview 的页面框架、真实 workspace 文件树、文件预览、上传文件模态框、文件树中的新建文件 / 新建目录 / rename / move / copy / delete 操作，以及基于 session snapshot 的结构化 runtime 观察视图（messages / todos / tasks / runtime）。
- `src/components/file-workspace/`：文件编辑/预览模块，当前已支持 Markdown 所见即所得编辑与手动保存，并预留图片/PDF 只读预览扩展位。
- `src/runtime/`：当前 runtime 核心实现目录，已具备 runtime core + durable 接线。
- `external/learn-claude-code/`：Claude Code 风格 harness 的教学拆解参考。
- `external/my-claude-code/`：内存态 runtime 的代码参考。
- `README.md`：面向项目目标和实施路径的顶层说明。

## 4. 核心逻辑（Core Logic）

- 需要明确分层：runtime core 关注的是 agent loop、prompt composer、tool-calling 协议、tool dispatch、tool result 回注、compact、subagent、mode 切换和模型路由，而不是某个具体工具本身。
- 因此 `Bash`、`WebFetch`、`WebSearch` 这类工具能力不应被视为 core 本体；它们只是挂接在 tool-calling 主链路上的能力插件。
- 主项目当前已经实现 Phase 3B runtime 逻辑：会话循环、工具调度、continuity compact、richer Todo、依赖型 task board、最小 subagent、真实 `state_exec`、memory/durable workspace、memory/workspace merged skills、D1-backed session/transcript/subagent stores。
- 当前项目额外补齐了 edge 适配版 `Bash`、`WebFetch`、`WebSearch` 作为工具能力，用于验证和扩展 tool-calling 主链路。
- `WebFetch` 当前通过 Jina Reader 获取页面文本，只向模型暴露少量高层提取参数；鉴权和抓取策略由 runtime 内部控制。Worker 宿主侧使用环境变量 `JINA_API_KEY` 透传访问密钥。
- `WebSearch` 当前通过 Jina Search 获取结果，只向模型暴露查询语义相关参数；provider、返回格式和鉴权由 runtime 内部控制。
- 本地开发环境需要在 `.env` 中提供 `JINA_API_KEY`；仓库根目录提供 `.env.example` 作为示例配置。
- runtime 默认 prompt 当前会强约束涉及工作区读写时必须调用真实工具，不能只输出待执行代码或虚构“已创建/已修改”的结果。
- 目标架构是：
  - runtime core：session、tool loop、todo、skills、tasks、subagent、protocol
  - execution plane：`@cloudflare/shell` 的 `state.*`、workspace、sandboxed execution
- 主项目后续编码时，应优先复用 `external/my-claude-code` 已验证的抽象思路，而不是从模板 API 直接堆功能。
- 当前项目叙事应围绕“可供 agent 自由操作的工作区”展开；`git` 只是在需要时用于证明工作区抽象足够完备，不是主目标。
- runtime 的核心持久化与模型层抽象已经有明确边界：
  - `SessionStore` -> D1
  - `AIClient` -> AI SDK adapter
  - `Workspace / VFS` -> durable backend + in-memory view
- 当前云端/Worker 语义里，session 已经是独立持久化对象，但 durable workspace 仍按“单共享测试工作区”运行，不按 session 隔离。这个阶段性模型当前视为可接受；未来引入 `project` 后，工作区应转为按 project 隔离，session 共享所属 project 的 workspace。

## 5. 关键入口（Entry Points）

- 想看项目目标与分期：`README.md`
- 想看当前 Worker API 起点：`src/worker/index.ts`
- 想看 runtime 当前边界与入口：`src/runtime/README-AI.md`
- 想看 runtime memory/durable 装配入口：`src/runtime/core/factory.ts`
- 想看 Claude Code 教学拆解：`external/learn-claude-code/agents/`
- 想看内存态 runtime 参考：`external/my-claude-code/src/`

## 6. 影响范围（Impact Scope）

- 根 README 和本文件定义了项目方向；后续目录切分、接口命名、模块边界都应与这里保持一致。
- `src/worker/` 当前已落地 session 主链路 API 和 workspace 文件系统 API（含上传、create file、mkdir、copy、move、rename、delete）；后续会继续扩展 tools、subagents 和事件流。
- `src/react-app/` 当前已开始承接 playground 联调，但仍应保持“验证 runtime 能力”的最小闭环，不要提前扩散成完整 IDE。
- chat 区当前应优先承担“真实 runtime 行为验证”职责：展示结构化消息块、Todo、Task 和 compact 状态，而不是先扩散到复杂控制台能力。
- `external/*` 是参考实现，不应被当成主项目最终目录结构直接复制。
- D1 schema 和 AI SDK adapter 一旦落地，会成为后续 runtime 分层的稳定基础，变更成本较高。
- durable workspace / VFS 边界已经落地为 `@cloudflare/shell Workspace({ sql })` + runtime adapter，后续扩展应沿这个边界继续推进。
- durable workspace 当前已预留并接通可选 R2 绑定：大文件可按阈值自动落到 R2，小文件继续内联存于 D1。
- 当前不要把“一个 session 一个工作区”当成既成事实；至少在现阶段实现里，多个 session 会共享同一份 durable 测试工作区。

## 7. 约束与注意事项（Constraints & Pitfalls）

- 当前阶段最重要的是先固定项目目标和目录边界，不要顺手在模板工程上直接堆零散能力。
- 文档里可以写目标、路径和 TODO，但不能把未实现的功能写成已完成事实。
- 后续如果 runtime 核心职责或目录边界发生变化，需要同步更新本文件和根 README。
- `src/react-app/` 当前应优先围绕 session / workspace 联调推进；复杂前端能力必须由已存在的 Worker API 驱动，不能反向定义 runtime 协议。

## 8. 相关文档（Related Docs）

- `./README.md`
- `./TODO-claude-code-reverse-compare.md`
- `./external/learn-claude-code/README-AI.md`
- `./external/my-claude-code/README-AI.md`
