// Coverage AC: AC-03, AC-30, AC-31, AC-56.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { apply as applyEnterprise } from '../packages/dsh-desktop-enterprise/index.js'
import { createMockEnterpriseServer } from '../scripts/mock-bisheng-enterprise.mjs'
import { startEnterpriseCredentialBroker } from '../src/main/enterprise/credential-broker'
import { createEnterpriseFetch } from '../src/main/enterprise/platform-fetch'
import { EnterpriseService } from '../src/main/enterprise/enterprise-service'
import { SecureEnterpriseCredentialVault, ENTERPRISE_VAULT_FILENAME } from '../src/main/enterprise/secure-credential-vault'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  delete process.env.DSH_DESKTOP_ENTERPRISE_BROKER_URL
  delete process.env.DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY
  delete process.env.DSH_DESKTOP_ENTERPRISE_ALLOW_INSECURE_LOOPBACK
  vi.restoreAllMocks()
})

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Audit integration state did not become ready.')
}

async function login(service: EnterpriseService, origin: string) {
  const started = await service.startLogin(origin)
  const authId = new URL(started.authorizationUrl).searchParams.get('auth_id') ?? ''
  const html = await fetch(origin + '/__mock/authorize', {
    method: 'POST', body: new URLSearchParams({
      auth_id: authId, email: 'alice@demo.bisheng.local', password: 'WorkBuddy123!', decision: 'allow'
    })
  }).then((response) => response.text())
  const callback = /location\.replace\((".*?")\)/u.exec(html)?.[1]
  if (!callback) throw new Error('Mock authorization returned no callback.')
  await fetch(JSON.parse(callback) as string)
  await waitFor(() => service.snapshot().phase === 'connected')
}

function vaultAt(path: string) {
  return new SecureEnterpriseCredentialVault(path, {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain',
    encryptString: (plain) => Buffer.from(plain),
    decryptString: (encrypted) => Buffer.from(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength).toString()
  })
}

interface Adapter {
  stream(options: { model: string, sessionId?: string, purpose?: string, messages: Array<{ role: string, content: Array<{ type: string, text: string }> }> }): AsyncIterable<unknown>
}
interface Route { path: string, fetch(request: Request): Promise<Response> }

async function plugin(service: EnterpriseService, services: Record<string, unknown> = {}) {
  const broker = await startEnterpriseCredentialBroker(service, { allowInsecureLoopback: true })
  cleanups.push(() => broker.stop())
  process.env.DSH_DESKTOP_ENTERPRISE_BROKER_URL = broker.url
  process.env.DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY = broker.capability
  process.env.DSH_DESKTOP_ENTERPRISE_ALLOW_INSECURE_LOOPBACK = '1'
  const routes: Route[] = []
  let adapter: Adapter | undefined
  applyEnterprise({
    ...services,
    provide() {},
    on(name: string, ...args: unknown[]) {
      // Only global audit-title events are delivered by this fixture; the
      // real locale request/inbox lifecycle is exercised in the locale tests.
      const options = args[1] as { global?: boolean } | undefined
      if (name !== 'session/event' || options?.global !== true) return () => undefined
      const subscribe = services.on
      return typeof subscribe === 'function' ? subscribe(name, ...args) : () => undefined
    },
    connection: { fetch: { register: (route: Route) => { routes.push(route); return () => undefined } } },
    llm: { registerAdapter: (_providers: string[], value: Adapter) => {
      adapter = value
      return Object.assign(() => undefined, { replace: () => undefined })
    } },
    effect: (callback: () => (() => unknown) | undefined) => {
      const dispose = callback()
      if (dispose) cleanups.push(dispose)
    }
  } as never)
  const update = async () => {
    const route = routes.find((candidate) => candidate.path === '/api/enterprise.state')
    if (!route) throw new Error('Enterprise state route not registered.')
    await route.fetch(new Request('http://127.0.0.1/api/enterprise.state'))
    await waitFor(() => adapter !== undefined)
  }
  await update()
  return {
    update,
    async call(sessionId?: string, purpose?: string) {
      if (!adapter) throw new Error('Adapter not registered.')
      const events: unknown[] = []
      for await (const event of adapter.stream({
        model: 'bisheng:42', sessionId, purpose,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic audit hello' }] }]
      })) events.push(event)
      return events
    }
  }
}

describe('audit context full desktop chain against synthetic mock', () => {
  it('negotiates fields, preserves persisted sessions after restart, and does not replay requests', async () => {
    const platform = createMockEnterpriseServer({ port: 0, auditContext: { fields: ['conversation_id', 'request_kind'] } })
    const origin = await platform.listen()
    cleanups.push(() => platform.close())
    const root = await mkdtemp(join(tmpdir(), 'dsh-model-audit-'))
    const credentialPath = join(root, ENTERPRISE_VAULT_FILENAME)
    let failConfig = false
    const fetchImpl = createEnterpriseFetch(async (input, init) => {
      if (failConfig && String(input).endsWith('/api/v1/dsh/config')) throw new Error('synthetic config outage')
      return fetch(input, init)
    })
    const service = new EnterpriseService({ vault: vaultAt(credentialPath), fetchImpl, allowInsecureLoopback: true })
    cleanups.push(() => service.stop())
    await login(service, origin)
    expect(service.snapshot().audit_context?.fields).toEqual(['conversation_id', 'request_kind'])
    const path = join(root, 'sessions')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root: path, compression: 'zstd' })
    const id = SessionId('persisted-audit-session')
    const handle = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false })
    await handle.flush()
    await handle.close()
    await fiber.dispose()
    const first = await plugin(service)
    const initialConfigCount = platform.state.configRequests
    for (const purpose of [undefined, 'compaction', 'session-title', 'future-purpose']) await first.call(id, purpose)
    await first.call('fork-session')
    await first.call()
    expect(platform.state.configRequests).toBe(initialConfigCount)
    const requests = platform.state.chatRequests as Array<{ audit_context?: { conversation_id?: string, request_kind?: string } }>
    expect(requests.slice(0, 4).map((request) => request.audit_context?.conversation_id)).toEqual([id, id, id, id])
    expect(requests.slice(0, 4).map((request) => request.audit_context?.request_kind)).toEqual(['chat', 'compaction', 'session-title', undefined])
    expect(requests[4]?.audit_context?.conversation_id).toBe('fork-session')
    expect(requests[5]?.audit_context).toEqual({ request_kind: 'chat' })
    platform.state.auditContext = { fields: ['conversation_id'] }
    await service.refreshAuditCapability()
    await first.update()
    await first.call(id)
    expect(requests[6]?.audit_context).toEqual({ conversation_id: id })
    failConfig = true
    await service.refreshAuditCapability()
    expect(service.snapshot().modelsAvailable).toBe(true)
    await first.update()
    await first.call(id)
    expect(requests[7]?.audit_context).toBeUndefined()
    expect(requests).toHaveLength(8)
    await service.stop()
    failConfig = false
    platform.state.auditContext = { fields: ['conversation_id', 'request_kind'] }
    const restarted = new EnterpriseService({ vault: vaultAt(credentialPath), fetchImpl, allowInsecureLoopback: true })
    cleanups.push(() => restarted.stop())
    expect(restarted.snapshot()).not.toHaveProperty('audit_context')
    await restarted.restore()
    await waitFor(() => restarted.snapshot().modelsAvailable)
    const reopened = new Context()
    await reopened.plugin(SessionStore)
    const reader = await reopened.plugin(JsonlSessionPersistence, { root: path, compression: 'zstd' })
    cleanups.push(() => reader.dispose())
    const recovered = (await reopened.sessionPersistence.list())[0]?.header.id
    expect(recovered).toBe(id)
    const second = await plugin(restarted)
    await second.call(recovered)
    expect(requests[8]?.audit_context).toEqual({ conversation_id: id, request_kind: 'chat' })
    await restarted.logout()
    expect(restarted.snapshot()).not.toHaveProperty('audit_context')
  })
})


describe('audit title through enterprise plugin and HTTP credential broker', () => {
  it.each([false, true])('reports snapshots and renames, with retry diagnostics (Responses=%s)', async (native) => {
    const platform = createMockEnterpriseServer({ port: 0, auditContext: { fields: ['conversation_id', 'request_kind', 'session_origin'] } })
    const origin = await platform.listen()
    cleanups.push(() => platform.close())
    const root = await mkdtemp(join(tmpdir(), 'dsh-title-integration-'))
    const uploads: Array<{ conversation_id: string, title: string, title_event_seq: number }> = []
    let responsesRequests = 0
    let modelContext: unknown
    const fetchImpl = createEnterpriseFetch(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/v1/dsh/audit/conversations/title') {
        uploads.push(JSON.parse(String(init?.body)))
        expect(modelContext).toMatchObject({ conversation_id: uploads.at(-1)?.conversation_id, request_kind: 'chat', session_origin: 'main' })
        if (uploads.length === 1) return Response.json({ error: { message: 'Private failure body' } }, { status: 503 })
        return Response.json({ status: 'UPDATED', title_event_seq: uploads.at(-1)?.title_event_seq })
      }
      if (path === '/api/v1/dsh/responses' || path === '/api/v1/dsh/chat/completions') {
        modelContext = (JSON.parse(String(init?.body)) as Record<string, unknown>).audit_context
      }
      if (path === '/api/v1/dsh/responses') {
        responsesRequests++
        const item = { id: 'msg_title', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }
        const final = { id: 'resp_title', object: 'response', status: 'completed', model: 'bisheng:42', output: [item], usage: null }
        const events = [
          { type: 'response.created', response: { ...final, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: final }
        ]
        return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
      const response = await fetch(input, init)
      if (path === '/api/v1/dsh/config') return Response.json({ ...await response.json(), audit_conversation_title: { version: 1 } })
      if (path === '/api/v1/dsh/models') {
        const body = await response.json() as { data: Array<{ capabilities: Record<string, unknown> }> }
        body.data = body.data.map(model => ({ ...model, capabilities: { ...model.capabilities, responses: native } }))
        return Response.json(body)
      }
      return response
    })
    const service = new EnterpriseService({ vault: vaultAt(join(root, ENTERPRISE_VAULT_FILENAME)), fetchImpl, allowInsecureLoopback: true })
    cleanups.push(() => service.stop())
    await login(service, origin)
    const session = { header: { id: `e2e-title-${native ? 'responses' : 'chat'}` } }
    let title = { title: 'Private existing title', eventSeq: 10 }
    let onTitle: ((current: typeof session, event: { type: string, data: { title: string }, seq: number }) => void) | undefined
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const client = await plugin(service, {
      get: (name: string) => name === 'sessions' ? { get: () => session } : name === 'sessionTitle' ? { get: () => title } : undefined,
      on: (name: string, listener: typeof onTitle, options: { global: boolean }) => {
        expect(name).toBe('session/event')
        expect(options.global).toBe(true)
        onTitle = listener
        return () => { onTitle = undefined }
      }
    })
    const events = await client.call(session.header.id)
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    await waitFor(() => uploads.length === 2)
    expect(uploads).toEqual(Array(2).fill({ conversation_id: session.header.id, title: title.title, title_event_seq: 10 }))
    expect(warning).toHaveBeenCalledWith('[enterprise-audit-title]', JSON.stringify({
      reason: 'retry', conversation_id: session.header.id, title_event_seq: 10, attempt: 1,
      failure_kind: 'request_failed', http_status: 503, retry_in_ms: 1000
    }))
    const logs = JSON.stringify(warning.mock.calls)
    expect(logs).not.toContain(title.title)
    expect(logs).not.toContain('Private failure body')
    expect(logs).not.toContain(service.snapshot().connectionKey)
    title = { title: 'Private renamed title', eventSeq: 15 }
    expect(onTitle).toBeTypeOf('function')
    onTitle?.(session, { type: 'session/title', data: { title: title.title }, seq: title.eventSeq })
    await waitFor(() => uploads.length === 3)
    expect(uploads[2]).toEqual({ conversation_id: session.header.id, title: title.title, title_event_seq: 15 })
    expect(platform.state.chatRequests).toHaveLength(native ? 0 : 1)
    expect(responsesRequests).toBe(native ? 1 : 0)
  })
})
