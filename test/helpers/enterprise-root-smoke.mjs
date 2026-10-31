import assert from 'node:assert/strict'
import { mkdir, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { mountRootInclude, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { createMarketRuntime } from '../../packages/dsh-desktop-enterprise/market-runtime.js'
import { applyEnterpriseAuth } from '../../packages/dsh-desktop-enterprise/enterprise-auth.js'

const home = await realpath(process.argv[2])
const directory = join(home, 'generation')
const root = join(directory, 'node_modules/company-demo')
await mkdir(root, { recursive: true })
await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'company-demo', type: 'module', exports: { '.': { types: './index.d.ts', import: './index.js' }, './extra': { import: './extra.js' }, './client': './client.js' }, dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }))
await writeFile(join(root, 'client.js'), 'export {}')
await writeFile(join(root, 'index.js'), `import 'company-demo/extra'; export function apply(ctx, config) { if (!config.guarded) throw new Error("bundle name assertion was lost"); ctx.enterpriseAuth.getState(); globalThis.enterpriseContexts.push(ctx) }`)
await writeFile(join(root, 'extra.js'), 'export function apply() {}')
await writeFile(join(root, 'cordis.patch.yml'), '- id: compaction-basic\n  disabled: true\n- insert:\n    - id: compaction-acp\n      name: company-demo\n    - name: cordis:noop\n- id: compaction-acp\n  name: company-demo\n  config:\n    guarded: true\n')
await writeFile(join(home, 'cordis.yml'), '[]')
globalThis.enterpriseContexts = []
const ctx = new Context()
const loader = ctx.plugin(Loader, { baseUrl: pathToFileURL(`${home}/`).href })
await loader
applyEnterpriseAuth(ctx)
ctx.loader.builtins.noop = { apply() {} }
ctx.loader.builtins.host = { apply(scope) { assert.throws(() => scope.enterpriseAuth.getState(), /not authorized/) } }
let runtimeContext, activeOnOwner
ctx.loader.builtins.owner = { apply(scope) { runtimeContext = scope; scope.effect(() => () => activeOnOwner?.dispose(), 'fixture cleanup') } }
const base = [{ insert: [{ id: 'compaction-basic', name: 'cordis:host' }, { id: 'owner', name: 'cordis:owner' }] }]
await mountRootInclude(ctx, join(home, 'cordis.yml'), base)
await ctx.loader.await()
const entry = id => [...ctx.loader.entries()].find(row => row.options.id === id)
let revoked = 0
const runtime = createMarketRuntime(runtimeContext, {
  async grant() { return { async state() { return { connected: true, sessionVersion: '1' } }, async request() { return new Response('ok') } } },
  async revoke() { revoked++ }
})
const record = { name: 'company-demo', plugin_id: 'company', directory }
try {
  const running = await runtime(record)
  assert.equal(running.state, 2)
  assert.equal(entry('compaction-basic').options.disabled, true)
  assert.equal(entry('compaction-acp').options.id, 'compaction-acp')
  assert.equal(entry('compaction-acp').parent, entry('compaction-basic').parent)
  const clientFiber = ctx.plugin(ClientModuleRegistry)
  await clientFiber
  assert.equal(ctx.clientModules.resolveMeta(entry('compaction-acp').options.name, pathToFileURL(`${home}/`).href).meta.clientPath, join(root, 'client.js'))
  const graph = ctx.clientModules.graph()
  const clientRow = graph.entries.find(row => row.id === 'company-demo')
  assert.ok(clientRow)
  const response = await ctx.clientModules.fetchBundle(new Request(new URL(clientRow.url, 'http://fixture.invalid')))
  assert.equal(response.status, 200)
  const secondRoot = join(home, 'second/node_modules/second-demo')
  await mkdir(join(secondRoot, 'node_modules/private-dep'), { recursive: true })
  await writeFile(join(secondRoot, 'package.json'), JSON.stringify({ name: 'second-demo', type: 'module', exports: { '.': { import: './index.js' } } }))
  await writeFile(join(secondRoot, 'index.js'), 'import value from "private-dep"; export function apply() { if (value !== 42) throw new Error("private dependency missing") }')
  await writeFile(join(secondRoot, 'node_modules/private-dep/package.json'), '{"main":"index.js"}')
  await writeFile(join(secondRoot, 'node_modules/private-dep/index.js'), 'module.exports = 42')
  const second = await runtime({ name: 'second-demo', plugin_id: 'second', directory: join(home, 'second') })
  assert.equal(second.state, 2)
  const old = globalThis.enterpriseContexts.at(-1)
  assert.equal(await (await old.enterpriseAuth.request('/fixture')).text(), 'ok')
  assert.throws(() => ctx.enterpriseAuth.getState(), /not authorized/)
  const edited = [...base, { insert: [{ id: 'user-extra', name: 'cordis:host' }] }]
  await reconcileProfilePatches(ctx, edited, 'test')
  assert.equal(entry('compaction-acp').fiber.state, 2)
  await running.dispose()
  assert.equal(entry('compaction-basic').fiber.state, 2)
  assert.equal(entry('user-extra').fiber.state, 2)
  assert.equal(entry('compaction-acp'), undefined)
  assert.equal(second.state, 2)
  await second.dispose()
  assert.throws(() => old.enterpriseAuth.getState(), /not authorized/)
  const again = await runtime(record)
  assert.throws(() => old.enterpriseAuth.getState(), /not authorized/)
  assert.equal(again.state, 2)
  await again.dispose()
  // A distinct generation prevents module caching from hiding an activation failure.
  const badRoot = join(home, 'bad/node_modules/bad-demo')
  await mkdir(badRoot, { recursive: true })
  await writeFile(join(badRoot, 'package.json'), JSON.stringify({ name: 'bad-demo', type: 'module', exports: { '.': { import: './index.js' } }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(badRoot, 'index.js'), 'export function apply() { throw new Error("bad root activation") }')
  await writeFile(join(badRoot, 'cordis.patch.yml'), '- id: compaction-basic\n  disabled: true\n- insert:\n    - id: bad\n      name: bad-demo\n')
  await assert.rejects(runtime({ name: 'bad-demo', plugin_id: 'bad', directory: join(home, 'bad') }), /bad root activation/)
  assert.equal(entry('compaction-basic').fiber.state, 2)
  assert.equal(entry('bad'), undefined)
  const missingRoot = join(home, 'missing/node_modules/missing-demo')
  await mkdir(missingRoot, { recursive: true })
  await writeFile(join(missingRoot, 'package.json'), '{"name":"missing-demo","type":"module","exports":{".":{"import":"./index.js"}}}')
  await writeFile(join(missingRoot, 'index.js'), 'import "@deepseek-ai/nonexistent-fixture-peer"; export function apply() {}')
  await assert.rejects(runtime({ name: 'missing-demo', plugin_id: 'missing', directory: join(home, 'missing') }), /@deepseek-ai\/nonexistent-fixture-peer/)
  assert.equal(entry('enterprise-missing'), undefined)
  assert.equal(revoked, 5)
  activeOnOwner = await runtime(record)
  await reconcileProfilePatches(ctx, [{ insert: [{ id: 'compaction-basic', name: 'cordis:host' }] }], 'owner-disposal')
  // Await the queued restoration requested from inside the owner's disposer.
  await ctx.profileRuntimeLayers.remove('queue-barrier')
  assert.equal(entry('compaction-acp'), undefined)
  assert.equal(entry('compaction-basic').fiber.state, 2)
  assert.equal(revoked, 6)
  console.log('PASS')
} finally { await loader.dispose() }
