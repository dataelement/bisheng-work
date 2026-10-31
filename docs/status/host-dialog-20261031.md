# 删除会话确认弹窗与原生 Chat 联动

## 基线与环境

- 目标：`dataelement/bisheng-desktop:V1.2.0`，远端基线 `e928c8c3bd5d2f188f17b7d93e0fbd7bc13eaf90`。
- 工作目录 `.worktrees/bisheng-work-v120-host-dialog`，分支 `codex/v120-host-dialog`；干净安装的 Harness `0.2.1-rc.2`、Electron `43.0.0`。
- 历史 `dsh-desktop-v090-integration` 工作区干净。本次 `upstream/v0.9.0` 远端查询遇到 GitHub TLS 连接失败；当前交付依据已成功核对的 Desktop V1.2.0。
- 本机正式应用 `1.2.0-test.2` / Harness `0.2.1-rc.2`：asar 中的客户端仍调用系统 confirm；当前 V1.2.0 已合入 [删除会话中文化](session-delete-locale-20261029.md)。安装包更新后才会携带最新实现。

## 根因和实现

原生 Chat 使用 WebContentsView，绘制在宿主 DOM 上方。Harness Modal 通过 body portal 展示，建立自己的焦点与键盘边界；宿主原先只用 root inert、About 标记与设置状态判断原生视图是否应显示。删除确认已出现时，Chat 仍占据内容区，导致确认框被覆盖。

桌面内容组件现在观察 body 下宿主 portal 的模态语义和可见状态。可见的 dialog / alertdialog 及原生 modal dialog 出现时，通过既有 present 通道隐藏原生视图；最后一个弹窗关闭后，按当前 Chat、Work、设置、安全模式与 About 状态恢复。挂载时同步读取已有弹窗，卸载时释放全部观察器。订阅范围限定为 body portal，普通会话内容的流式更新保持原生展示稳定。

删除流程继续使用已合入的 Harness Modal、locale 服务和 uiWorkspace.deleteSession。中文按钮显示“取消”“删除会话”；删除中防止重复提交，失败保留重试入口，关闭后恢复焦点。Windows 回归清单补入中文化测试。

## 验证

- 干净 `npm ci --no-audit --no-fund`、全部 postinstall 处理、`npm run typecheck`、`npm run build` 通过。
- 5 个相关测试文件 / 63 项通过，包含 5 项新增模态联动回归。用基线客户端运行同一 modes 文件：3 项失败、38 项通过，复现已有弹窗、多层确认与可见状态变化时 Chat 仍显示的问题。
- `npm test -- --no-file-parallelism` 完整串行回归通过：321 个文件 / 3,184 项通过，4 个文件 / 5 项按条件跳过；耗时 611.71 秒。JS 语法与 `git diff --check` 通过。
- `node scripts/verify-host-dialog.mjs <输出目录>` 在 macOS / arm64 / Electron 43.0.0 通过。使用独立临时 Profile、实际 Harness frontend 共享 React / Menu / Modal / Button 和正式样式及主题变量、当前宿主插件及真实 WebContentsView；检查显示切换、深浅色主题与窗口缩放、确认框位于窗口内、中文按钮、取消、Tab/Esc、焦点归还、英文切换、重复提交、失败重试、成功关闭、切到 Work 后关闭及切回 Chat 恢复原边界。
- 原生验证脚本使用受控会话服务和隔离 IPC，验证 UI / 原生视图组合；真实账号删除接口和安装版验收分别登记。支持 `DSH_TEST_HOST_DIALOG_CLIENT_SOURCE` 指定旧源码复现回归。
- 本地证据位于总工作区 `outputs/bisheng-host-dialog-20261031/`，已检查深浅色中文弹窗截图。Windows 安装包、真实企业账号和发布后更新验收待执行。
