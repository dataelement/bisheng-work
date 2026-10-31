# About foreground ownership — 2026-10-29

## Baseline

- Repository: `dataelement/bisheng-desktop` (the existing `bisheng-work` remote redirects).
- Verified target: `V1.2.0@919cc8d845b74f5719939b977b22c3fe9c5c5f68`.
- Worktree: `.worktrees/bisheng-work-v120-about-chat-visibility`; branch: `codex/v120-about-chat-visibility`.
- Installed local app: `BISHENG 1.2.0-test.2`; installed and development Harness: `0.2.1-rc.2`.
- Legacy v0.9.0 integration worktree was clean. This repair follows the current BISHENG version branch and its runtime contracts.
- Dependencies were copied into this isolated worktree from the prior verified checkout. The lockfile difference is confined to the owned `packages/dsh-desktop-client-ui` metadata; resolved installed-package records match. The owned package symlinks resolve into this checkout. Office cache inputs are checked by the existing build preparation.

## Root cause and change

The active About implementation is mounted by `src/preload/index.ts` in a closed Shadow DOM. `src/preload/desktop-update-ui.ts` has a separate About implementation, but it is absent from the shipped preload import graph. The repair targets the active implementation.

Electron's native Chat view paints above the host DOM. Its visibility previously continued while About displayed its backdrop, covering the dialog and version labels. About now publishes `data-dsh-about-open` through a small presentation lifecycle module. DesktopModes observes this exact root attribute and feeds the existing presentation IPC, giving About the foreground over both Chat and remote settings. Closing About re-evaluates the current mode, settings and onboarding boundaries. The scoped observer is released with the component.

The application-menu action focuses the host renderer before dispatching About. Its single close control receives focus, Tab stays within the dialog, and close/disposal releases the foreground state and restores the previous connected DOM focus target. Version data still comes from the original main-process IPC, with current language and theme behavior.

## Verification

- Related behavior tests: 72 passed across `about-presentation.test.ts`, `desktop-modes-ui.test.mjs` and `enterprise-chat-view.test.ts`.
- Two new DesktopModes cases fail against the original baseline. They exercise initial/restored About state, open/close, locale/theme/resize, foreground settings, current Work/Chat selection, overlapping onboarding and unmount cleanup.
- Presentation tests cover publication, repeated render/open/close, Tab/Shift+Tab, prior DOM focus restoration and unload cleanup.
- `npm run typecheck`, production build, JS syntax and diff checks: passed.
- Native fixture: 16 passing combinations on macOS Electron, using the shipped preload, actual DesktopModes, EnterpriseChatView and an isolated local service/account fixture. Checks cover 900/1154 widths, 100%/125% zoom, zh/en, light/dark, complete desktop/Harness version text, native visibility, focus, Tab, Escape/close/backdrop and Chat restoration. Screenshots were inspected.
- `npm test -- --maxWorkers=4`: 319 files / 3,163 tests passed; 4 files / 5 tests conditionally skipped.
- The related tests are added to the Windows test configuration for the next Windows run.

Native evidence and its portable runner are in the parent workspace's `outputs/about-chat-visibility-20261029/`. The native fixture ran on macOS; Windows installed-app composition, the real application-menu click and real-account acceptance remain pending.
