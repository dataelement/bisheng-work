# PR #85：会话悬浮提示定位与验证记录

## 2026-10-27 — Session action tooltip positioning

- Baseline: remote `dataelement/bisheng-work:V1.2.0@c2d71dffab1328ab723b4dad44992b6293d2f485`. Worktree `.worktrees/bisheng-work-v120-session-tooltip-position`, branch `codex/v120-session-tooltip-position`; installed Harness `0.2.1-rc.2`, Electron `43.0.0`. The general v0.9.0 integration checkout remains clean; this fix targets the reported BISHENG Work version.
- Root cause: Work grid layout/paint containment established a containing block for fixed-position tooltips whose positions are calculated in viewport coordinates. Native baseline reproduction measured a 279.995px horizontal error with a 280px sidebar.
- Implementation: the Work grid uses stacking isolation, preserving viewport-based fixed overlay coordinates and existing conversation/inspector sizing. The installed Tooltip implementation stays unchanged.
- Verification: 36 real Electron geometry scenarios passed (expanded/collapsed sidebar, inspector visibility, scroll, 80%/100%/125% zoom, top/bottom placement, hover/focus events and dismissal); 31 related desktop-mode/layout tests, TypeScript, JS syntax and diff checks passed. The geometry script uses a temporary Profile and fixture content; real-account native acceptance belongs to the user.
- Production build and packaged Harness/bootstrap/native modules (699 dependency manifests), Office authoring and DOCX/PPTX/XLSX PDF conversion checks passed. Packaged client source matches SHA-256 `691c723e60971b32a2d636bb702c99e6b64b00039ca9603de2365d54f10a3222`. Full suite: 3,012 passed, 5 skipped, one Safe Mode test hit `EADDRINUSE` on its temporary port; its isolated rerun passed. Native layout maximum horizontal error is 0.0049px and maximum 8px-gap error is 0.0079px. Delivery evidence: `outputs/session-tooltip-position-20261027/`.

## 2026-10-27 — 同步目标分支并整理文档

- 同步 `V1.2.0@d76696d1fcfabfa6a4bd34202d32f27ee3f8b679`，工作分支 `codex/v120-session-tooltip-position`，Harness `0.2.1-rc.2`、Electron `43.0.0`。参考 v0.9.0 集成工作树状态干净。
- 两个 PR 在扩展规范文末新增章节引发冲突。保留目标分支全部说明，将 Work 提示定位规则归入布局章节；本 PR 状态记录保存在当前独立文件。
- 干净依赖安装及 postinstall、类型检查、生产构建、JS 语法及差异检查通过；完整回归 313 个文件 / 3,090 项通过，4 个文件 / 5 项条件跳过。36 种原生 Electron 布局场景通过，最大横向误差 0.004883px。验证期间目标分支合入 #83，另以 `V1.2.0@71280d3` 完成自动合并预演。
