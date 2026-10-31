# 工作台企业页签语言修复 — 2026-10-30

## 基线

- 目标：`dataelement/bisheng-desktop:V1.2.0`；GitHub 连接器核对的远端提交为 `e928c8c3bd5d2f188f17b7d93e0fbd7bc13eaf90`。本地 Git 对象一致，独立工作目录直接从该提交创建。
- 工作目录：`.worktrees/bisheng-work-v120-enterprise-locale`；分支：`codex/v120-workbench-enterprise-locale`。
- 本机安装版：`BISHENG 1.2.0-test.2`，从安装包读取的 Harness 为 `0.2.1-rc.2`；开发依赖 Harness 同为 `0.2.1-rc.2`。
- 截图对应的工作台组件归属 BISHENG Desktop `V1.2.0`。父项目规则记录的 DSH `v0.9.0` 集成目录检查为干净，本次采用实际组件所属仓库的版本分支。
- 依赖复制自锁文件完全一致的已有工作目录，本地包相对链接指向当前修复目录。Office 构建缓存复用已有下载并由构建脚本校验 SHA。

## 根因与修改

企业页签的按钮子节点是固定中文字符串；同一页面的语言订阅已正常工作。按钮现从现有 `workbench.enterprise` 命名空间读取 `tab`，同批补齐中英文字典。现有语言订阅驱动文本更新，页签标识、选中状态和键盘导航继续由原组件管理。源码直接修改宿主工作台插件，复用 Harness locale 注册与读取接口。

## 验证

- `test/workbench-enterprise-locale.test.mjs`：2 项通过。使用真实 React DOM 和已安装 Harness LocaleRuntime，覆盖英文/中文初始显示、企业页签点击、中文→英文→中文即时切换、DOM 节点与选中状态保留、tab/panel 对应关系和 tabIndex。
- 同两项用例在原始基线上均失败，失败点为英文状态实际显示中文。
- 与 `test/workbench-settings-locale.test.mjs`、`test/workbench-client.test.mjs` 组合运行：220 项通过。
- 类型检查、JS 语法检查、生产构建及 `git diff --check` 通过。
- 完整回归首轮：321 个文件 / 3,175 项通过，4 个文件 / 5 项条件跳过；`session-search-recovery.test.mjs` 的 6 项失败（`renderSlot is not a function`）。复用依赖沿用旧工作目录的 workspace 客户端产物，遗漏当前基线已有修复。
- 按当前分支的版本化依赖修复恢复 workspace 客户端，其 Git blob 为 `f714d5fa4665e88ce3ba75b5a93c69359ed35cdc`，与当前补丁目标一致。该依赖调整属于验证环境同步。
- 环境同步后，全部 6 项失败用例与 220 项工作台相关用例组合复测：4 个文件 / 226 项全部通过；生产构建复跑通过。完整套件的首轮结果与组合复测分别记录。
- 本地日志：父工作区 `outputs/workbench-enterprise-locale-20261030/`。

Windows 安装版、真实企业账号及更新安装包验收待执行。本次检查证明源码与隔离组件行为。
