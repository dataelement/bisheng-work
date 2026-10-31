# 会话列表登录入口整理 — 2026-10-28

## 基线与原因

- 目标：`dataelement/bisheng-desktop:V1.2.0@0b26f94475d9fc29fbe0d0b9002d1ecb3423b55c`，获取远端后建立 `codex/v120-history-signin-entry`；工作目录 `.worktrees/bisheng-work-v120-history-signin-entry`。
- 干净安装 Harness `0.2.1-rc.2`，项目 postinstall 完成。通用 v0.9.0 参考集成目录检查时为干净状态。
- `SharedCollection` 在账号未连接时追加登录按钮，因此空列表和退出登录后的列表都出现账号操作。会话列表的职责是展示与访问会话，账号操作由已有账号入口与 Chat 登录引导承接。

## 实现与验证

- 直接删除 `SharedCollection` 中的登录按钮渲染分支。共用登录文案继续用于 Chat 登录引导。
- 更新既有行为测试：空列表只呈现标题和空状态；退出登录后继续呈现本地会话操作；Chat 引导打开账号设置并保留 Work 草稿。
- 原代码执行增强后的测试出现 2 项预期失败；修改后相关文件 32 项全部通过。
- JS 语法、类型检查、生产构建与差异检查通过。构建使用按 SHA256 校验的本地 Office 下载缓存。
- macOS Electron 43.0.0 原生组件夹具在 600/1200 宽度和深浅主题下共 4 组通过，覆盖空列表、本地会话、登录后云端会话、退出登录、Chat 登录引导打开账号设置及草稿保留。夹具使用真实列表组件与模拟服务，登录弹窗采用测试替身。
- 完整回归：314 个文件 / 3,120 项通过，4 个文件 / 5 项跳过；2 个工作台测试文件共 11 项失败。`workbench-navigation.test.mjs` 与 `workbench-settings-locale.test.mjs` 单独复测同样出现 11 项失败，原因均为模拟 window 缺少新版本工作台订阅所需的 `addEventListener`。这两个测试和它们加载的工作台源码均与 `V1.2.0@0b26f94` 一致，测试导入路径独立于本次修改的列表插件。
- Windows 安装包、真实企业账号及已安装应用验收待执行。

证据：主工作区 `outputs/history-signin-entry-20261028/`。
