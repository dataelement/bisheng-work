import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { withWorkMcp, readMcpPages } from './work-mcp.js'

const PREFIX = 'mcp__bisheng__'

/** Account-bound enterprise tools; no credential reaches Agent context. */
export function applyWorkCapabilities(ctx, { request, state, refreshState }) {
  let generation = 0, connectionKey, timer, stopped = false, syncing
  let signature = '', disposeTools = [], pickerTools = []
  let lifetime = new AbortController()
  const assertAccount = key => {
    const account = state()
    if (stopped || !account.connected || account.connectionKey !== key) throw new Error('Enterprise account changed.')
  }
  const mainSession = exec => {
    const session = exec.agent?.session
    return session && (session.header?.delegationDepth ?? 0) === 0 && ctx.sessions.get(session.id) === session
  }
  const clear = () => {
    generation++
    lifetime.abort()
    lifetime = new AbortController()
    for (const dispose of disposeTools) dispose()
    disposeTools = []; pickerTools = []; signature = ''; connectionKey = undefined
  }
  const rpc = async (key, signal, use) => {
    assertAccount(key)
    const result = await withWorkMcp(request, key, signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal, use)
    assertAccount(key)
    return result
  }
  const synchronize = async () => {
    if (stopped) throw new Error('Enterprise capability synchronization stopped.')
    const started = generation
    await refreshState()
    if (stopped || generation !== started) throw new Error('Enterprise capability synchronization expired.')
    const account = state()
    if (!account.connected || !account.connectionKey) { clear(); return }
    if (connectionKey && connectionKey !== account.connectionKey) clear()
    const key = account.connectionKey, epoch = generation
    const catalog = await rpc(key, undefined, async client => ({ tools: await readMcpPages(params => client.listTools(params), 'tools') }))
    if (generation !== epoch || stopped) throw new Error('Enterprise capability synchronization expired.')
    const nextSignature = JSON.stringify([key, catalog])
    if (signature === nextSignature) return
    const names = new Set()
    const definitions = catalog.tools.map(tool => {
      if (!/^bisheng_tool_[1-9][0-9]*$/.test(tool.name) || names.has(tool.name)) throw new Error('Invalid enterprise tool name.')
      names.add(tool.name)
      return createMcpToolDefinition(ctx, {
        name: PREFIX + tool.name, rawName: tool.name, description: tool.description || tool.title || tool.name,
        inputSchema: tool.inputSchema,
        call: async (args, exec) => {
          if (!mainSession(exec)) throw new Error('An active main Work task is required.')
          await refreshState()
          return rpc(key, exec.signal, client => client.callTool({ name: tool.name, arguments: args }, { signal: exec.signal, timeout: 65_000 }))
        }
      })
    })
    for (const dispose of disposeTools) dispose()
    disposeTools = []
    try { for (const definition of definitions) disposeTools.push(ctx.tools.register(definition)) }
    catch (error) { clear(); throw error }
    pickerTools = catalog.tools.map(tool => ({ name: PREFIX + tool.name, label: tool.title || tool.name, description: tool.description || '' }))
    connectionKey = key; signature = nextSignature
  }
  const sync = () => syncing ??= synchronize().catch(error => {
    clear()
    throw error
  }).finally(() => { syncing = undefined })
  // A request already in flight may have read the catalog before a saved toggle.
  // Join it, then start a fresh read shared by callers at this boundary.
  const refresh = async () => {
    if (syncing) await syncing
    await sync()
  }
  ctx.on('system-prompt/prepare', async ({ agent, signal }) => {
    if (mainSession({ agent }) && state().connected) {
      signal?.throwIfAborted()
      await refresh()
      signal?.throwIfAborted()
    }
  })

  // The picker and submission validator use the same fresh permission-filtered
  // catalog as native registration. References contain an account fingerprint,
  // keeping a draft owned by the account that selected its tools.
  ctx.connection.fetch.register({
    path: '/api/enterprise.work-tools', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const text = await request.text()
        if (text.length > 16384) throw new Error('Tool selection is too large.')
        const body = JSON.parse(text)
        if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['operation', 'names', 'connectionKey'].includes(key))) throw new Error('Invalid tool request.')
        if (!['catalog', 'validate', 'refresh'].includes(body.operation)) throw new Error('Unknown tool operation.')
        await refresh()
        if (body.operation === 'refresh') return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
        assertAccount(connectionKey)
        if (!connectionKey) throw new Error('Connect your enterprise account in Settings.')
        if (body.operation === 'validate') {
          if (body.connectionKey !== connectionKey) throw new Error('Enterprise account changed. Select tools again.')
          if (!Array.isArray(body.names) || body.names.length > 50 || body.names.some(name => typeof name !== 'string' || !pickerTools.some(tool => tool.name === name))) throw new Error('A selected tool is unavailable. Enable it in Tools & Skills or update your selection.')
          return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
        }
        return Response.json({ tools: pickerTools, connectionKey }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) { return Response.json({ error: error.message }, { status: 400 }) }
    }
  })

  ctx.tools.guard(exec => exec.name.startsWith(PREFIX) && !mainSession(exec) ? 'Enterprise tools require an active main Work task.' : undefined)
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (!exec.name.startsWith(PREFIX) || decision.kind !== 'allow') return decision
    if (!mainSession(exec)) return { kind: 'deny', reason: 'Enterprise tools require an active main Work task.' }
    return { kind: 'ask', reason: 'Use the enterprise tool with the displayed arguments.',
      displayReason: { en: 'Run this enterprise tool with these arguments?', zh: '使用这些参数调用企业工具？' } }
  })
  const poll = async () => {
    if (stopped) return
    try { await sync() }
    catch (error) { ctx.logger.warn('Enterprise Work capabilities: %s', error.message) }
    if (!stopped) { timer = setTimeout(poll, 30_000); timer.unref?.() }
  }
  void poll()
  ctx.effect(() => async () => {
    stopped = true; clearTimeout(timer); clear()
  })
  return { sync, refresh, clear }
}
