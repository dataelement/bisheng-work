import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { AgentRegistry, assembleContextFor } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { LlmRuntime, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { applyWorkCapabilities } from '../packages/dsh-desktop-enterprise/work-capabilities.js'

const contexts = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const name = 'mcp__bisheng__bisheng_tool_38'
const tool = { name: 'bisheng_tool_38', description: 'Weather fixture', inputSchema: { type: 'object', properties: {} } }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  for (const plugin of [SessionStore, SessionProjectionRegistry, AgentRegistry, SystemPrompt, ToolRuntime, LlmRuntime, AgentLoop]) await ctx.plugin(plugin)
  const requests = []
  class Model extends LlmAdapter {
    async *stream(request) {
      requests.push(request)
      yield { type: 'text-delta', index: 0, text: 'Done' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Model())
  let enabled = true, catalogError, hold, account = { connected: true, connectionKey: 'account-a' }
  let api, route, reads = 0
  const mounted = ctx.plugin({
    inject: ['tools', 'sessions'],
    apply(scoped) {
      api = applyWorkCapabilities({
        tools: scoped.tools, sessions: scoped.sessions, logger: scoped.logger,
        on: scoped.on.bind(scoped), effect: scoped.effect.bind(scoped),
        connection: { fetch: { register(value) { route = value } } }
      }, {
        state: () => account, refreshState: async () => {},
        request: async ({ message }) => {
          if (message.method.startsWith('notifications/')) return null
          let result
          if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          else if (message.method === 'tools/list') {
            reads++
            const snapshot = { tools: enabled ? [tool] : [] }
            if (hold) { const gate = hold; hold = undefined; gate.started.resolve(); await gate.finish.promise }
            if (catalogError) throw new Error(catalogError)
            result = snapshot
          } else throw new Error('Unexpected call: ' + message.method)
          return { jsonrpc: '2.0', id: message.id, result }
        }
      })
    }
  })
  await mounted
  await api.sync()
  let sequence = 0
  const create = options => ctx.agents.create({ sessionId: SessionId('fixture-' + ++sequence), agentOptions: { provider: 'fixture', model: 'test' }, ...options })
  const assemble = handle => ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
  return {
    ctx, api, requests, mounted, create, assemble,
    setEnabled(value) { enabled = value }, setError(value) { catalogError = value },
    logout() { account = { connected: false }; api.clear() },
    reads: () => reads,
    holdNext() { hold = { started: deferred(), finish: deferred() }; return hold },
    refresh: () => route.fetch(new Request('http://localhost/api/enterprise.work-tools', { method: 'POST', body: JSON.stringify({ operation: 'refresh' }) })),
    async send(handle) {
      handle.agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '北京天气' }] }), 'next-turn', true)
      await handle.agent.whenIdle()
    }
  }
}

it('uses the saved availability in the first actual model request of a new session', async () => {
  const f = await fixture()
  expect(f.ctx.tools.schemas().map(tool => tool.name)).toContain(name)
  f.setEnabled(false)
  const handle = await f.create()
  await f.send(handle)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0].tools?.map(tool => tool.name) ?? []).toEqual([])
  f.setEnabled(true)
  await f.send(handle)
  expect(f.requests).toHaveLength(2)
  expect(f.requests[1].tools.map(tool => tool.name)).toContain(name)
})

it('refreshes immediately after save and waits past a pre-save catalog response', async () => {
  const f = await fixture()
  const hold = f.holdNext()
  const background = f.api.sync()
  await hold.started.promise
  f.setEnabled(false)
  const refreshed = f.refresh()
  const handle = await f.create()
  const assembly = f.assemble(handle)
  hold.finish.resolve()
  await background
  expect((await refreshed).status).toBe(200)
  expect((await assembly).tools.map(tool => tool.name)).toEqual([])
  expect(f.ctx.tools.schemas()).toEqual([])
  expect(f.reads()).toBe(3)
})

it('clears stale registrations on catalog failure and retries on the next request', async () => {
  const f = await fixture(), handle = await f.create()
  f.setError('catalog unavailable')
  await expect(f.assemble(handle)).rejects.toThrow('catalog unavailable')
  expect(f.ctx.tools.schemas()).toEqual([])
  f.setError(undefined)
  f.setEnabled(false)
  expect((await f.assemble(handle)).tools).toEqual([])
  f.setEnabled(true)
  expect((await f.assemble(handle)).tools.map(tool => tool.name)).toContain(name)
})

it('discards catalog responses after logout or plugin disposal', async () => {
  for (const action of ['logout', 'dispose']) {
    const f = await fixture(), hold = f.holdNext()
    const pending = f.api.sync()
    const rejected = expect(pending).rejects.toThrow()
    await hold.started.promise
    if (action === 'logout') f.logout()
    else await f.mounted.dispose()
    hold.finish.resolve()
    await rejected
    expect(f.ctx.tools.schemas()).toEqual([])
  }
})

it('preserves scope restrictions and avoids enterprise refresh for child agents', async () => {
  const f = await fixture()
  const parent = await f.create({ setup: async scoped => { scoped.tools.restrict({ allow: [] }) } })
  expect((await f.assemble(parent)).tools).toEqual([])
  const child = await f.create({ parentAgent: parent.agent, meta: { origin: 'subagent', delegationDepth: 1 }, setup: async scoped => {
    scoped.tools.restrict({ allow: [] })
  } })
  const reads = f.reads()
  expect((await f.assemble(child)).tools).toEqual([])
  expect(f.reads()).toBe(reads)
})


it('refreshes on native notifications and releases the listener and pending request on unload', async () => {
  const source = readFileSync('packages/dsh-desktop-enterprise/client.js', 'utf8')
  const ast = ts.createSourceFile('client.js', source, ts.ScriptTarget.Latest, true)
  let binder
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'bindWorkToolChanges') binder = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  let changed
  const unsubscribe = vi.fn(), cancel = vi.fn(), warn = vi.fn()
  const fetch = vi.fn(async () => ({ ok: true, body: { cancel } }))
  const bind = new Function('window', 'fetch', 'AbortController', 'console', binder + '; return bindWorkToolChanges')(
    { dshEnterpriseChat: { onToolsChanged(callback) { changed = callback; return unsubscribe } } }, fetch, AbortController, { warn })
  const dispose = bind()
  expect(fetch).toHaveBeenCalledTimes(0)
  changed()
  await new Promise(resolve => setImmediate(resolve))
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/enterprise.work-tools', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ operation: 'refresh' })
  }))
  expect(cancel).toHaveBeenCalledOnce()
  const firstSignal = fetch.mock.calls[0][1].signal
  fetch.mockRejectedValueOnce(new Error('offline'))
  changed()
  await new Promise(resolve => setImmediate(resolve))
  expect(warn).toHaveBeenCalledOnce()
  dispose()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(firstSignal.aborted).toBe(true)
})

it('runs preparation before tool providers and respects preparation failure and cancellation', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  const order = []
  const plugin = ctx.plugin({
    inject: ['systemPrompt'],
    apply(scoped) {
      scoped.on('system-prompt/prepare', async () => { order.push('prepare'); await Promise.resolve() })
      scoped.systemPrompt.tools(() => { order.push('collect'); return { schemas: [] } })
    }
  })
  await plugin
  await ctx.systemPrompt.assemble()
  expect(order).toEqual(['prepare', 'collect'])
  order.length = 0
  const abort = new AbortController()
  abort.abort()
  await expect(ctx.systemPrompt.assemble({ signal: abort.signal })).rejects.toThrow()
  expect(order).toEqual([])
  await plugin.dispose()
  await ctx.systemPrompt.assemble()
  expect(order).toEqual([])
})
