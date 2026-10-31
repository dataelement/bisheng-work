import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import { createManagedMarketSource, performMarketAction } from '../packages/dsh-desktop-enterprise/managed-market.js'
import { installEnterpriseWorkbench } from '../packages/dsh-desktop-workbenches/enterprise-install.mjs'

const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const id = 'a'.repeat(32), key = 'b'.repeat(64)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'enterprise-manager-'))
  roots.push(root)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), '{"dependencies":{},"dsh":{"profile":{"bundles":[]}}}')
  let state = { accountKey: key, installed: [] }
  const market = {
    state: () => structuredClone(state),
    act: vi.fn(async input => {
      if (input.expectedAccountKey !== state.accountKey) throw new Error('Enterprise account changed.')
      if (input.action === 'uninstall') state.installed = []
      else if (input.action === 'install') state.installed = [{ plugin_id: id, name: 'company-demo', version: '1.0.0', enabled: true, status: 'enabled' }]
      else state.installed[0].status = input.action === 'enable' ? 'enabled' : 'disabled'
      return market.state()
    })
  }
  const source = createManagedMarketSource(market)
  const events = []
  const manager = Object.assign(Object.create(PluginManager.prototype), {
    profile: { dir: root, installAnchor: resolve('node_modules/@deepseek-ai/dsh/package.json') },
    ownerContext: { get: name => name === 'profileManagedBundleSource' ? source : undefined, emit: (...args) => events.push(args) },
    abort: new AbortController(), installs: new Map(), lockWaitMs: 2000,
    managementBundles: new Set(), protectsManager: () => false,
    declaredRows: () => ({ rows: [], overrides: [] })
  })
  return { manager, source, market, events, root, switchAccount: () => { state = { accountKey: 'c'.repeat(64), installed: [] } } }
}

describe('enterprise source through the real Plugin Manager methods', () => {
  it('installs, inventories, toggles and removes through the Manager without ordinary Profile projection', async () => {
    const { manager, source, market, events, root } = await fixture()
    const before = await readFile(join(root, 'package.json'), 'utf8')
    const installed = await performMarketAction(manager, source, market, { action: 'install', plugin_id: id })
    expect(installed.result).toMatchObject({ application: 'applied', stage: 'enable', changed: true })
    expect(installed.result.restartReason).toBeUndefined()
    const target = `enterprise:${key}:${id}`
    expect((await manager.listBundles()).find(row => row.name === target)).toMatchObject({ installed: true, enabled: true })
    expect(await manager.setBundleEnabled(target, false)).toMatchObject({ application: 'applied', enabled: false })
    expect(await manager.setBundleEnabled(target, true)).toMatchObject({ application: 'applied', enabled: true })
    expect(await manager.removeBundle(target)).toMatchObject({ application: 'applied', stage: 'remove', changed: true })
    expect((await manager.listBundles()).some(row => row.name === target)).toBe(false)
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(before)
    expect(events.filter(([name]) => name === 'plugin-manager/changed')).toHaveLength(4)
  })

  it('rejects stale account targets and consumes install tickets exactly once', async () => {
    const { manager, source, market, switchAccount } = await fixture()
    const prepared = source.prepare({ action: 'install', plugin_id: id })
    expect(await manager.installBundle(prepared.ticket)).toMatchObject({ application: 'applied' })
    expect(await manager.installBundle(prepared.ticket)).toMatchObject({ application: 'failed' })
    const stale = source.prepare({ action: 'install', plugin_id: id })
    switchAccount()
    expect(await manager.installBundle(stale.ticket)).toMatchObject({ application: 'failed' })
    expect(await manager.setBundleEnabled(prepared.target, true)).toMatchObject({ application: 'failed' })
    expect(await manager.removeBundle(prepared.target)).toMatchObject({ application: 'failed' })
    expect(market.act).toHaveBeenCalledTimes(1)
    expect((await manager.listBundles()).some(row => row.name.startsWith('enterprise:'))).toBe(false)
  })

  it('reports authorization/activation failures rather than installed success', async () => {
    const { manager, source, market } = await fixture()
    market.act.mockRejectedValueOnce(new Error('Enterprise seat revoked'))
    await expect(performMarketAction(manager, source, market, { action: 'install', plugin_id: id })).rejects.toThrow('Enterprise seat revoked')
    expect((await manager.listBundles()).some(row => row.name.startsWith('enterprise:'))).toBe(false)
  })

  it('fails closed for malformed source targets without attempting a package install', async () => {
    const { manager, market } = await fixture()
    expect(await manager.installBundle('enterprise:forged')).toMatchObject({ application: 'failed' })
    expect(await manager.removeBundle('enterprise:forged')).toMatchObject({ application: 'failed' })
    expect(market.act).not.toHaveBeenCalled()
  })
})

describe('enterprise workbench lifecycle', () => {
  function setup(application = 'applied') {
    const release = vi.fn()
    const packages = { open: vi.fn(async () => ({ path: '/temporary/verified.tgz', packageName: 'company-workbench', version: '1.0.0', release })) }
    const manager = {
      listBundles: vi.fn(async () => []),
      installBundle: vi.fn(async () => ({ application, stage: 'enable', bundle: 'company-workbench', changed: true, ...(application === 'restart-required' ? { restartReason: 'no-hmr' } : {}) }))
    }
    return { manager, packages, release }
  }
  it.each(['applied', 'restart-required'])('preserves %s and verifies package identity before publication', async application => {
    const { manager, packages, release } = setup(application)
    const response = await installEnterpriseWorkbench(manager, packages, id)
    expect(manager.installBundle).toHaveBeenCalledWith('/temporary/verified.tgz', { enabled: true, expectedName: 'company-workbench', expectedVersion: '1.0.0', replace: false })
    expect(response).toMatchObject({ status: 200, body: { application, restartRequired: application === 'restart-required', install: { id, source: 'enterprise' } } })
    expect(release).toHaveBeenCalledOnce()
  })
  it.each(['failed', 'cancelled', 'overridden'])('does not convert %s into a successful install', async application => {
    const { manager, packages, release } = setup(application)
    expect(await installEnterpriseWorkbench(manager, packages, id)).toMatchObject({ status: 409 })
    expect(release).toHaveBeenCalledOnce()
  })
  it('routes an existing enterprise package update through Manager replacement', async () => {
    const { manager, packages, release } = setup()
    manager.listBundles.mockResolvedValue([{ name: 'company-workbench', installed: true }])
    expect(await installEnterpriseWorkbench(manager, packages, id)).toMatchObject({ status: 200 })
    expect(manager.installBundle.mock.calls[0][1]).toMatchObject({ replace: true })
    expect(release).toHaveBeenCalledOnce()
  })
})

describe('verified tarball contract on the current Manager', () => {
  it('forwards expected identity to the backend and rolls back a mismatched package', async () => {
    const { manager, root } = await fixture()
    const packagePath = join(root, 'node_modules', 'wrong-package')
    const rollback = vi.fn()
    const backend = {
      supportsVerifiedInstall: true,
      install: vi.fn(async () => {
        await mkdir(packagePath, { recursive: true })
        await writeFile(join(packagePath, 'package.json'), JSON.stringify({ name: 'wrong-package', version: '2.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
        await writeFile(join(packagePath, 'cordis.patch.yml'), '[]\n')
        return { bundle: 'wrong-package', packageResult: { exitCode: 0, output: '', logPath: '', truncated: false }, rollback }
      })
    }
    manager.ownerContext.get = name => name === 'profileBundlePackageBackend' ? backend : undefined
    manager.installedFrom = new Map()
    const result = await manager.installBundle(join(root, 'verified.tgz'), { expectedName: 'expected-package', expectedVersion: '1.0.0' })
    expect(backend.install.mock.calls[0][0]).toMatchObject({ kind: 'tarball', expectedName: 'expected-package', expectedVersion: '1.0.0' })
    expect(result).toMatchObject({ application: 'failed', stage: 'install' })
    expect(result.error.diagnostic).toContain('identity does not match')
    expect(rollback).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies).toEqual({})
  })

  it('does not fall back to unverified pnpm when a backend declines', async () => {
    const { manager, root } = await fixture()
    manager.ownerContext.get = name => name === 'profileBundlePackageBackend' ? { supportsVerifiedInstall: true, install: async () => undefined } : undefined
    manager.runPnpm = vi.fn()
    const result = await manager.installBundle(join(root, 'verified.tgz'), { expectedName: 'company-demo', expectedVersion: '1.0.0' })
    expect(result).toMatchObject({ application: 'failed', stage: 'install' })
    expect(result.error.diagnostic).toContain('declined verified install')
    expect(manager.runPnpm).not.toHaveBeenCalled()
  })
})
