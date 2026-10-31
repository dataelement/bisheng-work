# Embedded page modal viewport — 2026-10-28

## Baseline

- Product branch: `dataelement/bisheng-work:V1.2.0@ea1b79129b1b636d459de65642f17dfd3864d8d3`, verified against the remote before implementation.
- Working branch: `codex/v120-window-modal`; worktree: `.worktrees/bisheng-work-v120-window-modal`.
- Installed Harness: `0.2.1-rc.2`; Electron: `43.0.0`; clean `npm ci` and project postinstall completed.
- Historical DSH baseline check: the remote currently exposes `refs/tags/v0.9.0` at `7a9ed7f94257ff82daf76f2ec5e9defe16bb8661`, peeled commit `aca970834bce88d2ec14ec278b368f6f0d168d0a`; `refs/heads/v0.9.0` is absent. The reference integration worktree was clean. The reported BISHENG page and its current native view contract belong to the verified V1.2.0 branch above.

## Cause and implementation

The capabilities page uses a separate Electron WebContentsView bounded to the right content region. Its skill-upload dialog already portals its overlay and content to body. Native view bounds therefore clip the overlay at the sidebar edge. The existing window viewport protocol was limited to the knowledge picker on conversation routes.

The presentation preload now owns one aggregate modal state for body portals. It observes body children, portal changes, and the application root's background-isolation attributes. Explicit modal semantics, native modal dialogs, and Radix's hidden background identify modal state; ordinary popovers retain their content viewport. Every visible modal remains tracked through its exit animation. Closing the final portal restores the native content bounds. Navigation refreshes the state; hidden documents defer scanning, and disposal releases observers and listeners. Streaming mutations inside the application root remain outside the observation scope.

Main retains connection generation, main-frame, origin, current-path and boolean validation. Full-window bounds and transparent backing apply while a modal is open; the application root keeps its content coordinates and the portal uses window coordinates. Native focus follows the modal. Embedded settings retain their host-owned bounds. Existing knowledge-dialog callers request a refresh of this same aggregate state.

This is a host window-presentation seam: Harness slots belong to the separate host renderer and cannot control the remote document's native viewport. The preload reads semantic DOM state and creates no business UI. The change directly updates owned Desktop sources.

## Verification

- Focused behavior regressions: 37 passed, including capabilities/skills/knowledge/conversation routes, invalid reports, nested dialogs, exit animations, nonmodal popovers, visibility, navigation and disposal.
- Typecheck: passed.
- Native Electron on macOS: 12 combinations of 900/1084 window widths, 0.8/1/1.25 zoom and light/dark presentation passed. Real production preload, IPC and EnterpriseChatView ran against local semantic portal fixtures. Assertions cover full-window mask geometry, centered dialog, preserved content bounds, nested close, mask click interception, Esc and restoration.
- The child-view capture has a 40% black alpha mask over the sidebar coordinates (RGBA 0,0,0,102), while page coordinates are opaque. It records the child surface; the underlying host sidebar is a separate renderer.
- Production build: passed. Office download retry used the existing SHA-addressed cache; the build verified each resource digest.
- Complete regression first run: 314 files / 3,107 tests passed, 4 files / 5 tests skipped; one Office workbook recalculation failed at its 30-second child-process timeout. An intermediate retry overlapped resource regeneration and reported missing Office template files. After the final build completed, serial recheck passed all 52 tests (15 Office + 37 modal/view). The complete suite result and isolated final recheck are recorded separately.
- JavaScript syntax and Git whitespace checks: passed.
- Windows installation, real-account skill upload and deployed-page acceptance: pending. Native fixture results represent the platform and fixture stated above.

Evidence: workspace `outputs/window-modal-20261028/`.

## PR #94 target-branch synchronization — 2026-10-28

- Remote repository: `dataelement/bisheng-desktop`; target `V1.2.0@3ec92416fc53610d0189b70729b683a2a98a03e5`; original PR head `2941475e59cc17a7b484093bc155e2b982a30b46`. Both fetched before merging.
- Continued in `.worktrees/bisheng-work-v120-window-modal` on `codex/v120-window-modal`; checkout was clean; installed Harness `0.2.1-rc.2`. The reference v0.9.0 integration checkout was clean.
- Conflict cause: both branches prepended independent entries to `docs/STATUS.md`. Resolution preserves both entries. Target changes to platform-specific drag regions, account usage recovery and workbench navigation combine with the window-modal implementation.
- Clean `npm ci` and all postinstall compatibility replay passed; installed Harness remains `0.2.1-rc.2`. The initial offline attempt found an uncached registry response; the subsequent online clean installation completed.
- Typecheck, production build and Git whitespace checks passed.
- Complete regression: 315 files / 3,127 tests passed, 4 files / 5 tests skipped, one Office startup test failed because the runtime port was occupied (`EADDRINUSE`), accompanied by temporary cache cleanup failure (`ENOTEMPTY`). The Office test and runtime source match the original PR baseline.
- Final serial recheck: all 55 tests in `office-runtime.test.mjs`, `enterprise-modal.test.mjs`, `enterprise-chat-view.test.ts` and `windows-workspace-navigation.test.ts` passed. The complete run and isolated recheck remain separate results.
- Native Electron 43.0.0 on macOS: all 12 modal cases and 48 navigation fixture cases passed. Windows installation, Windows native interaction and real-account skill upload remain pending.
- Evidence: workspace `outputs/pr94-conflict-20261028/`.
