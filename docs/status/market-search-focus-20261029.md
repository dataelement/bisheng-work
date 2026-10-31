# 工作台市场搜索框焦点边框

- 目标：`dataelement/bisheng-desktop:V1.2.0`，远端核对基线 `919cc8d845b74f5719939b977b22c3fe9c5c5f68`。
- 工作目录：`.worktrees/bisheng-work-v120-market-search-focus`；分支：`codex/v120-market-search-focus`。
- 干净安装的 Harness：`0.2.1-rc.2`；Electron：`43.0.0`。

## 根因与修复

工作台为控件统一设置了 `:focus-visible` 的 2px 外轮廓和 2px 间隔。市场搜索框本身有 1px 边框，点击输入框即可同时绘制两层轮廓；浅色主题的外轮廓使用主文字色，与反馈中的黑色双层描边一致。

搜索框现定义自身焦点状态：通过现有边框的颜色变化表示焦点，采用 Harness 原生 Input 使用的 `--dsw-alias-state-business-primary`。边框宽度与输入框尺寸保持一致。工作台按钮继续使用既有键盘焦点轮廓。

## 验证

- `npm ci`、全部兼容文件重放、类型检查和生产构建通过。
- 新增 `scripts/check-workbench-search-focus.cjs`，加载工作台实际源码中的完整 CSS，以匹配搜索框的 HTML 和深浅主题 token 夹具进行原生验证。
- 修复前运行失败于“Search uses a single border”，实际 outline 为 `solid`；修复后 macOS Electron 4 组通过（400/900 宽度 × 深浅主题）。真实鼠标点击与文字输入、Tab 到达/离开、失焦恢复、输入框尺寸和后续按钮的焦点提示均通过。截图已检查。
- 执行命令：`env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/check-workbench-search-focus.cjs`。
- 完整回归 3,158 项通过、5 项条件跳过，安全模式启动 1 项因测试端口 43129 被占用（EADDRINUSE）失败。随后串行复测安全模式启动与工作台客户端两个文件，214 项全部通过。
- JS 语法与差异检查通过。
- 本地日志及截图位于 `artifacts/market-search-focus/`。

本轮验证范围为源码、构建和 macOS Chromium 样式/交互夹具。真实账号的完整市场页面、更新后的安装包及 Windows 验收待发包执行。
