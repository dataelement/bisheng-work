# 会话搜索导致侧栏消失：根因修复与验证

## 基线

- 目标仓库与分支：`dataelement/bisheng-desktop:V1.2.0`（原仓库名 `bisheng-work`）。
- 开始工作与交付前核对的远端 SHA：`919cc8d845b74f5719939b977b22c3fe9c5c5f68`。
- 工作目录：`.worktrees/bisheng-work-v120-session-search`；分支：`codex/v120-session-search-recovery`。
- 实际安装：Harness `0.2.1-rc.2`、Electron `43.0.0`，沿用目标分支锁文件。

## 根因与行为

点击搜索入口只展开输入框；输入非空关键词后，WorkspaceBrowser 切换到 SearchResults。该组件通过 `renderSlot` 展示 `sidebar.workspaces.collection`，父组件遗漏了参数传递，导致 `TypeError: renderSlot is not a function` 和 React 渲染树崩溃，与反馈中需要重启恢复列表的表现一致。

修复直接补齐父子组件的 `renderSlot` 参数，搜索结果沿用宿主的集合与行扩展协议。搜索、无匹配、打开结果、清空和 Escape 都在原组件生命周期内完成；列表源数据与搜索结果保持各自职责。修复通过仓库既有的依赖分发机制交付。

## 自动化证据

- 新增 `test/session-search-recovery.test.mjs`：运行已安装 Harness 的 WorkspaceBrowser 和桌面 SharedCollection。宿主存储及装饰组件使用夹具。
- 6 项行为回归覆盖平铺/项目树分组、原生 fallback/桌面合并集合、点击搜索、输入、匹配结果打开、无匹配、清空、Escape、Chat 结果导航、源数据保持、延迟响应和搜索失败。
- 将运行代码恢复为修复前调用后，新增回归复现 `renderSlot is not a function`；恢复修复后 6 项通过。相关集合投影与未读回归合计 11 项通过。
- 全新 `npm ci` 与全部兼容文件重放、类型检查、生产构建通过。
- 全量回归通过：319 个文件、3,165 项通过；4 个文件 / 5 项按环境条件跳过。
- 差异检查通过。

## macOS 原生组件验证

`node scripts/verify-session-search.mjs` 在隔离临时 Profile 的 Electron 窗口加载相同生产组件，4 组流程通过（平铺/项目树 × fallback/合并集合）。验证输入匹配词后打开结果、无匹配后清空、云端结果打开及 Escape 恢复；全程保留两个本地会话。

运行环境为 macOS / Electron 43.0.0，宿主数据和装饰组件使用夹具。真实账号、安装包更新后的完整客户端流程及 Windows 验收待发包执行。

本地运行日志：`artifacts/session-search/`，包含修复前失败、干净安装、构建、定向回归、完整回归及原生组件结果。
