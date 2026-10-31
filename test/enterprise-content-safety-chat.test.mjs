import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { EnterpriseLlmAdapter } from '../packages/dsh-desktop-enterprise/openai.js'
import { CONTENT_SAFETY_ERROR_COPY } from '../packages/dsh-desktop-enterprise/error-copy.js'

// Coverage AC: AC-05, AC-24, AC-29, AC-30, AC-31, AC-32, AC-56.
const model = {
  id: 'bisheng:42', display_name: 'Synthetic safety Chat',
  capabilities: { streaming: true, tools: true, reasoning_content: true }
}
const tenantReply = 'Tenant custom reply Ω: keep numbers < 5.'
const options = () => ({
  provider: 'enterprise', model: model.id, sessionId: 'safety-chat-session',
  messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic request' }] })],
  tools: [{ name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } }]
})
const data = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const delta = (value, finish = null) => data({ choices: [{ index: 0, delta: value, finish_reason: finish }] })
const done = 'data: [DONE]\n\n'
const toolDelta = () => delta({ tool_calls: [{ index: 0, id: 'call_safety', type: 'function', function: { name: 'lookup', arguments: '{"q":"complete"}' } }] })
const filter = () => data({
  choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }],
  content_safety: { code: 'content_blocked', message: tenantReply }, request_id: 'chat-filter-request'
}) + done
const error = (code, message = tenantReply) => `event: error\ndata: ${JSON.stringify({
  error: { type: 'content_safety', code, message }, request_id: 'chat-error-request'
})}\n\n`

function fixture(reply, hooks = {}) {
  const calls = []
  const adapter = new EnterpriseLlmAdapter({
    models: () => [model], providerName: () => 'BiSheng',
    localizeContentSafety: hooks.localizeContentSafety,
    contentSafetyFormatterFor: hooks.contentSafetyFormatterFor,
    request: async (body) => { calls.push(body); return reply() }
  })
  return { adapter, calls }
}
function sse(body) {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}
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
  expect(result.chunks.filter((chunk) => chunk.type === 'finish' && chunk.reason.kind !== 'error')).toEqual([])
}
function expectNoCompletedTool(result) {
  expect(result.chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toEqual([])
  expect(result.assembler.interruptedBlocks().some((block) => block.type === 'tool-call')).toBe(false)
}

describe('enterprise Chat content safety', () => {
  it.each([
    [403, 'content_blocked', 'CONTENT_FILTERED'],
    [503, 'check_unavailable', 'CONTENT_CHECK_UNAVAILABLE']
  ])('normalizes HTTP %i %s without replaying the request', async (status, code, expected) => {
    const { adapter, calls } = fixture(() => new Response(JSON.stringify({
      error: { type: 'content_safety', code, message: tenantReply }, request_id: 'body-request'
    }), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'header-request' } }))
    const result = await observe(adapter)
    expect(calls).toHaveLength(1)
    expectFailure(result, expected)
    expect(result.failure).toMatchObject({ status, requestId: 'body-request', message: tenantReply })
    expect(result.chunks).toEqual([])
    expect(adapter.providerRetryPolicy().maxRetries).toBe(0)
    expect(adapter.providerRetryPolicy().retryableCodes).not.toContain(expected)
  })

  it('recognizes content_filter plus DONE and uses the tenant extension as display text', async () => {
    const { adapter, calls } = fixture(() => sse(filter()))
    const result = await observe(adapter)
    expect(calls).toHaveLength(1)
    expectFailure(result, 'CONTENT_FILTERED')
    expect(result.failure.message).toBe(tenantReply)
    expectNoCompletedTool(result)
  })

  it.each([
    ['malformed tail', 'data: not-json\n\ndata: [DONE]\n\n'],
    ['EOF without DONE', '']
  ])('keeps a confirmed content_filter terminal stable across %s', async (_label, suffix) => {
    const terminal = filter().slice(0, -done.length)
    const { adapter, calls } = fixture(() => sse(delta({ content: 'Safe prefix.' }) + toolDelta() + terminal + suffix))
    const result = await observe(adapter)
    expect(calls).toHaveLength(1)
    expectFailure(result, 'CONTENT_FILTERED')
    expect(result.failure.message).toBe(tenantReply)
    expectNoCompletedTool(result)
    expect(result.assembler.interruptedBlocks()).toEqual([{ type: 'text', text: 'Safe prefix.' }])
  })

  it.each([
    ['content_blocked', 'CONTENT_FILTERED'],
    ['check_unavailable', 'CONTENT_CHECK_UNAVAILABLE']
  ])('recognizes event:error %s with the audited request ID', async (code, expected) => {
    const { adapter, calls } = fixture(() => sse(error(code)))
    const result = await observe(adapter)
    expect(calls).toHaveLength(1)
    expectFailure(result, expected)
    expect(result.failure).toMatchObject({ message: tenantReply, requestId: 'chat-error-request' })
    expectNoCompletedTool(result)
  })

  it('keeps a safe visible prefix while an unavailable check settles the turn as an error', async () => {
    const { adapter, calls } = fixture(() => sse(delta({ content: 'Already checked prefix. ' }) + error('check_unavailable', 'Checks temporarily unavailable.')))
    const result = await observe(adapter)
    expect(calls).toHaveLength(1)
    expectFailure(result, 'CONTENT_CHECK_UNAVAILABLE')
    expect(result.assembler.interruptedBlocks()).toEqual([{ type: 'text', text: 'Already checked prefix. ' }])
    expect(result.chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Already checked prefix. ' })
  })

  it.each([
    ['content_filter', () => filter(), 'CONTENT_FILTERED'],
    ['event content_blocked', () => error('content_blocked'), 'CONTENT_FILTERED'],
    ['event check_unavailable', () => error('check_unavailable'), 'CONTENT_CHECK_UNAVAILABLE']
  ])('does not end a complete tool when the final signal is %s', async (_label, terminal, expected) => {
    const { adapter, calls } = fixture(() => sse(delta({ content: 'Safe prefix.' }) + toolDelta() + terminal()))
    const result = await observe(adapter)
    expect(calls).toHaveLength(1)
    // The real adapter has already received the complete arguments before the terminal arrives.
    expect(result.chunks).toContainEqual(expect.objectContaining({ type: 'tool-call-delta', argumentsDelta: '{"q":"complete"}' }))
    expectNoCompletedTool(result)
    expectFailure(result, expected)
    expect(result.assembler.interruptedBlocks()).toEqual([{ type: 'text', text: 'Safe prefix.' }])
  })

  it('does not mistake an ordinary upstream error for a content safety decision', async () => {
    const { adapter, calls } = fixture(() => sse(error('quota_exhausted', 'Synthetic quota exhausted.')))
    const result = await observe(adapter)
    expect(calls).toHaveLength(1)
    expectFailure(result, 'quota_exhausted')
    expect(result.failure.requestId).toBe('chat-error-request')
  })

  it('keeps normal tool completion, reasoning, and cache-aware usage unchanged', async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 3, cache_creation_tokens: 2 } }
    const { adapter, calls } = fixture(() => sse(delta({ reasoning_content: 'Safe reasoning.' }) + toolDelta() + delta({}, 'tool_calls') + data({ choices: [], usage }) + done))
    const result = await observe(adapter)
    expect(result.failure).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(result.chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toEqual([
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_safety', name: 'lookup', arguments: '{"q":"complete"}' } }
    ])
    expect(result.chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 12, cacheReadTokens: 3, cacheWriteTokens: 2 } })
    expect(result.assembler.blocks()).toContainEqual({ type: 'reasoning', text: 'Safe reasoning.' })
    expect(result.chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('does not turn unknown normal usage into zero counts', async () => {
    const { adapter, calls } = fixture(() => sse(delta({ content: 'Normal answer.' }) + delta({}, 'stop') + data({ choices: [], usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null } }) + done))
    const result = await observe(adapter)
    expect(result.failure).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(result.chunks.filter((chunk) => chunk.type === 'usage')).toEqual([])
    expect(result.chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})

// Coverage AC: AC-03, AC-30, AC-31, AC-56. Optional locale context must reach real error consumers.
describe('enterprise Chat content safety locale context', () => {
  it.each([
    [403, 'content_blocked', 'CONTENT_FILTERED'],
    [503, 'check_unavailable', 'CONTENT_CHECK_UNAVAILABLE']
  ])('uses the current locale callback for HTTP %i missing-message defaults', async (status, code, expected) => {
    let active = 'zh'
    const localizeContentSafety = vi.fn((normalizedCode, defaultMessage) => {
      expect(defaultMessage).toEqual(expect.any(String))
      expect(defaultMessage.length).toBeGreaterThan(0)
      return CONTENT_SAFETY_ERROR_COPY[normalizedCode][active]
    })
    const { adapter, calls } = fixture(() => new Response(JSON.stringify({
      error: { code }, request_id: 'chat-locale-request'
    }), { status, headers: { 'content-type': 'application/json' } }), { localizeContentSafety })
    for (const language of ['zh', 'en', 'ja']) {
      active = language
      const result = await observe(adapter)
      expectFailure(result, expected)
      expect(result.failure).toMatchObject({ message: CONTENT_SAFETY_ERROR_COPY[expected][language], requestId: 'chat-locale-request' })
    }
    expect(calls).toHaveLength(3)
    expect(localizeContentSafety).toHaveBeenCalledTimes(3)
    expect(localizeContentSafety.mock.calls.every(([code]) => code === expected)).toBe(true)
  })

  it('passes the same locale context to content_filter without a tenant extension', async () => {
    const localizeContentSafety = vi.fn((code) => CONTENT_SAFETY_ERROR_COPY[code].ja)
    const { adapter, calls } = fixture(() => sse(delta({}, 'content_filter') + done), { localizeContentSafety })
    const result = await observe(adapter)
    expectFailure(result, 'CONTENT_FILTERED')
    expect(result.failure.message).toBe(CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED.ja)
    expect(localizeContentSafety).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(1)
  })

  it('localizes the real Gateway unavailable sentence instead of treating it as a tenant reply', async () => {
    let active = 'zh'
    const localizeContentSafety = vi.fn((code) => CONTENT_SAFETY_ERROR_COPY[code][active])
    const { adapter, calls } = fixture(() => sse(error('check_unavailable', 'Content safety check unavailable')), { localizeContentSafety })
    for (const language of ['zh', 'en', 'ja']) {
      active = language
      const result = await observe(adapter)
      expectFailure(result, 'CONTENT_CHECK_UNAVAILABLE')
      expect(result.failure.message).toBe(CONTENT_SAFETY_ERROR_COPY.CONTENT_CHECK_UNAVAILABLE[language])
    }
    expect(calls).toHaveLength(3)
    expect(localizeContentSafety).toHaveBeenCalledTimes(3)
  })

  it.each([tenantReply, CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED.en])('preserves an explicit tenant reply even when it equals a fixed sentence: %s', async (message) => {
    const localizeContentSafety = vi.fn(() => 'This must not replace tenant copy.')
    const { adapter } = fixture(() => sse(error('content_blocked', message)), { localizeContentSafety })
    const result = await observe(adapter)
    expectFailure(result, 'CONTENT_FILTERED')
    expect(result.failure.message).toBe(message)
    expect(localizeContentSafety).not.toHaveBeenCalled()
  })

  it.each(['invalid_access_token', 'monthly_token_limit_exceeded'])('does not localize or reclassify ordinary %s failures', async (code) => {
    const localizeContentSafety = vi.fn(() => 'This must not replace account or quota failures.')
    const { adapter, calls } = fixture(() => sse(error(code, 'Ordinary synthetic failure.')), { localizeContentSafety })
    const result = await observe(adapter)
    expectFailure(result, code)
    expect(result.failure.message).toBe('Ordinary synthetic failure.')
    expect(calls).toHaveLength(1)
    expect(localizeContentSafety).not.toHaveBeenCalled()
  })

  it.each(['empty', 'invalid', 'throws'])('preserves the fixed safety fallback when the locale callback %s', async (mode) => {
    const localizeContentSafety = vi.fn(() => {
      if (mode === 'throws') throw new Error('Synthetic locale diagnostic must stay private.')
      return mode === 'empty' ? '   ' : { message: 'Not a string' }
    })
    const { adapter } = fixture(() => sse(delta({}, 'content_filter') + done), { localizeContentSafety })
    const result = await observe(adapter)
    expectFailure(result, 'CONTENT_FILTERED')
    expect(Object.values(CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED)).toContain(result.failure.message)
    expect(result.failure.message).not.toContain('diagnostic')
    expect(localizeContentSafety).toHaveBeenCalledOnce()
  })

  it('keeps the Gateway body request ID for safety errors despite a backend header ID', async () => {
    const { adapter, calls } = fixture(() => new Response(JSON.stringify({
      error: { code: 'content_blocked', message: tenantReply }, request_id: 'synthetic-gateway-uuid'
    }), { status: 403, headers: { 'content-type': 'application/json', 'x-request-id': 'synthetic-backend-uuid' } }))
    const result = await observe(adapter)
    expectFailure(result, 'CONTENT_FILTERED')
    expect(result.failure.requestId).toBe('synthetic-gateway-uuid')
    expect(calls).toHaveLength(1)
  })

  it('keeps header request ID precedence for an ordinary account error', async () => {
    const { adapter, calls } = fixture(() => new Response(JSON.stringify({
      error: { code: 'invalid_access_token', message: 'Ordinary account failure.' }, request_id: 'synthetic-body-uuid'
    }), { status: 401, headers: { 'content-type': 'application/json', 'x-request-id': 'synthetic-backend-uuid' } }))
    const result = await observe(adapter)
    expectFailure(result, 'invalid_access_token')
    expect(result.failure.requestId).toBe('synthetic-backend-uuid')
    expect(calls).toHaveLength(1)
  })

  it('keeps the existing fixed fallback when no locale callback is provided', async () => {
    const { adapter } = fixture(() => sse(delta({}, 'content_filter') + done))
    const result = await observe(adapter)
    expectFailure(result, 'CONTENT_FILTERED')
    expect(Object.values(CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED)).toContain(result.failure.message)
  })
})


// Coverage AC: AC-03, AC-30, AC-31, AC-56. Formatter creation is per protocol stream;
// it is not a mutable last-session cache and never becomes model input.
describe('CHAT per-stream safety formatter factory', () => {
  it.each(['chat', 'compaction', 'session-title'])('captures the formatter once before transport for purpose %s', async purpose => {
    let active = 'zh'
    const localizeContentSafety = vi.fn(() => 'Legacy callback must not replace a scoped formatter.')
    const returnedFormatter = vi.fn((code, fallback) => {
      expect(fallback).toBe(CONTENT_SAFETY_ERROR_COPY[code].en)
      return CONTENT_SAFETY_ERROR_COPY[code].zh
    })
    const contentSafetyFormatterFor = vi.fn(scope => {
      expect(active).toBe('zh')
      expect(scope).toEqual({ sessionId: 'safety-chat-session', purpose })
      return returnedFormatter
    })
    const { adapter, calls } = fixture(() => {
      active = 'ja'
      return new Response(JSON.stringify({ error: { code: 'content_blocked' }, request_id: 'factory-chat-request' }), { status: 403, headers: { 'content-type': 'application/json' } })
    }, { localizeContentSafety, contentSafetyFormatterFor })
    const input = { ...options(), ...(purpose === 'chat' ? {} : { purpose }) }
    const result = await observe(adapter, input)
    expectFailure(result, 'CONTENT_FILTERED')
    expect(result.failure).toMatchObject({ message: CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED.zh, requestId: 'factory-chat-request' })
    expect(contentSafetyFormatterFor).toHaveBeenCalledOnce()
    expect(returnedFormatter).toHaveBeenCalledOnce()
    expect(localizeContentSafety).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls)).not.toContain('CONTENT_FILTERED')
    expect(JSON.stringify(calls)).not.toContain(CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED.zh)
  })

  it('passes an absent session identity explicitly and retains the old callback when the factory has no formatter', async () => {
    const contentSafetyFormatterFor = vi.fn(() => undefined)
    const localizeContentSafety = vi.fn(code => CONTENT_SAFETY_ERROR_COPY[code].ja)
    const { adapter } = fixture(() => new Response(JSON.stringify({ error: { code: 'content_blocked' }, request_id: 'factory-chat-request' }), { status: 403, headers: { 'content-type': 'application/json' } }), { contentSafetyFormatterFor, localizeContentSafety })
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
    const normal = fixture(() => sse(delta({ content: 'Checked ordinary response.' }, 'stop') + done), { contentSafetyFormatterFor })
    const ordinary = await observe(normal.adapter)
    expect(ordinary.failure).toBeUndefined()
    expect(ordinary.chunks).toContainEqual(expect.objectContaining({ type: 'finish', reason: expect.objectContaining({ kind: 'stop' }) }))
    expect(normal.calls).toHaveLength(1)
    const blocked = fixture(() => new Response(JSON.stringify({ error: { code: 'content_blocked' }, request_id: 'factory-chat-request' }), { status: 403, headers: { 'content-type': 'application/json' } }), { contentSafetyFormatterFor })
    const denied = await observe(blocked.adapter)
    expectFailure(denied, 'CONTENT_FILTERED')
    expect(denied.failure.message).toBe(CONTENT_SAFETY_ERROR_COPY.CONTENT_FILTERED.en)
    const tenant = fixture(() => new Response(JSON.stringify({ error: { code: 'content_blocked', message: tenantReply }, request_id: 'factory-chat-request' }), { status: 403, headers: { 'content-type': 'application/json' } }), { contentSafetyFormatterFor })
    const custom = await observe(tenant.adapter)
    expectFailure(custom, 'CONTENT_FILTERED')
    expect(custom.failure.message).toBe(tenantReply)
  })

  it('creates but never invokes a safety formatter for a successful ordinary stream', async () => {
    const formatter = vi.fn(() => { throw new Error('Ordinary responses must not request safety text') })
    const contentSafetyFormatterFor = vi.fn(() => formatter)
    const { adapter } = fixture(() => sse(delta({ content: 'Checked ordinary response.' }, 'stop') + done), { contentSafetyFormatterFor })
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
    const { adapter, calls } = fixture(async () => {
      transportCalls += 1
      if (transportCalls === 1) { startFirst(); await firstPending }
      return new Response(JSON.stringify({ error: { code: 'content_blocked' }, request_id: 'factory-chat-request' }), { status: 403, headers: { 'content-type': 'application/json' } })
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
    expect(calls).toHaveLength(2)
  })
})


// Coverage AC: AC-03, AC-30, AC-31, AC-56.
describe('Chat scoped factory at streaming safety terminals', () => {
  it.each([
    ['content_filter', 'CONTENT_FILTERED'],
    ['content_blocked', 'CONTENT_FILTERED'],
    ['check_unavailable', 'CONTENT_CHECK_UNAVAILABLE']
  ])('uses the captured formatter for %s', async (signal, code) => {
    const formatter = vi.fn(normalized => CONTENT_SAFETY_ERROR_COPY[normalized].ja)
    const contentSafetyFormatterFor = vi.fn(() => formatter)
    const terminal = signal === 'content_filter' ? delta({}, 'content_filter') + done
      : 'event: error\ndata: ' + JSON.stringify({ error: { code: signal }, request_id: 'factory-chat-stream-id' }) + '\n\n'
    const { adapter } = fixture(() => sse(delta({ content: 'Safe prefix.' }) + terminal), { contentSafetyFormatterFor })
    const result = await observe(adapter)
    expectFailure(result, code)
    expect(result.failure.message).toBe(CONTENT_SAFETY_ERROR_COPY[code].ja)
    expect(contentSafetyFormatterFor).toHaveBeenCalledOnce()
    expect(formatter).toHaveBeenCalledOnce()
  })
})


// Coverage AC: AC-03, AC-30, AC-31, AC-56.
it('discards rejected native/cross-realm Promise and thenable factory or formatter results without unhandled process errors', () => {
  const moduleUrl = new URL('../packages/dsh-desktop-enterprise/openai.js', import.meta.url).href
  // Observe rejection only in a disposable Node process, never in Vitest's own
  // global handler. A display-only async return must not terminate the Host.
  const script = `
    import assert from 'node:assert/strict'
    import vm from 'node:vm'
    import { contentSafetyFormatterForStream, requestFailure } from ${JSON.stringify(moduleUrl)}
    const unhandled = []
    process.on('unhandledRejection', error => unhandled.push(error))
    const fallback = () => 'Existing synchronous fallback'
    const invalid = [
      () => Promise.reject(new Error('Synthetic native rejection')),
      () => vm.runInNewContext('Promise.reject(new Error("Synthetic cross-realm rejection"))'),
      () => ({ then(_resolve, reject) { reject(new Error('Synthetic thenable rejection')) } }),
      () => Object.defineProperty({}, 'then', { get() { throw new Error('Synthetic then getter failure') } })
    ]
    for (const factory of invalid) {
      const formatter = contentSafetyFormatterForStream({ sessionId: 'synthetic-process-session' }, {
        localizeContentSafety: fallback, contentSafetyFormatterFor: factory
      })
      assert.equal(formatter, fallback)
    }
    for (const callback of invalid) {
      const scoped = contentSafetyFormatterForStream({ sessionId: 'synthetic-process-session' }, {
        contentSafetyFormatterFor: () => callback
      })
      for (const formatter of [scoped, callback]) {
        const failure = requestFailure(403, undefined, { error: { code: 'content_blocked' } }, formatter)
        assert.equal(failure.code, 'CONTENT_FILTERED')
        assert.equal(typeof failure.message, 'string')
        assert(!failure.message.includes('Synthetic'))
      }
    }
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(unhandled.length, 0, 'Optional async display result escaped as unhandledRejection')
    console.log('PASS: optional async formatter rejection contained')
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5_000 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('PASS: optional async formatter rejection contained')
})
