import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import '@deepseek-ai/dsh-web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMarketController, hostDshEntryPath, type MarketController } from '../packages/dsh-desktop-enterprise/market.js'
import { sha256 } from '../packages/dsh-desktop-enterprise/offline-bundle.js'
import { zipEntries } from '../scripts/pack-enterprise-plugin.mjs'
import { applyEnterpriseAuth } from '../packages/dsh-desktop-enterprise/enterprise-auth.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const target = process.platform + '-' + process.arch
const pluginId = 'a'.repeat(32), versionId = 'b'.repeat(32)
// Provider selection is business-plugin code, not market/host behavior.
const source = `export const inject = ['enterpriseAuth', 'loader']
function readConfig(config) {
  const plain = {}
  for (const [key, item] of Object.entries(config)) {
    plain[key] = item && typeof item.get === 'function' ? item.get() : item
  }
  return plain
}
export async function apply(ctx, config) {
  const web = ctx.get('web')
  const entries = [...ctx.loader.entries()].filter(entry => entry.options.name === '@deepseek-ai/dsh-web' && entry.fiber?.state === 2 && entry.fiber.context.get('web')?.searchProviders === web?.searchProviders)
  if (!web || entries.length !== 1) throw new Error('Search plugin requires one active web service')
  const fiber = entries[0].fiber
  const previous = readConfig(fiber.config).searchProvider
  const provider = ctx.inject(['web', 'enterpriseAuth'], scoped => {
    scoped.web.registerSearchProvider({ id: 'bs-web-search', available: () => scoped.enterpriseAuth.getState().connected, search: async (request, signal) => {
      const response = await scoped.enterpriseAuth.request('/business/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal })
      if (!response.ok) throw new Error('Search upstream failed: ' + response.status)
      return response.json()
    } })
  })
  ctx.effect(() => async () => {
    if (fiber.state === 2 && readConfig(fiber.config).searchProvider === 'bs-web-search') {
      fiber.update({ ...readConfig(fiber.config), searchProvider: previous }, true)
      await fiber.await()
    }
  })
  fiber.update({ ...readConfig(fiber.config), searchProvider: 'bs-web-search' }, true)
  await fiber.await()
  await provider.await()
  if (config.fail) throw new Error('search activation failed')
}
`

async function fixture(options: { bridge?: boolean; disabledWeb?: boolean } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'enterprise-search-market-')))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'cordis.yml'), JSON.stringify([{ id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'previous', fetchProvider: 'http' } }]))
  await mkdir(join(home, 'profiles', 'node_modules'), { recursive: true })
  await symlink(await realpath('node_modules/@deepseek-ai'), join(home, 'profiles', 'node_modules', '@deepseek-ai'), process.platform === 'win32' ? 'junction' : 'dir')
  const ctx = new Context()
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(profile + '/').href })
  cleanups.push(() => ctx.fiber.dispose())
  await mountRootInclude(ctx, join(profile, 'cordis.yml'))
  await ctx.loader.await()
  const webEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'web')
  const webFiber = webEntry?.fiber
  if (!webEntry || !webFiber) throw new Error('Web fixture did not create a runtime')
  await webFiber.await()
  if (options.disabledWeb) await ctx.loader.create({ name: '@deepseek-ai/dsh-web', disabled: true })
  const search = vi.fn(async () => Response.json({ sources: [{ url: 'https://example.com', title: 'Search result' }], content: 'enterprise result' }))
  const dispose = vi.fn(async () => {})
  if (options.bridge !== false) applyEnterpriseAuth(ctx)
  const auth = {
    grant: vi.fn(async () => ({ state: async () => ({ connected: true, sessionVersion: 'fixture-session' }), request: search })),
    revoke: dispose
  }
  ctx.plugin({ inject: ['web'], apply(scoped: Context) {
    scoped.web.registerSearchProvider({ id: 'previous', available: () => true, search: async () => ({ sources: [], content: 'previous result', truncated: false }) })
  } })
  await ctx.fiber.await()
  const files = {
    'node_modules/bs-web-search/package.json': Buffer.from(JSON.stringify({ name: 'bs-web-search', version: '0.1.0', type: 'module', main: './index.js' })),
    'node_modules/bs-web-search/index.js': Buffer.from(source)
  }
  const plugin = { name: 'bs-web-search', version: '0.1.0', display_name: 'Enterprise Search', description: 'Enterprise search', publisher: 'Company', license: 'MIT', desktop_min: '0.9.1', permissions: [], services: [] }
  const manifest = { schema_version: 1, plugin, targets: { [target]: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha256(bytes)])) } }
  const bytes = zipEntries({ 'manifest.json': Buffer.from(JSON.stringify(manifest)), ...Object.fromEntries(Object.entries(files).map(([path, bytes]) => ['bundles/' + target + '/' + path, bytes])) })
  const selected = { id: pluginId, ...plugin, revision: 1, current_version_id: versionId, versions: [{ id: versionId, version: plugin.version, digest: sha256(bytes), manifest }] }
  const request = vi.fn(async (path: string) => {
    if (path.endsWith('/artifact')) return bytes
    if (path.endsWith('/capabilities')) return { status_code: 200, data: { enabled: true, contract_version: 2, tenant_id: '2', sync_seconds: 60 } }
    if (path.includes('/catalog?')) return { status_code: 200, data: { data: [selected], total: 1 } }
    if (path.endsWith('/sync')) {
      return { status_code: 200, data: { tenant_id: '2', user_id: '20', device_id: marketDevice, synced_at: Math.floor(Date.now() / 1000), policies: [{ plugin_id: pluginId, name: 'bs-web-search', revision: 1, disabled: false, current_version_id: versionId, versions: [{ id: versionId, digest: sha256(bytes) }] }] } }
    }
    throw new Error('Unexpected market request: ' + path)
  })
  let marketDevice = ''
  const marketRequest = async (path: string, body?: unknown) => {
    if (path.endsWith('/sync')) marketDevice = (body as { device_id: string }).device_id
    return request(path)
  }
  const market = createMarketController(ctx, { state: () => ({ connected: true, user: { id: '20' }, tenant: { id: '2' }, base: 'https://enterprise.example', desktopVersion: '0.9.2' }), marketRequest }, { home, target, dshEntryPath: hostDshEntryPath(), auth })
  cleanups.push(() => market.stop())
  await market.synchronize()
  return { ctx, market, search, dispose, webEntry, webFiber, profile, request }
}
const install = (market: MarketController, config?: Record<string, unknown>) => market.act({ action: 'install', plugin_id: pluginId, config })

function readConfig(config: object): Record<string, unknown> {
  const plain: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(config)) {
    plain[key] = item !== null && typeof item === 'object' && 'get' in item && typeof item.get === 'function'
      ? item.get()
      : item
  }
  return plain
}

describe('enterprise search market installation', () => {
  it('downloads, validates, activates and selects search; disabling restores the previous provider without persisting transient config', async () => {
    const { ctx, market, search, webEntry, profile, request } = await fixture({ disabledWeb: true })
    const original = await readFile(join(profile, 'cordis.yml'), 'utf8')
    await expect(install(market)).resolves.toMatchObject({ installed: [{ name: 'bs-web-search', status: 'enabled' }] })
    expect(request.mock.calls.some(([path]) => path.endsWith('/artifact'))).toBe(true)
    await expect(ctx.web.search({ query: 'test' })).resolves.toMatchObject({ content: 'enterprise result' })
    expect(search).toHaveBeenCalledOnce()
    expect(search).toHaveBeenCalledWith('/business/search', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ query: 'test' }),
      sessionVersion: 'fixture-session', signal: expect.any(AbortSignal)
    }))
    expect(webEntry.options.config).toMatchObject({ searchProvider: 'previous' })
    expect(await readFile(join(profile, 'cordis.yml'), 'utf8')).toBe(original)
    await market.act({ action: 'disable', plugin_id: pluginId })
    await expect(ctx.web.search({ query: 'test' })).resolves.toMatchObject({ content: 'previous result' })
    await market.act({ action: 'enable', plugin_id: pluginId })
    await expect(ctx.web.search({ query: 'test' })).resolves.toMatchObject({ content: 'enterprise result' })
    await market.act({ action: 'uninstall', plugin_id: pluginId })
    expect(market.state().installed).toEqual([])
    await expect(ctx.web.search({ query: 'test' })).resolves.toMatchObject({ content: 'previous result' })
  })

  it('rolls back selection and installation when required host services are missing', async () => {
    const { ctx, market, webFiber } = await fixture({ bridge: false })
    await expect(install(market)).rejects.toThrow(/enterpriseAuth|dependencies or configuration/)
    expect(market.state().installed).toEqual([])
    expect(readConfig(webFiber.config)).toMatchObject({ searchProvider: 'previous' })
    await expect(ctx.web.search({ query: 'test' })).resolves.toMatchObject({ content: 'previous result' })
  })

  it('preserves later user selection and waits for asynchronous plugin cleanup', async () => {
    const { ctx, market, dispose, webFiber } = await fixture()
    await install(market)
    webFiber.update({ searchProvider: 'previous', fetchProvider: 'changed' }, true)
    await webFiber.await()
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    dispose.mockImplementation(async () => { await gate })
    let stopped = false
    const stopping = market.act({ action: 'disable', plugin_id: pluginId }).then(() => { stopped = true })
    await vi.waitFor(() => expect(dispose).toHaveBeenCalled())
    expect(stopped).toBe(false)
    release?.()
    await stopping
    expect(readConfig(webFiber.config)).toMatchObject({ searchProvider: 'previous', fetchProvider: 'changed' })
    await expect(ctx.web.search({ query: 'test' })).resolves.toMatchObject({ content: 'previous result' })
  })

  it('restores the previous provider when plugin activation fails', async () => {
    const { ctx, market } = await fixture()
    await expect(install(market, { fail: true })).rejects.toThrow()
    expect(market.state().installed).toEqual([])
    await expect(ctx.web.search({ query: 'test' })).resolves.toMatchObject({ content: 'previous result' })
  })
})
