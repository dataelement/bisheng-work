import { describe, expect, it, vi } from 'vitest'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { EnterpriseLlmAdapter } from '../packages/dsh-desktop-enterprise/openai.js'
import { CONTENT_SAFETY_ERROR_COPY } from '../packages/dsh-desktop-enterprise/error-copy.js'

// Coverage AC: AC-05, AC-23, AC-24, AC-29, AC-30, AC-31, AC-32, AC-56.
const connectionKey = '1234567890abcdef'
const model = {
  id: 'bisheng:42', display_name: 'Synthetic safety Responses',
  capabilities: { streaming: true, tools: true, responses: true },
  reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }
}
const tenantReply = 'Tenant response policy Ω: please revise the request.'
const visible = { id: 'msg_safe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Safe visible prefix.', annotations: [] }] }
const tool = { id: 'fc_safe', type: 'function_call', call_id: 'call_safe', name: 'lookup', arguments: '{"q":"complete"}', status: 'completed' }
const reasoning = { id: 'rs_safe', type: 'reasoning', summary: [], encrypted_content: 'synthetic-encrypted-reasoning' }
const knownUsage = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 8 } }
const options = (messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic request' }] })]) => ({
  provider: 'enterprise', model: model.id, sessionId: 'safety-responses-session', messages,
  tools: [{ name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } }]
})
const finalResponse = (output, usage = knownUsage) => ({ id: 'resp_safe', object: 'response', status: 'completed', model: model.id, output, usage })
const created = () => ({ type: 'response.created', response: { ...finalResponse([]), status: 'in_progress', usage: null } })
const added = (item, output_index = 0) => ({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : { arguments: '' }) } })
const itemDone = (item, output_index = 0) => ({ type: 'response.output_item.done', output_index, item })
const complete = (output, usage = knownUsage) => ({ type: 'response.completed', response: finalResponse(output, usage) })
const eventBytes = (event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`
const events = (values) => values.map(eventBytes).join('')
// The Gateway's terminal safety error is deliberately unsequenced.
const safetyError = (code, nested = false, message = tenantReply) => `event: error\ndata: ${JSON.stringify({
  type: 'error', ...(nested ? { error: { type: 'content_safety', code, message } } : { code, message }), request_id: 'responses-safety-request'
})}\n\n`
function fixture(reply, hooks = {}) {
  const sent = []
  let chatCalls = 0
  const adapter = new EnterpriseLlmAdapter({
    models: () => [model], connectionKey: () => connectionKey,
    localizeContentSafety: hooks.localizeContentSafety,
    contentSafetyFormatterFor: hooks.contentSafetyFormatterFor,
    request: () => { chatCalls += 1; throw new Error('Native Responses must not fall back to Chat') },
    requestResponses: async (request) => { sent.push(request); return reply() }
  })
  return { adapter, sent, chatCalls: () => chatCalls }
}
const sse = (body) => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
async function observe(adapter, input = options()) {
  const chunks = []
  let thrown
  try {
    for await (const chunk of adapter.stream(input)) chunks.push(chunk)
  } catch (error) { thrown = error }
  const assembler = new BlockAssembler()
  chunks.forEach((chunk) => assembler.push(chunk))
  return { chunks, assembler, failure: thrown?.failure ?? chunks.findLast((chunk) => chunk.type === 'finish' && chunk.reason.kind === 'error')?.reason.failure }
}
function expectFailure(result, code) {
  expect(result.failure).toMatchObject({ code })
  expect(result.failure.code).not.toBe('UPSTREAM_ERROR')
  expect(result.failure.code).not.toBe('INVALID_RESPONSE')
  expect(result.chunks.filter((chunk) => chunk.type === 'finish' && chunk.reason.kind !== 'error')).toEqual([])
  expect(result.assembler.replayState).toBeUndefined()
}
function expectNoCompletedTool(result) {
  expect(result.chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toEqual([])
  expect(result.assembler.interruptedBlocks().some((block) => block.type === 'tool-call')).toBe(false)
}

describe('enterprise Responses content safety', () => {
  it.each([
    ['content_blocked', 'CONTENT_FILTERED', false],
    ['check_unavailable', 'CONTENT_CHECK_UNAVAILABLE', false],
    ['content_blocked', 'CONTENT_FILTERED', true],
    ['check_unavailable', 'CONTENT_CHECK_UNAVAILABLE', true]
  ])('recognizes unsequenced %s as %s before sequence validation (nested=%s)', async (code, expected, nested) => {
    const { adapter, sent, chatCalls } = fixture(() => sse(safetyError(code, nested)))
    const result = await observe(adapter)
    expect(sent).toHaveLength(1)
    expect(chatCalls()).toBe(0)
    expectFailure(result, expected)
    expect(result.failure).toMatchObject({ message: tenantReply, requestId: 'responses-safety-request' })
    expectNoCompletedTool(result)
  })

  it.each([
    [403, 'content_blocked', 'CONTENT_FILTERED'],
    [503, 'check_unavailable', 'CONTENT_CHECK_UNAVAILABLE']
  ])('normalizes HTTP %i %s without retry or protocol fallback', async (status, code, expected) => {
    const { adapter, sent, chatCalls } = fixture(() => new Response(JSON.stringify({
      error: { type: 'content_safety', code, message: tenantReply }, request_id: 'responses-http-request'
    }), { status, headers: { 'content-type': 'application/json' } }))
    const result = await observe(adapter)
    expect(sent).toHaveLength(1)
    expect(chatCalls()).toBe(0)
    expectFailure(result, expected)
    expect(result.failure).toMatchObject({ status, requestId: 'responses-http-request', message: tenantReply })
  })

  it('preserves the checked text prefix when an unsequenced unavailable error follows it', async () => {
    const body = events([created(), added(visible), itemDone(visible)]) + safetyError('check_unavailable')
    const { adapter, sent } = fixture(() => sse(body))
    const result = await observe(adapter)
    expect(sent).toHaveLength(1)
    expect(result.assembler.interruptedBlocks()).toEqual([{ type: 'text', text: 'Safe visible prefix.' }])
    expectFailure(result, 'CONTENT_CHECK_UNAVAILABLE')
  })

  it.each([
    ['content_blocked', 'CONTENT_FILTERED'],
    ['check_unavailable', 'CONTENT_CHECK_UNAVAILABLE']
  ])('keeps a completed tool snapshot non-executable when the turn ends with %s', async (code, expected) => {
    const body = events([created(), added(visible), itemDone(visible), added(tool, 1), itemDone(tool, 1)]) + safetyError(code)
    const { adapter, sent, chatCalls } = fixture(() => sse(body))
    const result = await observe(adapter)
    expect(sent).toHaveLength(1)
    expect(chatCalls()).toBe(0)
    expect(result.chunks).toContainEqual(expect.objectContaining({ type: 'block-start', blockType: 'tool-call' }))
    expectNoCompletedTool(result)
    expectFailure(result, expected)
    expect(result.assembler.interruptedBlocks()).toEqual([{ type: 'text', text: 'Safe visible prefix.' }])
  })

  it('keeps complete argument deltas non-executable until the entire turn succeeds', async () => {
    const body = events([
      created(), added(tool),
      { type: 'response.function_call_arguments.delta', item_id: tool.id, output_index: 0, delta: tool.arguments },
      { type: 'response.function_call_arguments.done', item_id: tool.id, output_index: 0, arguments: tool.arguments },
      itemDone(tool)
    ]) + safetyError('content_blocked')
    const { adapter, sent } = fixture(() => sse(body))
    const result = await observe(adapter)
    expect(sent).toHaveLength(1)
    expect(result.chunks).toContainEqual(expect.objectContaining({ type: 'tool-call-delta', argumentsDelta: tool.arguments }))
    expectNoCompletedTool(result)
    expectFailure(result, 'CONTENT_FILTERED')
  })

  it.each(['{"q":', 'true'])('does not make incomplete or non-object arguments executable: %s', async (argumentsText) => {
    const incomplete = { ...tool, arguments: argumentsText }
    const { adapter, sent } = fixture(() => sse(events([
      created(), added(incomplete), itemDone(incomplete), complete([incomplete])
    ])))
    const result = await observe(adapter)
    expect(sent).toHaveLength(1)
    expectNoCompletedTool(result)
    expect(result.failure).toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(result.chunks.filter((chunk) => chunk.type === 'finish')).toEqual([])
    expect(result.assembler.replayState).toBeUndefined()
  })

  it('does not release a complete tool when the terminal response has no confirmed status', async () => {
    const final = complete([tool])
    delete final.response.status
    const { adapter, sent } = fixture(() => sse(events([created(), added(tool), itemDone(tool), final])))
    const result = await observe(adapter)
    expect(sent).toHaveLength(1)
    expectNoCompletedTool(result)
    expect(result.failure).toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(result.chunks.filter((chunk) => chunk.type === 'finish')).toEqual([])
    expect(result.assembler.replayState).toBeUndefined()
  })

  it('preserves the safe prefix and max-tokens finish when tool arguments were truncated', async () => {
    const truncated = { ...tool, arguments: '{"q":', status: 'incomplete' }
    const terminal = {
      type: 'response.incomplete',
      response: { ...finalResponse([visible, truncated]), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
    }
    const { adapter, sent } = fixture(() => sse(events([
      created(), added(visible), itemDone(visible), added(truncated, 1), itemDone(truncated, 1), terminal
    ])))
    const result = await observe(adapter)
    expect(sent).toHaveLength(1)
    expect(result.failure).toBeUndefined()
    expectNoCompletedTool(result)
    expect(result.assembler.blocks()).toEqual([{ type: 'text', text: 'Safe visible prefix.' }])
    expect(result.chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('keeps native tool IDs, usage, encrypted replay, and the successful finish unchanged', async () => {
    const output = [reasoning, tool]
    const { adapter, sent, chatCalls } = fixture(() => sse(events([created(), added(tool, 1), itemDone(tool, 1), complete(output)])))
    const result = await observe(adapter)
    expect(result.failure).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(chatCalls()).toBe(0)
    const completed = result.chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
    expect(completed.filter((block) => block.type === 'tool-call')).toEqual([
      { type: 'tool-call', id: 'call_safe|fc_safe', name: 'lookup', arguments: tool.arguments }
    ])
    expect(result.chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 12, cacheReadTokens: 8 } })
    expect(result.chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(JSON.stringify(completed)).not.toContain(reasoning.encrypted_content)
    const assistant = JSON.parse(JSON.stringify(result.assembler.message({ provider: 'enterprise', model: model.id, replayState: result.assembler.replayState })))
    await observe(adapter, options([assistant, ...options().messages]))
    expect(sent).toHaveLength(2)
    expect(sent[1].input).toContainEqual(reasoning)
    expect(sent[1].input).toContainEqual(tool)
    expect(sent[1].include).toEqual(['reasoning.encrypted_content'])
  })

  it('does not fabricate known usage from a successful nullable usage snapshot', async () => {
    const { adapter, sent } = fixture(() => sse(events([created(), added(visible), itemDone(visible), complete([visible], null)])))
    const result = await observe(adapter)
    expect(result.failure).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(result.chunks.filter((chunk) => chunk.type === 'usage')).toEqual([])
    expect(result.chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('still rejects an unsequenced ordinary data event as a protocol error', async () => {
    const invalid = 'event: response.created\ndata: ' + JSON.stringify(created()) + '\n\n'
    const { adapter, sent } = fixture(() => sse(invalid))
    const result = await observe(adapter)
    expect(sent).toHaveLength(1)
    expect(result.failure).toMatchObject({ code: 'INVALID_RESPONSE' })
    expectNoCompletedTool(result)
  })
})

// Coverage AC: AC-03, AC-30, AC-31, AC-56. Responses shares the adapter's optional locale context.
describe('enterprise Responses content safety locale context', () => {
  it.each([
    ['content_blocked', 'CONTENT_FILTERED'],
    ['check_unavailable', 'CONTENT_CHECK_UNAVAILABLE']
  ])('uses current locale context for an unsequenced %s without a custom message', async (code, expected) => {
    let active = 'zh'
    const localizeContentSafety = vi.fn((normalizedCode, defaultMessage) => {
      expect(defaultMessage).toEqual(expect.any(String))
      expect(defaultMessage.length).toBeGreaterThan(0)
      return CONTENT_SAFETY_ERROR_COPY[normalizedCode][active]
    })
    const body = `event: error\ndata: ${JSON.stringify({ type: 'error', code, request_id: 'responses-locale-request' })}\n\n`
    const { adapter, sent, chatCalls } = fixture(() => sse(body), { localizeContentSafety })
    for (const language of ['zh', 'en', 'ja']) {
      active = language
      const result = await observe(adapter)
      expectFailure(result, expected)
      expect(result.failure).toMatchObject({ message: CONTENT_SAFETY_ERROR_COPY[expected][language], requestId: 'responses-locale-request' })
    }
    expect(sent).toHaveLength(3)
    expect(chatCalls()).toBe(0)
    expect(localizeContentSafety).toHaveBeenCalledTimes(3)
    expect(localizeContentSafety.mock.calls.every(([code]) => code === expected)).toBe(true)
  })

  it('passes locale context through the native Responses HTTP failure path', async () => {
    const localizeContentSafety = vi.fn((code) => CONTENT_SAFETY_ERROR_COPY[code].ja)
    const { adapter, sent } = fixture(() => new Response(JSON.stringify({ error: { code: 'check_unavailable' } }), {
      status: 503, headers: { 'content-type': 'application/json' }
    }), { localizeContentSafety })
    const result = await observe(adapter)
    expectFailure(result, 'CONTENT_CHECK_UNAVAILABLE')
    expect(result.failure.message).toBe(CONTENT_SAFETY_ERROR_COPY.CONTENT_CHECK_UNAVAILABLE.ja)
    expect(localizeContentSafety).toHaveBeenCalledOnce()
    expect(sent).toHaveLength(1)
  })

  it('localizes the real Gateway unavailable sentence through the shared callback', async () => {
    let active = 'zh'
    const localizeContentSafety = vi.fn((code) => CONTENT_SAFETY_ERROR_COPY[code][active])
    const { adapter, sent } = fixture(() => sse(safetyError('check_unavailable', false, 'Content check unavailable')), { localizeContentSafety })
    for (const language of ['zh', 'en', 'ja']) {
      active = language
      const result = await observe(adapter)
      expectFailure(result, 'CONTENT_CHECK_UNAVAILABLE')
      expect(result.failure.message).toBe(CONTENT_SAFETY_ERROR_COPY.CONTENT_CHECK_UNAVAILABLE[language])
    }
    expect(sent).toHaveLength(3)
    expect(localizeContentSafety).toHaveBeenCalledTimes(3)
  })

  it.each([tenantReply, CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED.en])('never replaces an explicit native tenant reply: %s', async (message) => {
    const localizeContentSafety = vi.fn(() => 'This must not replace tenant copy.')
    const { adapter, sent } = fixture(() => sse(safetyError('content_blocked', true, message)), { localizeContentSafety })
    const result = await observe(adapter)
    expectFailure(result, 'CONTENT_FILTERED')
    expect(result.failure.message).toBe(message)
    expect(localizeContentSafety).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  })

  it.each(['invalid_access_token', 'monthly_token_limit_exceeded'])('does not route ordinary native %s through safety localization', async (code) => {
    const localizeContentSafety = vi.fn(() => 'This must not replace account failure.')
    const { adapter, sent } = fixture(() => sse(safetyError(code, true, 'Ordinary account failure.')), { localizeContentSafety })
    const result = await observe(adapter)
    expect(result.failure).toMatchObject({ code, message: 'Ordinary account failure.' })
    expect(localizeContentSafety).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  })

  it.each(['empty', 'invalid', 'throws'])('preserves the fixed safety fallback when the locale callback %s', async (mode) => {
    const localizeContentSafety = vi.fn(() => {
      if (mode === 'throws') throw new Error('Synthetic locale diagnostic must stay private.')
      return mode === 'empty' ? '   ' : { message: 'Not a string' }
    })
    const { adapter } = fixture(() => sse('event: error\ndata: {"type":"error","code":"content_blocked"}\n\n'), { localizeContentSafety })
    const result = await observe(adapter)
    expectFailure(result, 'CONTENT_FILTERED')
    expect(Object.values(CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED)).toContain(result.failure.message)
    expect(result.failure.message).not.toContain('diagnostic')
    expect(localizeContentSafety).toHaveBeenCalledOnce()
  })

  it('keeps the Gateway safety request ID when a native backend header carries another ID', async () => {
    const body = safetyError('check_unavailable')
    const { adapter, sent } = fixture(() => new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'synthetic-backend-uuid' }
    }))
    const result = await observe(adapter)
    expectFailure(result, 'CONTENT_CHECK_UNAVAILABLE')
    expect(result.failure.requestId).toBe('responses-safety-request')
    expect(sent).toHaveLength(1)
  })

  it('keeps the backend header request ID for ordinary native quota errors', async () => {
    const { adapter, sent } = fixture(() => new Response(JSON.stringify({
      error: { code: 'monthly_token_limit_exceeded', message: 'Ordinary quota failure.' }, request_id: 'synthetic-body-uuid'
    }), { status: 429, headers: { 'content-type': 'application/json', 'x-request-id': 'synthetic-backend-uuid' } }))
    const result = await observe(adapter)
    expect(result.failure).toMatchObject({ code: 'monthly_token_limit_exceeded', requestId: 'synthetic-backend-uuid' })
    expect(sent).toHaveLength(1)
  })

  it('keeps the existing native fallback when no locale callback is provided', async () => {
    const body = 'event: error\ndata: {"type":"error","code":"check_unavailable"}\n\n'
    const { adapter } = fixture(() => sse(body))
    const result = await observe(adapter)
    expectFailure(result, 'CONTENT_CHECK_UNAVAILABLE')
    expect(Object.values(CONTENT_SAFETY_ERROR_COPY.CONTENT_CHECK_UNAVAILABLE)).toContain(result.failure.message)
  })
})


// Coverage AC: AC-03, AC-30, AC-31, AC-56. Formatter creation is per protocol stream;
// it is not a mutable last-session cache and never becomes model input.
describe('RESPONSES per-stream safety formatter factory', () => {
  it.each(['chat', 'compaction', 'session-title'])('captures the formatter once before transport for purpose %s', async purpose => {
    let active = 'zh'
    const localizeContentSafety = vi.fn(() => 'Legacy callback must not replace a scoped formatter.')
    const returnedFormatter = vi.fn((code, fallback) => {
      expect(fallback).toBe(CONTENT_SAFETY_ERROR_COPY[code].en)
      return CONTENT_SAFETY_ERROR_COPY[code].zh
    })
    const contentSafetyFormatterFor = vi.fn(scope => {
      expect(active).toBe('zh')
      expect(scope).toEqual({ sessionId: 'safety-responses-session', purpose })
      return returnedFormatter
    })
    const { adapter, sent } = fixture(() => {
      active = 'ja'
      return new Response(JSON.stringify({ error: { code: 'content_blocked' }, request_id: 'factory-responses-request' }), { status: 403, headers: { 'content-type': 'application/json' } })
    }, { localizeContentSafety, contentSafetyFormatterFor })
    const input = { ...options(), ...(purpose === 'chat' ? {} : { purpose }) }
    const result = await observe(adapter, input)
    expectFailure(result, 'CONTENT_FILTERED')
    expect(result.failure).toMatchObject({ message: CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED.zh, requestId: 'factory-responses-request' })
    expect(contentSafetyFormatterFor).toHaveBeenCalledOnce()
    expect(returnedFormatter).toHaveBeenCalledOnce()
    expect(localizeContentSafety).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    expect(JSON.stringify(sent)).not.toContain('CONTENT_FILTERED')
    expect(JSON.stringify(sent)).not.toContain(CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED.zh)
  })

  it('passes an absent session identity explicitly and retains the old callback when the factory has no formatter', async () => {
    const contentSafetyFormatterFor = vi.fn(() => undefined)
    const localizeContentSafety = vi.fn(code => CONTENT_SAFETY_ERROR_COPY[code].ja)
    const { adapter } = fixture(() => new Response(JSON.stringify({ error: { code: 'content_blocked' }, request_id: 'factory-responses-request' }), { status: 403, headers: { 'content-type': 'application/json' } }), { contentSafetyFormatterFor, localizeContentSafety })
    const input = options()
    delete input.sessionId
    const result = await observe(adapter, input)
    expect(result.failure).toMatchObject({ code: 'CONTENT_FILTERED', message: CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED.ja })
    expect(contentSafetyFormatterFor).toHaveBeenCalledExactlyOnceWith({ sessionId: undefined, purpose: 'chat' })
    expect(localizeContentSafety).toHaveBeenCalledOnce()
  })

  it.each([
    ['throws', () => { throw new Error('Synthetic private factory failure') }],
    ['returns an object', () => ({ invalid: true })],
    ['returns an asynchronous value', () => Promise.resolve(() => 'Do not await a synchronous display factory')],
    ['is not callable', 'invalid-factory']
  ])('a factory that %s cannot fail an ordinary model request or alter tenant copy', async (_label, contentSafetyFormatterFor) => {
    const normal = fixture(() => sse(events([created(), added(visible), itemDone(visible), complete([visible])])), { contentSafetyFormatterFor })
    const ordinary = await observe(normal.adapter)
    expect(ordinary.failure).toBeUndefined()
    expect(ordinary.chunks).toContainEqual(expect.objectContaining({ type: 'finish', reason: expect.objectContaining({ kind: 'stop' }) }))
    expect(normal.sent).toHaveLength(1)
    const blocked = fixture(() => new Response(JSON.stringify({ error: { code: 'content_blocked' }, request_id: 'factory-responses-request' }), { status: 403, headers: { 'content-type': 'application/json' } }), { contentSafetyFormatterFor })
    const denied = await observe(blocked.adapter)
    expectFailure(denied, 'CONTENT_FILTERED')
    expect(denied.failure.message).toBe(CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED.en)
    const tenant = fixture(() => new Response(JSON.stringify({ error: { code: 'content_blocked', message: tenantReply }, request_id: 'factory-responses-request' }), { status: 403, headers: { 'content-type': 'application/json' } }), { contentSafetyFormatterFor })
    const custom = await observe(tenant.adapter)
    expectFailure(custom, 'CONTENT_FILTERED')
    expect(custom.failure.message).toBe(tenantReply)
  })

  it('creates but never invokes a safety formatter for a successful ordinary stream', async () => {
    const formatter = vi.fn(() => { throw new Error('Ordinary responses must not request safety text') })
    const contentSafetyFormatterFor = vi.fn(() => formatter)
    const { adapter } = fixture(() => sse(events([created(), added(visible), itemDone(visible), complete([visible])])), { contentSafetyFormatterFor })
    const result = await observe(adapter)
    expect(result.failure).toBeUndefined()
    expect(contentSafetyFormatterFor).toHaveBeenCalledOnce()
    expect(formatter).not.toHaveBeenCalled()
  })

  it('keeps concurrent session formatters independent while transports settle in reverse order', async () => {
    let releaseFirst
    const firstPending = new Promise(resolve => { releaseFirst = resolve })
    let startFirst
    const firstStarted = new Promise(resolve => { startFirst = resolve })
    let transportCalls = 0
    const formatters = []
    const contentSafetyFormatterFor = vi.fn(({ sessionId }) => {
      const language = sessionId === 'first-synthetic-session' ? 'zh' : 'ja'
      const formatter = vi.fn(code => CONTENT_SAFETY_ERROR_COPY[code][language])
      formatters.push(formatter)
      return formatter
    })
    const { adapter, sent } = fixture(async () => {
      transportCalls += 1
      if (transportCalls === 1) { startFirst(); await firstPending }
      return new Response(JSON.stringify({ error: { code: 'content_blocked' }, request_id: 'factory-responses-request' }), { status: 403, headers: { 'content-type': 'application/json' } })
    }, { contentSafetyFormatterFor })
    const first = observe(adapter, { ...options(), sessionId: 'first-synthetic-session' })
    await firstStarted
    try {
      const second = await observe(adapter, { ...options(), sessionId: 'second-synthetic-session' })
      expect(second.failure?.message).toBe(CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED.ja)
    } finally { releaseFirst() }
    expect((await first).failure?.message).toBe(CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED.zh)
    expect(contentSafetyFormatterFor).toHaveBeenCalledTimes(2)
    expect(formatters).toHaveLength(2)
    expect(formatters.every(formatter => formatter.mock.calls.length === 1)).toBe(true)
    expect(sent).toHaveLength(2)
  })
})


// Coverage AC: AC-03, AC-30, AC-31, AC-56.
describe('Responses scoped factory at streaming safety terminals', () => {
  it.each([
    ['content_blocked', false, 'CONTENT_FILTERED'],
    ['content_blocked', true, 'CONTENT_FILTERED'],
    ['check_unavailable', false, 'CONTENT_CHECK_UNAVAILABLE'],
    ['check_unavailable', true, 'CONTENT_CHECK_UNAVAILABLE']
  ])('uses the captured formatter for %s nested=%s', async (signal, nested, code) => {
    const formatter = vi.fn(normalized => CONTENT_SAFETY_ERROR_COPY[normalized].ja)
    const contentSafetyFormatterFor = vi.fn(() => formatter)
    const terminal = 'event: error\ndata: ' + JSON.stringify({
      type: 'error', ...(nested ? { error: { code: signal } } : { code: signal }), request_id: 'factory-responses-stream-id'
    }) + '\n\n'
    const { adapter } = fixture(() => sse(terminal), { contentSafetyFormatterFor })
    const result = await observe(adapter)
    expectFailure(result, code)
    expect(result.failure.message).toBe(CONTENT_SAFETY_ERROR_COPY[code].ja)
    expect(contentSafetyFormatterFor).toHaveBeenCalledOnce()
    expect(formatter).toHaveBeenCalledOnce()
  })
})
