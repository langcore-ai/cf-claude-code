# File Workspace

## 模块职责

`src/components/file-workspace/` 是 playground 右侧文件编辑/预览区的统一入口。

它负责：

- 根据文件路径和扩展名决定渲染模式
- 管理编辑器与只读预览的边界
- 向页面层暴露统一的 `FileWorkspace` 组件
- 收敛文件类型扩展规则，避免把判断逻辑散落在 `App.tsx`

## 当前已支持

- `editable_markdown`
  - `.md`
  - `.markdown`
  - 使用 Tiptap 所见即所得编辑
  - 手动保存
- `preview_text`
  - 其他普通文本文件，继续只读预览

## 已预留未实现

- `preview_image`
- `preview_pdf`
- `unsupported`

这些类型当前只返回占位提示，不提供具体预览器。

## 设计约束

- 页面层继续负责文件读取、文件保存和路径切换
- 模块层只负责视图选择、编辑器状态和局部脏状态
- 不在这个模块中直接发 HTTP 请求
- 首版不做自动保存、协同编辑或 Markdown 源码/预览双视图

## 后续扩展规则

- 新文件类型先在 `registry.ts` 注册
- 再在 `renderers/` 中补对应 renderer
- 尽量保持 `FileWorkspace` 顶层分派逻辑稳定，不要把文件类型判断再放回页面层
