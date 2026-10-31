# V1.2.0 删除会话确认弹窗语言

## 基线与范围

- 目标仓库：`dataelement/bisheng-desktop`（原名 `bisheng-work`），目标分支 `V1.2.0`。
- 远端基线：`919cc8d845b74f5719939b977b22c3fe9c5c5f68`；实际安装 Harness `0.2.1-rc.2`、Electron `43.0.0`。
- 独立工作树 `.worktrees/bisheng-work-v120-session-delete-locale`，分支 `codex/v120-session-delete-locale`；历史 v0.9.0 参考集成目录工作区干净。

## 实现

删除入口原先向 `window.confirm` 传入中文正文，Electron 使用固定的 `OK` / `Cancel` 按钮。现在由已有 `shell.overlay`（list / root）出口承载 Harness `Modal`，菜单、标题、正文、按钮、进度与失败提示使用同一 locale 服务，中文操作显示“取消／删除会话”。

每个插件实例维护一份请求，菜单和会话行卸载后由根级弹窗继续管理。菜单先归还焦点，再打开弹窗；初始焦点为取消，Tab 与 Esc 复用 Modal 行为。删除中锁定关闭和重复提交，错误保留在弹窗中并支持重试。插件卸载清理请求与订阅，异步结果按请求身份处理。

删除继续通过 `uiWorkspace.deleteSession` 执行，权限、会话保留计数与持久化由原有链路负责。原生 IPC、产品依赖及第三方补丁沿用基线。

## 验证

- 干净 `npm ci` 与 postinstall 通过；类型检查、生产构建、差异检查通过。
- 删除会话相关 5 个测试文件 / 26 项通过。新增 8 项行为回归覆盖中英文、应用/页面语言差异、打开后的语言切换、标题转义、菜单卸载、焦点、取消、重复提交、同步/异步失败重试、插件卸载。目标基线代码运行这 8 项全部失败。
- macOS Electron 43.0.0 / arm64 隔离窗口加载本次插件及 V1.2.0 实际分发的完整前端入口与 vendor 依赖，使用 loader 的 `staticModules` 中的 React、Menu、Modal 和 Button，确认中文按钮、会话标题、取消、Tab/Esc、焦点归还、英文切换、删除中锁定、失败重试与成功关闭。删除服务为受控替身；临时用户目录独立于正式用户数据。
- 完整回归：319 个测试文件通过、4 个条件跳过；3,167 项通过、5 项条件跳过。

本地证据：总工作区 `outputs/bisheng-session-delete-locale-20261029/`。正式安装包、真实企业账号会话与 Windows 验收待执行；发布待安排。
