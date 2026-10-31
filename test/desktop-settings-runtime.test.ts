import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { HarnessRuntime } from '../src/main/runtime/harness-runtime'
import { resolveTestNodeExecutable } from './node-executable'

it('discovers and serves employee Settings through the actual normal-profile Harness', async () => {
  const root = resolve(import.meta.dirname, '..')
  const home = await mkdtemp(join(tmpdir(), 'bisheng-settings-runtime-'))
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await symlink(join(root, 'node_modules'), join(home, 'profiles', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  const overlay = join(home, 'settings.patch.yml')
  await writeFile(overlay, '- id: ui-settings-account\n  disabled: true\n- insert:\n    - id: dsh-desktop-settings\n      name: dsh-desktop-settings\n    - id: dsh-desktop-enterprise\n      name: dsh-desktop-enterprise\n')
  const runtime = new HarnessRuntime({
    dshEntryPath: join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    nodeEntryPath: join(root, 'build/harness-node-entry.mjs'),
    nodeExecutablePath: resolveTestNodeExecutable(),
    dshPatchPath: overlay, dshSafePatchPath: join(root, 'build/dsh-desktop-safe.patch.yml'),
    dshHome: home, logPath: join(home, 'runtime.log'), startupTimeoutMs: 30_000, launchProcess: (executable, args, options) => spawn(executable, args, options), onChanged() {}
  })
  try {
    await runtime.start(home, 'web')
    expect(runtime.snapshot().phase, runtime.snapshot().logs.join('\n')).toBe('ready')
    const { url, authToken } = runtime.snapshot()
    if (!url || !authToken) throw new Error('Harness endpoint missing')
    const loginURL = `${url}/?token=${encodeURIComponent(authToken)}`
    const login = await fetch(loginURL, { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const html = await (await fetch(url, { headers: { Cookie: cookie } })).text()
    const scripts = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/gu)].map(match => match[1])
    const settingsScript = scripts.find(src => src?.includes('dsh-desktop-settings/client.js'))
    expect(settingsScript, html.slice(-2000)).toBeDefined()
    if (!settingsScript) throw new Error('Settings script missing')
    const response = await fetch(new URL(settingsScript.replaceAll('&amp;', '&'), url), { headers: { Cookie: cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/javascript/u)
    const registrations: { id: string }[] = []
    runInNewContext(await response.text(), { window: { __ModuleLoader__: { load: (entry: { id: string }) => registrations.push(entry) } } })
    expect(registrations.some(entry => entry.id === 'dsh-desktop-settings')).toBe(true)
    if (process.env.DSH_SETTINGS_UI_PREVIEW === '1') {
      await writeFile(join(root, 'doc/settings-ui-preview.json'), JSON.stringify({ url: loginURL, home }))
      await new Promise(resolveDone => setTimeout(resolveDone, 120_000))
    }
  } finally {
    await runtime.stop()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 170_000)
