import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

it('prepares only the PPT runtime before focused Windows regressions', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8')
  ) as { scripts: Record<string, string> }

  expect(packageJson.scripts['pretest:windows']).toBe('npm run ppt:build')
  expect(packageJson.scripts.pretest).toBe('npm run reference-icons:prepare && npm run office:prepare && npm run ppt:build')
  expect(packageJson.scripts.build).toContain('npm run office:prepare')
})

it('defaults Windows to focused regressions and makes recovery UI an explicit dispatch check', async () => {
  const yaml = createRequire(import.meta.url)('js-yaml') as {
    load: (source: string) => {
      on: { workflow_dispatch: { inputs: Record<string, { default: boolean }> } }
      jobs: Record<string, { steps: Array<{ name?: string; if?: string; run?: string }> }>
    }
  }
  const workflow = yaml.load(await readFile(path.join(projectRoot, '.github/workflows/release.yml'), 'utf8'))
  const steps = workflow.jobs['windows-x64']?.steps ?? []
  const focused = steps.find(step => step.name === 'Run focused Windows regressions')
  const complete = steps.find(step => step.name === 'Run complete Windows test suite')
  const recovery = steps.find(step => step.name === 'Check recovery UI on native Windows at three display scales')
  expect(focused?.run).toBe('npx --no-install vitest run --config vitest.windows.config.ts')
  expect(complete?.run).toBe('npx --no-install vitest run')
  const buildIndex = steps.findIndex(step => step.name === 'Build Windows application once')
  expect(buildIndex).toBeGreaterThan(-1)
  expect(buildIndex).toBeLessThan(steps.findIndex(step => step === focused))
  expect(buildIndex).toBeLessThan(steps.findIndex(step => step === complete))
  expect(workflow.on.workflow_dispatch.inputs.windows_full_tests?.default).toBe(false)
  expect(workflow.on.workflow_dispatch.inputs.windows_recovery_ui?.default).toBe(false)
  const evaluate = (expression: string | undefined, event: string, inputs: Record<string, boolean>) =>
    new Function('github', 'inputs', `return (${expression})`)({ event_name: event }, inputs) as boolean
  for (const event of ['push', 'workflow_dispatch']) {
    expect(evaluate(focused?.if, event, {})).toBe(true)
    expect(evaluate(complete?.if, event, {})).toBe(false)
    expect(evaluate(recovery?.if, event, {})).toBe(false)
  }
  expect(evaluate(focused?.if, 'workflow_dispatch', { windows_full_tests: true })).toBe(false)
  expect(evaluate(complete?.if, 'workflow_dispatch', { windows_full_tests: true })).toBe(true)
  expect(evaluate(recovery?.if, 'workflow_dispatch', { windows_recovery_ui: true })).toBe(true)
  expect(evaluate(recovery?.if, 'push', { windows_recovery_ui: true })).toBe(false)
})

it('builds Windows only for release tags or an explicit manual platform selection', async () => {
  const yaml = createRequire(import.meta.url)('js-yaml') as {
    load: (source: string) => {
      on: { pull_request?: unknown; workflow_dispatch: { inputs: { target: { default: string } } } }
      jobs: Record<string, { if: string }>
    }
  }
  const workflow = yaml.load(await readFile(path.join(projectRoot, '.github/workflows/release.yml'), 'utf8'))
  expect(workflow.on.pull_request).toBeUndefined()
  expect(workflow.on.workflow_dispatch.inputs.target.default).toBe('macos')
  const evaluate = new Function('github', 'inputs', 'startsWith', `return (${workflow.jobs['windows-x64']?.if})`) as
    (github: { event_name: string; ref: string }, inputs: { target: string },
     startsWith: (value: string, prefix: string) => boolean) => boolean
  for (const [event, ref, target, expected] of [
    ['pull_request', 'refs/pull/1/merge', 'all', false],
    ['push', 'refs/heads/main', 'all', false],
    ['push', 'refs/tags/v1.0.2', '', true],
    ['workflow_dispatch', 'refs/heads/main', 'macos', false],
    ['workflow_dispatch', 'refs/heads/main', 'windows', true],
    ['workflow_dispatch', 'refs/heads/main', 'all', true]
  ] as const) {
    expect(evaluate({ event_name: event, ref }, { target }, (value, prefix) => value.startsWith(prefix))).toBe(expected)
  }
})

const releaseAssets = [
  'bisheng-mac-arm64.dmg',
  'bisheng-mac-x64.dmg',
  'bisheng-windows-x64-setup.exe'
]

/** The exact Harness build every `@deepseek-ai/dsh-*` production dep is pinned to. */
const HARNESS_VERSION = '0.2.1-rc.2'

describe('GitHub release contract', () => {
  it('keeps the package and lockfile versions aligned', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { version: string }
    const packageLock = JSON.parse(
      await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8')
    ) as { version: string; packages: Record<string, { version?: string }> }

    expect(packageLock.version).toBe(packageJson.version)
    expect(packageLock.packages['']?.version).toBe(packageJson.version)
  })

  it('declares required DSH peer packages as production dependencies', async () => {
    const packageLock = JSON.parse(
      await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8')
    ) as {
      packages: Record<string, { dev?: boolean; peer?: boolean }>
    }

    // A lock location is a path, so nested installs read as
    // `node_modules/<host>/node_modules/<name>`. Only the segment after the
    // last `node_modules/` names the package: without that, a third-party peer
    // that npm nested under a DSH package (rc.8 gives ui-trajectory its own
    // React 19) reads as a DSH package and trips this guard.
    const packageNameOf = (location: string): string =>
      location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)

    const peerOnlyRuntimePackages = Object.entries(packageLock.packages)
      .filter(
        ([location, metadata]) =>
          packageNameOf(location).startsWith('@deepseek-ai/') &&
          metadata.peer === true &&
          metadata.dev !== true
      )
      .map(([location]) => packageNameOf(location))

    expect(peerOnlyRuntimePackages).toEqual([])
  })

  it('vendors upstream-new closure packages as file: production deps with no registry resolution', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string> }
    const packageLockRaw = await readFile(
      path.join(projectRoot, 'package-lock.json'),
      'utf8'
    )
    const packageLock = JSON.parse(packageLockRaw) as {
      packages: Record<string, { resolved?: string; integrity?: string }>
    }

    // alpha.3 introduced these as transitive deps of shipped packages; they are
    // explicit production deps so the lockfile pins them like the rest of the
    // closure instead of letting a transitive range float.
    const promotedClosurePackages = [
      '@deepseek-ai/dsh-client-ui-schedule',
      '@deepseek-ai/dsh-deque',
      '@deepseek-ai/dsh-session-turn-outline',
      '@deepseek-ai/dsh-util-time',
      '@deepseek-ai/dsh-util-values'
    ]

    for (const packageName of promotedClosurePackages) {
      expect(packageJson.dependencies[packageName]).toBe(HARNESS_VERSION)
    }

    // Upstream publishes the official CI build to the registry, so every
    // `@deepseek-ai/dsh-*` dep is pinned to one exact version and every
    // resolution carries an integrity hash — `npm ci` stays reproducible
    // without vendoring tarballs into the repository.
    const harnessDeps = Object.entries(packageJson.dependencies).filter(
      ([name]) => name.startsWith('@deepseek-ai/dsh')
    )
    expect(harnessDeps.length).toBeGreaterThan(200)
    for (const [name, range] of harnessDeps) {
      expect(range, name).toBe(HARNESS_VERSION)
      const entry = packageLock.packages[`node_modules/${name}`]
      expect(entry?.resolved, name).toMatch(/^https?:\/\//)
      expect(entry?.integrity, name).toMatch(/^sha\d+-/)
    }

    // The vendored-tarball layout is gone; nothing may resolve from it.
    expect(packageLockRaw).not.toMatch(/file:packages\/harness-/)
  })

  it('keeps the official Harness closure at one version without promoting optional providers or test support', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string> }
    const packageLock = JSON.parse(
      await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8')
    ) as { packages: Record<string, { version?: string }> }

    for (const [location, metadata] of Object.entries(packageLock.packages)) {
      const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)
      if (/^@deepseek-ai\/dsh(?:-|$)/.test(name)) {
        expect(metadata.version, location).toBe(HARNESS_VERSION)
      }
    }

    const excludedHarnessPackages = [
      '@deepseek-ai/cordis-plugin-logger-console',
      '@deepseek-ai/dsh-agent-loop-testkit',
      '@deepseek-ai/dsh-client-test-runtime',
      '@deepseek-ai/dsh-client-web',
      // upstream 0.1.2-rc.1 moved this to packages/experimental/ (out of the
      // dsh family tarball set); desktop continues not to bundle it.
      '@deepseek-ai/dsh-code-runtime-python',
      '@deepseek-ai/dsh-e2b',
      '@deepseek-ai/dsh-fs-e2b',
      '@deepseek-ai/dsh-llm-mock-server',
      '@deepseek-ai/dsh-llm-replay',
      '@deepseek-ai/dsh-loader-smoke',
      '@deepseek-ai/dsh-lsp',
      '@deepseek-ai/dsh-lsp-stdio',
      '@deepseek-ai/dsh-sdk-client',
      // NOTE: @deepseek-ai/dsh-session-persistence-sqlite was removed upstream in
      // 0.1.2-alpha.3, so its exclusion assertion is gone. dsh-storage-sqlite is
      // likewise no longer in the closure but its guard is kept defensively.
      '@deepseek-ai/dsh-session-snapshot',
      '@deepseek-ai/dsh-storage-sqlite',
      '@deepseek-ai/dsh-subagent-acp',
      '@deepseek-ai/dsh-subagent-claude-code',
      '@deepseek-ai/dsh-subagent-codex',
      '@deepseek-ai/dsh-subagent-dsh-sdk',
      '@deepseek-ai/dsh-subprocess-e2b',
      '@deepseek-ai/dsh-tool-lsp',
      '@deepseek-ai/dsh-web-search-exa',
      '@deepseek-ai/dsh-web-search-perplexity'
    ]

    for (const packageName of excludedHarnessPackages) {
      expect(packageJson.dependencies[packageName]).toBeUndefined()
      expect(packageLock.packages[`node_modules/${packageName}`]).toBeUndefined()
    }
    // Official bundles own these, including the rc.2 retrieval API and model badge.
    for (const packageName of [
      '@deepseek-ai/dsh-tool-terminal',
      '@deepseek-ai/dsh-tool-session-query',
      '@deepseek-ai/dsh-session-title-all-prompts-llm',
      '@deepseek-ai/dsh-web-deepseek-api',
      '@deepseek-ai/dsh-client-ui-deepseek-model-label-1017'
    ]) {
      expect(packageJson.dependencies[packageName]).toBeUndefined()
      expect(packageLock.packages[`node_modules/${packageName}`]).toBeDefined()
    }
    expect(packageLock.packages['node_modules/@anthropic-ai/claude-agent-sdk']).toBeUndefined()
    expect(packageLock.packages['node_modules/@openai/codex']).toBeUndefined()
  })

  it('uses stable platform-specific artifact names', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as {
      build: {
        artifactName: string
        extraResources: Array<{ from: string; to: string }>
        win: { target: Array<{ target: string; arch: string[] }>; requestedExecutionLevel?: string }
        nsis: { artifactName: string; include: string }
        portable?: unknown
      }
    }
    const harnessNodeEntry = await readFile(
      path.join(projectRoot, 'build', 'harness-node-entry.mjs'),
      'utf8'
    )
    const windowsHiddenConsole = await readFile(
      path.join(projectRoot, 'build', 'windows-hidden-console.mjs'),
      'utf8'
    )
    const windowsHideConsoleImport = await readFile(
      path.join(projectRoot, 'build', 'windows-hide-console-import.mjs'),
      'utf8'
    )

    expect(packageJson.build.artifactName).toBe('bisheng-${os}-${arch}.${ext}')
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/app-icon.png',
      to: 'icon.png'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/windows-hidden-console.mjs',
      to: 'windows-hidden-console.mjs'
    })
    expect(harnessNodeEntry).toContain("await import('./windows-hidden-console.mjs')")
    // A top-level import: leaving this out of the package does not degrade the
    // host peer fallback, it stops the Harness entry from loading at all.
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/host-module-fallback.mjs',
      to: 'host-module-fallback.mjs'
    })
    expect(harnessNodeEntry).toContain("from './host-module-fallback.mjs'")
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/packaged-pnpm-invocation.mjs',
      to: 'packaged-pnpm-invocation.mjs'
    })
    expect(harnessNodeEntry).toContain("from './packaged-pnpm-invocation.mjs'")
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/office-engine-resolution.mjs',
      to: 'office-engine-resolution.mjs'
    })
    expect(harnessNodeEntry).toContain("from './office-engine-resolution.mjs'")
    expect(windowsHiddenConsole).toContain('export function createHiddenConsole')
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/windows-child-process-hide.mjs',
      to: 'windows-child-process-hide.mjs'
    })
    expect(windowsHideConsoleImport).toContain("await import('./windows-hidden-console.mjs')")
    expect(windowsHideConsoleImport).toContain('enforceWindowsChildProcessHide')
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/windows-hide-console-import.mjs',
      to: 'windows-hide-console-import.mjs'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/splash.html',
      to: 'splash.html'
    })
    expect(packageJson.build.extraResources).not.toContainEqual(
      expect.objectContaining({ to: expect.stringMatching(/dsh-loader.*\.gif$/) })
    )
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/dsh-desktop.patch.yml',
      to: 'dsh-desktop.patch.yml'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/dsh-desktop-safe.patch.yml',
      to: 'dsh-desktop-safe.patch.yml'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/web-import.html',
      to: 'web-import.html'
    })
    expect(packageJson.build.nsis.artifactName).toBe(
      'bisheng-windows-${arch}-setup.${ext}'
    )
    expect(packageJson.build.nsis.include).toBe('build/installer.nsh')
    expect(packageJson.build.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(packageJson.build.win.requestedExecutionLevel).toBe('asInvoker')
    expect(packageJson.build.portable).toBeUndefined()
  })

  it('keeps update metadata on the latest channel for pre-release versions', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { build: { detectUpdateChannel?: boolean } }

    // A version like 0.8.0-rc.1 would otherwise make electron-builder write
    // rc-mac.yml / rc.yml instead of latest-mac.yml / latest.yml, which every
    // downstream release step expects by name.
    expect(packageJson.build.detectUpdateChannel).toBe(false)
  })

  it('publishes update metadata for installed desktop builds', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as {
      dependencies: Record<string, string>
      build: {
        appId: string
        productName: string
        protocols: Array<{ name: string; schemes: string[] }>
        publish: Array<{ provider: string; url?: string; owner?: string; repo?: string }>
        win: { verifyUpdateCodeSignature: boolean; signtoolOptions: { publisherName: string } }
      }
    }
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8'
    )

    expect(packageJson.dependencies['electron-updater']).toBeTruthy()
    expect(packageJson.build.appId).toBe('io.bisheng')
    expect(packageJson.build.productName).toBe('BISHENG')
    expect(packageJson.build.protocols).toEqual([
      { name: 'BISHENG Enterprise Login', schemes: ['bisheng'] }
    ])
    expect(packageJson.build.publish).toEqual([
      {
        provider: 'generic',
        url: 'https://dshdesktop.com/work/updates/latest/'
      }
    ])
    expect(packageJson.build.win.verifyUpdateCodeSignature).toBe(true)
    expect(packageJson.build.win.signtoolOptions.publisherName).toBe('Beijing Shuju Xiangsu Intelligence Technology Co., Ltd.')
    for (const asset of [
      'latest-mac-arm64.yml',
      'latest-mac-x64.yml',
      'latest-mac.yml',
      'latest.yml',
      'bisheng-mac-arm64.zip.blockmap',
      'bisheng-mac-x64.zip.blockmap',
      'bisheng-windows-x64-setup.exe.blockmap'
    ]) {
      expect(workflow).toContain(asset)
    }
    expect(workflow).toContain('merge-mac-update-metadata.mjs')
    expect(workflow).toContain('Verify release assets before publication')
    expect(workflow).toContain('verify-release-assets.mjs release-assets')
    expect(workflow).toContain('Configure isolated macOS output')
    expect(workflow).toContain(
      'MACOS_OUTPUT_DIR=$RUNNER_TEMP/bisheng-macos-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${{ matrix.arch }}'
    )
    expect(workflow).toContain('--config.directories.output="$MACOS_OUTPUT_DIR"')
    expect(workflow).toContain('$MACOS_OUTPUT_DIR/${{ matrix.app-directory }}/BISHENG.app')
    expect(workflow).toContain(
      'stage-development-assets.mjs ${{ matrix.arch }} "$MACOS_OUTPUT_DIR"'
    )
    expect(workflow).not.toContain('dist/${{ matrix.app-directory }}/BISHENG.app')
    expect(workflow).toContain('dist\\win-unpacked\\BISHENG.exe')
    expect(workflow).toContain("--name 'BISHENG'")
    expect(workflow).toContain('--title "BISHENG $release_tag"')
  })

  it('keeps builder jobs from attempting implicit tag publishing', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }

    for (const script of [
      'package:mac',
      'package:mac:arm64',
      'package:mac:x64',
      'package:win',
      'package:dev:mac:arm64',
      'package:dev:mac:x64',
      'package:dev:win'
    ]) {
      expect(packageJson.scripts[script]).toContain('--publish never')
    }
  })

  it('packages an isolated development channel from the current workspace', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }
    const developmentConfig = createRequire(import.meta.url)('../electron-builder.dev.cjs') as {
      appId: string
      productName: string
      protocols: Array<{ name: string; schemes: string[] }>
      directories: { output: string }
      extraMetadata: { dshDesktopChannel: string }
      artifactName: string
      nsis: { artifactName: string }
    }

    expect(packageJson.scripts['package:dev:dir']).toContain('npm run build')
    expect(packageJson.scripts['package:dev:dir']).toContain('electron-builder.dev.cjs')
    expect(packageJson.scripts['package:dev:mac:arm64']).toContain('verify-target.mjs darwin arm64')
    expect(packageJson.scripts['package:dev:mac:arm64']).toContain('electron-builder.dev.cjs')
    expect(packageJson.scripts['package:dev:mac:x64']).toContain('verify-target.mjs darwin x64')
    expect(packageJson.scripts['package:dev:mac:x64']).toContain('electron-builder.dev.cjs')
    expect(packageJson.scripts['package:dev:win']).toContain('verify-target.mjs win32 x64')
    expect(packageJson.scripts['package:dev:win']).toContain('electron-builder.dev.cjs')
    expect(packageJson.scripts['package:dev:win']).toContain('--publish never')
    expect(developmentConfig.appId).toBe('io.bisheng.dev')
    expect(developmentConfig.productName).toBe('BISHENG Dev')
    expect(developmentConfig.protocols).toEqual([
      { name: 'BISHENG Dev Enterprise Login', schemes: ['bisheng-dev'] }
    ])
    expect(developmentConfig.directories.output).toBe('dist-dev')
    expect(developmentConfig.extraMetadata.dshDesktopChannel).toBe('development')
    expect(developmentConfig.artifactName).toBe('bisheng-dev-${os}-${arch}.${ext}')
    expect(developmentConfig.nsis.artifactName).toBe('bisheng-dev-windows-${arch}-setup.${ext}')
  })

  it('builds and publishes every supported platform', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8'
    )

    expect(workflow).toContain('runner: [self-hosted, macOS, ARM64]')
    expect(workflow).toContain('runner: [self-hosted, macOS, bisheng-intel]')
    expect(workflow).toContain('runs-on: ${' + '{ matrix.runner }}')
    expect(workflow).toContain('runs-on: [self-hosted, macOS, bisheng-windows]')
    expect(workflow).toContain('runs-on: windows-2022')
    expect(workflow).toContain('node scripts/electron-builder-windows.mjs --win --x64 --publish never --config electron-builder.dev.cjs')
    expect(workflow).toContain('Smoke test packaged Windows Harness')
    expect(workflow).toContain('$sourceExecutable = Get-Item $env:SMOKE_EXE')
    expect(workflow).toContain("$isolatedApp = Join-Path $env:RUNNER_TEMP")
    expect(workflow).toContain('$executable = Join-Path $isolatedApp $sourceExecutable.Name')
    expect(workflow).toContain('-WorkingDirectory $isolatedApp')
    expect(workflow).toContain('Packaged koffi native binding failed (exit code')
    expect(workflow).toContain("'dist-dev\\win-unpacked\\BISHENG Dev.exe'")
    expect(workflow).toContain('if (-not [string]::IsNullOrEmpty($log))')
    expect(workflow).toContain("dsh web: (http://127\\.0\\.0\\.1:\\d+/\\?token=[^\\s]+)")
    expect(workflow).toContain('-SessionVariable harnessSession')
    expect(workflow).toContain('-WebSession $harnessSession')
    expect(workflow).toContain('Packaged Windows Harness smoke test passed.')
    expect(workflow).toContain('payload = @{ args = @{ request = $request } }')
    expect(workflow).toContain("Invoke-HarnessRpc 'workspace/create'")
    expect(workflow).toContain("Invoke-HarnessRpc 'session/create'")
    expect(workflow).toContain('Harness process exited after workspace and session creation.')
    expect(workflow).toContain('& taskkill.exe /PID $desktop.Id /T /F')
    expect(workflow).toContain('Remove-Item -Recurse -Force $isolatedApp')
    expect(workflow).toContain('Failed to remove packaged Windows smoke copy')
    expect(workflow).toContain('prerelease_tag:')
    expect(workflow).toContain('signed_version:')
    expect(workflow).toContain('mode:')
    expect(workflow).toContain('--prerelease')
    expect(workflow).toContain('Store windows-x64-dev in draft release')
    expect(workflow).toContain('node scripts/stage-development-assets.mjs windows')
    for (const asset of releaseAssets) expect(workflow).toContain(asset)
    expect(
      workflow.match(
        /npm version --no-git-tag-version --allow-same-version "\$\{\{ github\.ref_name \}\}"/g
      )
    ).toHaveLength(3)
  })

  it('signs and notarizes both macOS architectures on tag releases', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8'
    )

    for (const secret of [
      'DESKTOP_CSC_LINK',
      'DESKTOP_CSC_KEY_PASSWORD',
      'DESKTOP_APPLE_API_KEY',
      'DESKTOP_APPLE_API_KEY_ID',
      'DESKTOP_APPLE_API_ISSUER',
      'DESKTOP_APPLE_TEAM_ID'
    ]) {
      expect(workflow).toContain(`secrets.${secret}`)
    }
    expect(workflow).toContain('bisheng-arm64-xcrun')
    expect(workflow).toContain('if [ "${{ matrix.arch }}" = "x64" ]; then')
    expect(workflow).toContain('exec /usr/bin/arch -arm64 /usr/bin/xcrun "$@"')
    expect(workflow).toContain('"$xcrun_bridge/xcrun" --find notarytool')
    expect(workflow).toContain('/usr/bin/xcrun --find notarytool')
    expect(workflow.match(/Prepare macOS signing keychain/g)).toHaveLength(1)
    expect(workflow.match(/xcrun stapler validate/g)).toHaveLength(2)
    expect(workflow.match(/xcrun notarytool submit/g)).toHaveLength(1)
    expect(workflow.match(/CSC_IDENTITY_AUTO_DISCOVERY: 'false'/g)).toHaveLength(1)
    expect(workflow).not.toContain("CSC_LINK: ''")
    expect(workflow).toContain("runs-on: ${{ matrix.runner }}")
    expect(workflow).toContain("runner: [self-hosted, macOS, ARM64]")
    expect(workflow).toContain("runner: [self-hosted, macOS, bisheng-intel]")
    expect(workflow).toMatch(
      /windows-x64:\r?\n\s+name: Windows x64\r?\n(?:[\s\S]*?)runs-on: windows-2022\r?\n\s+steps:/
    )
  })

  it('signs Windows installers on the local UKey runner before publishing', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8'
    )

    expect(workflow).toContain('Stage unsigned Windows assets in draft release')
    expect(workflow).toContain('Sign Windows package locally with UKey')
    expect(workflow).toContain('runs-on: [self-hosted, macOS, bisheng-windows]')
    expect(workflow).toContain('--storetype ETOKEN')
    expect(workflow).toContain('--storepass "file:$pin_file"')
    expect(workflow).toContain('--tsmode RFC3161')
    expect(workflow).toContain('secrets.DESKTOP_WINDOWS_SIGNING_PIN')
    expect(workflow).toContain(`printf '%s' "$WINDOWS_SIGNING_PIN" > "$pin_file"`)
    expect(workflow).toContain('unset WINDOWS_SIGNING_PIN')
    expect(workflow).not.toContain('security find-generic-password')
    expect(workflow).not.toContain('WINDOWS_SIGNING_KEYCHAIN_SERVICE')
    expect(workflow).toContain('finalize-windows-release.mjs')
    expect(workflow).toContain('sign-windows-unpacked.mjs')
    expect(workflow).toContain('node scripts/electron-builder-windows.mjs --win --x64 --publish never')
    expect(workflow).toMatch(/JSIGN_JAR="\$JSIGN_JAR" JSIGN_PIN_FILE="\$pin_file" \\\r?\n\s+node scripts\/electron-builder-windows\.mjs/)
    expect(workflow).not.toContain('Falling back to original installer')
    expect(workflow).not.toContain('Restoring original Windows installer from backup')
    expect(workflow).toContain('win-unpacked.tar.gz')
    expect(workflow).toContain('--prepackaged')
    expect(workflow).toContain('set -euo pipefail')
    expect(workflow).not.toContain('Falling back to original installer')
    expect(workflow).not.toContain('Restoring original Windows installer')
    expect(workflow).toContain("if (Test-Path $packagedNode) { throw 'Standalone Windows node.exe must not be packaged.' }")
    expect(workflow).toContain('version="${PRERELEASE_TAG#v}"')
    expect(workflow).toContain('version="${SIGNED_VERSION#v}"')
    expect(workflow).not.toContain('version="${PRERELEASE_TAG:-${GITHUB_REF_NAME#v}}"')
    expect(workflow).toContain('Download verified pre-release assets from draft release')
    expect(workflow).toContain('verify-release-staging.mjs')
    expect(workflow).toMatch(
      /publish:[\s\S]*?needs\.sign-windows\.result == 'success'[\s\S]*?- sign-windows/
    )
  })

  it('keeps Windows signing independent of macOS packaging and notarization', async () => {
    const { jobs } = createRequire(import.meta.url)('js-yaml').load(await readFile(path.join(projectRoot, '.github/workflows/release.yml'), 'utf8')) as {
      jobs: Record<string, { needs?: string | string[]; if?: string }>
    }
    expect(jobs['sign-windows']?.needs).toEqual(['validate-dispatch', 'windows-x64'])
    const ancestors = new Set<string>()
    const pending = ['sign-windows']
    while (pending.length > 0) {
      const name = pending.pop()
      if (!name || ancestors.has(name)) continue
      ancestors.add(name)
      expect(jobs[name]).toBeDefined()
      const needs = jobs[name]?.needs ?? []
      pending.push(...(Array.isArray(needs) ? needs : [needs]))
    }
    expect(ancestors.has('macos')).toBe(false)
    for (const name of ancestors) {
      expect(jobs[name]?.if ?? '').not.toContain('needs.macos')
    }
    for (const name of ['publish', 'publish-prerelease', 'publish-signed']) {
      expect(jobs[name]?.needs).toContain('macos')
      expect(jobs[name]?.needs).toContain('sign-windows')
    }
  })

  it('uses local npm downloads and bounds Node setup on the persistent UKey signer', async () => {
    const { jobs } = createRequire(import.meta.url)('js-yaml').load(await readFile(path.join(projectRoot, '.github/workflows/release.yml'), 'utf8')) as {
      jobs: Record<string, {
        'runs-on'?: string | string[]
        steps: Array<{ uses?: string; with?: { cache?: string }; 'timeout-minutes'?: number }>
      }>
    }
    const persistentJobs = Object.values(jobs).filter(job =>
      Array.isArray(job['runs-on']) && job['runs-on'].includes('self-hosted')
    )
    expect(persistentJobs).toHaveLength(3)
    for (const job of persistentJobs) {
      const setup = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'))
      expect(setup).toBeDefined()
      expect(setup?.with?.cache).toBeUndefined()
      expect(setup?.['timeout-minutes']).toBe(5)
    }
    expect(jobs['windows-x64']?.steps.find(step => step.uses?.startsWith('actions/setup-node@'))?.with?.cache).toBe('npm')
    const macosSetup = jobs.macos?.steps.filter(step => step.uses?.startsWith('actions/setup-node@')) ?? []
    expect(macosSetup.length).toBeGreaterThan(0)
    expect(macosSetup.every(step => step.with?.cache === undefined)).toBe(true)
  })

  it('does not change Windows security settings during installation', async () => {
    const installer = await readFile(path.join(projectRoot, 'build', 'installer.nsh'), 'utf8')
    expect(installer).not.toMatch(/Add-MpPreference|HKLM|ExecShell\s+"runas"/)
  })

  it('routes stable downloads through the website and previews through GitHub', async () => {
    const readmes = await Promise.all(
      ['README.md', 'README.zh.md', 'README.ja.md', 'README.ru.md', 'README.es.md', 'README.pt.md'].map((file) =>
        readFile(path.join(projectRoot, file), 'utf8')
      )
    )

    for (const readme of readmes) {
      expect(readme).toMatch(/https:\/\/(?:www\.)?dshdesktop\.com\/(?:#download|zh\/)/)
      expect(readme).not.toContain('| Platform | Package | Download |')
      expect(readme).not.toContain('| 平台 | 安装包 | 下载 |')
      expect(readme).not.toContain('Coming soon')
      expect(readme).not.toContain('即将发布')
      expect(readme).toContain('https://github.com/dataelement/dsh-desktop/releases')
      expect(readme).toContain('**Pre-release**')
      for (const asset of releaseAssets) {
        expect(readme).not.toContain(`releases/latest/download/${asset}`)
      }
    }
  })
})

describe('prerelease parity workflow', () => {
  const load = () =>
    readFile(path.join(projectRoot, '.github/workflows/release.yml'), 'utf8')

  it('replaces the windows-only prerelease input with a general one', async () => {
    const yml = await load()
    expect(yml).toContain('prerelease_tag:')
    expect(yml).not.toContain('windows_prerelease_tag')
    expect(yml).not.toContain('Publish validated Windows development pre-release')
  })

  it('gates signing and both publish jobs so prerelease and release never overlap', async () => {
    const yml = await load()
    const windowsIf = yml.slice(
      yml.indexOf('\n  windows-x64:'),
      yml.indexOf('runs-on: windows-2022')
    )
    const signWindows = yml.slice(
      yml.indexOf('\n  sign-windows:'),
      yml.indexOf('\n  publish:')
    )
    const publishJob = yml.slice(
      yml.indexOf('\n  publish:'),
      yml.indexOf('\n  publish-prerelease:')
    )
    const publishPrerelease = yml.slice(
      yml.indexOf('\n  publish-prerelease:'),
      yml.indexOf('\n  publish-signed:')
    )

    expect(yml).toContain('publish-prerelease:')
    expect(yml).toContain('  - development')
    expect(yml).toContain('  - signed')
    expect(yml).toContain('  - prerelease')
    expect(yml).toContain('validate-dispatch:')
    expect(yml).toContain('signed mode requires signed_version')
    expect(windowsIf).toContain("inputs.target == 'all' || inputs.target == 'windows'")
    expect(windowsIf).not.toContain('prerelease_tag')
    expect(signWindows).toContain("inputs.mode == 'signed'")
    expect(signWindows).toContain("inputs.mode == 'prerelease'")
    expect(publishJob).toContain("startsWith(github.ref, 'refs/tags/v')")
    expect(publishJob).toContain("inputs.prerelease_tag == ''")
    expect(publishPrerelease).toContain("inputs.mode == 'prerelease'")
    expect(publishPrerelease).toContain("inputs.target == 'all'")
    expect(publishPrerelease).toContain("inputs.prerelease_tag != ''")
    expect(
      yml.match(
        /npm version --no-git-tag-version --allow-same-version "\$\{\{ inputs\.signed_version \}\}"/g
      )
    ).toHaveLength(3)
  })

  it('publishes prereleases to their separate ModelScope path', async () => {
    const yml = await load()
    const prereleaseJob = yml.slice(
      yml.indexOf('\n  publish-prerelease:'),
      yml.indexOf('\n  publish-signed:')
    )
    expect(prereleaseJob).toContain('Mirror pre-release assets to ModelScope')
    expect(prereleaseJob).toContain('MODELSCOPE_TOKEN')
    expect(prereleaseJob).toContain('releases/prerelease/latest')
    expect(prereleaseJob).toContain('--draft=false --prerelease')
    expect(prereleaseJob).not.toContain('releases/test/')
  })

  it('keeps formal and pre-release ModelScope paths separate', async () => {
    const yml = await load()
    const publishJob = yml.slice(
      yml.indexOf('\n  publish:'),
      yml.indexOf('\n  publish-prerelease:')
    )
    const prereleaseJob = yml.slice(
      yml.indexOf('\n  publish-prerelease:'),
      yml.indexOf('\n  publish-signed:')
    )
    const signedJob = yml.slice(yml.indexOf('\n  publish-signed:'))
    expect(yml).toContain('Require ModelScope token for published releases')
    expect(publishJob).toContain('Mirror formal release to ModelScope')
    expect(publishJob).toContain('MODELSCOPE_REPO_ID: alexyaojin/bisheng-work')
    expect(publishJob).toContain('releases/archive/{version}')
    expect(publishJob).toContain('"releases/latest"')
    expect(prereleaseJob).toContain('releases/prerelease/{tag}')
    expect(prereleaseJob).not.toContain('"releases/latest"')
    expect(signedJob).toContain('Mirror signed test assets to ModelScope')
    expect(signedJob).toContain('releases/test/{tag}')
    expect(signedJob).toContain('releases/test/latest')
    expect(signedJob).not.toContain('releases/prerelease/')
    expect(signedJob).not.toContain('"releases/latest"')
    expect(signedJob).not.toContain('--draft=false')
    expect(signedJob).not.toContain('--prerelease')
    expect(publishJob).not.toContain('releases/test/')
  })

  it('parametrises the Windows smoke test executable', async () => {
    const yml = await load()
    expect(yml).toContain('SMOKE_EXE')
    expect(yml).toContain('SMOKE_USERDATA')
  })
})

describe('BISHENG release publication', () => {
  it('does not configure the DSH version index or rollout', async () => {
    const yml = await readFile(
      path.join(projectRoot, '.github/workflows/release.yml'),
      'utf8'
    )
    expect(yml).not.toContain('releases/versions.json')
    expect(yml).not.toContain('CRASH_ADMIN_TOKEN')
  })
})

describe('AI-organized GitHub release body', () => {
  const load = () =>
    readFile(path.join(projectRoot, '.github/workflows/release.yml'), 'utf8')

  it('drops --generate-notes for the real release and uses a notes file', async () => {
    const yml = await load()
    const publishJob = yml.slice(
      yml.indexOf('\n  publish:'),
      yml.indexOf('\n  publish-prerelease:')
    )
    expect(publishJob).not.toContain('--generate-notes')
    expect(publishJob).toContain('--notes-file')
    expect(publishJob).toContain('github_release_notes.py')
    expect(publishJob).toContain('github-release-notes.md')
  })

  it('generates pre-release notes when creating its draft', async () => {
    const yml = await load()
    const validationJob = yml.slice(yml.indexOf('\n  validate-dispatch:'), yml.indexOf('\n  macos-apple-silicon:'))
    expect(validationJob).toContain('note_args=(--generate-notes)')
  })

  it('ships a RELEASE_NOTES.md style reference', async () => {
    const notes = await readFile(path.join(projectRoot, 'RELEASE_NOTES.md'), 'utf8')
    expect(notes.startsWith('# ')).toBe(true)
  })
})
