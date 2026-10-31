import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEnterpriseFetch, type EnterpriseFetch } from '../src/main/enterprise/platform-fetch'
import { EnterpriseService, type EnterpriseServiceNote, type EnterpriseServiceOptions } from '../src/main/enterprise/enterprise-service'
import { startLoginCallbackServer } from '../src/main/enterprise/login-callback-server'
import {
  ENTERPRISE_VAULT_FILENAME,
  type SafeStorageCryptoAdapter,
  SecureEnterpriseCredentialVault
} from '../src/main/enterprise/secure-credential-vault'
import { createMockEnterpriseServer } from '../scripts/mock-bisheng-enterprise.mjs'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

function memorySafeStorage(): SafeStorageCryptoAdapter {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (plainText) => Buffer.from(plainText, 'utf8'),
    decryptString: (encrypted) => Buffer.from(encrypted as Buffer).toString('utf8')
  }
}

async function createService(
  fetchImpl: EnterpriseFetch = createEnterpriseFetch(globalThis.fetch),
  options: Pick<EnterpriseServiceOptions, 'desktopVersion' | 'activateDesktop' | 'now' | 'startCallback'> = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'enterprise-service-'))
  const vault = new SecureEnterpriseCredentialVault(join(directory, ENTERPRISE_VAULT_FILENAME), memorySafeStorage())
  const notes: string[] = []
  const entries: EnterpriseServiceNote[] = []
  const service = new EnterpriseService({
    ...options,
    vault,
    fetchImpl,
    allowInsecureLoopback: true,
    note: (entry) => { notes.push(entry.event); entries.push(entry) }
  })
  await service.restore()
  cleanups.push(async () => service.stop())
  return { service, vault, notes, entries }
}

async function completeBrowserLogin(origin: string, authorizationUrl: string) {
  const authId = new URL(authorizationUrl).searchParams.get('auth_id')
  const browserResponse = await fetch(`${origin}/__mock/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      auth_id: authId ?? '',
      email: 'alice@demo.bisheng.local',
      password: 'WorkBuddy123!',
      decision: 'allow'
    })
  })
  const html = await browserResponse.text()
  const callbackLiteral = /location\.replace\((".*?")\)/u.exec(html)?.[1]
  expect(callbackLiteral).toBeTruthy()
  const callback = new URL(JSON.parse(callbackLiteral!))
  expect(callback.searchParams.get('identity_ticket')).toMatch(/^ticket_/u)
  expect(await fetch(callback).then((response) => response.status)).toBe(200)
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for enterprise service.')
}

describe('enterprise service login loop', () => {
  it('publishes a new catalog revision when only an administrator display name changes', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    let label = 'Provider A / Original label'
    const requests: string[] = []
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      requests.push(String(input))
      const response = await globalThis.fetch(input, init)
      if (String(input).includes('/api/v1/dsh/models') && response.ok) {
        const body = await response.json() as { data: Array<{ display_name: string }> }
        body.data.forEach(model => { model.display_name = label })
        return Response.json(body)
      }
      return response
    }
    const { service } = await createService(createEnterpriseFetch(fetchImpl))
    const started = await service.startLogin(origin)
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => service.snapshot().phase === 'connected' && service.snapshot().modelsAvailable)
    const before = service.snapshot()
    label = 'Provider A / Renamed label'
    requests.length = 0
    await Promise.all([service.refreshModels(), service.refreshModels(), service.refreshModels()])
    expect(requests.filter(url => url.includes('/api/v1/dsh/models'))).toHaveLength(1)
    expect(requests.filter(url => url.includes('/token') || url.includes('/usage'))).toHaveLength(0)
    const after = service.snapshot()
    expect(after.models.map(model => model.id)).toEqual(before.models.map(model => model.id))
    expect(after.models[0]?.display_name).toBe(label)
    expect(after.revision).toBeGreaterThan(before.revision)
  })

  it('keeps the signed-out catalog empty when an earlier metadata refresh finishes', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    let hold = false
    let release: (() => void) | undefined
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      const response = await globalThis.fetch(input, init)
      if (hold && String(input).includes('/api/v1/dsh/models')) {
        await new Promise<void>(resolve => { release = resolve })
      }
      return response
    }
    const { service } = await createService(createEnterpriseFetch(fetchImpl))
    const started = await service.startLogin(origin)
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => service.snapshot().phase === 'connected')
    hold = true
    const refreshing = service.refreshModels()
    await waitFor(() => release !== undefined)
    await service.logout()
    release?.()
    await refreshing
    expect(service.snapshot()).toMatchObject({ connected: false, modelsAvailable: false, models: [] })
  })

  it('retains reasoning metadata through login, refresh and detached public snapshots', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    const reasoning = { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      const response = await globalThis.fetch(input, init)
      if (!String(input).endsWith('/api/v1/dsh/models')) return response
      const body = await response.json()
      body.data = body.data.map((model: Record<string, unknown>) => ({ ...model, reasoning }))
      return Response.json(body)
    }
    const { service } = await createService(createEnterpriseFetch(fetchImpl))
    const started = await service.startLogin(origin)
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => service.snapshot().modelsAvailable)
    const snapshot = service.snapshot()
    expect(snapshot.models[0]?.reasoning).toEqual(reasoning)
    snapshot.models[0]?.reasoning?.efforts.splice(0)
    expect(service.snapshot().models[0]?.reasoning).toEqual(reasoning)
    await service.refresh()
    expect(service.snapshot().models[0]?.reasoning).toEqual(reasoning)
  })

  it('AC-T05/AC-T07: title broker binds the current epoch, refreshes once, and never sends broker identity fields', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(() => platform.close())
    const bodies: unknown[] = []
    let first = true
    const { service } = await createService(createEnterpriseFetch(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/v1/dsh/audit/conversations/title') {
        bodies.push(JSON.parse(String(init?.body)))
        if (first) {
          first = false
          return Response.json({ error: { message: 'Expired', type: 'authentication_error', code: 'invalid_access_token' } }, { status: 401 })
        }
        return Response.json({ status: 'UPDATED', title_event_seq: 12 })
      }
      const response = await fetch(input, init)
      if (path === '/api/v1/dsh/config') return Response.json({ ...await response.json(), audit_conversation_title: { version: 1 } })
      return response
    }))
    await completeBrowserLogin(origin, (await service.startLogin(origin)).authorizationUrl)
    await waitFor(() => service.snapshot().phase === 'connected')
    const state = service.snapshot()
    const update = { conversation_id: 'e2e-title-main', title: 'e2e-title-main', title_event_seq: 12 }
    const request = { connectionKey: state.connectionKey, auditTitleEpoch: state.auditTitleEpoch, update }
    expect(await service.reportAuditTitle(request)).toEqual({ status: 'UPDATED', title_event_seq: 12 })
    expect(bodies).toEqual([update, update])
    expect(service.snapshot().usage).toMatchObject({ used: state.usage?.used, remaining: state.usage?.remaining, limit: state.usage?.limit })
    await expect(service.reportAuditTitle({ ...request, auditTitleEpoch: Number(state.auditTitleEpoch) - 1 })).rejects.toMatchObject({ status: 409 })
    await expect(service.reportAuditTitle({ ...request, update: { ...update, user_id: 1 } })).rejects.toMatchObject({ status: 400 })
    await service.logout()
    await completeBrowserLogin(origin, (await service.startLogin(origin)).authorizationUrl)
    await waitFor(() => service.snapshot().phase === 'connected')
    expect(service.snapshot().connectionKey).toBe(state.connectionKey)
    expect(service.snapshot().auditTitleEpoch).not.toBe(state.auditTitleEpoch)
    await expect(service.reportAuditTitle(request)).rejects.toMatchObject({ status: 409 })
    expect(bodies).toHaveLength(2)
  })

  it('refreshes optional capability independently and clears it across a BASE/account change', async () => {
    const first = createMockEnterpriseServer({ port: 0, auditContext: { fields: ['conversation_id', 'request_kind'] } })
    const second = createMockEnterpriseServer({ port: 0, auditContext: { fields: ['request_kind'] } })
    const origin = await first.listen()
    const otherOrigin = await second.listen()
    cleanups.push(() => first.close(), () => second.close())
    let failConfig = false
    const { service } = await createService(createEnterpriseFetch(async (input, init) => {
      if (failConfig && String(input).endsWith('/api/v1/dsh/config')) throw new Error('synthetic capability outage')
      return fetch(input, init)
    }))
    await completeBrowserLogin(origin, (await service.startLogin(origin)).authorizationUrl)
    await waitFor(() => service.snapshot().phase === 'connected')
    expect(service.snapshot().audit_context?.fields).toEqual(['conversation_id', 'request_kind'])
    const copy = service.snapshot()
    copy.audit_context?.fields.pop()
    expect(service.snapshot().audit_context?.fields).toHaveLength(2)
    first.state.auditContext = { fields: [1] }
    await service.refreshAuditCapability()
    expect(service.snapshot()).not.toHaveProperty('audit_context')
    expect(service.snapshot().modelsAvailable).toBe(true)
    failConfig = true
    await service.refreshAuditCapability()
    expect(service.snapshot()).not.toHaveProperty('audit_context')
    expect(service.snapshot().phase).toBe('connected')
    failConfig = false
    const nextLogin = await service.startLogin(otherOrigin)
    expect(service.snapshot()).not.toHaveProperty('audit_context')
    await completeBrowserLogin(otherOrigin, nextLogin.authorizationUrl)
    await waitFor(() => service.snapshot().phase === 'connected')
    expect(service.snapshot().base).toBe(otherOrigin)
    expect(service.snapshot().audit_context?.fields).toEqual(['request_kind'])
    await service.logout()
    expect(service.snapshot()).not.toHaveProperty('audit_context')
  })

  it('does not treat an invalid root config as a successful initial connection', async () => {
    const { service } = await createService(createEnterpriseFetch(async () => new Response(
      JSON.stringify({ enabled: true, client_id: 'not-dsh', contract_version: '0.5.0' }),
      { headers: { 'content-type': 'application/json' } }
    )))
    await expect(service.startLogin('http://127.0.0.1:34567')).rejects.toThrow('incompatible')
    expect(service.snapshot().connected).toBe(false)
  })

  it('does not let an older config refresh overwrite the latest capability snapshot', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(() => platform.close())
    let intercept = false
    const pending: Array<(response: Response) => void> = []
    const { service } = await createService(createEnterpriseFetch(async (input, init) => {
      if (intercept && String(input).endsWith('/api/v1/dsh/config')) {
        return new Promise<Response>((resolve) => pending.push(resolve))
      }
      return fetch(input, init)
    }))
    await completeBrowserLogin(origin, (await service.startLogin(origin)).authorizationUrl)
    await waitFor(() => service.snapshot().phase === 'connected')
    intercept = true
    const old = service.refreshAuditCapability()
    await waitFor(() => pending.length === 1)
    const recent = service.refreshAuditCapability()
    await waitFor(() => pending.length === 2)
    const config = (fields: string[]) => new Response(JSON.stringify({
      enabled: true, client_id: 'dsh-desktop', contract_version: '0.5.0', audit_context: { fields }
    }), { headers: { 'content-type': 'application/json' } })
    pending[1]?.(config(['request_kind']))
    await recent
    pending[0]?.(config(['conversation_id', 'request_kind']))
    await old
    expect(service.snapshot().audit_context?.fields).toEqual(['request_kind'])
  })

  it.each([false, true])('reports the app version and commits login even when activation fails: %s', async (failActivation) => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    const requests: Record<string, unknown>[] = []
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      if (String(input).endsWith('/api/v1/dsh/authorizations')) requests.push(JSON.parse(String(init?.body)))
      return globalThis.fetch(input, init)
    }
    const activateDesktop = vi.fn(() => {
      expect(service.snapshot().phase).toBe('connected')
    expect(service.snapshot().desktopVersion).toBe('0.1.1-beta.2+build.7')
      if (failActivation) throw new Error('window unavailable')
    })
    const { service, notes } = await createService(createEnterpriseFetch(fetchImpl), {
      desktopVersion: '0.1.1-beta.2+build.7', activateDesktop
    })
    const started = await service.startLogin(origin)
    expect(requests[0]).toMatchObject({ client_version: '0.1.1-beta.2+build.7', device_name: 'BISHENG' })
    expect(activateDesktop).not.toHaveBeenCalled()
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => activateDesktop.mock.calls.length === 1)
    expect(service.snapshot().phase).toBe('connected')
    expect(notes).toContain('login_committed')
    expect(notes.includes('desktop_activation_failed')).toBe(failActivation)
    expect(notes).not.toContain('login_failed')
    const sessions = platform.state.sessions as Map<string, { clientVersion: string }>
    expect([...sessions.values()][0]?.clientVersion).toBe('0.1.1-beta.2+build.7')
    await service.refresh()
    expect(activateDesktop).toHaveBeenCalledTimes(1)
  })

  it('omits an unavailable version and does not activate Desktop when token exchange fails', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    const requests: Record<string, unknown>[] = []
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      if (String(input).endsWith('/api/v1/dsh/authorizations')) requests.push(JSON.parse(String(init?.body)))
      if (String(input).endsWith('/api/v1/dsh/token')) {
        return Response.json({ error: { message: 'Invalid ticket', code: 'invalid_ticket' } }, { status: 401 })
      }
      return globalThis.fetch(input, init)
    }
    const activateDesktop = vi.fn()
    const { service, notes } = await createService(createEnterpriseFetch(fetchImpl), { activateDesktop })
    const started = await service.startLogin(origin)
    expect(requests[0]).not.toHaveProperty('client_version')
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => notes.includes('login_failed'))
    expect(service.snapshot().connected).toBe(false)
    expect(activateDesktop).not.toHaveBeenCalled()
  })

  it('completes PKCE login, refreshes once, and logs out without exposing tokens', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    const { service, notes } = await createService()

    const started = await service.startLogin(origin)
    expect(started.authorizationUrl).toContain(origin)
    expect(service.snapshot().phase).toBe('authorizing')
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => {
      const snapshot = service.snapshot()
      return snapshot.phase === 'connected'
        && snapshot.modelsAvailable === true
        && typeof snapshot.modelUsage?.['bisheng:42']?.used === 'number'
    })
    const connected = service.snapshot()
    expect(connected.connected).toBe(true)
    expect(connected.user?.username).toBe('alice')
    expect(connected.modelsAvailable).toBe(true)
    expect(connected.modelUsage?.['bisheng:42']?.used).toEqual(expect.any(Number))
    expect(connected.modelUsage?.['bisheng:42']?.limit).toBeGreaterThan(0)
    expect(JSON.stringify(connected)).not.toMatch(/access_token|refresh_token|identity_ticket/u)
    expect(notes).toContain('login_committed')

    const first = service.refresh()
    const second = service.refresh()
    const [a, b] = await Promise.all([first, second])
    expect(a.revision).toBe(b.revision)
    expect(a.connected).toBe(true)
    expect(notes).toContain('refresh_committed')

    const loggedOut = await service.logout()
    expect(loggedOut.connected).toBe(false)
    expect(loggedOut.phase).toBe('idle')
    expect(notes).toContain('logout_committed')
    expect(notes.join(' ')).not.toMatch(/access_token|refresh_token|identity_ticket|code_verifier|ticket_/u)
  })

  it('keeps the session when refresh hits a transient network error', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    let failRefresh = false
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      if (failRefresh && String(input).includes('/api/v1/dsh/token') && String(init?.body).includes('refresh_token')) {
        throw new TypeError('fetch failed')
      }
      return globalThis.fetch(input, init)
    }
    const { service } = await createService(createEnterpriseFetch(fetchImpl))
    const started = await service.startLogin(origin)
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => {
      const snapshot = service.snapshot()
      return snapshot.phase === 'connected' && snapshot.modelsAvailable === true
    })
    failRefresh = true
    const degraded = await service.refresh()
    expect(degraded.phase).toBe('degraded')
    expect(degraded.connected).toBe(true)
    expect(degraded.base).toBe(origin)
  })

  it('clears the session for an invalid refresh token', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    let rejectRefresh = false
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      if (rejectRefresh && String(input).includes('/api/v1/dsh/token') && String(init?.body).includes('refresh_token')) {
        return new Response(JSON.stringify({
          error: { message: 'Refresh token is invalid.', type: 'authentication_error', code: 'invalid_refresh_token' }
        }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
      }
      return globalThis.fetch(input, init)
    }
    const { service } = await createService(createEnterpriseFetch(fetchImpl))
    const started = await service.startLogin(origin)
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => {
      const snapshot = service.snapshot()
      return snapshot.phase === 'connected' && snapshot.modelsAvailable === true
    })
    rejectRefresh = true
    const cleared = await service.refresh()
    expect(cleared.connected).toBe(false)
    expect(cleared.phase).toBe('idle')
    expect(cleared.models).toEqual([])
    expect(cleared.errorCode).toBe('invalid_refresh_token')
    expect(cleared.error).toBe('Refresh token is invalid.')
  })

  it('clears the session and keeps the reason when the session has expired', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    let rejectRefresh = false
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      if (rejectRefresh && String(input).includes('/api/v1/dsh/token') && String(init?.body).includes('refresh_token')) {
        return new Response(JSON.stringify({
          error: { message: 'session expired', type: 'authentication_error', code: 'session_expired' }
        }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
      }
      return globalThis.fetch(input, init)
    }
    const { service, notes } = await createService(createEnterpriseFetch(fetchImpl))
    const started = await service.startLogin(origin)
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => {
      const snapshot = service.snapshot()
      return snapshot.phase === 'connected' && snapshot.modelsAvailable === true
    })
    rejectRefresh = true
    const cleared = await service.refresh()
    expect(cleared.connected).toBe(false)
    expect(cleared.phase).toBe('idle')
    expect(cleared.models).toEqual([])
    expect(cleared.errorCode).toBe('session_expired')
    expect(cleared.error).toBe('session expired')
    expect(notes).toContain('refresh_invalid')
  })

  it('publishes access_denied when browser sign-in is cancelled', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    const { service } = await createService()
    const started = await service.startLogin(origin)
    const authId = new URL(started.authorizationUrl).searchParams.get('auth_id')
    const browserResponse = await fetch(`${origin}/__mock/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth_id: authId ?? '', decision: 'deny' })
    })
    const html = await browserResponse.text()
    const callbackLiteral = /location\.replace\((".*?")\)/u.exec(html)?.[1]
    expect(callbackLiteral).toBeTruthy()
    const callback = new URL(JSON.parse(callbackLiteral!))
    expect(callback.searchParams.get('error')).toBe('access_denied')
    expect(await fetch(callback).then((response) => response.status)).toBe(200)
    await waitFor(() => service.snapshot().errorCode === 'access_denied')
    expect(service.snapshot()).toMatchObject({
      connected: false,
      phase: 'idle',
      errorCode: 'access_denied'
    })
  })

  it.each(['seat_revoked', 'seat_not_assigned'])('publishes %s on login failure', async (code) => {
    const message = code.replaceAll('_', ' ')
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      if (String(input).includes('/api/v1/dsh/token') && String(init?.body).includes('identity_ticket')) {
        return new Response(JSON.stringify({
          error: { message, code },
          request_id: 'req-seat-1'
        }), {
          status: 403,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-seat-1' }
        })
      }
      return globalThis.fetch(input, init)
    }
    const { service } = await createService(createEnterpriseFetch(fetchImpl))
    const started = await service.startLogin(origin)
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => {
      const snapshot = service.snapshot()
      return snapshot.phase === 'idle' && snapshot.error === message
    })
    expect(service.snapshot()).toMatchObject({
      error: message,
      errorCode: code,
      requestId: 'req-seat-1'
    })
  })

  it('still logs out locally when remote revoke fails', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      if (String(input).includes('/api/v1/dsh/logout')) {
        return new Response(JSON.stringify({
          error: { message: 'upstream unavailable', code: 'server_error' }
        }), { status: 503, headers: { 'content-type': 'application/json' } })
      }
      return globalThis.fetch(input, init)
    }
    const { service, notes } = await createService(createEnterpriseFetch(fetchImpl))
    const started = await service.startLogin(origin)
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => {
      const snapshot = service.snapshot()
      return snapshot.phase === 'connected' && snapshot.modelsAvailable === true
    })
    const loggedOut = await service.logout()
    expect(loggedOut.phase).toBe('idle')
    expect(loggedOut.connected).toBe(false)
    expect(notes).toContain('logout_remote_failed')
    expect(notes).toContain('logout_committed')
  })

  it('inspects intranet HTTP but refuses to start login without confirmation', async () => {
    const { service } = await createService()
    await expect(service.inspectBase('http://192.168.106.119:30006')).resolves.toEqual({
      base: 'http://192.168.106.119:30006',
      insecurePrivateHttp: true
    })
    await expect(service.startLogin('http://192.168.106.119:30006')).rejects.toMatchObject({
      message: 'HTTP intranet addresses require explicit confirmation.',
      status: 400
    })
  })

  it('keeps refreshing until per-model usage finishes after login', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())

    let releaseModels: (() => void) | undefined
    let releaseUsage: (() => void) | undefined
    const modelsGate = new Promise<void>((resolve) => {
      releaseModels = resolve
    })
    const usageGate = new Promise<void>((resolve) => {
      releaseUsage = resolve
    })
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      const url = String(input)
      if (url.includes('/api/v1/dsh/models')) await modelsGate
      if (url.includes('/api/v1/dsh/usage')) await usageGate
      return globalThis.fetch(input, init)
    }
    const { service } = await createService(createEnterpriseFetch(fetchImpl))

    const started = await service.startLogin(origin)
    await completeBrowserLogin(origin, started.authorizationUrl)

    await waitFor(() => {
      const snapshot = service.snapshot()
      return snapshot.phase === 'refreshing' && snapshot.modelsAvailable !== true
    })
    const revisionBeforeModels = service.snapshot().revision

    releaseModels!()
    await waitFor(() => {
      const snapshot = service.snapshot()
      return snapshot.modelsAvailable === true && snapshot.models.length > 0
    })
    const midCatalog = service.snapshot()
    expect(midCatalog.phase).toBe('refreshing')
    expect(midCatalog.connected).toBe(true)
    expect(midCatalog.modelUsage).toBeUndefined()
    expect(midCatalog.revision).toBeGreaterThan(revisionBeforeModels)

    releaseUsage!()
    await waitFor(() => {
      const snapshot = service.snapshot()
      return snapshot.phase === 'connected'
        && typeof snapshot.modelUsage?.['bisheng:42']?.used === 'number'
    })
    const connected = service.snapshot()
    expect(connected.phase).toBe('connected')
    expect(connected.modelUsage?.['bisheng:42']?.used).toEqual(expect.any(Number))
    expect(connected.modelUsage?.['bisheng:42']?.limit).toBeGreaterThan(0)
  })

  it('loads per-model usage when a saved session is restored', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    const directory = await mkdtemp(join(tmpdir(), 'enterprise-service-'))
    const vault = new SecureEnterpriseCredentialVault(join(directory, ENTERPRISE_VAULT_FILENAME), memorySafeStorage())
    const fetchImpl = createEnterpriseFetch(globalThis.fetch)
    const service = new EnterpriseService({ vault, fetchImpl, allowInsecureLoopback: true })
    cleanups.push(async () => service.stop())
    await service.restore()
    await completeBrowserLogin(origin, (await service.startLogin(origin)).authorizationUrl)
    await waitFor(() => {
      const usage = service.snapshot().modelUsage?.['bisheng:42']
      return service.snapshot().phase === 'connected' && typeof usage?.used === 'number'
    })
    await service.stop()

    const restarted = new EnterpriseService({ vault, fetchImpl, allowInsecureLoopback: true })
    cleanups.push(async () => restarted.stop())
    expect(restarted.snapshot().modelUsage).toBeUndefined()
    await restarted.restore()
    await waitFor(() => {
      const snapshot = restarted.snapshot()
      const usage = snapshot.modelUsage?.['bisheng:42']
      return snapshot.modelsAvailable === true
        && usage?.quota_state === 'available'
        && typeof usage.used === 'number'
        && typeof usage.limit === 'number'
    })
  })

  it('completes login from a pasted one-time code without the loopback callback', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    const { service } = await createService()

    const started = await service.startLogin(origin)
    expect(service.snapshot().loginExpiresAt).toBeTruthy()
    await expect(service.submitManualTicket('')).rejects.toMatchObject({ status: 400 })

    const authId = new URL(started.authorizationUrl).searchParams.get('auth_id')
    const browserResponse = await fetch(`${origin}/__mock/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        auth_id: authId ?? '',
        email: 'alice@demo.bisheng.local',
        password: 'WorkBuddy123!',
        decision: 'allow'
      })
    })
    const html = await browserResponse.text()
    const callbackLiteral = /location\.replace\((".*?")\)/u.exec(html)?.[1]
    expect(callbackLiteral).toBeTruthy()
    const ticket = new URL(JSON.parse(callbackLiteral!)).searchParams.get('identity_ticket')
    expect(ticket).toMatch(/^ticket_/u)

    const connected = await service.submitManualTicket(ticket!)
    expect(connected.connected).toBe(true)
    expect(connected.phase).toBe('connected')
    expect(connected.user?.username).toBe('alice')
    expect(connected.modelsAvailable).toBe(true)
    expect(connected.modelUsage?.['bisheng:42']?.used).toEqual(expect.any(Number))
    expect(connected.modelUsage?.['bisheng:42']?.limit).toBeGreaterThan(0)
    expect(connected.loginExpiresAt).toBeUndefined()
    expect(JSON.stringify(connected)).not.toMatch(/access_token|refresh_token|identity_ticket|ticket_/u)
  })
})

describe('enterprise market credential boundary', () => {
  it('uses generic host auth without replaying 401 and preserves versions across refresh', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    const requests: RequestInit[] = []
    let now = Date.now()
    const { service, vault, entries } = await createService(async (url, init) => {
      if (new URL(url).pathname === '/business/stream') return new Response(new ReadableStream({}, { highWaterMark: 0 }))
      if (new URL(url).pathname !== '/business/action') return fetch(url, init)
      requests.push(init ?? {})
      return Response.json({ denied: true }, { status: 401 })
    }, { now: () => now })
    const plugin = { pluginId: 'example-plugin', instanceId: 'instance-1' }
    const initialVersion = service.authState().sessionVersion
    const started = await service.startLogin(origin)
    expect(service.authState().sessionVersion).not.toBe(initialVersion)
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => service.snapshot().modelsAvailable)
    const state = service.authState()
    expect(state).toMatchObject({ connected: true, enterpriseId: expect.any(String), userId: expect.any(String) })
    const before = (await vault.read()).session
    now = Date.parse(before?.access_expires_at ?? '') + 1
    const response = await service.authRequest(plugin, { path: '/business/action?private=query', method: 'POST', body: 'business', sessionVersion: state.sessionVersion }, new AbortController().signal)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ denied: true })
    expect(requests).toHaveLength(1)
    expect(new Headers(requests[0]?.headers).get('authorization')).toMatch(/^Bearer /)
    expect(new Headers(requests[0]?.headers).get('authorization')).not.toBe('Bearer ' + before?.access_token)
    expect(entries.find(entry => entry.event === 'auth_request')).toMatchObject({ pluginId: plugin.pluginId, path: '/business/action', status: 401, duration: expect.any(Number) })
    expect(requests[0]).toMatchObject({ redirect: 'error', credentials: 'omit' })
    await service.refresh()
    expect(service.authState().sessionVersion).toBe(state.sessionVersion)
    expect(service.snapshot().revision).toBeGreaterThan(0)
    const stream = await service.authRequest(plugin, { path: '/business/stream', sessionVersion: state.sessionVersion }, new AbortController().signal)
    const late = expect(stream.text()).rejects.toMatchObject({ code: 'session_changed', status: 409 })
    const logout = service.logout()
    await late
    expect(service.authState().connected).toBe(false)
    expect(service.authState().sessionVersion).not.toBe(state.sessionVersion)
    await expect(service.authRequest(plugin, { path: '/business/action', sessionVersion: state.sessionVersion }, new AbortController().signal)).rejects.toMatchObject({ code: 'session_changed', status: 409 })
    await logout
    expect(requests).toHaveLength(1)
  })

  it('serves catalog and artifact through the broker with refreshed host credentials and rejects stale account requests', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    const requests: Array<{ path: string, authorization: string | null, body?: unknown }> = []
    let rejectFirst = true
    const { service } = await createService(async (url, init) => {
      const path = new URL(url).pathname
      if (path.startsWith('/api/v1/dsh/market/')) {
        requests.push({ path, authorization: new Headers(init?.headers).get('authorization'), body: init?.body && JSON.parse(String(init.body)) })
        if (rejectFirst) { rejectFirst = false; return new Response('', { status: 401 }) }
        return path.endsWith('/artifact') ? new Response(new Uint8Array([80, 75, 3, 4]))
          : Response.json({ status_code: 200, data: { total: 1 } })
      }
      return fetch(url, init)
    })
    const started = await service.startLogin(origin)
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => service.snapshot().modelsAvailable)
    const { startEnterpriseCredentialBroker } = await import('../src/main/enterprise/credential-broker')
    const broker = await startEnterpriseCredentialBroker(service, { allowInsecureLoopback: true })
    cleanups.push(async () => broker.stop())
    const connectionKey = service.snapshot().connectionKey
    const call = (body: unknown) => fetch(`${broker.url}/v1/market`, { method: 'POST',
      headers: { authorization: `Bearer ${broker.capability}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const catalog = await call({ path: '/api/v1/dsh/market/catalog?page=1&size=100', connectionKey })
    expect(catalog.status).toBe(200)
    expect(await catalog.json()).toEqual({ status_code: 200, data: { total: 1 } })
    expect(requests).toHaveLength(2)
    expect(requests[0]!.authorization).toMatch(/^Bearer /)
    expect(requests[1]!.authorization).not.toBe(requests[0]!.authorization)
    const artifact = await call({ path: `/api/v1/dsh/market/plugins/${'a'.repeat(32)}/versions/${'b'.repeat(32)}/artifact`, connectionKey })
    expect(artifact.status).toBe(200)
    expect([...new Uint8Array(await artifact.arrayBuffer())]).toEqual([80, 75, 3, 4])
    const syncBody = { device_id: 'test-device', plugins: [] }
    expect((await call({ path: '/api/v1/dsh/market/sync', connectionKey, body: syncBody })).status).toBe(200)
    expect(requests.at(-1)?.body).toEqual(syncBody)
    const before = requests.length
    for (const path of ['https://other.example/api/v1/dsh/market/catalog', '/api/v1/dsh/market/admin/plugins', '/api/v1/dsh/market/catalog?token=secret', '/api/v1/dsh/market/sync']) {
      expect((await call({ path, connectionKey })).status).toBe(400)
    }
    expect(requests).toHaveLength(before)
    await service.logout()
    expect((await call({ path: '/api/v1/dsh/market/catalog', connectionKey })).status).toBe(409)
    expect(requests).toHaveLength(before)
  })

  it('ends browser authorization when the platform expiry is reached', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    let now = Date.now()
    let callbackClosed = false
    const { service } = await createService(createEnterpriseFetch(globalThis.fetch), {
      now: () => now,
      startCallback: async (callbackOptions) => {
        const callback = await startLoginCallbackServer(callbackOptions)
        const close = callback.close.bind(callback)
        return {
          ...callback,
          alignTimeout: callback.alignTimeout.bind(callback),
          async close() {
            callbackClosed = true
            await close()
          }
        }
      }
    })

    await service.startLogin(origin)
    const expiresAt = Date.parse(service.snapshot().loginExpiresAt ?? '')
    expect(expiresAt - now).toBe(300_000)
    now = expiresAt - 1
    expect((await service.readState()).phase).toBe('authorizing')
    expect(callbackClosed).toBe(false)

    now = expiresAt
    const expired = await service.readState()
    expect(expired.phase).toBe('idle')
    expect(expired.errorCode).toBe('authorization_expired')
    expect(expired.loginExpiresAt).toBeUndefined()
    expect(callbackClosed).toBe(true)
  })

  it('follows a shorter authorization lifetime and ignores the previous login timer', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    let now = Date.now()
    let alignedTimeout = 0
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      const response = await globalThis.fetch(input, init)
      if (!String(input).endsWith('/api/v1/dsh/authorizations')) return response
      const body = await response.json() as { expires_in?: number }
      body.expires_in = 45
      return Response.json(body)
    }
    const { service } = await createService(createEnterpriseFetch(fetchImpl), {
      now: () => now,
      startCallback: async (callbackOptions) => {
        const callback = await startLoginCallbackServer(callbackOptions)
        return {
          ...callback,
          alignTimeout(timeoutMs: number) {
            alignedTimeout = timeoutMs
            callback.alignTimeout(timeoutMs)
          },
          close: callback.close.bind(callback)
        }
      }
    })

    await service.startLogin(origin)
    expect(alignedTimeout).toBe(45_000)
    const firstExpiresAt = Date.parse(service.snapshot().loginExpiresAt ?? '')
    now = firstExpiresAt
    await service.startLogin(origin)
    const restarted = await service.readState()
    expect(restarted.phase).toBe('authorizing')
    expect(restarted.errorCode).toBeUndefined()
    expect(Date.parse(restarted.loginExpiresAt ?? '') - now).toBe(45_000)
  })
})

describe('enterprise browser session handoff', () => {
  it('exchanges only host credentials, refreshes rejected access once, and rejects requests after logout', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    let exchanges = 0
    const cookie = 'signed-browser-cookie-for-host-only'
    let releaseToken!: () => void
    const tokenGate = new Promise<void>((resolve) => { releaseToken = resolve })
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      if (String(input).endsWith('/token') && String(init?.body).includes('identity_ticket')) await tokenGate
      if (String(input).endsWith('/api/v1/dsh/web-session')) {
        exchanges += 1
        expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /u)
        if (exchanges === 1) return Response.json({ error: { code: 'invalid_access_token', message: 'Expired access' } }, { status: 401 })
        return Response.json({ cookie, expires_in: 300 })
      }
      return globalThis.fetch(input, init)
    }
    const { service } = await createService(createEnterpriseFetch(fetchImpl))
    const login = await service.startLogin(origin)
    await completeBrowserLogin(origin, login.authorizationUrl)
    await waitFor(() => service.snapshot().phase === 'refreshing')
    expect(service.snapshot().connected).toBe(false)
    releaseToken()
    await waitFor(() => service.snapshot().connected)
    const key = service.snapshot().connectionKey!
    expect(await service.webSession(key)).toMatchObject({ cookie, connectionKey: key, base: origin })
    expect(exchanges).toBe(2)
    expect(JSON.stringify(service.snapshot())).not.toContain(cookie)
    await service.logout()
    await expect(service.webSession(key)).rejects.toThrow('Enterprise account changed')
    expect(exchanges).toBe(2)
  })
})


describe('enterprise Work MCP single sign-on', () => {
  it('uses the logged-in account, refreshes access automatically, and rejects stale identity', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    cleanups.push(async () => platform.close())
    let exchanges = 0, calls = 0
    const cookie = 'work-browser-cookie-host-owned'
    const fetchImpl: EnterpriseFetch = async (input, init) => {
      if (input.endsWith('/api/v1/dsh/web-session')) {
        exchanges++
        if (exchanges === 1) return Response.json({ error: { code: 'invalid_access_token', message: 'Expired' } }, { status: 401 })
        expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /u)
        return Response.json({ cookie, expires_in: 300 })
      }
      if (input.endsWith('/api/v1/dsh/work/mcp')) {
        calls++
        expect(new Headers(init?.headers).get('cookie')).toBe(`access_token_cookie=${cookie}`)
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
      }
      return globalThis.fetch(input, init)
    }
    const { service } = await createService(createEnterpriseFetch(fetchImpl))
    const login = await service.startLogin(origin)
    await completeBrowserLogin(origin, login.authorizationUrl)
    await waitFor(() => service.snapshot().connected)
    const request = { connectionKey: service.snapshot().connectionKey, message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }
    expect(await service.workMcp(request)).toMatchObject({ result: { tools: [] } })
    expect(exchanges).toBe(2)
    expect(JSON.stringify(service.snapshot())).not.toContain(cookie)
    await service.logout()
    await expect(service.workMcp(request)).rejects.toThrow('account changed')
    expect(calls).toBe(1)
  })
})
