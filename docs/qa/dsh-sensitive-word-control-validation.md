# DSH 敏感词控制客户端：V1.2.0 合并验证记录

日期：2026-10-24。功能与 QA 操作步骤见 [功能说明](./dsh-sensitive-word-control.zh.md)。

## 代码基线与合并

- 开发源：`feat/bisheng-work-dsh-guardrails`，`3e8486c4da82b163d568ffde385a0304f040c698`。
- 目标：远端实际分支名 `V1.2.0`，核对基线 `9a1695150619ab22df1f332ccaca8b99bc559822`。
- 在隔离工作树正常合并目标分支，保留两侧历史；没有改动既有运行客户端的源码、依赖、Profile 或启动状态。
- 三处冲突逐段处理：企业入口同时保留语言作用域与 V1.2.0 的 skills/resources/capabilities 接线；adapter 夹具保留 `on` 和 `inject`；登录确认夹具保留真实 Locale、模块字典和原有 primitives。
- 另在 `desktop-settings-view.test.mjs` 复现 `ctx.locale.getSnapshot is not a function`：新设置用例仍使用过时 Locale 桩。只将该用例接入真实 Locale runtime，并在 finally 释放订阅；原模型展示、原生按钮、usage slot 和卸载断言保持。对应单案先失败，再由四文件 76 项组合验证通过。
- 相对目标分支，package.json 和 package-lock.json 均无差异，没有依赖升级或新增 UI 库。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| 干净 `npm ci` | PASS；39 项 patch-package 补丁重放成功，包含 Undici 8.11.2 |
| `npm run typecheck` | PASS；沿仓库既有 TypeScript 检查范围，不冒充全部插件 JS 静态检查 |
| `npm run build` | PASS；生成本次 Office/PPT 与 Electron main/preload 输出，无受跟踪生成物差异 |
| 设置／登录确认／Locale 组合 | 4 文件 76 PASS |
| 市场／Locale 相邻组合 | 4 文件 40 PASS |
| 最终完整 `npm test` | PASS；303 文件通过、4 文件跳过；3001 项通过、5 项跳过、0 失败，565.38s（跳过不计通过） |
| `git diff --check` | PASS |

全量测试使用仓库已有 macOS CI 文件串行配置：`CI=1`，PATH 优先使用已有 Python 3.11；仓库和其他工作区的依赖环境没有修改。测试预准备仍按仓库脚本选择其 Office runtime。首轮全量在发现上述夹具失败后停止，只停止经工作目录确认的本轮测试进程树，保留失败和中止日志；最终结果仅统计修复后的完整运行。

## 证据范围与 QA 待验

本记录的合并后证据为 macOS 干净安装、类型、正式构建和自动化测试；未将当前仍运行的旧特性客户端视为合并后 UI，也未发布新的正式安装包。QA 应使用本 PR 构建重做功能说明中的 P0 用例及 V1.2.0 相邻功能回归。

开发源在 109 的真实协议、审计和工具屏障证据见功能说明第 7 节。Windows 原生安装包、完整三语、跨租户／多副本、无 Gateway、Linux DM8、容量与故障／回退专项仍待对应环境验证，不由本次本地结果替代。
