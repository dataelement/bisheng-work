import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import * as connectionPlugin from '@deepseek-ai/dsh-client-connection'
import { CookieJar, JSDOM } from 'jsdom'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { FileUploads } from '@deepseek-ai/dsh-client-file-upload'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import * as enterprise from '../packages/dsh-desktop-enterprise/index.js'
import { CONTENT_SAFETY_ERROR_COPY } from '../packages/dsh-desktop-enterprise/error-copy.js'

// Coverage AC: AC-30, AC-31, AC-56.
// This exercises real authenticated Connection dispatch and the registered adapter.
// The direct fixture is not Session/Agent or native GUI coverage. Queued cases
// separately mount the actual public SessionController and Agent runtime; their
// authenticated Fetch route is not the generated Remote RPC carrier or full app.
const root = resolve(import.meta.dirname, '..')
const tenantReply = 'Synthetic tenant policy reply Ω.'
const localeSources = await Promise.all([
  'node_modules/@deepseek-ai/dsh-client-locale/lib/client.js',
  'packages/dsh-desktop-enterprise/client.js'
].map(file => readFile(join(root, file), 'utf8')))
let fixture

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function close(server) {
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function createFixture({ queueProtocol } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-safety-locale-'))
  await mkdir(join(home, 'profile'))
  vi.stubEnv('DSH_HOME', home)
  const received = [], turnEnds = [], inboxMessages = [], publicOrder = []
  let releaseFirst, firstStarted
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const started = new Promise(resolve => { firstStarted = resolve })
  let handle
  const account = {
    connected: true, secureStorageAvailable: true, phase: 'connected', revision: 1,
    connectionKey: '1234567890abcdef', desktopVersion: '1.0.1', base: 'https://synthetic.invalid',
    tenant: { id: '101', name: 'Synthetic tenant' }, user: { id: '11', display_name: 'Synthetic user' },
    modelsAvailable: true, models: [
      { id: 'bisheng:42', display_name: 'Synthetic Chat', capabilities: { streaming: true, tools: true } },
      { id: 'bisheng:43', display_name: 'Synthetic Responses', capabilities: { streaming: true, tools: true, responses: true },
        reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }
    ]
  }
  const broker = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/state') return response.end(JSON.stringify(account))
    // Model admission now refreshes the enterprise tool catalog before assembly.
    // This content-safety fixture has an authenticated account and an empty catalog.
    if (request.url === '/v1/work-mcp') {
      const message = input.message
      if (message.method.startsWith('notifications/')) return response.end('null')
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [] }
      return response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    }
    if (request.url === '/v1/chat' || request.url === '/v1/responses') {
      received.push({ path: request.url, headers: request.headers, body: input })
      if (queueProtocol && received.length === 1) {
        firstStarted()
        await firstGate
        response.setHeader('content-type', 'text/event-stream')
        return response.end(safeFirstResponse(queueProtocol))
      }
      const text = JSON.stringify(input.request)
      const unavailable = text.includes('unavailable')
      const message = unavailable ? (request.url === '/v1/chat' ? 'Content safety check unavailable' : 'Content check unavailable')
        : text.includes('tenant') ? tenantReply : undefined
      // Keep several requests in flight to expose a process-global last-locale implementation.
      await new Promise(resolve => setTimeout(resolve, text.includes('slow') ? 20 : 1))
      response.writeHead(unavailable ? 503 : 403, { 'x-request-id': 'synthetic-backend-id' })
      return response.end(JSON.stringify({
        error: { code: unavailable ? 'check_unavailable' : 'content_blocked', ...(message ? { message } : {}) },
        request_id: 'synthetic-gateway-id'
      }))
    }
    if (request.url === '/v1/market') return response.end(JSON.stringify({
      status_code: 200, data: { enabled: false, contract_version: 2, tenant_id: '101', sync_seconds: 60 }
    }))
    response.end(JSON.stringify({ ok: true }))
  })
  const brokerOrigin = await listen(broker)
  vi.stubEnv('DSH_DESKTOP_ENTERPRISE_BROKER_URL', brokerOrigin)
  vi.stubEnv('DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY', 'synthetic-private-test-owner')
  const context = new Context()
  const routes = [], adapters = [], records = new Map(), renderers = []
  context.provide('credentials', { async modifyRecord(key, update) {
    const next = await update(records.get(key))
    if (next) records.set(key, next)
    return records.get(key)
  } })
  context.provide('webServer', { register(route) {
    routes.push(route)
    return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1) }
  } })
  if (!queueProtocol) context.provide('llm', { registerAdapter(_providers, adapter) {
    adapters.push(adapter)
    const dispose = () => { const index = adapters.indexOf(adapter); if (index >= 0) adapters.splice(index, 1) }
    dispose.replace = () => {}
    return dispose
  } })
  await context.plugin(Loader, { baseUrl: pathToFileURL(join(home, 'profile') + '/').href })
  await context.plugin(connectionPlugin)
  if (queueProtocol) {
    for (const plugin of [SessionStore, SessionProjectionRegistry, AgentRegistry, SystemPrompt, ToolRuntime, LlmRuntime, AgentLoop]) {
      await context.plugin(plugin)
    }
    context.on('session/event', (_session, event) => { if (event.type === 'turn/end') turnEnds.push(event.data) })
    context.on('agent/inbox/inserted', ({ message }) => {
      inboxMessages.push(message)
      publicOrder.push(['inserted', message.id])
    })
    context.on('agent/inbox/claimed', ({ message, turn }) => publicOrder.push(['claimed', message.id, turn]))
  }
  await context.plugin(enterprise)
  if (queueProtocol) {
    const route = { provider: 'bisheng-enterprise', model: queueProtocol === 'RESPONSES' ? 'bisheng:43' : 'bisheng:42' }
    await expect.poll(async () => { try { await context.llm.resolveCallConfig(route); return true } catch { return false } }).toBe(true)
    handle = await context.agents.create({
      sessionId: SessionId('synthetic-queued-session'), meta: { cwd: home }, agentOptions: route
    })
    await context.plugin(AttachmentStore)
    // Plain-text receipt binding is real. These unused controller capability
    // ports only allow its public registration; they perform no Agent behavior.
    context.provide('commands', { registerFileReceiptResolver() { return () => {} } })
    await context.plugin(FileUploads)
    context.provide('agentDefaultModel', { currentSelection() { return route } })
    context.provide('fs', {})
    context.provide('remoteAccess', {})
    context.provide('sessionQuery', {})
    await context.plugin(TypertRegistry)
    context.provide('workspaceRegistry', { archivedSessionIds: [] })
    await context.plugin(SessionController, { nativeOpen: false })
    context.connection.fetch.register({
      path: '/api/synthetic-queued-content-safety', methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        const { scenario } = await request.json()
        return Response.json(await context.sessionController.prompt({
          requestId: scenario, sessionId: handle.agent.id, mode: 'queue',
          content: [{ type: 'text', text: scenario }]
        }, new AbortController().signal))
      }
    })
  } else await expect.poll(() => adapters.length).toBe(1)
  context.connection.fetch.register({
    path: '/api/synthetic-content-safety', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const input = await request.json(), chunks = []
      let thrown
      try {
        for await (const chunk of adapters[0].stream({
          provider: 'bisheng-enterprise', model: input.protocol === 'RESPONSES' ? 'bisheng:43' : 'bisheng:42',
          sessionId: 'synthetic-locale-session',
          messages: [{ role: 'user', content: [{ type: 'text', text: input.scenario }] }]
        })) chunks.push(chunk)
      } catch (error) { thrown = error.failure }
      return Response.json({ failure: thrown ?? chunks.findLast(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error')?.reason.failure })
    }
  })
  const host = createServer(async (request, response) => {
    try {
      if (request.url === '/' || request.url.startsWith('/?')) {
        if (context.connection.authorizeIndex(request, response)) response.end('<html></html>')
        return
      }
      const route = routes.find(route => route.kind === 'prefix' && request.url.startsWith(route.path)
        || route.kind === 'exact' && request.url === route.path)
      if (route) await route.handler(request, response)
      else { response.writeHead(404); response.end() }
    } catch { response.writeHead(500); response.end('Synthetic fixture request failed') }
  })
  const origin = await listen(host)
  const login = await fetch(context.connection.authenticatedUrl(origin + '/'), { redirect: 'manual' })
  expect(login.status).toBe(303)
  const authCookie = login.headers.get('set-cookie').split(';')[0]
  const name = 'dshEnterpriseSafetyLocale_' + encodeURIComponent(new URL(origin).host.toLowerCase())
  const createRenderer = async ({ jar = new CookieJar(), durableHost, languages = ['zh-CN'], existingJapanese = false } = {}) => {
    const dom = new JSDOM('<html><head></head><body></body></html>', { url: origin, cookieJar: jar })
    dom.window.document.cookie = authCookie
    const definitions = new Map()
    dom.window.__ModuleLoader__ = { load: definition => definitions.set(definition.id, definition) }
    const realm = {
      window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
      Date, AbortController, CustomEvent: dom.window.CustomEvent, console,
      fetch: (url, init = {}) => fetch(new URL(url, origin), { ...init, headers: { ...init.headers, cookie: dom.window.document.cookie } })
    }
    for (const source of localeSources) runInNewContext(source, realm)
    const exported = definitions.get('@deepseek-ai/dsh-client-locale').factory(name =>
      name === 'react' ? React : name === 'react/jsx-runtime' ? jsx : {})
    const renderer = new Context()
    const locale = new exported.LocaleRuntime(renderer, durableHost, { languages, preference: null })
    if (existingJapanese) locale.addLanguage({ id: 'ja', label: 'Existing Japanese pack', fallback: 'en' })
    renderer.provide('locale', locale)
    renderer.provide('slots', { inject(_name, callback) { return callback() }, register() { return () => {} } })
    const client = definitions.get('dsh-desktop-enterprise').factory(name => {
      if (name === 'react') return React
      throw new Error('Unexpected client dependency: ' + name)
    })
    let fiber
    const activate = async () => { fiber = renderer.plugin(client); await fiber }
    await activate()
    const instance = { locale, dom, renderer, activate, async deactivate() { await fiber.dispose() }, cookie() { return dom.window.document.cookie } }
    renderers.push(instance)
    return instance
  }
  return {
    createRenderer, name, authCookie, received, adapters, turnEnds, inboxMessages, publicOrder,
    firstStarted: started, releaseFirst,
    async whenIdle() { await handle.agent.whenIdle() },
    async enqueue(cookie, scenario) {
      const response = await fetch(origin + '/api/synthetic-queued-content-safety', {
        method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ scenario })
      })
      expect(response.status).toBe(200)
      return response.json()
    },
    async invoke(cookie, scenario = 'blocked', protocol = 'CHAT') {
      const response = await fetch(origin + '/api/synthetic-content-safety', {
        method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ scenario, protocol })
      })
      return { status: response.status, ...(response.ok ? await response.json() : {}) }
    },
    async dispose() {
      releaseFirst()
      if (handle) { await handle.agent.whenIdle(); await handle.dispose() }
      for (const instance of renderers.reverse()) { await instance.renderer.fiber.dispose(); instance.dom.window.close() }
      await context.fiber.dispose()
      await Promise.all([close(host), close(broker)])
      await rm(home, { recursive: true, force: true })
    }
  }
}

function safeFirstResponse(protocol) {
  const text = 'Safe first response'
  if (protocol === 'CHAT') return 'data: ' + JSON.stringify({
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }]
  }) + '\n\ndata: [DONE]\n\n'
  const item = { id: 'synthetic-first-message', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] }
  const events = [
    { type: 'response.created', response: { id: 'synthetic-first-response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'synthetic-first-response', status: 'completed', output: [item] } }
  ]
  return events.map((event, sequence_number) => 'event: ' + event.type + '\ndata: ' +
    JSON.stringify({ ...event, sequence_number }) + '\n\n').join('')
}

beforeEach(async () => { fixture = await createFixture() })
afterEach(async () => { try { await fixture?.dispose() } finally { fixture = undefined; vi.unstubAllEnvs() } })

function expected(code, language) { return CONTENT_SAFETY_ERROR_COPY[code][language] }
function encoded(messages, owner = '16e16958-4444-4444-8444-444444444444') { return encodeURIComponent(JSON.stringify({ owner, messages })) }

describe('enterprise content-safety current-locale entry', () => {
  it('uses the real no-preference browser locale before a durable selection exists', async () => {
    const renderer = await fixture.createRenderer()
    expect(renderer.locale.getSnapshot().active).toBe('zh')
    expect((await fixture.invoke(renderer.cookie())).failure).toMatchObject({
      code: 'CONTENT_FILTERED', message: expected('CONTENT_FILTERED', 'zh'), requestId: 'synthetic-gateway-id'
    })
    expect(fixture.adapters).toHaveLength(1)
    expect(fixture.received).toHaveLength(1)
    expect(fixture.received.every(entry => !entry.headers.cookie && !JSON.stringify(entry.body).includes('CONTENT_FILTERED'))).toBe(true)
  })

  it.each(['CHAT', 'RESPONSES'])('%s follows selectable zh/en and preserves tenant messages', async protocol => {
    const renderer = await fixture.createRenderer()
    expect(renderer.locale.getSnapshot().locales.map(locale => locale.id)).toEqual(['zh', 'en'])
    for (const language of ['zh', 'en']) {
      renderer.locale.setLocale(language)
      for (const [scenario, code] of [['blocked', 'CONTENT_FILTERED'], ['unavailable', 'CONTENT_CHECK_UNAVAILABLE']]) {
        expect((await fixture.invoke(renderer.cookie(), scenario, protocol)).failure).toMatchObject({
          code, message: expected(code, language), requestId: 'synthetic-gateway-id'
        })
      }
      expect((await fixture.invoke(renderer.cookie(), 'tenant', protocol)).failure.message).toBe(tenantReply)
    }
    expect(new Set(fixture.received.map(entry => entry.path))).toEqual(new Set([protocol === 'CHAT' ? '/v1/chat' : '/v1/responses']))
    expect(fixture.adapters).toHaveLength(1)
  })

  it('publishes active selection synchronously while Host preference persistence is unresolved', async () => {
    const writes = []
    const durableHost = { subscribe() { return () => {} }, getSnapshot() { return { value: {} } }, set(key, value) { writes.push([key, value]); return new Promise(() => {}) } }
    const renderer = await fixture.createRenderer({ durableHost, existingJapanese: true })
    expect(writes).toHaveLength(0)
    renderer.locale.setLocale('ja')
    expect((await fixture.invoke(renderer.cookie())).failure.message).toBe(expected('CONTENT_FILTERED', 'ja'))
    expect(writes).toEqual([['preference', 'ja']])
  })

  it('keeps concurrent authenticated requests in separate locale contexts', async () => {
    const renderers = await Promise.all(['zh', 'en', 'ja'].map(async language => {
      const renderer = await fixture.createRenderer({ existingJapanese: language === 'ja' })
      renderer.locale.setLocale(language)
      return { renderer, language }
    }))
    const results = await Promise.all([...renderers, ...renderers].map(async ({ renderer, language }, index) => ({
      language, result: await fixture.invoke(renderer.cookie(), index % 2 ? 'slow blocked' : 'blocked', index % 2 ? 'RESPONSES' : 'CHAT')
    })))
    for (const { language, result } of results) expect(result.failure.message).toBe(expected('CONTENT_FILTERED', language))
  })

  it('ignores malformed, oversized, untrusted, duplicate and other-authority display cookies', async () => {
    const renderer = await fixture.createRenderer({ existingJapanese: true })
    renderer.locale.setLocale('ja')
    const messages = { CONTENT_FILTERED: expected('CONTENT_FILTERED', 'ja'), CONTENT_CHECK_UNAVAILABLE: expected('CONTENT_CHECK_UNAVAILABLE', 'ja') }
    const badValues = ['%invalid', 'x'.repeat(2049), encoded(messages, 'not-an-owner'),
      encoded({ ...messages, CONTENT_FILTERED: '<b>arbitrary</b>' }), encoded({ ...messages, extra: 'untrusted' })]
    for (const value of badValues) expect((await fixture.invoke(fixture.authCookie + '; ' + fixture.name + '=' + value)).failure.message).toBe(expected('CONTENT_FILTERED', 'en'))
    const value = encoded(messages)
    for (const cookie of [fixture.authCookie + '; ' + fixture.name + '=' + value + '; ' + fixture.name + '=' + value,
      fixture.authCookie + '; ' + fixture.name + '_other=' + value]) {
      expect((await fixture.invoke(cookie)).failure.message).toBe(expected('CONTENT_FILTERED', 'en'))
    }
    expect(fixture.received.every(entry => !entry.headers.cookie && !JSON.stringify(entry.body).includes('CONTENT_FILTERED'))).toBe(true)
  })

  it('never lets a locale hint replace authenticated Connection admission', async () => {
    const renderer = await fixture.createRenderer()
    const displayCookie = renderer.cookie().split(';').map(value => value.trim()).find(value => value.startsWith(fixture.name + '='))
    expect((await fixture.invoke(displayCookie)).status).toBe(401)
    expect(fixture.received).toHaveLength(0)
  })

  it('unloads and reloads real Cordis fibers without stale dictionaries, language ownership or duplicate subscriptions', async () => {
    const renderer = await fixture.createRenderer()
    for (let index = 0; index < 3; index++) {
      expect(renderer.locale.getSnapshot().locales.map(locale => locale.id)).toEqual(['zh', 'en'])
      renderer.locale.setLocale('en')
      expect((await fixture.invoke(renderer.cookie())).failure.message).toBe(expected('CONTENT_FILTERED', 'en'))
      await renderer.deactivate()
      expect(renderer.cookie().includes(fixture.name + '=')).toBe(false)
      expect(renderer.locale.getSnapshot().locales.map(locale => locale.id)).toEqual(['zh', 'en'])
      await renderer.activate()
    }
  })

  it('does not delete the same-language cookie owned by another live renderer', async () => {
    const jar = new CookieJar()
    const first = await fixture.createRenderer({ jar }), second = await fixture.createRenderer({ jar })
    expect(first.locale.getSnapshot().active).toBe('zh')
    expect(second.locale.getSnapshot().active).toBe('zh')
    await first.deactivate()
    expect(second.cookie().includes(fixture.name + '=')).toBe(true)
    expect((await fixture.invoke(second.cookie())).failure.message).toBe(expected('CONTENT_FILTERED', 'zh'))
    await second.deactivate()
    expect(second.cookie().includes(fixture.name + '=')).toBe(false)
  })

  it('leaves an existing Japanese language pack registered when the enterprise client unloads', async () => {
    const renderer = await fixture.createRenderer({ existingJapanese: true })
    await renderer.deactivate()
    expect(renderer.locale.getSnapshot().locales.find(locale => locale.id === 'ja')?.label).toBe('Existing Japanese pack')
  })
})

// Coverage AC: AC-03, AC-30, AC-31, AC-56.
describe('queued current-locale through the public SessionController and Agent', () => {
  it.each(['CHAT', 'RESPONSES'].flatMap(protocol => ['blocked', 'unavailable'].map(scenario => [protocol, scenario])))
    ('%s captures the later ja request for %s instead of its older active driver locale', async (protocol, scenario) => {
      await fixture.dispose()
      fixture = await createFixture({ queueProtocol: protocol })
      const renderer = await fixture.createRenderer({ existingJapanese: true })
      renderer.locale.setLocale('zh')
      expect((await fixture.enqueue(renderer.cookie(), 'first-unique-request')).accepted).toBe(true)
      await fixture.firstStarted
      renderer.locale.setLocale('ja')
      const messages = JSON.parse(decodeURIComponent(renderer.cookie().split(';').map(value => value.trim())
        .find(value => value.startsWith(fixture.name + '=')).split('=').slice(1).join('='))).messages
      const code = scenario === 'blocked' ? 'CONTENT_FILTERED' : 'CONTENT_CHECK_UNAVAILABLE'
      expect(messages[code]).toBe(expected(code, 'ja'))
      expect((await fixture.enqueue(renderer.cookie(), 'queued-' + scenario)).accepted).toBe(true)
      // The real later inbox message exists while the original model is blocked.
      expect(fixture.publicOrder.map(([event]) => event)).toEqual(['inserted', 'claimed', 'inserted'])
      fixture.releaseFirst()
      await fixture.whenIdle()
      expect(fixture.received).toHaveLength(2)
      expect(fixture.turnEnds).toHaveLength(2)
      expect(fixture.turnEnds[0].reason.kind).toBe('completed')
      expect(fixture.publicOrder.map(([event]) => event)).toEqual(['inserted', 'claimed', 'inserted', 'claimed'])
      expect(fixture.publicOrder[2][1]).toBe(fixture.publicOrder[3][1])
      expect(fixture.received.every(entry => !entry.headers.cookie &&
        !JSON.stringify(entry.body).includes('CONTENT_FILTERED') && !JSON.stringify(entry.body).includes(expected(code, 'ja')))).toBe(true)
      expect(JSON.stringify(fixture.inboxMessages)).not.toContain('CONTENT_FILTERED')
      expect(JSON.stringify(fixture.inboxMessages)).not.toContain(expected(code, 'ja'))
      expect(fixture.turnEnds[1].reason).toMatchObject({ kind: 'error', error: {
        code, message: expected(code, 'ja'), requestId: 'synthetic-gateway-id'
      } })
    })

  it.each(['CHAT', 'RESPONSES'].flatMap(protocol => ['missing', 'invalid'].map(hint => [protocol, hint])))
    ('%s uses the English default for a queued %s hint instead of its older driver locale', async (protocol, hint) => {
      await fixture.dispose()
      fixture = await createFixture({ queueProtocol: protocol })
      const renderer = await fixture.createRenderer()
      renderer.locale.setLocale('zh')
      expect((await fixture.enqueue(renderer.cookie(), 'first-unique-request')).accepted).toBe(true)
      await fixture.firstStarted
      // Keep authenticated admission, but omit or invalidate only the display hint.
      const cookie = fixture.authCookie + (hint === 'invalid' ? '; ' + fixture.name + '=%invalid' : '')
      expect((await fixture.enqueue(cookie, 'queued-without-valid-locale')).accepted).toBe(true)
      expect(fixture.publicOrder.map(([event]) => event)).toEqual(['inserted', 'claimed', 'inserted'])
      fixture.releaseFirst()
      await fixture.whenIdle()
      expect(fixture.received).toHaveLength(2)
      expect(fixture.turnEnds).toHaveLength(2)
      expect(fixture.turnEnds[0].reason.kind).toBe('completed')
      expect(fixture.publicOrder.map(([event]) => event)).toEqual(['inserted', 'claimed', 'inserted', 'claimed'])
      expect(fixture.received.every(entry => !entry.headers.cookie && !JSON.stringify(entry.body).includes('CONTENT_FILTERED'))).toBe(true)
      expect(JSON.stringify(fixture.inboxMessages)).not.toContain('CONTENT_FILTERED')
      expect(fixture.turnEnds[1].reason).toMatchObject({ kind: 'error', error: {
        code: 'CONTENT_FILTERED', message: expected('CONTENT_FILTERED', 'en'), requestId: 'synthetic-gateway-id'
      } })
    })
})
