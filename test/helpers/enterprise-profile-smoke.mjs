import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const [entry, home, fixtureFile] = process.argv.slice(2)
const require = createRequire(join(entry, 'package.json'))
// The isolated copy does not sit beside the running installation. Supply the
// checkout's DSH entry the same way Desktop passes the packaged one.
const dshEntryPath = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js')
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { Loader } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-loader')).href)
const { mountRootInclude } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
const { apply } = await import(pathToFileURL(join(entry, 'index.js')).href)
assert.equal(typeof apply, 'function')
const { PluginManager } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager')).href)
const { createManagedMarketSource, performMarketAction } = await import(pathToFileURL(join(entry, 'managed-market.js')).href)
const { createMarketController } = await import(pathToFileURL(join(entry, 'market.js')).href)
const fixtures = JSON.parse(await readFile(fixtureFile, 'utf8'))
const account = { connected: true, desktopVersion: '0.9.2-test.1', base: 'https://fixture.invalid', tenant: { id: 'tenant' }, user: { id: 'user' } }
let current = fixtures.good, market, source
const ctx = new Context()
const loader = ctx.plugin(Loader, { baseUrl: pathToFileURL(`${home}/`).href })
await loader
ctx.loader.builtins.enterpriseSmoke = { apply(scope) {
  market = createMarketController(scope, { state: () => account, async marketRequest(path, body) {
    let data
    if (path.endsWith('/capabilities')) data = { enabled: true, contract_version: 2, tenant_id: 'tenant', sync_seconds: 60 }
    else if (path.endsWith('/sync')) {
      data = { tenant_id: 'tenant', user_id: 'user', device_id: body.device_id, synced_at: Math.floor(Date.now() / 1000),
        policies: [{ plugin_id: fixtures.pluginId, name: current.name, disabled: false, revision: 1, current_version_id: current.id,
          versions: [fixtures.good, fixtures.bad].map(item => ({ id: item.id, digest: item.digest })) }] }
    } else if (path.endsWith('/artifact')) return Buffer.from(current.bytes, 'base64')
    else data = { total: 1, data: [{ id: fixtures.pluginId, name: current.name, display_name: 'Smoke plugin', current_version_id: current.id, revision: 1,
      versions: [{ id: current.id, version: current.version, digest: current.digest, manifest: current.manifest }] }] }
    return { status_code: 200, data }
  } }, { home, dshEntryPath })
  source = createManagedMarketSource(market)
  scope.provide('profileManagedBundleSource', source)
} }
await writeFile(join(home, 'cordis.yml'), '[]')
await mountRootInclude(ctx, join(home, 'cordis.yml'), [{ insert: [{ id: 'enterprise-owner', name: 'cordis:enterpriseSmoke' }] }])
await ctx.loader.await()
const profile = join(home, 'profiles', 'web')
await mkdir(profile, { recursive: true })
await writeFile(join(profile, 'package.json'), '{"dependencies":{},"dsh":{"profile":{"bundles":[]}}}')
ctx.provide('profileContext', { dir: profile, startedBundles: [], installAnchor: createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json') })
const managerFiber = ctx.plugin(PluginManager, {})
await managerFiber
let changes = 0
ctx.on('plugin-manager/changed', () => { changes++ })
const act = input => performMarketAction(ctx.pluginManager, source, market, input)
try {
  await act({ action: 'install', plugin_id: fixtures.pluginId })
  assert.equal(market.state().installed[0].status, 'enabled')
  await act({ action: 'disable', plugin_id: fixtures.pluginId })
  assert.equal(market.state().installed[0].status, 'disabled')
  await act({ action: 'enable', plugin_id: fixtures.pluginId })
  current = fixtures.bad
  await assert.rejects(act({ action: 'install', plugin_id: fixtures.pluginId }), /smoke bad update/)
  assert.equal(market.state().installed[0].version, fixtures.good.version)
  assert.equal(market.state().installed[0].status, 'enabled')
  const mounted = [...ctx.loader.entries()].filter(row => row.options.name.includes('company-demo/index.js'))
  assert.equal(mounted.length, 1)
  const changesBeforeStop = changes
  await market.stop()
  assert.ok(changes > changesBeforeStop, 'account stop publishes manager inventory changes')
  assert.equal([...ctx.loader.entries()].filter(row => row.options.name.includes('company-demo/index.js')).length, 0)
  console.log(JSON.stringify({ isolatedImport: 'PASS', managerLifecycle: 'PASS', install: 'PASS', disableEnable: 'PASS', failedUpdateRollback: 'PASS', stop: 'PASS', platform: process.platform }))
} finally { await market.stop(); await managerFiber.dispose(); await loader.dispose() }
