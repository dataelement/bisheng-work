import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
// Match the synchronous observable contract used by model catalog and projection stores.
function createSnapshotStore(value) {
  const listeners = new Set()
  const store = {
    getSnapshot: () => value,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { value = next; for (const fn of [...listeners]) fn() },
    update(fn) { const next = { ...value }; fn(next); store.set(next) }
  }
  return store
}
const modelSource = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-model-selection/client'), 'utf8')
const jsx = (type, props) => ({ type, props })
const react = {
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  useState: value => [value, () => {}], useRef: value => ({ current: value }),
  useMemo: fn => fn(), useEffect() {}, useLayoutEffect() {}, useId: () => 'test-model'
}
let modelClient
vm.runInNewContext(modelSource.replace('exports.apply = apply;', 'exports.ModelSelect = ModelSelect; exports.optionsOf = optionsOf; exports.zh = zh; exports.en = en; exports.apply = apply;'), {
  window: { __ModuleLoader__: { load({ factory }) {
    modelClient = factory(id => ({
      react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-dom': {},
      '@deepseek-ai/cordis': { Service: class {} },
      '@deepseek-ai/dsh-client-store': { createSnapshotStore },
      '@deepseek-ai/dsh-client-ui-primitives': { rankByName: models => models }
    })[id])
  } } }
})
const enterprise = 'bisheng-enterprise'
const old = { provider: enterprise, model: 'bisheng:2', reasoningEffort: 'high' }
const replacement = { provider: enterprise, model: 'bisheng:3' }
const group = (id, models) => ({ id, name: id, models: models.map(model => typeof model === 'string' ? { id: model, name: `Name ${model}` } : model) })
const catalogValue = (groups, fallback = old, failures = []) => ({ default: fallback, groups, failures })
const initial = catalogValue([group(enterprise, ['bisheng:2', 'bisheng:3'])])

function fixture(value = initial, selected = old, available = true) {
  const projected = createSnapshotStore({ next: selected, lastUsed: selected })
  const catalog = {
    store: createSnapshotStore({ value, status: 'ready', error: null }),
    reasoningFor(selection) { return this.store.getSnapshot().value?.groups.find(g => g.id === selection.provider)?.models.find(m => m.id === selection.model)?.reasoning },
    async load() { return this.store.getSnapshot().value }
  }
  const selectModel = vi.fn(async ({ sessionId: _id, ...selection }) => {
    projected.set({ next: selection, lastUsed: old })
    return { ok: true, value: { selected: selection } }
  })
  const directory = new modelClient.ModelDirectory({ selectModel }, 'session-1', () => available, catalog, projected, () => false)
  const publish = (value, status = 'ready') => catalog.store.set({ value, status, error: null })
  return { directory, catalog, projected, selectModel, publish }
}

function caption(directory, locale = 'zh') {
  const dictionary = modelClient[locale]
  const tree = modelClient.ModelSelect({ locked: false, available: true, directory: directory.store, load() {}, select() {}, renderSlot: (_name, _props, options) => options?.fallback ?? null, t: (key, args = {}) => dictionary[key].replace(/\{(\w+)\}/g, (_match, name) => args[name]) })
  const flatten = node => typeof node === 'string' ? [node] : Array.isArray(node) ? node.flatMap(flatten) : node?.props ? flatten(node.props.children) : []
  return flatten(tree).join(' ')
}

describe('model catalog revocation', () => {
  it('keeps a selection that is still authorized', async () => {
    const f = fixture()
    await f.directory.load()
    expect(f.selectModel).not.toHaveBeenCalled()
    expect(f.directory.store.getSnapshot()).toMatchObject({ current: old, routable: true })
    expect(caption(f.directory)).toContain('Name bisheng:2')
  })

  it('updates the selected caption when the administrator renames a stable model route', async () => {
    const f = fixture(catalogValue([group(enterprise, [{ id: old.model, name: '阿里云百炼 / qwen-max' }])]))
    await f.directory.load()
    expect(caption(f.directory)).toContain('阿里云百炼 / qwen-max')
    f.publish(catalogValue([group(enterprise, [{ id: old.model, name: '阿里云百炼 / 1111' }])]))
    await f.directory.load()
    expect(caption(f.directory)).toContain('阿里云百炼 / 1111')
    expect(f.directory.store.getSnapshot().current).toEqual(old)
    expect(f.selectModel).toHaveBeenCalledTimes(0)
  })

  it('replaces a revoked session model and uses the replacement reasoning default', async () => {
    const f = fixture()
    f.publish(catalogValue([group(enterprise, [{ id: 'bisheng:3', name: 'Authorized model', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }] } }])]))
    await f.directory.load()
    expect(f.selectModel).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', ...replacement, reasoningEffort: 'low' })
    expect(f.directory.store.getSnapshot()).toMatchObject({ current: { ...replacement, reasoningEffort: 'low' }, routable: true, pending: null })
    expect(caption(f.directory)).toContain('Authorized model')
    expect(caption(f.directory)).not.toContain('bisheng-enterprise/bisheng:2')
  })

  it('prefers an available configured default, then same provider, then another provider', async () => {
    for (const [value, expected] of [
      [catalogValue([group(enterprise, ['bisheng:3']), group('other', ['a'])], { provider: 'other', model: 'a' }), { provider: 'other', model: 'a' }],
      [catalogValue([group('other', ['a']), group(enterprise, ['bisheng:3'])]), replacement],
      [catalogValue([group('other', ['a'])]), { provider: 'other', model: 'a' }]
    ]) {
      const f = fixture(value)
      await f.directory.load()
      expect(f.directory.store.getSnapshot()).toMatchObject({ current: expected, routable: true })
    }
  })

  it('repairs a restored session and a new session with a stale default', async () => {
    for (const next of [old, null]) {
      const f = fixture(catalogValue([group(enterprise, ['bisheng:3'])]), next)
      await f.directory.load()
      expect(f.directory.store.getSnapshot().current).toEqual(replacement)
    }
  })

  it('renders the empty state, retains history, and recovers after authorization returns', async () => {
    const f = fixture()
    f.publish(catalogValue([]))
    await f.directory.load()
    expect(f.selectModel).not.toHaveBeenCalled()
    expect(f.projected.getSnapshot().lastUsed).toEqual(old)
    expect(caption(f.directory)).toContain('暂无可用模型')
    expect(caption(f.directory, 'en')).toContain('No models available')
    expect(caption(f.directory)).not.toContain('high')
    f.publish(catalogValue([group(enterprise, ['bisheng:3'])]))
    await f.directory.load()
    expect(f.directory.store.getSnapshot().current).toEqual(replacement)
  })

  it('retains selection while loading and when the selected provider catalog fails', async () => {
    const f = fixture()
    f.publish(catalogValue([]), 'loading')
    expect(f.selectModel).not.toHaveBeenCalled()
    f.publish(catalogValue([group('other', ['a'])], old, [{ id: enterprise, name: 'Enterprise', message: 'timeout' }]))
    await f.directory.load()
    expect(f.selectModel).not.toHaveBeenCalled()
    expect(caption(f.directory)).toContain('请选择可用模型')
    expect(caption(f.directory)).not.toContain('暂无可用模型')
  })

  it('coalesces recovery and waits for the host to confirm it', async () => {
    const f = fixture()
    let settle
    f.selectModel.mockImplementation(() => new Promise(resolve => { settle = resolve }))
    f.publish(catalogValue([group(enterprise, ['bisheng:3'])]))
    const loaded = vi.fn()
    const pending = f.directory.load().then(loaded)
    f.projected.set({ next: old, lastUsed: old })
    await Promise.resolve()
    expect(loaded).not.toHaveBeenCalled()
    expect(f.selectModel).toHaveBeenCalledTimes(1)
    f.projected.set({ next: replacement, lastUsed: old })
    settle({ ok: true, value: { selected: replacement } })
    await pending
    expect(loaded).toHaveBeenCalledWith(expect.objectContaining({ current: replacement, pending: null, routable: true }))
  })

  it.each(['rejected', 'transport'])('retains recoverable %s failures without retry loops', async failure => {
    const f = fixture()
    f.selectModel.mockImplementation(async () => {
      if (failure === 'transport') throw new Error('offline')
      return { ok: false, error: { code: 'session/model-unavailable', message: 'revoked' } }
    })
    f.publish(catalogValue([group(enterprise, ['bisheng:3'])]))
    await f.directory.load()
    await f.directory.load()
    expect(f.selectModel).toHaveBeenCalledTimes(1)
    expect(f.directory.store.getSnapshot()).toMatchObject({ status: 'error', pending: null, routable: false })
    expect(f.directory.store.getSnapshot().error).toMatch(/offline|revoked/)
  })

  it('preserves a later manual selection over an earlier automatic response', async () => {
    const f = fixture()
    let settle
    f.selectModel.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
    f.publish(catalogValue([group(enterprise, ['bisheng:3', 'bisheng:4'])]))
    await f.directory.select({ provider: enterprise, model: 'bisheng:4' })
    settle({ ok: true, value: { selected: replacement } })
    await f.directory.load()
    expect(f.directory.store.getSnapshot().current.model).toBe('bisheng:4')
  })

  it('isolates addressed subagents and disposed sessions', async () => {
    const addressed = fixture(catalogValue([group(enterprise, ['bisheng:3'])]), old, false)
    expect(addressed.selectModel).not.toHaveBeenCalled()
    const f = fixture()
    f.directory.dispose()
    f.publish(catalogValue([group(enterprise, ['bisheng:3'])]))
    expect(f.selectModel).not.toHaveBeenCalled()
  })
})

// Run the actual submission boundary with the same shared ModelDirectory used by the selector.
const conversationSource = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8')
const hubSource = conversationSource.slice(conversationSource.indexOf('var InputHub = class'), conversationSource.indexOf('\n\t\t//#endregion', conversationSource.indexOf('var InputHub = class')))
const InputHub = vm.runInNewContext(`${hubSource}; InputHub`)
function input(f) {
  const sendSession = vi.fn(async () => ({ kind: 'success' }))
  const services = { modelDirectories: { directoryFor: () => f.directory }, conversation: { sendSession } }
  const hub = new InputHub({ get: name => services[name] }, key => key)
  const session = { sessionId: 'session-1', getSnapshot: () => ({ subagent: null }) }
  return { sendSession, send: signal => hub.sink(session, 'Keep this draft', ['image-1'], 'queue', signal) }
}
it('sends through the confirmed replacement and preserves attachments', async () => {
  const f = fixture(catalogValue([group(enterprise, ['bisheng:3'])]))
  const i = input(f)
  expect(await i.send()).toEqual({ kind: 'success' })
  expect(i.sendSession).toHaveBeenCalledWith(expect.anything(), 'Keep this draft', ['image-1'], 'queue', undefined)
  expect(f.directory.store.getSnapshot().current).toEqual(replacement)
})
it('returns an actionable empty-catalog error before submitting the draft', async () => {
  const f = fixture(catalogValue([]))
  const i = input(f)
  expect(await i.send()).toEqual({ kind: 'error', text: 'model.empty' })
  expect(i.sendSession).not.toHaveBeenCalled()
})
it('preserves cancellation while model recovery is in flight', async () => {
  const f = fixture()
  let settle
  f.selectModel.mockImplementation(() => new Promise(resolve => { settle = resolve }))
  f.publish(catalogValue([group(enterprise, ['bisheng:3'])]))
  const i = input(f)
  const abort = new AbortController()
  const pending = i.send(abort.signal)
  abort.abort()
  f.projected.set({ next: replacement, lastUsed: old })
  settle({ ok: true, value: { selected: replacement } })
  await expect(pending).rejects.toThrow()
  expect(i.sendSession).not.toHaveBeenCalled()
})

// Display fallback applies to trigger, menu/search names, tooltips and /model rows.
it.each([undefined, '', '   ', 'bisheng:2', 'bisheng-enterprise/bisheng:2'])('shows a localized caption for enterprise display name %s', async name => {
  const f = fixture(catalogValue([group(enterprise, [{ id: old.model, name }])]))
  await f.directory.load()
  expect(caption(f.directory)).toContain('企业模型 1')
  expect(caption(f.directory, 'en')).toContain('Enterprise model 1')
  const rows = modelClient.optionsOf(f.directory.store.getSnapshot(), (key, args = {}) => modelClient.zh[key].replace(/\{(\w+)\}/g, (_match, name) => args[name]))
  expect(rows[0]).toMatchObject({ id: 'bisheng-enterprise/bisheng:2', label: '企业模型 1' })
  expect(f.directory.store.getSnapshot().current).toEqual(old)
})
it('keeps administrator display names and distinguishes unnamed enterprise models', async () => {
  const f = fixture(catalogValue([group(enterprise, [{ id: old.model, name: '  DeepSeek V3  ' }, { id: 'bisheng:3', name: 'bisheng:3' }, { id: 'bisheng:4', name: '' }])]))
  await f.directory.load()
  expect(caption(f.directory)).toContain('DeepSeek V3')
  const rows = modelClient.optionsOf(f.directory.store.getSnapshot(), (key, args = {}) => modelClient.zh[key].replace(/\{(\w+)\}/g, (_match, name) => args[name]))
  expect(rows.map(row => row.label)).toEqual(['DeepSeek V3', '企业模型 2', '企业模型 3'])
})
