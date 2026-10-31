import { describe, expect, it, vi } from 'vitest'
import {
  ALLOWED_ATTRIBUTION_HEADERS,
  CHAT_HEADER_TIMEOUT_MS,
  desktopChatAbortKind,
  enterpriseHeaderTimeoutAbortReason,
  enterpriseSessionChangedAbortReason,
  parseEnterpriseChatPayload,
  pickAttributionHeaders
} from '../src/main/enterprise/enterprise-chat'
import { serializeEnterpriseRequest } from '../packages/dsh-desktop-enterprise/openai.js'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const validRequest = {
  model: 'bisheng:42',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
  stream_options: { include_usage: true },
  n: 1
}

describe('enterprise chat payload validation', () => {
  it.each([undefined, 'high'])('accepts actual adapter serialization with default or explicit effort: %s', (effort) => {
    const model = {
      id: 'bisheng:42', display_name: 'Reasoner', capabilities: { streaming: true, tools: true, reasoning_content: false },
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' }
    }
    const request = serializeEnterpriseRequest({
      model: model.id, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) })
    }, model)
    expect(parseEnterpriseChatPayload({ request }).request.reasoning_effort).toBe(effort ?? 'low')
  })

  it.each([null, true, 1, {}, '', 'a'.repeat(129), ' high', 'high\r\nx-header: injected'])('rejects invalid effort %j', (effort) => {
    expect(() => parseEnterpriseChatPayload({ request: { ...validRequest, reasoning_effort: effort } })).toThrow('reasoning effort is invalid')
  })

  it('soft filters optional audit context by trusted connection capability', () => {
    const value = { request: { ...validRequest, audit_context: {
      conversation_id: 'session-a', request_kind: 'chat', user_id: 'forged', version: 1
    } } }
    expect(parseEnterpriseChatPayload(value).request).not.toHaveProperty('audit_context')
    expect(parseEnterpriseChatPayload(value, ['conversation_id']).request.audit_context)
      .toEqual({ conversation_id: 'session-a' })
    for (const audit_context of [null, [], { conversation_id: 1 }, { request_kind: 'unknown' }]) {
      expect(parseEnterpriseChatPayload({ request: { ...validRequest, audit_context } },
        ['conversation_id', 'request_kind']).request).not.toHaveProperty('audit_context')
    }
    expect(value.request.audit_context.user_id).toBe('forged')
  })
  it('accepts a streaming request and keeps only attribution user-agent', () => {
    expect(ALLOWED_ATTRIBUTION_HEADERS).toEqual(['user-agent', 'x-dsh-conversation-id', 'x-dsh-request-purpose'])
    const parsed = parseEnterpriseChatPayload({
      request: validRequest,
      attribution: { 'user-agent': 'deepseek-harness/0.1.5-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)' }
    })
    expect(parsed.model).toBe('bisheng:42')
    expect(parsed.attribution).toEqual({
      'user-agent': 'deepseek-harness/0.1.5-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)'
    })
  })

  it('rejects caller-controlled authorization and other headers', () => {
    expect(() => pickAttributionHeaders({ authorization: 'Bearer stolen' })).toThrow('forbidden header')
    expect(() => pickAttributionHeaders({ 'x-request-id': 'abc' })).toThrow('forbidden header')
    expect(() => parseEnterpriseChatPayload({
      request: validRequest,
      attribution: { host: 'evil.example' }
    })).toThrow('forbidden header')
    expect(() => parseEnterpriseChatPayload({
      request: { ...validRequest, authorization: 'Bearer stolen' }
    })).toThrow('unsupported fields')
    expect(() => parseEnterpriseChatPayload({
      request: validRequest,
      base: 'https://evil.example'
    })).toThrow('unsupported fields')
  })

  it.each([11, 30])('accepts %i images across messages within byte limits', (count) => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
    const messages = Array.from({ length: count }, () => ({ role: 'user', content: [image] }))
    const parsed = parseEnterpriseChatPayload({ request: { ...validRequest, messages } })
    expect(parsed.request.messages).toEqual(messages)
  })

  it('still rejects images exceeding the total byte limit', () => {
    const url = `data:image/png;base64,${'A'.repeat(Math.ceil(4 * 1024 * 1024 * 4 / 3))}`
    expect(() => parseEnterpriseChatPayload({
      request: {
        ...validRequest,
        messages: [{
          role: 'user',
          content: Array.from({ length: 6 }, () => ({ type: 'image_url', image_url: { url } }))
        }]
      }
    })).toThrow('size limit')
  })

  it('rejects remote image URLs and oversized inline images', () => {
    expect(() => parseEnterpriseChatPayload({
      request: {
        ...validRequest,
        messages: [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://evil.example/x.png' } }]
        }]
      }
    })).toThrow('inline images')
    const huge = `data:image/png;base64,${'A'.repeat(Math.ceil(6 * 1024 * 1024 * 4 / 3))}`
    expect(() => parseEnterpriseChatPayload({
      request: {
        ...validRequest,
        messages: [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: huge } }]
        }]
      }
    })).toThrow('size limit')
  })
})

describe('desktop chat abort reasons', () => {
  it('waits 60 seconds for the upstream response headers', () => {
    expect(CHAT_HEADER_TIMEOUT_MS).toBe(60_000)
  })

  it('recognizes session and header reasons and ignores a caller abort', () => {
    expect(desktopChatAbortKind(enterpriseSessionChangedAbortReason())).toBe('session')
    expect(enterpriseSessionChangedAbortReason()).toMatchObject({
      status: 409,
      code: 'enterprise_session_changed',
      message: 'Enterprise session changed.'
    })
    expect(desktopChatAbortKind(enterpriseHeaderTimeoutAbortReason())).toBe('header')
    expect(enterpriseHeaderTimeoutAbortReason()).toMatchObject({
      status: 504,
      code: 'upstream_timeout',
      message: 'Enterprise model response timed out.'
    })
    const caller = new AbortController()
    caller.abort()
    expect(desktopChatAbortKind(caller.signal.reason)).toBeUndefined()
  })

  it('keeps the first abort reason when later sources also abort', () => {
    const caller = new AbortController()
    const session = new AbortController()
    const header = new AbortController()
    const combined = AbortSignal.any([caller.signal, session.signal, header.signal])
    // Observe cancellation as fetch does; Node can resolve unobserved combined signals lazily.
    const onAbort = vi.fn()
    combined.addEventListener('abort', onAbort, { once: true })
    session.abort(enterpriseSessionChangedAbortReason())
    header.abort(enterpriseHeaderTimeoutAbortReason())
    caller.abort()
    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(desktopChatAbortKind(combined.reason)).toBe('session')
    expect(combined.reason).toMatchObject({ status: 409, code: 'enterprise_session_changed' })
  })

  it('prefers the caller when every source is already aborted', () => {
    const caller = new AbortController()
    const session = new AbortController()
    const header = new AbortController()
    caller.abort()
    session.abort(enterpriseSessionChangedAbortReason())
    header.abort(enterpriseHeaderTimeoutAbortReason())
    const combined = AbortSignal.any([caller.signal, session.signal, header.signal])
    expect(desktopChatAbortKind(combined.reason)).toBeUndefined()
    expect(combined.reason).not.toMatchObject({ code: 'enterprise_session_changed' })
  })
})
