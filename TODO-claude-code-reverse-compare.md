# Claude Code Reverse 模块差异对比 TODO

## 1. 文档目的

这份文档用于归档 `external/claude-code-reverse` 与当前主实现之间的模块级功能差异，作为后续逐模块深入比对、结论同步和落地整改的统一入口。

使用方式：

- 每一节先写清楚 reverse 仓库里的真实能力来源
- 再写当前仓库已有实现
- 再明确“已确认差异”
- 最后列出后续需要继续比对的待办项

说明：

- 本文档当前聚焦“功能语义差异”，不是源码逐行 diff
- 只写已经从 `external/claude-code-reverse` 与当前仓库中确认过的事实
- 未确认的实现细节使用 TODO 标注，不把推测写成结论
- 当 reverse 仓库已经给出 prompt / tool 原文时，本文档尽量把这些原文体现出的“行为规则”单独拆出来，而不是只写功能名

### 1.1 对比口径修正

- 这份对比文档后续必须区分：
  - runtime core 差异
  - 工具能力覆盖差异
- runtime core 的判断标准不是“有哪些具体工具”，而是：
  - 模型能否稳定产生 `tool_use`
  - runtime 能否稳定执行工具
  - 工具结果能否以 `tool_result` 正确回注回下一轮推理
  - prompt、mode、compact、subagent 是否围绕这条主链路稳定工作
- 因此：
  - `NotebookRead` / `NotebookEdit` 不属于 core
  - `Bash` / `WebFetch` / `WebSearch` 也不属于 core
  - 它们属于“工具能力覆盖差异”，不应再写成“runtime core 是否完成”的判断依据

对比方法：

- reverse 侧优先引用三类证据：
  - `results/prompts/*`
  - `results/tools/*`
  - `README.md` / `v1/cli.beautify.mjs` / `logs/*`
- 当前仓库优先引用真实代码入口：
  - `src/runtime/core/*`
  - `src/runtime/tools/index.ts`
  - `src/runtime/workspace/index.ts`
  - `src/worker/index.ts`
  - `src/react-app/*`

---

## 2. 模块总览

- [x] 启动阶段与轻量预检
- [x] 系统 Prompt 体系
- [x] 主会话循环与模型调用链
- [x] 工具集合：文件、搜索、编辑
- [x] 工具集合：Todo / Task / Subagent
- [x] 工具集合：Web / Notebook / Plan 模式
- [x] Context Compact 与历史摘要
- [x] IDE / MCP / 编辑器集成
- [x] 持久化模型与状态边界
- [x] 工作区与文件系统模型
- [x] Host 形态：CLI / Worker / Playground

结论：

- 本文档的“首轮系统级差异梳理”已完成
- 后续剩余工作不再是“继续拆模块”，而是“围绕单个模块做深挖和收敛建议”

---

## 2.1 Prompt 片段矩阵

| reverse 片段 | reverse 作用 | 当前是否有对应实现 | 当前对应位置 | 已确认差异 |
| --- | --- | --- | --- | --- |
| `system-identity.prompt.md` | 定义 Claude Code 身份 | 部分有 | `src/runtime/core/runtime.ts` | 当前身份语义是通用 runtime assistant，不是 Claude Code CLI |
| `system-workflow.prompt.md` | 主工作流、输出风格、工具策略、Todo 规则、Claude Code docs 查询 | 部分有 | `src/runtime/core/runtime.ts`、`src/runtime/tools/index.ts` | 当前拆成默认 prompt + tool 描述，但缺少完整 workflow 模板 |
| `system-reminder-start.prompt.md` | 会话开头的系统提醒 | 无直接对应 | 无 | 当前没有 start reminder 生命周期片段 |
| `system-reminder-end.prompt.md` | 会话末尾 Todo/记忆提醒 | 部分有 | `src/runtime/core/runtime.ts` | 当前只有 Todo nag，不是 end reminder 片段 |
| `system-output-style-explanatory.prompt.md` | explanatory 风格 | 无 | 无 | 当前无输出风格切换层 |
| `system-output-style-learning.prompt.md` | learning 风格 + learn-by-doing | 无 | 无 | 当前无 learning mode、也无 human contribution 流程 |
| `system-compact.prompt.md` | compact system 提示 | 有 | `src/runtime/core/compact.ts` | 当前 compact prompt 更简化 |
| `compact.prompt.md` | compact 输出结构 | 部分有 | `src/runtime/core/compact.ts` | 当前 continuity summary 结构远比 reverse 简化 |
| `ide-opened-file.prompt.md` | IDE 当前打开文件注入 | 无 | 无 | 当前没有 IDE opened file 注入 |
| `check-new-topic.prompt.md` | 新话题检测 | 无 | 无 | 当前没有 topic detection |
| `summarize-previous-conversation.prompt.md` | 启动时摘要上一轮对话 | 无 | 无 | 当前只有 compact summary，没有 previous conversation summary |

---

## 2.2 工具矩阵

| reverse 工具 | reverse 语义 | 当前是否有直接对应 | 当前替代/位置 | 已确认差异 |
| --- | --- | --- | --- | --- |
| `Read` | 绝对路径读取、支持 offset/limit、行号输出、图片/PDF | 部分有 | `read_file` in `src/runtime/tools/index.ts` | 缺 offset/limit/行号/多模态 |
| `Write` | 写文件，要求 read-before-write | 部分有 | `write_file` | 没有强校验 read-before-write |
| `Edit` | 单点 exact replace | 无 | `state_exec` | 缺补丁级编辑语义 |
| `MultiEdit` | 单文件多点原子编辑 | 无 | `state_exec` | 缺原子多编辑工具 |
| `LS` | 目录 listing + ignore | 部分有 | `list_files` | 缺 ignore 与大目录提示策略 |
| `Glob` | 文件模式匹配 | 无 | 无 | 当前没有 glob 搜索 |
| `Grep` | 内容搜索、上下文、多行、type 过滤 | 无 | 无 | 当前没有 grep 搜索 |
| `Bash` | 命令执行与 git/gh 工作流 | 无 | 无 | 当前主动收缩命令执行面 |
| `TodoWrite` | 高频计划管理工具 | 有 | `TodoWrite` | 当前规则和持久化形态较简化 |
| `Task` | stateless subagent launcher | 部分有 | `subagent_run` | 方向接近，但协议和扩展面不同 |
| `WebFetch` | 抓网页并用小模型提取 | 无 | 无 | 当前没有 web fetch 工具 |
| `WebSearch` | 联网搜索 | 无 | 无 | 当前没有内建 web search |
| `NotebookRead` | 读取 Jupyter notebook | 无 | 无 | 当前没有 notebook reader |
| `NotebookEdit` | 编辑 Jupyter notebook cell | 无 | 无 | 当前没有 notebook editor |
| `ExitPlanMode` | 退出 plan mode | 无 | 无 | 当前没有 plan mode |

补充：

- 当前仓库新增了 reverse 仓库里没有的 `state_exec`
- 当前仓库新增了 reverse 仓库里没有的 task board：`task_create / task_list / task_get / task_update`
- 当前仓库新增了 reverse 仓库里没有的 Worker / workspace HTTP API

---

## 3. 启动阶段与轻量预检

### reverse 仓库来源

- `external/claude-code-reverse/README.md`
- `external/claude-code-reverse/results/prompts/check-new-topic.prompt.md`
- `external/claude-code-reverse/results/prompts/summarize-previous-conversation.prompt.md`
- `external/claude-code-reverse/logs/setup-output-style.log`
- `external/claude-code-reverse/v1/cli.beautify.mjs`

### 当前仓库对应位置

- `src/runtime/core/runtime.ts`
- `src/runtime/adapters/ai-sdk-client.ts`
- `src/worker/index.ts`

### 当前实现实际代码落点

- session 创建后直接进入主循环：`src/runtime/core/runtime.ts`
- 当前没有启动预检入口，也没有轻量模型路由器：`src/runtime/core/runtime.ts`、`src/runtime/adapters/ai-sdk-client.ts`
- Worker 创建 runtime 后直接暴露 session API：`src/worker/index.ts`

### reverse 实际证据

- `README.md` 已明确写出 quota / topic detection / summarize previous conversations
- `logs/setup-output-style.log` 中可见启动时直接向 Haiku 发送 `"quota"`
- `v1/cli.beautify.mjs` 中可见 `check-new-topic` prompt 被直接内嵌到调用链

### 已确认差异

- reverse 仓库存在“启动即执行”的轻量预检流程，包括 quota 检查、topic 检测、前一轮会话摘要判断
- 当前仓库没有 quota 检查逻辑，也没有“先用轻量模型判断是否新话题”的预处理阶段
- reverse 仓库有“总结上一轮会话”的独立 prompt；当前仓库只有 session snapshot 和 compact transcript，没有独立的“previous conversation summary”入口
- 当前仓库创建 session 后会直接进入主会话循环，不存在启动阶段的多步预判链

### 功能点级差异

- quota check
  - reverse：每次启动时固定发送 `quota` 给轻量模型，目的是快速探测额度可用性
  - 当前：没有独立 quota probe，也没有“启动失败归因到额度”的专门逻辑
- topic detection
  - reverse：对每条用户输入用独立 prompt 做 `isNewTopic + title` JSON 判定
  - 当前：没有新话题检测，也没有对话标题/终端标题更新逻辑
- summarize previous conversations
  - reverse：启动时存在“上一轮会话总结”请求，且要求输出极短摘要
  - 当前：没有启动摘要阶段，只有 compact 时生成 continuity summary

### 后续比对 TODO

- [ ] 继续定位 reverse 仓库里 quota check 的具体调用链、模型选择和触发时机
- [ ] 继续定位 reverse 仓库里 topic detection 的输入、输出和与主循环的衔接关系
- [ ] 明确 previous conversation summary 在 reverse 仓库中是持久化产物、上下文拼接产物，还是一次性启动提示

### 当前阶段结论

- 可以确认当前实现与 reverse 仓库在“启动预检层”上存在明确缺口
- 这不是宿主差异，而是 runtime 语义差异

---

## 4. 系统 Prompt 体系

### reverse 仓库来源

- `external/claude-code-reverse/results/prompts/system-identity.prompt.md`
- `external/claude-code-reverse/results/prompts/system-workflow.prompt.md`
- `external/claude-code-reverse/results/prompts/system-reminder-start.prompt.md`
- `external/claude-code-reverse/results/prompts/system-reminder-end.prompt.md`
- `external/claude-code-reverse/results/prompts/system-output-style-explanatory.prompt.md`
- `external/claude-code-reverse/results/prompts/system-output-style-learning.prompt.md`
- `external/claude-code-reverse/results/prompts/system-compact.prompt.md`
- `external/claude-code-reverse/results/prompts/ide-opened-file.prompt.md`

### 当前仓库对应位置

- `src/runtime/core/runtime.ts`
- `src/runtime/tools/index.ts`
- `src/runtime/skills/index.ts`

### 当前实现实际代码落点

- 默认 runtime prompt 常量：`src/runtime/core/runtime.ts` 中的 `DEFAULT_RUNTIME_SYSTEM_PROMPT`
- 主会话 prompt 拼接：`src/runtime/core/runtime.ts` 中的 `buildSystemPrompt(...)`
- subagent prompt 拼接：`src/runtime/core/runtime.ts` 中的 `buildSubagentSystemPrompt(...)`
- state prompt 注入：`src/runtime/core/runtime.ts` 中的 `RENDERED_STATE_SYSTEM_PROMPT`
- 工具描述 prompt：`src/runtime/tools/index.ts`

### reverse 实际证据

- `results/prompts/system-workflow.prompt.md` 是主流程总提示
- `results/prompts/system-reminder-start.prompt.md` / `system-reminder-end.prompt.md` 是生命周期插入片段
- `results/prompts/system-output-style-*.prompt.md` 展示了完整输出风格模板，不只是几句说明
- `results/prompts/ide-opened-file.prompt.md` 明确是独立条件 prompt

### 已确认差异

- reverse 仓库的系统 Prompt 是分层组合的：identity、workflow、start reminder、end reminder、output style、compact、IDE opened file 等多个片段共同组成
- 当前仓库虽然也在 `runtime.ts` 中按需拼装 prompt，但整体仍然是单一主 prompt + skills + compact summary + state prompt 的简化组合
- reverse 仓库区分不同输出风格 prompt；当前仓库没有 explanatory / learning 风格分支
- reverse 仓库有明确的“session 开始提醒”和“session 结束提醒”片段；当前仓库只有 Todo nag、state section 和 compact section 这类运行态提示
- reverse 仓库有针对 IDE 打开文件的专门 prompt；当前仓库没有真正的 IDE 打开文件注入机制

### 功能点级差异

- system identity
  - reverse：固定把自己定义为 `Claude Code, Anthropic's official CLI for Claude`
  - 当前：固定定义为 `pragmatic agent runtime assistant`
- workflow prompt
  - reverse：把语气、输出长度、工具使用策略、Todo 使用频率、WebFetch 文档查询策略、slash command、code reference 格式都集中放在 workflow/output-style prompt 中
  - 当前：默认 system prompt 主要强调“文件操作必须调用真实工具”“Todo 需细粒度拆分”“state_exec 参数必须完整”
- reminder lifecycle
  - reverse：明确有 `system-reminder-start` 和 `system-reminder-end` 两段生命周期提示，其中 end prompt 负责 Todo 空状态或短期记忆提醒
  - 当前：只有运行中按条件插入的 Todo nag，没有 start/end 双提醒结构
- output style
  - reverse：存在 `explanatory` 与 `learning` 两种完整输出风格模板，甚至包含“Learn by Doing”协作流程
  - 当前：没有输出风格模板层，前端/Worker 也没有 style-mode 概念
- Claude Code docs routing
  - reverse：当用户问 Claude Code 自身能力时，必须先走 `WebFetch` 查询官方文档
  - 当前：没有内建 web docs routing 逻辑

### 后续比对 TODO

- [ ] 逐段梳理 reverse prompt 组合顺序，确认哪些是强制段、哪些是条件段
- [ ] 对比当前 `buildSystemPrompt(...)` 是否缺少 workflow / reminder 的生命周期概念
- [ ] 对比 reverse 仓库里 tool prompt 与 system prompt 的职责划分，避免当前实现重复约束或约束缺失

### 当前阶段结论

- 当前实现最明显的缺口不是“少几句提示词”，而是缺少 reverse 那种分层 prompt lifecycle
- 当前实现的很多行为约束被塞进默认 system prompt 和 tool description，尚未分层

---

## 5. 主会话循环与模型调用链

### reverse 仓库来源

- `external/claude-code-reverse/README.md`
- `external/claude-code-reverse/v1/README.md`
- `external/claude-code-reverse/v1/cli.mjs`
- `external/claude-code-reverse/v1/merged-chunks/*`

### 当前仓库对应位置

- `src/runtime/core/runtime.ts`
- `src/runtime/adapters/ai-sdk-client.ts`
- `src/runtime/core/tool-dispatcher.ts`
- `src/runtime/core/subagent-runner.ts`

### 当前实现实际代码落点

- 主循环：`src/runtime/core/runtime.ts` 中的 `sendUserMessage(...)`
- tool dispatch：`src/runtime/core/tool-dispatcher.ts`
- AI SDK 适配：`src/runtime/adapters/ai-sdk-client.ts`
- subagent 子循环：`src/runtime/core/subagent-runner.ts` 中的 `executeLoop(...)`

### reverse 实际证据

- `README.md` 已明确不同阶段使用 Haiku 3.5 或 Sonnet 4
- `v1/cli.mjs` / `cli.beautify.mjs` 中可见基于 Anthropic SDK `beta.messages.create`
- `logs/*` 与 `results/prompts/*` 说明主流程和 compact 走的不是一套 prompt

### 已确认差异

- reverse 仓库明确基于 Anthropic TS SDK `beta.messages.create` 组织调用链；当前仓库基于 AI SDK + OpenAI-compatible provider
- reverse 仓库存在“轻量模型执行预检、主模型执行主循环”的多模型分工；当前仓库当前主链路没有明确的多模型角色拆分
- 当前仓库的主循环已经具备 `tool_use -> tool_result -> end_turn` 闭环，但还没有 reverse 仓库那种前置 topic/quota/summarize 分层
- 当前仓库有 Cloudflare / Worker 运行面与 HTTP API；reverse 仓库核心语义是 CLI / IDE 宿主里的 agent loop

### 功能点级差异

- 模型分工
  - reverse：README 已明确 Haiku 3.5 用于 quota / topic / summarize，Sonnet 4 用于主工作流和 compact
  - 当前：统一使用一个 AIClient 配置，没有按任务类型切模型
- tool loop
  - reverse：日志反推表明 tool 集合在主工作流中稳定加载
  - 当前：tool loop 已实现，但不同场景不会动态切一套“更小/更专门”的工具面，除了 subagent 过滤
- output discipline
  - reverse：workflow prompt 强约束输出极短、直接、CLI 风格
  - 当前：默认 runtime prompt 不控制回答长度，输出风格更多依赖外层宿主/UI

### 后续比对 TODO

- [ ] 继续从 merged chunks 中确认 reverse 仓库的 stop reason、tool retry、turn budget 控制细节
- [ ] 对比 reverse 仓库是否存在更细的模型路由策略，例如工具调用、compact、topic check 各自用什么模型
- [ ] 对比 reverse 仓库对 tool call 参数错误的恢复逻辑，评估当前 runtime 是否需要 repair 机制

### 当前阶段结论

- 当前实现的主循环闭环已经成立，但缺的是 reverse 的前置分层和模型路由
- 当前实现与 reverse 的核心差异不是“有没有 loop”，而是 loop 前后的 orchestration 粒度

---

## 6. 工具集合：文件、搜索、编辑

### reverse 仓库来源

- `external/claude-code-reverse/results/tools/Read.tool.yaml`
- `external/claude-code-reverse/results/tools/Write.tool.yaml`
- `external/claude-code-reverse/results/tools/Edit.tool.yaml`
- `external/claude-code-reverse/results/tools/MultiEdit.tool.yaml`
- `external/claude-code-reverse/results/tools/Ls.tool.yaml`
- `external/claude-code-reverse/results/tools/Glob.tool.yaml`
- `external/claude-code-reverse/results/tools/Grep.tool.yaml`
- `external/claude-code-reverse/results/tools/Bash.tool.yaml`

### 当前仓库对应位置

- `src/runtime/tools/index.ts`
- `src/runtime/workspace/index.ts`
- `src/runtime/core/state-executor.ts`

### 当前实现实际代码落点

- 默认工具定义：`src/runtime/tools/index.ts`
- `read_file` / `write_file` / `list_files`：`src/runtime/tools/index.ts`
- `state_exec`：`src/runtime/tools/index.ts` + `src/runtime/core/state-executor.ts`
- workspace 读写/list/copy/move/delete/mkdir：`src/runtime/workspace/index.ts`

### reverse 实际证据

- `results/tools/*.tool.yaml` 已给出官方工具 schema 和说明
- `v1/cli.beautify.mjs` 中可见 `GlobTool`、`GrepTool`、`ReadNotebook`、`NotebookEditCell` 等工具常量与错误文案
- `v1/cli.beautify.mjs` 中还可见 `/compact`、LS 大目录提示、Edit 文件类型提示等宿主逻辑

### 已确认差异

- reverse 仓库具备更完整的文件操作面：`Read`、`Write`、`Edit`、`MultiEdit`、`Ls`、`Glob`、`Grep`、`Bash`
- 当前仓库只显式提供 `read_file`、`write_file`、`list_files`，复杂文件操作依赖 `state_exec`
- 当前仓库没有 reverse 仓库同级别的 `Edit` / `MultiEdit` 结构化补丁工具
- 当前仓库没有独立的 `Glob` / `Grep` 搜索工具
- 当前仓库没有 `Bash` 工具，命令执行能力被主动收缩
- 当前仓库额外引入了 `state_exec`，这是 reverse 仓库工具面里没有的 Cloudflare / shell 风格执行抽象

### 功能点级差异

- Read
  - reverse：
    - 要求绝对路径
    - 支持 offset / limit
    - 返回 `cat -n` 风格带行号内容
    - 支持图片、PDF、多模态读取
    - `.ipynb` 要改用 NotebookRead
  - 当前：
    - `read_file` 只接收 workspace 路径
    - 不支持 offset / limit
    - 返回纯文本内容，不带行号
    - 不支持图片/PDF 读取
- Write
  - reverse：
    - 写现有文件前必须先 Read
    - 强约束“不要主动创建 README / 文档”
    - 只接受绝对路径
  - 当前：
    - 已有“不要主动创建 README”的 prompt 语义
    - 没有真正的“写前必须先读”校验链
    - 路径是 workspace 绝对路径，不是宿主 FS 绝对路径
- LS
  - reverse：
    - 需要绝对路径
    - 有 `ignore` glob
    - 在仓库过大时会主动提示改用 LS/Bash/其他工具分层探索
  - 当前：
    - `list_files` 返回树状 entries，但没有 ignore 参数，也没有大目录回退策略
- Edit / MultiEdit
  - reverse：
    - 以 exact string replace 为核心
    - 强调 old_string 必须精确匹配
    - MultiEdit 是原子顺序编辑
  - 当前：
    - 没有结构化字符串补丁工具
    - 需要借助 `state_exec` 自己实现编辑逻辑
- Ls / Glob / Grep
  - reverse：
    - `LS` 支持 ignore glob
    - `Glob` 支持模式匹配并按修改时间排序
    - `Grep` 内建 ripgrep 语义、上下文行、多行、type 过滤
  - 当前：
    - 只有 `list_files`
    - 不支持 ignore / glob / grep / multiline / context 输出模式
- Bash
  - reverse：
    - 把执行命令当成一等工具
    - 还承载 git commit / PR 工作流说明
  - 当前：
    - 完全没有 Bash 工具
    - 对命令执行能力保持收缩

### 后续比对 TODO

- [ ] 对照 `Edit.tool.yaml` / `MultiEdit.tool.yaml` 评估当前是否要补“结构化文本补丁”工具
- [ ] 对照 `Glob.tool.yaml` / `Grep.tool.yaml` 评估当前是否要补搜索工具，而不是完全压给 `state_exec`
- [ ] 对照 `Bash.tool.yaml` 评估当前是否需要保留显式禁用策略，还是未来接 sandbox 后恢复命令工具

### 当前阶段结论

- 当前仓库在“文件能力的最终可达性”上不弱，因为有 `state_exec`
- 但在“模型可学会的标准工具粒度”上明显弱于 reverse
- reverse 工具面更细、更显式；当前则把很多能力折叠进 `state_exec`

---

## 7. 工具集合：Todo / Task / Subagent

### reverse 仓库来源

- `external/claude-code-reverse/results/tools/TodoWrite.tool.yaml`
- `external/claude-code-reverse/results/tools/Task.tool.yaml`
- `external/claude-code-reverse/README.md`

### 当前仓库对应位置

- `src/runtime/domain/todo.ts`
- `src/runtime/domain/tasks.ts`
- `src/runtime/core/subagent-runner.ts`
- `src/runtime/tools/index.ts`

### 当前实现实际代码落点

- Todo 校验与渲染：`src/runtime/domain/todo.ts`
- task board：`src/runtime/domain/tasks.ts`
- Todo nag：`src/runtime/core/runtime.ts`
- `subagent_run/start/status/list`：`src/runtime/tools/index.ts`
- subagent 执行器：`src/runtime/core/subagent-runner.ts`

### reverse 实际证据

- `results/tools/TodoWrite.tool.yaml` 已明确给出触发条件、禁用条件、状态管理规则
- `results/tools/Task.tool.yaml` 已明确 Task 是 stateless agent launcher
- `README.md` 已明确 Todo JSON 存在 `~/.claude/todos/`

### 已确认差异

- reverse 仓库里 `TodoWrite` 是 Claude Code 的短期记忆与计划管理核心；当前仓库已经实现 Todo，但约束、提醒和持久化形态仍是简化版
- reverse 仓库有单独的 `Task` 工具用于子任务/子代理；当前仓库已经有 `subagent_run` / `subagent_start`，但异步部分仍是 job skeleton，不是完整后台 agent
- reverse 仓库中的 Task 更偏“主 agent 调一个独立子代理再回收结果”的官方语义；当前仓库虽然方向一致，但工具命名、协议和元数据结构还不完全对齐
- 当前仓库额外做了 richer task board（`task_create / task_list / task_get / task_update` 与依赖关系），这不属于 reverse 仓库里已确认的官方工具表面

### 功能点级差异

- TodoWrite 触发策略
  - reverse：
    - prompt 里明确规定何时必须用、何时不要用
    - 要求非常频繁使用，并且实时更新完成状态
  - 当前：
    - 已实现 Todo nag 和细粒度拆分约束
    - 但整体策略仍比 reverse 温和
- Todo 持久化
  - reverse：
    - `TodoWrite` 会在 `~/.claude/todos/` 写 JSON 文件
    - reminder end 会加载最新 Todo
  - 当前：
    - Todo 内嵌在 session snapshot 中
    - 没有独立 todo 文件或 todo store
- Task/Subagent
  - reverse：
    - Task 是“一次性 stateless 子代理调用”，结果仅回传一条总结
    - prompt 明确强调：prompt 要高度详细，输出 generally trusted
  - 当前：
    - `subagent_run` 语义接近，但仍有 `subagent_start/status/list` 这套异步骨架扩展
    - 当前还提供 task board 工具，与 reverse 的 Task tool 是两层不同概念
- Task board
  - reverse：
    - 当前已确认的官方工具层里没有显式 `task_create/task_update/task_get/task_list`
  - 当前：
    - 有独立任务板和依赖图，属于额外扩展能力，不是 reverse 仓库里已确认的 Claude Code 官方工具表面

### 后续比对 TODO

- [ ] 深挖 reverse 仓库中 Task tool 的真实输入输出结构，确认当前 `subagent_run` 是否需要向其收敛
- [ ] 对比 reverse 仓库 TodoWrite 的更新策略、提醒频率和渲染语义，确认当前 Todo 粒度约束是否仍偏弱
- [ ] 确认 reverse 仓库是否有独立 task board 概念，还是只有 Task/subagent 工具，没有当前这种显式任务列表模型

### 当前阶段结论

- 当前 Todo / subagent 能力方向正确，但“官方 Claude Code 语义浓度”还不够高
- 当前 task board 是额外扩展，不应误认为 reverse 官方已有

---

## 8. 工具集合：Web / Notebook / Plan 模式

### reverse 仓库来源

- `external/claude-code-reverse/results/tools/WebFetch.tool.yaml`
- `external/claude-code-reverse/results/tools/WebSearch.tool.yaml`
- `external/claude-code-reverse/results/tools/NotebookRead.tool.yaml`
- `external/claude-code-reverse/results/tools/NotebookEdit.tool.yaml`
- `external/claude-code-reverse/results/tools/ExitPlanMode.tool.yaml`

### 当前仓库对应位置

- `src/runtime/tools/index.ts`
- `src/worker/index.ts`
- `src/react-app/App.tsx`

### 当前实现实际代码落点

- 当前没有任何 `web_search` / `web_fetch` / notebook / plan mode 工具定义：`src/runtime/tools/index.ts`
- 当前前端和 Worker 也没有对应 UI / API：`src/worker/index.ts`、`src/react-app/App.tsx`

### reverse 实际证据

- `results/tools/WebFetch.tool.yaml`
- `results/tools/WebSearch.tool.yaml`
- `results/tools/NotebookRead.tool.yaml`
- `results/tools/NotebookEdit.tool.yaml`
- `results/tools/ExitPlanMode.tool.yaml`
- `v1/cli.beautify.mjs` 中可见 `/compact` 和 notebook 错误文案

### 已确认差异

- reverse 仓库有显式 `WebFetch` / `WebSearch` 工具；当前仓库没有内建 web 工具
- reverse 仓库有 Notebook 读写工具；当前仓库没有 notebook 特化能力
- reverse 仓库有 `ExitPlanMode` 工具；当前仓库没有 plan mode / exit plan mode 概念
- 当前仓库因此也缺失与这些工具对应的专门 prompt 约束和交互状态

### 功能点级差异

- WebFetch
  - reverse：
    - 抓 URL，转 markdown，再用小模型按 prompt 提取信息
    - 支持 15 分钟缓存和重定向重试约束
  - 当前：
    - 没有该工具
- WebSearch
  - reverse：
    - 支持 allowed_domains / blocked_domains
    - 明确要参考“今天日期”
  - 当前：
    - 没有该工具
- NotebookRead / NotebookEdit
  - reverse：
    - 明确按 cell 读写 `.ipynb`
  - 当前：
    - 没有 notebook 专项处理
- ExitPlanMode
  - reverse：
    - 明确只在“已经完成 coding plan、准备退出 plan mode”时调用
  - 当前：
    - 没有 plan mode，也没有对应工具和 UI 交互

### 后续比对 TODO

- [ ] 判断 web 工具在当前 Cloudflare 运行面里是否应保留为独立工具，而不是外接浏览/search 能力
- [ ] 判断 notebook 工具是否属于必须补齐的 Claude Code 核心能力
- [ ] 深挖 reverse 仓库里的 plan mode 语义，确认是否要在 runtime 内单独建模

### 当前阶段结论

- 这一块当前仓库基本属于明确缺失，不是简化实现
- 是否补齐应取决于后续是否真的要向 Claude Code 行为面收敛

---

## 9. Context Compact 与历史摘要

### reverse 仓库来源

- `external/claude-code-reverse/results/prompts/compact.prompt.md`
- `external/claude-code-reverse/results/prompts/system-compact.prompt.md`
- `external/claude-code-reverse/results/prompts/summarize-previous-conversation.prompt.md`
- `external/claude-code-reverse/README.md`

### 当前仓库对应位置

- `src/runtime/core/compact.ts`
- `src/runtime/adapters/transcript-store.ts`
- `src/runtime/adapters/sql-backend.ts`

### 当前实现实际代码落点

- 微压缩：`src/runtime/core/compact.ts` 中的 `microCompactMessages(...)`
- 自动压缩：`src/runtime/core/compact.ts` 中的 `autoCompactSession(...)`
- 手动 compact：`src/runtime/core/compact.ts` 中的 `compactSession(...)`
- continuity summary 生成：`src/runtime/core/compact.ts` 中的 `summarizeForContinuity(...)`
- compact 注入主循环：`src/runtime/core/runtime.ts`

### reverse 实际证据

- `results/prompts/system-compact.prompt.md` + `compact.prompt.md`
- `README.md` 已明确 compact 用 Sonnet 4
- `v1/cli.beautify.mjs` 中可见 `/compact` 命令提示和 context low 文案

### 已确认差异

- reverse 仓库有更明确的 compact prompt 体系和“总结上一轮对话”能力
- 当前仓库已经实现 continuity compact、transcript store、auto/manual compact，但没有独立的 previous conversation summary 流程
- 当前仓库 compact 结果会进 `compactSummary + transcriptRef`；reverse 仓库还存在更强的 reminder / prompt lifecycle 配合

### 功能点级差异

- compact prompt 结构
  - reverse：
    - `compact.prompt.md` 明确要求输出极其详细的结构化总结
    - 甚至要求列出 files、code sections、errors、all user messages、pending tasks、current work、optional next step
  - 当前：
    - continuity summary 只要求 completed work / current state / decisions / unfinished work
    - 摘要目标是“继续工作”，不是“完整会话归档”
- compact system prompt
  - reverse：`system-compact.prompt.md` 非常简洁，只定义“你是总结会话的助手”
  - 当前：也有简短 compact system prompt，但要求项更少
- previous conversation summary
  - reverse：有独立 summarize prompt，且长度约束极强（50 字符内）
  - 当前：没有该能力

### 后续比对 TODO

- [ ] 对比 reverse 仓库 compact 触发条件、摘要结构、回注入方式
- [ ] 确认 reverse 仓库 compact 是否与 topic detection / previous summary 有联动
- [ ] 评估当前 compact 是否只覆盖“长上下文收缩”，而没有覆盖“跨会话恢复”

### 当前阶段结论

- 当前 compact 已经能工作，但目标更接近 continuity summary，而不是 reverse 那种“高度结构化会话归档”
- reverse 在 compact/summary 上明显更重视会话再恢复能力

---

## 10. IDE / MCP / 编辑器集成

### reverse 仓库来源

- `external/claude-code-reverse/results/prompts/ide-opened-file.prompt.md`
- `external/claude-code-reverse/README.md`
- `external/claude-code-reverse/v1/merged-chunks/*`

### 当前仓库对应位置

- `src/worker/index.ts`
- `src/react-app/`
- `src/runtime/core/runtime.ts`

### 当前实现实际代码落点

- 当前没有 IDE opened file 注入或 IDE-specific MCP tool registration：`src/runtime/core/runtime.ts`
- 当前宿主是 Web playground：`src/react-app/App.tsx`

### reverse 实际证据

- `results/prompts/ide-opened-file.prompt.md`
- `README.md` 的 IDE Integration 章节
- `logs/ide-integration.log` 在 reverse 仓库中被 README 明确点名

### 已确认差异

- reverse 仓库有 IDE 打开文件注入和 IDE MCP 集成能力
- 当前仓库没有真正的 IDE/MCP 宿主集成；当前 host surface 是 Worker API + web playground
- 当前 playground 只承担 runtime 验证，不具备 reverse 仓库那种编辑器上下文自动注入

### 功能点级差异

- IDE opened file prompt
  - reverse：把“用户打开了哪个文件”显式注入 prompt，说明它“可能相关也可能无关”
  - 当前：没有该类上下文注入
- IDE MCP tools
  - reverse：README 明确说明 IDE 状态下会注册 IDE-specific MCP tools，例如错误信息和执行代码
  - 当前：没有 IDE-specific tool registration

### 后续比对 TODO

- [ ] 继续定位 reverse 仓库如何感知 IDE 当前打开文件、选区或编辑器上下文
- [ ] 判断这些能力未来应落到 MCP、前端状态同步，还是 Worker 会话上下文里

### 当前阶段结论

- 当前仓库缺的不是“再加一个 prompt”，而是整个 IDE 宿主集成层
- 这部分后续应单独建模，不应混进普通 runtime prompt 调整

---

## 11. 持久化模型与状态边界

### reverse 仓库来源

- `external/claude-code-reverse/README.md`
- `external/claude-code-reverse/v1/merged-chunks/*`

### 当前仓库对应位置

- `src/runtime/adapters/session-store.ts`
- `src/runtime/adapters/sql-backend.ts`
- `src/runtime/adapters/transcript-store.ts`
- `src/runtime/adapters/subagent-store.ts`

### 当前实现实际代码落点

- session snapshot：`src/runtime/adapters/session-store.ts`、`src/runtime/adapters/sql-backend.ts`
- transcript store：`src/runtime/adapters/transcript-store.ts`、`src/runtime/adapters/sql-backend.ts`
- subagent store：`src/runtime/adapters/subagent-store.ts`、`src/runtime/adapters/sql-backend.ts`

### reverse 实际证据

- `README.md` / `README.zh_CN.md` 对 Todo 文件持久化已有明确说明
- 其余持久化仍需继续从 merged chunks 或运行日志中反推

### 已确认差异

- reverse 仓库至少确认有 Todo 短期记忆持久化，以及 previous conversation 相关摘要能力
- 当前仓库已经明确拆出了 `SessionStore`、`TranscriptStore`、`SubagentStore`，并落到了 D1
- 当前仓库的 session 状态是 JSON 快照式持久化；reverse 仓库的内部持久化粒度和边界还需要继续深挖
- 当前仓库已经把 transcript / subagent job 作为独立 durable state；这未必与 reverse 仓库的真实实现完全一致

### 功能点级差异

- session persistence
  - reverse：当前已确认的是“会话可总结、Todo 可持续读取”，但其底层持久化实现尚未完全展开
  - 当前：`runtime_sessions` 直接存整包 `SessionState` JSON
- transcript persistence
  - reverse：目前更像“用于 compact / previous summary 的上下文材料”
  - 当前：显式有 `runtime_transcripts`
- subagent persistence
  - reverse：Task tool 作为 stateless agent，是否显式持久化 job 仍待确认
  - 当前：显式有 `runtime_subagent_jobs`

### 后续比对 TODO

- [ ] 继续确认 reverse 仓库中 todos、subagent、compact transcript 是否落在独立文件/表/缓存中
- [ ] 对比 reverse 仓库是否有更细粒度的 session metadata，而不是当前的整包 snapshot

### 当前阶段结论

- 当前仓库的 durable state 边界比 reverse 已知信息更明确
- 这不代表更先进，只说明当前仓库更偏工程化平台实现

---

## 12. 工作区与文件系统模型

### reverse 仓库来源

- `external/claude-code-reverse/results/tools/Read.tool.yaml`
- `external/claude-code-reverse/results/tools/Write.tool.yaml`
- `external/claude-code-reverse/results/tools/Edit.tool.yaml`
- `external/claude-code-reverse/results/tools/Bash.tool.yaml`

### 当前仓库对应位置

- `src/runtime/workspace/index.ts`
- `src/runtime/core/factory.ts`
- `src/runtime/core/state-executor.ts`
- `src/worker/index.ts`

### 当前实现实际代码落点

- in-memory / durable workspace adapter：`src/runtime/workspace/index.ts`
- durable runtime 装配：`src/runtime/core/factory.ts`
- Worker workspace API：`src/worker/index.ts`
- front-end 文件树 / 文件编辑：`src/react-app/App.tsx`、`src/components/file-workspace/`

### reverse 实际证据

- `results/tools/Read/Write/Edit/MultiEdit/Ls/Bash/*.tool.yaml`
- `v1/cli.beautify.mjs` 中的 notebook / edit / grep / glob 文案

### 已确认差异

- reverse 仓库明显是围绕真实宿主文件系统进行操作，工具语义偏本地 CLI/IDE 环境
- 当前仓库围绕 `@cloudflare/shell` 抽象了 memory/durable workspace，并提供 Worker 文件系统 API
- 当前仓库 durable workspace 当前仍按“单共享测试工作区”运行，不按 session 隔离；未来预期应按 project 隔离
- 当前仓库支持大文件阈值后自动走 R2；reverse 仓库里没有这一层 Cloudflare-specific 存储切换语义

### 功能点级差异

- 宿主文件系统 vs 抽象工作区
  - reverse：工具面直接把宿主 FS 暴露给模型，路径要求是真实绝对路径
  - 当前：模型看到的是 workspace 绝对路径，如 `/README.md`，不是机器真实路径
- durable workspace
  - reverse：当前已知没有 D1/R2 这类边缘存储工作区抽象
  - 当前：基于 `@cloudflare/shell`，小文件 inline 到 D1，大文件可切 R2
- 隔离边界
  - reverse：更像依赖“当前工作目录 / IDE 当前项目”作为天然隔离边界
  - 当前：当前阶段把 durable workspace 视为共享测试工作区，未来要改成 project 级工作区

### 后续比对 TODO

- [ ] 明确 reverse 仓库是否有工作区/project 级边界，还是完全依赖宿主当前目录
- [ ] 对比 reverse 仓库文件编辑能力是否依赖真实 git 工作区状态，而当前实现如何映射到 Cloudflare workspace

### 当前阶段结论

- 这一块差异主要来自平台和宿主，不宜简单定义为“当前缺失”
- 真正要关注的是：当前 workspace 工具语义是否足够贴近 reverse 的文件操作工作流

---

## 13. Host 形态：CLI / Worker / Playground

### reverse 仓库来源

- `external/claude-code-reverse/v1/cli.mjs`
- `external/claude-code-reverse/README.md`

### 当前仓库对应位置

- `src/worker/index.ts`
- `src/react-app/`

### 当前实现实际代码落点

- Worker session/workspace API：`src/worker/index.ts`
- playground：`src/react-app/App.tsx`
- Markdown 编辑/预览模块：`src/components/file-workspace/`

### reverse 实际证据

- `v1/cli.mjs`
- `v1/cli.beautify.mjs`
- `visualize.html` / `parser.js`

### 已确认差异

- reverse 仓库宿主形态是 Claude Code 风格 CLI，并具备 IDE 集成
- 当前仓库宿主形态是 Cloudflare Worker + Web Playground
- 当前仓库因此额外具备 session/workspace HTTP API、前端文件树、文件编辑/预览模块，这些不属于 reverse 仓库核心逻辑
- reverse 仓库的 CLI/IDE 交互语义与当前 Web UI 并不一一对应，因此后续比对应优先聚焦 runtime 语义，不应把宿主差异误判为能力缺失

### 功能点级差异

- reverse：
  - CLI 优先
  - 日志可视化工具用于反向分析
  - 用户与主 agent 的交互以命令行和 IDE 上下文为主
- 当前：
  - Worker API 优先
  - Web playground 承担“runtime 行为观测 + workspace 手工操作”
  - 还额外支持 Markdown 可视化编辑

### 后续比对 TODO

- [ ] 后续对比时把“宿主形态差异”与“runtime 语义差异”分开记录，避免混淆
- [ ] 如需进一步对齐 Claude Code 体验，应先决定目标是 CLI 复刻、IDE 集成，还是继续以 Web Playground 为主

### 当前阶段结论

- 当前仓库和 reverse 仓库在 host 形态上已经分叉
- 后续如果要对齐 Claude Code，优先对齐 runtime/tool/prompt 语义，而不是强行复制 CLI 壳

---

## 14. 当前阶段的总判断

### 当前仓库已具备但 reverse 仓库未直接体现的方向

- Cloudflare Worker 宿主
- D1 session/transcript/subagent 持久化
- durable workspace + R2 大文件承接
- `state_exec` 结构化执行面
- Web Playground、文件树和文件编辑/预览模块

### reverse 仓库已具备但当前仓库仍明显缺失的方向

- quota check
- topic detection
- previous conversation summary
- 更完整的 system prompt / reminder 生命周期
- `Bash`
- `Glob` / `Grep`
- `Edit` / `MultiEdit`
- `WebFetch` / `WebSearch`
- `NotebookRead` / `NotebookEdit`
- `ExitPlanMode`
- 更强的 IDE / MCP integration
- 基于输出风格的 prompt 模式切换
- 更强的“工具即策略”约束，例如 Read-before-Write、Task-first 搜索、slash command 处理
- 输出风格切换与 learning / explanatory 协作模式
- 当前打开文件 / IDE 诊断上下文注入

### 当前仓库已实现但语义仍明显简化的方向

- TodoWrite
- Task/Subagent
- Compact
- Prompt 组合系统
- 工具参数修复与错误恢复
- 搜索与文件修改能力目前被 `state_exec` 吸收，缺少官方工具粒度
- 启动阶段完全缺失 reverse 那种“轻模型预检层”

### 当前仓库新增但需和 reverse 分开看的平台特化能力

- Worker HTTP API
- Web playground
- `state_exec`
- D1 durable state
- R2 大文件承接
- Markdown 可视化编辑器

### 需要刻意避免的误判

- 不要把“当前没有 CLI/IDE 宿主”直接等同于 runtime 缺失
- 不要把“当前有 Worker/API/Playground/R2”误判为比 reverse 更完整；这只是宿主与平台差异
- 不要把 reverse prompt 中的所有安全/风格文案直接视为当前必须照搬的实现目标；应先拆 runtime 语义与宿主策略

---

## 15. 后续执行顺序建议

- [ ] 先比对“系统 Prompt 体系”
- [ ] 再比对“工具集合：文件、搜索、编辑”
- [ ] 再比对“Todo / Task / Subagent”
- [ ] 再比对“Compact 与历史摘要”
- [ ] 再比对“启动预检与模型路由”
- [ ] 最后单独归档“宿主差异（CLI/IDE vs Worker/Web）”

## 16. 下一轮比对建议的具体输出物

- [ ] 为“系统 Prompt 体系”单独产出一份逐段对照表，明确当前哪些段缺失、哪些段被合并、哪些段被弱化
- [ ] 为“文件、搜索、编辑工具”单独产出一份工具矩阵表，列出 reverse 工具、当前替代方案、是否建议补齐
- [ ] 为“Todo / Task / Subagent”单独产出一份状态机对比，明确当前简化点与潜在行为偏差
- [ ] 为“Compact 与历史摘要”单独产出摘要格式对照，评估是否需要双层 summary 机制

## 17. 本文档当前完成状态

- [x] 已完成按模块的首轮系统对比
- [x] 已完成 prompt 片段矩阵
- [x] 已完成工具矩阵
- [x] 已把当前仓库的主要代码落点写入文档
- [ ] 尚未完成 merged chunks 的更深层控制流考古
- [ ] 尚未完成 reverse 仓库持久化实现的代码级确认
- [ ] 尚未完成 reverse 仓库 stop reason / retry / turn budget 的细节还原

当前可视为：

- “模块差异比较 TODO 文档”已经完成首轮闭环
- 后续工作应转为专题对照文档，而不是继续扩写这份总表

---

## 18. 专题一：系统 Prompt 重构差异

本节把 reverse 仓库的 prompt 体系拆成“应该由谁负责”的层级，避免后续继续把所有约束堆回一个默认 system prompt。

### 18.1 reverse prompt 分层

#### A. 身份层

- `system-identity.prompt.md`
- 职责：
  - 定义产品身份
  - 固定宿主心智模型

#### B. 工作流层

- `system-workflow.prompt.md`
- 职责：
  - 定义主会话中的行动方式
  - 规定输出长度
  - 规定工具优先级
  - 规定 Todo 使用策略
  - 规定 Claude Code 自问自答时的 docs 查询路径
  - 规定 slash command / Task / WebFetch 的使用时机

#### C. 生命周期提醒层

- `system-reminder-start.prompt.md`
- `system-reminder-end.prompt.md`
- 职责：
  - 在会话头尾注入动态环境提醒
  - 把 Todo、短期记忆、重要环境规则按时机注入

#### D. 输出风格层

- `system-output-style-explanatory.prompt.md`
- `system-output-style-learning.prompt.md`
- 职责：
  - 在不改主工作流的前提下切换交互风格
  - explanatory 强调讲解
  - learning 强调用户参与式编码

#### E. 条件上下文层

- `ide-opened-file.prompt.md`
- 职责：
  - 当 IDE 有额外上下文时，按条件附加上下文说明

#### F. 特殊模式层

- `system-compact.prompt.md`
- `compact.prompt.md`
- `check-new-topic.prompt.md`
- `summarize-previous-conversation.prompt.md`
- 职责：
  - compact
  - topic detection
  - previous conversation summary

### 18.2 当前实现对应关系

| reverse 分层 | 当前状态 | 当前落点 | 问题 |
| --- | --- | --- | --- |
| 身份层 | 存在但弱化 | `DEFAULT_RUNTIME_SYSTEM_PROMPT` | 身份过泛，不体现 Claude Code 风格宿主 |
| 工作流层 | 存在但折叠 | `DEFAULT_RUNTIME_SYSTEM_PROMPT` + tool descriptions | 规则分布不均，workflow 不成体系 |
| 生命周期提醒层 | 仅局部存在 | Todo nag in `runtime.ts` | 没有 start/end 生命周期结构 |
| 输出风格层 | 缺失 | 无 | 无法做 explanatory/learning style 切换 |
| 条件上下文层 | 部分存在 | skills/state/compact 注入 | 缺 IDE opened file、缺 IDE/MCP 条件上下文 |
| 特殊模式层 | 部分存在 | compact 已有；其余缺失 | compact 有；topic/summarize 缺失 |

### 18.3 当前默认 prompt 的问题清单

- 当前默认 prompt 同时承担：
  - 身份
  - 文件工具使用约束
  - Todo 粒度约束
  - `state_exec` 参数约束
- 这导致它更像“临时补丁容器”，而不是稳定的 prompt 组合系统
- 反向仓库里的很多策略，当前被放在 tool description，而不是 workflow prompt 中
- 当前没有“不同会话模式共用核心 workflow，只切换 style 层”的能力

### 18.4 后续建议的 prompt 重构方向

#### 最小重构目标

- 保持当前主循环不动
- 不引入多余抽象层
- 只把 prompt 逻辑从“单串拼接”调整为“固定段落组合”

#### 建议分段

- `identityPrompt`
- `workflowPrompt`
- `runtimeGuardrailPrompt`
- `stylePrompt?`
- `startReminderPrompt?`
- `endReminderPrompt?`
- `conditionalPrompt[]`
  - `skillsPrompt`
  - `statePrompt`
  - `compactPrompt`
  - `ideOpenedFilesPrompt`

#### 优先补齐项

- [ ] 把当前默认 prompt 中的 workflow 规则与 runtime guardrail 分离
- [ ] 引入 `startReminder` / `endReminder` 两段，而不是继续只靠 Todo nag
- [ ] 增加 `topic detection` 和 `previous conversation summary` 的独立 prompt 常量位
- [ ] 保留 `state_exec` 约束，但从主身份段中挪到 runtime guardrail 层

### 18.5 当前结论

- 当前 prompt 系统的主要问题不是“提示词不够长”，而是“分层缺失”
- reverse 仓库的价值主要在于 prompt 生命周期设计，而不是某几句具体文案

---

## 19. 专题二：文件 / 搜索 / 编辑工具补齐矩阵

本节只关心 Claude Code 风格工具面，不讨论 Worker API 和前端文件树能力。

### 19.1 逆向工具面与当前映射

| reverse 工具 | reverse 核心能力 | 当前最接近能力 | 是否等价 | 主要缺口 |
| --- | --- | --- | --- | --- |
| `Read` | 文件读取、分段读取、多模态读取 | `read_file` | 否 | 缺 offset/limit、行号、多模态 |
| `Write` | 整体写文件、要求先读 | `write_file` | 部分 | 缺 read-before-write 强校验 |
| `Edit` | 精确字符串替换 | `state_exec` | 否 | 缺模型易学的局部编辑工具 |
| `MultiEdit` | 单文件原子多编辑 | `state_exec` | 否 | 缺批量补丁语义 |
| `LS` | 目录列举 + ignore | `list_files` | 部分 | 缺 ignore、大目录策略 |
| `Glob` | 模式匹配找文件 | 无 | 否 | 完全缺失 |
| `Grep` | 内容搜索 | 无 | 否 | 完全缺失 |
| `Bash` | 命令执行、git/gh 工作流 | 无 | 否 | 完全缺失 |

### 19.2 当前工具面的实际问题

#### A. 能力可达，但模型学习成本高

- `state_exec` 理论上能完成：
  - 读写多个文件
  - 搜索
  - JSON 操作
  - 目录树操作
- 但它对模型来说过于通用，缺少 Claude Code 官方工具那种“一个工具对应一个动作”的强语义

#### B. 细粒度搜索缺失

- 当前没有 `Glob`
- 当前没有 `Grep`
- 这会让模型：
  - 要么频繁 `list_files`
  - 要么滥用 `state_exec`
  - 要么子代理搜索粒度过粗

#### C. 局部编辑能力缺失

- 当前没有 `Edit`
- 当前没有 `MultiEdit`
- 结果是模型经常只能：
  - 整体重写文件
  - 或写 `state_exec` 自己做补丁

这和 reverse 工具面的“更强可控性”差别很大。

### 19.3 工具补齐优先级

#### P0：应优先补齐

- `Glob`
- `Grep`
- `Edit`

原因：

- 这些是最直接提升模型工具参数质量和搜索效率的能力
- 不需要先放开 Bash
- 与当前 workspace 抽象兼容性最好

#### P1：建议补齐

- `MultiEdit`
- `Read` 的 offset/limit/line-number 语义
- `LS` 的 ignore 与大目录提示

#### P2：后续视平台决定

- `Bash`
- Notebook 工具

### 19.4 当前实现可复用的基础

这些能力不需要从零开始：

- workspace 基础操作：
  - `readFile`
  - `writeFile`
  - `list`
  - `copy`
  - `move`
  - `remove`
  - `mkdir`
- `state_exec`
  - 可以作为更高阶兜底工具继续保留
- tool dispatcher
  - 已支持标准工具分发

所以补齐这些工具时，真正需要新增的是：

- 工具 schema
- 轻量执行逻辑
- prompt 说明

而不是重做 workspace 层。

### 19.5 建议的实现顺序

- [ ] 先补 `Glob`
- [ ] 再补 `Grep`
- [ ] 再补 `Edit`
- [ ] 然后决定是否补 `MultiEdit`
- [ ] 最后再讨论是否开放 `Bash`

### 19.6 当前结论

- 当前文件能力“够用”，但“不可学”
- reverse 工具面的核心价值在于把复杂行为拆成模型更容易学会的原子能力
- 当前如果继续只靠 `state_exec`，会持续遇到参数质量和行为不稳定的问题
