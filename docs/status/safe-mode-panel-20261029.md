# Safe Mode plugin manager presentation — 2026-10-29

## Baseline

- Repository: `dataelement/bisheng-desktop` (renamed from `dataelement/bisheng-work`; the existing remote redirects), target `V1.2.0`, verified remote SHA `804205500286b9cd8a44632acfd9154c9615c466`.
- Worktree: `.worktrees/bisheng-work-v120-safe-mode-panel`; branch: `codex/v120-safe-mode-panel`.
- Installed macOS app: `BISHENG 1.2.0-test.2`; installed and development Harness: `0.2.1-rc.2`.
- The legacy `dsh-desktop:v0.9.0` remote branch lookup returned no matching head. The existing v0.9.0 integration worktree was clean. The current BISHENG UI and dependency contracts belong to `bisheng-work:V1.2.0`, which owns this fix.
- Dependencies were copied into this isolated worktree from a checkout with an identical `package-lock.json`; local package symlinks resolve to this worktree. Offline installation was attempted first and reported a missing npm metadata cache entry. Build preparation uses SHA-verified local Office download caches.

## Root cause and implementation

`SafeModeFrame` sends the recovery URL to the host preload, which mounts an iframe and sets `html[data-dsh-safe-mode-page]`. `DesktopModes` previously kept its native Chat view visible while that page occupied the pane. Electron composites that child view above the host DOM, so only the strip outside Chat's bounds remained visible.

The existing presentation calculation now consumes the recovery-page attribute. A scoped attribute observer refreshes native visibility on open and close, including the case where the page already exists when the content component mounts. Remote settings retain their foreground presentation; mode selection, connection state and host modal boundaries continue to control restoration. The observer is released with the existing component cleanup. This changes the owned desktop plugin through the existing presentation IPC; Harness dependencies and permissions retain their current contracts.

## Verification

- `test/desktop-modes-ui.test.mjs` and `test/enterprise-chat-view.test.ts`: 70 passing tests. New cases cover initial/restored recovery state, open/close/reopen, locale/theme/resize, remote settings handoff, Work selection, draft preservation and observer cleanup.
- Both new cases fail against the original baseline: native presentation remains visible during recovery.
- `npm run typecheck` and `node --check packages/dsh-desktop-client-ui/client.js`: passed.
- macOS Electron: 24 passing combinations (900/1200 width × 0.8/1/1.25 zoom × zh/en × dark/light). The isolated fixture executes the actual DesktopModes component, recovery preload section, SafeModeFrame, safe-mode HTML and EnterpriseChatView against a local account/service fixture. It checks title/list/action geometry, native visibility, iframe action relay, resizing and Chat restoration. Screenshots were inspected.
- `npm run build`: passed.
- `CI=true npm test`: 316 files / 3,134 tests passed; 4 files / 5 tests conditionally skipped. The restricted-environment run was interrupted after local-service tests failed; the completed serial run had local networking and child-process access.
- `git diff --check`: passed.

Local evidence is stored under the parent workspace's `outputs/safe-mode-panel-20261029/`, including the native verification runner, screenshots and JSON results. This proves the source-level fix and isolated macOS native composition. Updated installation-package, real-account and Windows acceptance remain pending.
