import { AsyncLocalStorage } from 'node:async_hooks'
import { CONTENT_SAFETY_ERROR_COPY } from './error-copy.js'
import { createContentSafetyLocaleScope } from './content-safety-locale.js'
import { applyEnterpriseSkills } from './work-skills.js'
import { applyWorkResources } from './work-resources.js'
import { applyWorkCapabilities } from './work-capabilities.js'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import { applyEnterpriseMarket } from './market.js'
import { applyEnterpriseWorkbenchMarket } from './workbench-market.js'
import { applyEnterpriseAuth, createEnterpriseAuthTransport } from './enterprise-auth.js'
import { parseThirdPartyPolicy } from './contract.js'
import { createAuditTitleSync } from './audit-title.js'
import {
  isInsecurePrivateHttpOrigin,
  normalizeEnterpriseServerUrl,
  parseEnterpriseLoginDeepLink
} from './deep-link.js'
import { EnterpriseLlmAdapter, pickAttributionHeaders } from './openai.js'

export { EnterpriseAuthError } from './enterprise-auth.js'

export const name = 'dsh-desktop-enterprise'
export const inject = ['connection', 'llm', 'loader']
export const BISHENG_PROVIDER_ROUTE = 'bisheng-enterprise'

const LOCAL_PATHS = Object.freeze({
  state: '/api/enterprise.state',
  inspectBase: '/api/enterprise.base.inspect',
  start: '/api/enterprise.login.start',
  manual: '/api/enterprise.login.manual',
  inspectDeepLink: '/api/enterprise.deep-link.inspect',
  confirmDeepLink: '/api/enterprise.deep-link.confirm',
  refresh: '/api/enterprise.refresh',
  refreshModels: '/api/enterprise.models.refresh',
  logout: '/api/enterprise.logout'
})

const MAX_JSON_BYTES = 64 * 1024

function disabledState(error) {
  return {
    connected: false,
    secureStorageAvailable: false,
    phase: 'disabled',
    revision: 0,
    models: [],
    modelsAvailable: false,
    ...(error ? { error } : {})
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function allowInsecureLoopback() {
  return process.env.DSH_DESKTOP_ENTERPRISE_ALLOW_INSECURE_LOOPBACK === '1'
}

function inspectUrlOptions() {
  return {
    allowInsecureLoopback: allowInsecureLoopback(),
    allowInsecurePrivateHttp: true
  }
}

function inspectedBase(base) {
  return {
    base,
    ...(isInsecurePrivateHttpOrigin(base) ? { insecurePrivateHttp: true } : {})
  }
}

function brokerConfig() {
  const urlValue = process.env.DSH_DESKTOP_ENTERPRISE_BROKER_URL
  const capability = process.env.DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY
  // Consume the owner secret before any market plugin is imported. This is not a Node sandbox.
  delete process.env.DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY
  if (!urlValue || !capability) {
    console.warn('[enterprise] broker configuration missing', { urlConfigured: Boolean(urlValue), capabilityConfigured: Boolean(capability) })
    return undefined
  }
  let url
  try {
    url = new URL(urlValue)
  } catch {
    console.warn('[enterprise] broker URL is invalid')
    return undefined
  }
  if (
    url.protocol !== 'http:'
    || (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]')
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    console.warn('[enterprise] broker URL must be an HTTP loopback origin without credentials, query or hash')
    return undefined
  }
  return { origin: url.origin, capability }
}

async function readJson(request) {
  const text = await request.text()
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error('Request body is too large.')
  if (!text) return {}
  const body = JSON.parse(text)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Request body must be a JSON object.')
  }
  return body
}

function jsonResponse(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' }
  })
}

function registerJsonRoute(connection, path, methods, handler) {
  connection.fetch.register({
    path,
    methods,
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return jsonResponse(await handler(request))
      } catch (error) {
        const status = Number(error?.status) || 400
        return jsonResponse({ ok: false, error: errorMessage(error) }, status)
      }
    }
  })
}

function unavailable() {
  throw Object.assign(new Error('Enterprise login is not available yet.'), { status: 503 })
}

async function brokerChat(broker, body, signal, attribution, connectionKey) {
  if (!broker) unavailable()
  let response
  try {
    response = await fetch(new URL(connectionKey === undefined ? '/v1/chat' : '/v1/responses', `${broker.origin}/`), {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        authorization: `Bearer ${broker.capability}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ request: body, attribution, ...(connectionKey === undefined ? {} : { connectionKey }) })
    })
  } catch (error) {
    if (signal?.aborted) throw error
    console.warn('[enterprise] broker model request failed', error)
    unavailable()
  }
  return response
}

async function requestBrokerJson(broker, path, body, signal) {
  if (!broker) unavailable()
  let response
  try {
    response = await fetch(new URL(path, `${broker.origin}/`), {
      method: body === undefined ? 'GET' : 'POST',
      signal,
      redirect: 'error',
      headers: {
        authorization: `Bearer ${broker.capability}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  } catch (error) {
    signal?.throwIfAborted()
    console.warn('[enterprise] broker request failed', { path }, error)
    unavailable()
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(typeof payload.error === 'string' ? payload.error : `Enterprise request failed (${response.status}).`), {
      status: response.status,
      ...(typeof payload.errorCode === 'string' && payload.errorCode ? { errorCode: payload.errorCode } : {})
    })
  }
  return payload
}

export function apply(ctx) {
  const broker = brokerConfig()
  const brokerJson = (path, body, signal) => requestBrokerJson(broker, path, body, signal)
  const connection = Reflect.get(ctx, 'connection')
  let market
  let workbenches
  let capabilityPolicy
  let account = disabledState()
  let workSkills
  let workResources
  let workCapabilities
  let ingestEnterpriseState = () => undefined
  const thirdPartyFlags = () => {
    const snap = capabilityPolicy?.snapshot()
    const connected = account.connected === true && snap?.connected === true && snap?.connectionKey === account.connectionKey
    return {
      allowThirdPartyPlugins: connected && snap.allowThirdPartyPlugins === true,
      allowThirdPartyWorkbenches: connected && snap.allowThirdPartyWorkbenches === true
    }
  }
  const readBrokerState = async () => {
    const state = broker ? await brokerJson('/v1/state') : disabledState()
    if (account.connectionKey !== state.connectionKey) {
      await market?.stop()
      await workbenches?.stop()
      capabilityPolicy?.reset()
    }
    if (!state.connected || account.connectionKey !== state.connectionKey) { workResources?.clear(); workSkills?.clear(); workCapabilities?.clear() }
    account = state
    if (!state.connected) capabilityPolicy?.reset()
    else void capabilityPolicy?.refresh(state.connectionKey).catch(() => undefined)
    ingestEnterpriseState(state)
    return { ...state, ...thirdPartyFlags() }
  }
  const marketRequest = async (path, body, binary = false) => {
    if (!broker) unavailable()
    const response = await fetch(new URL('/v1/market', broker.origin), {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${broker.capability}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path, connectionKey: account.connectionKey, ...(body === undefined ? {} : { body }) })
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      const failure = new Error(payload.error || `Enterprise market request failed (${response.status}).`)
      if (typeof payload.errorCode === 'string' && payload.errorCode) failure.code = payload.errorCode
      throw failure
    }
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json()
  }
  if (typeof ctx.inject === 'function') ctx.inject(['tools', 'sessions', 'systemPrompt'], scoped => { workResources = applyWorkResources(scoped, {
    state: () => account, refreshState: readBrokerState,
    request: (body, signal) => brokerJson('/v1/work-resources', body, signal)
  }) })
  if (typeof ctx.inject === 'function') ctx.inject(['skills'], scoped => { workSkills = applyEnterpriseSkills(scoped, {
    state: () => account, refreshState: readBrokerState,
    request: async (body, signal) => {
      if (!broker) unavailable()
      const response = await fetch(new URL('/v1/work-skills', broker.origin), {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${broker.capability}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
      })
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Skill request failed (${response.status}).`)
      return body.operation === 'bundle' ? Buffer.from(await response.arrayBuffer()) : response.json()
    }
  }) })
  if (typeof ctx.inject === 'function') ctx.inject(['tools', 'sessions'], scoped => {
    workCapabilities = applyWorkCapabilities(scoped, {
      state: () => account, refreshState: readBrokerState,
      request: (body, signal) => brokerJson('/v1/work-mcp', body, signal)
    })
  })
  const verifyWorkbenchArtifact = async (input) => {
    if (!broker) unavailable()
    const response = await fetch(new URL('/v1/workbench/verify', broker.origin), {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${broker.capability}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, connectionKey: account.connectionKey })
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw Object.assign(new Error(payload.error || `Enterprise workbench verification failed (${response.status}).`), { status: response.status })
    }
    return payload
  }
  const materializeWorkbenchArtifact = async (input) => {
    if (!broker) unavailable()
    const response = await fetch(new URL('/v1/workbench/materialize', broker.origin), {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${broker.capability}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, connectionKey: account.connectionKey })
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw Object.assign(new Error(payload.error || `Enterprise workbench installation failed (${response.status}).`), { status: response.status })
    }
    return payload
  }
  const releaseWorkbenchArtifact = async (ticket, connectionKey) => {
    if (!broker || typeof ticket !== 'string' || typeof connectionKey !== 'string') return
    await fetch(new URL('/v1/workbench/release', broker.origin), {
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${broker.capability}`, 'content-type': 'application/json' },
      body: JSON.stringify({ connectionKey, ticket })
    }).catch(() => undefined)
  }
  applyEnterpriseAuth(ctx)
  const grants = new WeakMap()
  const auth = {
    async grant(identity) {
      const value = await brokerJson('/v1/auth/grant', identity)
      if (typeof value.capability !== 'string' || !value.capability) throw new Error('Invalid enterprise grant.')
      const transport = createEnterpriseAuthTransport(broker.origin, value.capability)
      grants.set(transport, value.capability)
      return transport
    },
    async revoke(transport) {
      const capability = grants.get(transport)
      if (capability) {
        await brokerJson('/v1/auth/revoke', { capability })
        grants.delete(transport)
      }
    }
  }
  const accountController = {
    state: () => account,
    refreshState: readBrokerState,
    refreshProfile: readBrokerState,
    marketRequest,
    verifyWorkbenchArtifact,
    materializeWorkbenchArtifact,
    releaseWorkbenchArtifact
  }
  market = applyEnterpriseMarket(ctx, accountController, { auth })
  workbenches = applyEnterpriseWorkbenchMarket(ctx, accountController)
  if (typeof ctx.provide === 'function') {
    ctx.provide('enterpriseWorkbenchPackages', {
      async open(id) {
        const opened = await workbenches.packageForInstall(id)
        return {
          path: opened.path,
          packageName: opened.packageName,
          version: opened.version,
          release: () => releaseWorkbenchArtifact(opened.ticket, opened.connectionKey)
        }
      }
    })
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['enterpriseCapabilityPolicy'], (scoped) => {
      capabilityPolicy = scoped.enterpriseCapabilityPolicy
      const disposeResolver = capabilityPolicy.registerResolver(async () => {
        const connectionKey = account.connectionKey
        if (!account.connected || !connectionKey) return { connected: false, connectionKey, authoritative: true }
        try {
          const envelope = await marketRequest('/api/v1/dsh/market/capabilities')
          if (account.connectionKey !== connectionKey) return { stale: true, connectionKey }
          const parsed = envelope?.status_code === 200
            ? parseThirdPartyPolicy(envelope.data)
            : parseThirdPartyPolicy(undefined)
          return { connected: true, connectionKey, authoritative: true, ...parsed }
        } catch {
          if (account.connectionKey !== connectionKey) return { stale: true, connectionKey }
          return { connected: true, connectionKey, authoritative: true, ...parseThirdPartyPolicy(undefined) }
        }
      })
      if (account.connected) void capabilityPolicy.refresh(account.connectionKey).catch(() => undefined)
      return () => {
        disposeResolver()
        capabilityPolicy = undefined
      }
    })
  }
  registerJsonRoute(connection, LOCAL_PATHS.state, ['GET'], async () => readBrokerState())
  registerJsonRoute(connection, LOCAL_PATHS.inspectBase, ['POST'], async (request) => {
    const body = await readJson(request)
    return inspectedBase(normalizeEnterpriseServerUrl(String(body?.base ?? ''), inspectUrlOptions()))
  })
  registerJsonRoute(connection, LOCAL_PATHS.start, ['POST'], async (request) => {
    const body = await readJson(request)
    return brokerJson('/v1/login/start', {
      base: String(body?.base ?? ''),
      ...(body?.confirmInsecurePrivateHttp === true ? { confirmInsecurePrivateHttp: true } : {})
    })
  })
  registerJsonRoute(connection, LOCAL_PATHS.manual, ['POST'], async (request) => {
    const body = await readJson(request)
    const state = await brokerJson('/v1/login/manual', { identityTicket: String(body?.identityTicket ?? '') })
    if (!state.connected || account.connectionKey !== state.connectionKey) { workResources?.clear(); workSkills?.clear(); workCapabilities?.clear() }
    account = state
    ingestEnterpriseState(state)
    if (state.connected) await capabilityPolicy?.refresh(state.connectionKey).catch(() => undefined)
    return { ...state, ...thirdPartyFlags() }
  })
  registerJsonRoute(connection, LOCAL_PATHS.inspectDeepLink, ['POST'], async (request) => {
    const body = await readJson(request)
    const parsed = parseEnterpriseLoginDeepLink(String(body?.url ?? ''), inspectUrlOptions())
    return inspectedBase(parsed.serverUrl)
  })
  registerJsonRoute(connection, LOCAL_PATHS.confirmDeepLink, ['POST'], async (request) => {
    const body = await readJson(request)
    return brokerJson('/v1/login/start', {
      base: String(body?.base ?? ''),
      ...(body?.confirmInsecurePrivateHttp === true ? { confirmInsecurePrivateHttp: true } : {})
    })
  })
  registerJsonRoute(connection, LOCAL_PATHS.refreshModels, ['POST'], async (request) => {
    await readJson(request)
    if (!broker) return disabledState()
    const state = await brokerJson('/v1/models/refresh', {})
    ingestEnterpriseState(state)
    return state
  })
  registerJsonRoute(connection, LOCAL_PATHS.refresh, ['POST'], async (request) => {
    await readJson(request)
    if (!broker) return disabledState()
    const state = await brokerJson('/v1/refresh', {})
    ingestEnterpriseState(state)
    return state
  })
  registerJsonRoute(connection, LOCAL_PATHS.logout, ['POST'], async (request) => {
    await readJson(request)
    if (!broker) return disabledState()
    const state = await brokerJson('/v1/logout', {})
    await market.stop()
    await workbenches?.stop()
    capabilityPolicy?.reset()
    if (!state.connected || account.connectionKey !== state.connectionKey) { workResources?.clear(); workSkills?.clear(); workCapabilities?.clear() }
    account = state
    ingestEnterpriseState(state)
    return { ...state, allowThirdPartyPlugins: false, allowThirdPartyWorkbenches: false }
  })
  const llm = ctx.llm
  if (llm && broker) {
    const handle = startEnterpriseLlm(ctx, llm, broker)
    ingestEnterpriseState = handle.ingest
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => handle.dispose, 'dsh-desktop-enterprise: poll broker state')
    }
  }
}

function contentSafetyLocale(request) {
  const authority = request.headers.host
  const cookie = request.headers.cookie
  if (typeof authority !== 'string' || typeof cookie !== 'string') return undefined
  const name = 'dshEnterpriseSafetyLocale_' + encodeURIComponent(authority.toLowerCase())
  const values = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='))
  if (values.length !== 1) return undefined
  const value = values[0].slice(name.length + 1)
  if (value.length > 2048) return undefined
  try {
    const payload = JSON.parse(decodeURIComponent(value))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'messages')
      || typeof payload.owner !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.owner)) return undefined
    const messages = payload.messages
    const codes = Object.keys(CONTENT_SAFETY_ERROR_COPY)
    if (!messages || typeof messages !== 'object' || Array.isArray(messages)
      || Object.keys(messages).length !== codes.length
      || !codes.every(code => typeof messages[code] === 'string'
        && Object.values(CONTENT_SAFETY_ERROR_COPY[code]).includes(messages[code]))) return undefined
    return Object.freeze(messages)
  } catch {
    // Locale is an optional display hint, never an authentication or model input.
    return undefined
  }
}

function startEnterpriseLlm(ctx, llm, broker) {
  const safetyLocale = new AsyncLocalStorage()
  const disposeSafetyLocale = ctx.on('connection/request', (request, _response, next) =>
    safetyLocale.run(contentSafetyLocale(request), next))
  const safetyLocaleScope = createContentSafetyLocaleScope(ctx, () => safetyLocale.getStore())
  let latest = disabledState()
  let models = []
  let modelsAvailable = false
  let revision = -1
  let registration
  let timer
  let stopped = false
  const titles = createAuditTitleSync({
    ctx,
    async send(body, signal) {
      if (!broker) throw new Error('Enterprise broker unavailable.')
      const response = await fetch(new URL('/v1/audit/conversations/title', broker.origin), {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${broker.capability}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw Object.assign(new Error('Audit title synchronization failed.'), { status: response.status })
      }
      return response.json()
    },
    note: (reason, details) => console.warn('[enterprise-audit-title]', JSON.stringify({ reason, ...details }))
  })
  const adapter = new EnterpriseLlmAdapter({
    providerName: () => latest.tenant?.name || latest.user?.display_name || 'BiSheng Enterprise',
    models: () => modelsAvailable ? models : [],
    auditFields: () => latest.connected ? latest.audit_context?.fields ?? [] : [],
    resolveAuditSession: (id) => {
      titles.track(id)
      try {
        const header = ctx.get?.('sessions')?.get(id)?.header
        if (!header || header.id !== id) return undefined
        if (header.origin === 'subagent') return { session_origin: 'subagent', parent_conversation_id: header.parentSession }
        return header.origin === undefined ? { session_origin: 'main' } : undefined
      } catch {
        // Sessions are optional; unavailable provenance never blocks model generation.
        return undefined
      }
    },
    request: (body, signal, headers) => brokerChat(broker, body, signal, pickAttributionHeaders(headers)),
    requestResponses: (body, signal, headers, connectionKey) => brokerChat(broker, body, signal, pickAttributionHeaders(headers), connectionKey),
    connectionKey: () => latest.connectionKey,
    contentSafetyFormatterFor: options => safetyLocaleScope.formatterFor(options),
    onReplayDegrade: (reason) => ctx.logger?.info?.(`Enterprise Responses replay degraded: ${reason}`),
    readImage: (ref, signal) => ctx.get?.('attachments')?.readImageRequest?.(ref, {
      ...requestImageDimensions(ref.width, ref.height, 4_194_304),
      maxBytes: 5 * 1024 * 1024
    }, signal)
  })

  const ingest = (state) => {
    latest = state
    titles.ingest(state)
    if (state.revision === revision) return
    const nextRevision = Number.isSafeInteger(state.revision) ? state.revision : revision
    models = Array.isArray(state.models) ? state.models : []
    modelsAvailable = state.modelsAvailable === true && models.length > 0
    if (modelsAvailable) {
      if (!registration) registration = llm.registerAdapter([BISHENG_PROVIDER_ROUTE], adapter)
      else registration.replace([BISHENG_PROVIDER_ROUTE])
    } else if (registration) {
      registration.replace([])
    }
    revision = nextRevision
  }

  const poll = async () => {
    if (stopped) return
    try {
      ingest(broker ? await requestBrokerJson(broker, '/v1/state') : disabledState())
    } catch {
      // Keep the last published catalog until the next local snapshot.
    }
    const delay = ['authorizing', 'refreshing'].includes(latest.phase)
      ? 1_000
      : latest.connected
        ? 30_000
        : 60_000
    timer = setTimeout(() => { void poll() }, delay)
    timer.unref?.()
  }
  void poll()
  return {
    ingest(state) {
      if (stopped) return
      try {
        ingest(state)
      } catch {
        // Settings reads must not fail if adapter registration throws.
      }
    },
    dispose() {
      stopped = true
      disposeSafetyLocale()
      safetyLocaleScope.dispose()
      safetyLocale.disable()
      titles.dispose()
      if (timer) clearTimeout(timer)
      registration?.()
    }
  }
}
