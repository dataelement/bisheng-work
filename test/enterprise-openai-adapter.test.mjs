import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  attributionHeaders,
  createToolResultMessage,
  LlmRuntime,
  requestImageHandleText,
  textOnlyImageText,
  ToolCallId
} from '@deepseek-ai/dsh-llm'
import {
  ALLOWED_ATTRIBUTION_HEADERS,
  EnterpriseLlmAdapter,
  pickAttributionHeaders,
  serializeEnterpriseRequest
} from '../packages/dsh-desktop-enterprise/openai.js'

const model = {
  id: 'bisheng:42',
  display_name: 'BiSheng Chat',
  capabilities: { streaming: true, tools: true, reasoning_content: false }
}

describe('enterprise audit association', () => {
  it('keeps error request ids and does not replay when association metadata is present', async () => {
    let requests = 0
    const adapter = new EnterpriseLlmAdapter({
      providerName: () => 'BiSheng', models: () => [model],
      auditFields: () => ['conversation_id', 'request_kind'],
      request: async (body) => {
        requests += 1
        expect(body.audit_context).toEqual({ conversation_id: 'failed-session', request_kind: 'chat' })
        return new Response(
          'event: error\ndata: {"error":{"message":"Synthetic upstream failure","code":"upstream_error"},"request_id":"synthetic-audit-error"}\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
    })
    const events = []
    for await (const event of adapter.stream({
      model: model.id, sessionId: 'failed-session',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic failure request' }] }]
    })) events.push(event)
    expect(requests).toBe(1)
    expect(events.at(-1)).toMatchObject({
      type: 'finish', reason: { kind: 'error', failure: { code: 'upstream_error', requestId: 'synthetic-audit-error' } }
    })
  })

  it.each([
    [undefined, 'chat'], ['compaction', 'compaction'], ['session-title', 'session-title'], ['future-purpose', undefined]
  ])('uses the actual session and purpose %s', async (purpose, kind) => {
    let body
    const adapter = new EnterpriseLlmAdapter({
      providerName: () => 'BiSheng', models: () => [model],
      auditFields: () => ['conversation_id', 'request_kind'],
      request: async (request) => { body = request; return completedResponse() }
    })
    for await (const event of adapter.stream({
      model: model.id, sessionId: 'persisted-session', purpose,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })) void event
    expect(body.audit_context).toEqual({ conversation_id: 'persisted-session', ...(kind ? { request_kind: kind } : {}) })
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
  })
})

const visionModel = {
  ...model,
  capabilities: { ...model.capabilities, vision: true }
}

describe('enterprise reasoning effort', () => {
  const reasoning = {
    efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
    defaultEffort: 'low'
  }
  const reasoner = { ...model, reasoning }

  it('passes Harness effort validation and resolves the declared default', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(LlmRuntime)
    await fiber
    const dispose = ctx.llm.registerAdapter(['enterprise'], new EnterpriseLlmAdapter({
      models: () => [reasoner], providerName: () => 'Enterprise'
    }))
    try {
      const route = { provider: 'enterprise', model: model.id }
      expect(await ctx.llm.resolveCallConfig(route)).toMatchObject({ reasoningEffort: 'low' })
      expect(await ctx.llm.resolveCallConfig({ ...route, reasoningEffort: 'high' })).toMatchObject({ reasoningEffort: 'high' })
      await expect(ctx.llm.resolveCallConfig({ ...route, reasoningEffort: 'max' })).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    } finally {
      dispose()
      await fiber.dispose()
    }
  })

  it('advertises the same effort metadata for catalog and exact-model resolution', async () => {
    const adapter = new EnterpriseLlmAdapter({ models: () => [reasoner] })
    expect((await adapter.listModels('enterprise'))[0].reasoning).toEqual(reasoning)
    expect((await adapter.resolveModel('enterprise', model.id)).reasoning).toEqual(reasoning)
  })

  it('sends explicit and default efforts without coupling them to reasoning text support', () => {
    const options = { model: model.id, messages: [] }
    expect(serializeEnterpriseRequest({ ...options, reasoningEffort: 'high' }, reasoner).reasoning_effort).toBe('high')
    expect(serializeEnterpriseRequest(options, reasoner).reasoning_effort).toBe('low')
    expect(serializeEnterpriseRequest(options, model)).not.toHaveProperty('reasoning_effort')
    expect(serializeEnterpriseRequest(options, { ...reasoner, reasoning: { efforts: reasoning.efforts } })).not.toHaveProperty('reasoning_effort')
  })

  it('rejects unsupported efforts before sending a request', () => {
    for (const selected of [model, reasoner]) {
      expect(() => serializeEnterpriseRequest({ model: model.id, messages: [], reasoningEffort: 'max' }, selected))
        .toThrow('does not support reasoning effort')
    }
  })

  it('preserves a selected effort through an actual adapter streaming call', async () => {
    let sent
    const adapter = new EnterpriseLlmAdapter({
      models: () => [reasoner],
      request: async (body) => { sent = body; return completedResponse('ok') }
    })
    const chunks = []
    for await (const chunk of adapter.stream({ model: model.id, messages: [], reasoningEffort: 'high' })) chunks.push(chunk)
    expect(sent.reasoning_effort).toBe('high')
    expect(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'ok')).toBe(true)
  })
})

const referenceImage = {
  attachmentId: 'sha256:abcdef1234567890',
  mediaType: 'image/png',
  width: 1920,
  height: 1080,
  bytes: 4,
  name: 'reference.png'
}

function completedResponse(text = 'ok') {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n'
  ].join(''), { headers: { 'content-type': 'text/event-stream' } })
}

function requestVersion(width, height) {
  return {
    data: Buffer.from([255, 216, 255]),
    mediaType: 'image/jpeg',
    width,
    height
  }
}

function dataUrl() {
  return `data:image/jpeg;base64,${Buffer.from([255, 216, 255]).toString('base64')}`
}

async function usageFrom(payload) {
  const stream = [
    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    `data: ${JSON.stringify({ choices: [], usage: payload })}\n\n`,
    'data: [DONE]\n\n'
  ].join('')
  const adapter = new EnterpriseLlmAdapter({
    providerName: () => 'BiSheng',
    models: () => [model],
    request: async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'bisheng-enterprise', model: model.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  })) chunks.push(chunk)
  return chunks.find((chunk) => chunk.type === 'usage')?.usage
}

describe('BiSheng OpenAI adapter', () => {
  it('refreshes configured names and provider labels while preserving the model route', async () => {
    let current = [{ ...model, display_name: 'Provider A / Custom label' }]
    const adapter = new EnterpriseLlmAdapter({ providerName: () => 'Enterprise', models: () => current })
    const before = (await adapter.listModels('bisheng-enterprise'))[0]
    expect(before.name).toBe('Provider A / Custom label')
    current = [{ ...model, display_name: 'Provider A / Updated label' }]
    const after = await adapter.resolveModel('bisheng-enterprise', model.id)
    expect(after.name).toBe('Provider A / Updated label')
    expect(after.id).toBe(before.id)
    expect(serializeEnterpriseRequest({ model: after.id, messages: [] }, current[0]).model).toBe(model.id)
  })

  it.each([
    { text: 'result', isError: false, expected: 'result' },
    { text: 'lookup failed', isError: true, expected: 'lookup failed' },
    { text: '', isError: false, expected: '(no output)' }
  ])('serializes Harness tool-role messages with their call ID: $expected', ({ text, isError, expected }) => {
    const request = serializeEnterpriseRequest({
      model: model.id,
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{}' }] },
        createToolResultMessage({
          callId: ToolCallId('call-1'),
          content: text ? [{ type: 'text', text }] : [],
          isError
        })
      ]
    }, model)
    expect(request.messages).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: expected }
    ])
  })

  it('preserves parallel tool results through a complete adapter round trip', async () => {
    const requests = []
    const adapter = new EnterpriseLlmAdapter({
      providerName: () => 'BiSheng',
      models: () => [model],
      request: async (body) => {
        requests.push(body)
        const first = requests.length === 1
        if (!first) {
          expect(body.messages.slice(2)).toEqual([
            { role: 'tool', tool_call_id: 'call-1', content: 'first result' },
            { role: 'tool', tool_call_id: 'call-2', content: 'second result' }
          ])
        }
        const delta = first ? { tool_calls: [
          { index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"first"}' } },
          { index: 1, id: 'call-2', type: 'function', function: { name: 'lookup', arguments: '{"q":"second"}' } }
        ] } : { content: 'completed' }
        return new Response([
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\n`,
          'data: [DONE]\n\n'
        ].join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
    })
    const options = {
      provider: 'bisheng-enterprise', model: model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look up both' }] }],
      tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }]
    }
    const firstChunks = []
    for await (const chunk of adapter.stream(options)) firstChunks.push(chunk)
    const calls = firstChunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
    expect(calls).toHaveLength(2)
    expect(firstChunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    const chunks = []
    for await (const chunk of adapter.stream({
      ...options,
      messages: [
        ...options.messages,
        { role: 'assistant', content: calls },
        ...calls.map((call, index) => createToolResultMessage({
          callId: call.id,
          content: [{ type: 'text', text: index === 0 ? 'first result' : 'second result' }],
          isError: false
        }))
      ]
    })) chunks.push(chunk)
    expect(requests).toHaveLength(2)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'completed' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('copies only the known attribution header keys', () => {
    const headers = attributionHeaders()
    expect(Object.keys(headers).every((key) => ALLOWED_ATTRIBUTION_HEADERS.includes(key.toLowerCase()))).toBe(true)
    expect(pickAttributionHeaders({
      ...headers,
      authorization: 'Bearer stolen',
      'x-request-id': 'inject',
      host: 'evil.example'
    })).toEqual({ 'user-agent': headers['user-agent'] })
  })

  it('serializes tool history without putting provider credentials in the request body', () => {
    const request = serializeEnterpriseRequest({
      model: model.id,
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{"q":"x"}' }] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'result' }] }] }
      ],
      tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }]
    }, model)
    expect(request).toMatchObject({
      model: 'bisheng:42', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call-1' }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'result' }
      ]
    })
    expect(JSON.stringify(request)).not.toContain('access_token')
    expect(JSON.stringify(request)).not.toContain('refresh_token')
  })

  async function collectRequest(selectedModel, messages, readImage) {
    const requests = []
    let reads = 0
    const adapter = new EnterpriseLlmAdapter({
      providerName: () => 'BiSheng',
      models: () => [selectedModel],
      readImage: async (ref, signal) => {
        reads += 1
        return readImage(ref, signal)
      },
      request: async (body) => {
        requests.push(body)
        return completedResponse()
      }
    })
    const chunks = []
    try {
      for await (const chunk of adapter.stream({
        provider: 'bisheng-enterprise',
        model: selectedModel.id,
        messages
      })) chunks.push(chunk)
      return { requests, reads, chunks }
    } catch (error) {
      return { requests, reads, chunks, error }
    }
  }

  it('sends vision tool images as a handled user message without dropping the tool call', async () => {
    const toolMessage = createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [
        { type: 'text', text: 'template reference' },
        { type: 'image', attachment: referenceImage }
      ],
      isError: false
    })
    const messages = [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'ppt_get_template_reference', arguments: '{}' }] },
      toolMessage
    ]
    const result = await collectRequest(visionModel, messages, async () => requestVersion(640, 360))
    expect(result.error).toBeUndefined()
    expect(result.requests).toHaveLength(1)
    expect(result.reads).toBe(1)
    expect(toolMessage.content[1].type).toBe('image')
    expect(result.requests[0].messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'ppt_get_template_reference', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'template reference' },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Tool call call-1. ${requestImageHandleText(referenceImage, { width: 640, height: 360 })}`
          },
          { type: 'image_url', image_url: { url: dataUrl() } }
        ]
      }
    ])
    expect(result.requests[0].messages[2].content[0].text).toContain('640x360')
    expect(result.requests[0].messages[2].content[0].text).not.toContain('1920x1080')
  })

  it('keeps parallel tool results together and flushes their images after the group', async () => {
    const secondImage = { ...referenceImage, attachmentId: 'sha256:bbbbbbbbbbbbbbbb', name: 'second.png' }
    const messages = [
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{}' },
        { type: 'tool-call', id: 'call-2', name: 'lookup', arguments: '{}' }
      ] },
      createToolResultMessage({
        callId: ToolCallId('call-1'),
        content: [{ type: 'text', text: 'first result' }, { type: 'image', attachment: referenceImage }],
        isError: false
      }),
      createToolResultMessage({
        callId: ToolCallId('call-2'),
        content: [{ type: 'text', text: 'second result' }, { type: 'image', attachment: secondImage }],
        isError: false
      }),
      { role: 'user', content: [{ type: 'text', text: 'continue' }] }
    ]
    const result = await collectRequest(visionModel, messages, async () => requestVersion(640, 360))
    expect(result.requests[0].messages.map((entry) => entry.role)).toEqual([
      'assistant', 'tool', 'tool', 'user', 'user'
    ])
    expect(result.requests[0].messages.slice(1, 3)).toEqual([
      { role: 'tool', tool_call_id: 'call-1', content: 'first result' },
      { role: 'tool', tool_call_id: 'call-2', content: 'second result' }
    ])
    expect(result.requests[0].messages[3].content.map((part) => part.type)).toEqual([
      'text', 'image_url', 'text', 'image_url'
    ])
    expect(result.requests[0].messages[3].content[0].text).toContain('Tool call call-1.')
    expect(result.requests[0].messages[3].content[2].text).toContain('Tool call call-2.')
    expect(result.requests[0].messages[4]).toEqual({ role: 'user', content: 'continue' })
  })

  it('places nested tool-result images before the surrounding user content', async () => {
    const userImage = { ...referenceImage, attachmentId: 'sha256:cccccccccccccccc', name: 'user.png', width: 800, height: 600 }
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'use both' },
        { type: 'image', attachment: userImage },
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [
            { type: 'text', text: 'result' },
            { type: 'image', attachment: referenceImage }
          ]
        }
      ]
    }]
    const result = await collectRequest(visionModel, messages, async (ref) => (
      ref.attachmentId === userImage.attachmentId ? requestVersion(320, 180) : requestVersion(640, 360)
    ))
    expect(result.requests[0].messages).toEqual([
      { role: 'tool', tool_call_id: 'call-1', content: 'result' },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Tool call call-1. ${requestImageHandleText(referenceImage, { width: 640, height: 360 })}`
          },
          { type: 'image_url', image_url: { url: dataUrl() } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'use both' },
          { type: 'image_url', image_url: { url: dataUrl() } }
        ]
      }
    ])
    expect(result.requests[0].messages[2].content[0].text).not.toContain('Tool call')
  })

  it.each([11, 30])('sends %i tool images when the request stays within byte limits', async (count) => {
    const content = Array.from({ length: count }, (_, index) => ({
      type: 'image',
      attachment: { ...referenceImage, attachmentId: `sha256:${String(index).padStart(16, '0')}`, name: `page-${index}.png` }
    }))
    const result = await collectRequest(visionModel, [
      createToolResultMessage({ callId: ToolCallId('call-1'), content, isError: false })
    ], async () => requestVersion(640, 360))
    expect(result.error).toBeUndefined()
    expect(result.requests).toHaveLength(1)
    expect(result.reads).toBe(count)
    const images = result.requests[0].messages.flatMap((message) => (
      Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url') : []
    ))
    expect(images).toHaveLength(count)
  })

  it.each([
    ['single image', 1, 6 * 1024 * 1024],
    ['total images', 6, 4 * 1024 * 1024]
  ])('requests recoverable offload for oversized %s before sending', async (_label, count, bytes) => {
    const content = Array.from({ length: count }, (_, index) => ({
      type: 'image',
      attachment: { ...referenceImage, attachmentId: `sha256:${String(index).padStart(16, '0')}` }
    }))
    const result = await collectRequest(visionModel, [
      createToolResultMessage({ callId: ToolCallId('call-1'), content, isError: false })
    ], async () => {
      const data = new Uint8Array(bytes)
      data.set([255, 216, 255])
      return { ...requestVersion(640, 360), data }
    })
    expect(result.requests).toHaveLength(0)
    expect(result.error.failure).toMatchObject({
      code: 'IMAGE_OFFLOAD_REQUIRED',
      offloadImages: count === 1 ? 1 : 2
    })
  })

  it('projects tool images to placeholder text for a text-only model', async () => {
    const toolMessage = createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [
        { type: 'text', text: 'template reference' },
        { type: 'image', attachment: referenceImage }
      ],
      isError: false
    })
    const originalContent = toolMessage.content
    const result = await collectRequest(model, [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{}' }] },
      toolMessage
    ], async () => requestVersion(640, 360))
    expect(result.error).toBeUndefined()
    expect(result.requests).toHaveLength(1)
    expect(result.reads).toBe(0)
    expect(toolMessage.content).toBe(originalContent)
    expect(toolMessage.content[1].type).toBe('image')
    expect(result.requests[0].messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: `template reference${textOnlyImageText(referenceImage)}`
    })
  })

  it('projects nested tool-result images without changing the original message', async () => {
    const nested = [
      { type: 'text', text: 'page' },
      { type: 'image', attachment: referenceImage }
    ]
    const message = {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call-9', content: nested }]
    }
    const result = await collectRequest(model, [message], async () => requestVersion(640, 360))
    expect(result.requests).toHaveLength(1)
    expect(result.reads).toBe(0)
    expect(message.content[0].content).toBe(nested)
    expect(nested[1].type).toBe('image')
    expect(result.requests[0].messages).toEqual([
      { role: 'tool', tool_call_id: 'call-9', content: `page${textOnlyImageText(referenceImage)}` }
    ])
  })

  it('rejects an image on an assistant message for a vision model before sending', async () => {
    const result = await collectRequest(visionModel, [{
      role: 'assistant',
      content: [{ type: 'image', attachment: referenceImage }]
    }], async () => requestVersion(640, 360))
    expect(result.requests).toHaveLength(0)
    expect(result.reads).toBe(0)
    expect(result.error.failure).toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      message: 'Image input is unavailable for this model or message role.'
    })
  })

  it('still sends a direct user image on a vision model', async () => {
    const result = await collectRequest(visionModel, [{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', attachment: referenceImage }
      ]
    }], async () => requestVersion(640, 360))
    expect(result.requests[0].messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: dataUrl() } }
      ]
    }])
  })

  it('assembles split UTF-8 SSE text, authoritative usage, and a terminal finish', async () => {
    const encoder = new TextEncoder()
    const source = [
      'data: {"choices":[{"index":0,"delta":{"content":"Mock 联',
      '调成功"},"finish_reason":null}]}\r\n\r\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n'
    ]
    const adapter = new EnterpriseLlmAdapter({
      providerName: () => 'BiSheng',
      models: () => [model],
      request: async () => new Response(new ReadableStream({
        start(controller) {
          for (const piece of source) controller.enqueue(encoder.encode(piece))
          controller.close()
        }
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'bisheng-enterprise', model: model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Mock 联调成功' })
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('finishes normally when a successful SSE response has no authoritative usage block', async () => {
    const stream = [
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ].join('')
    const adapter = new EnterpriseLlmAdapter({
      providerName: () => 'BiSheng',
      models: () => [model],
      request: async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'bisheng-enterprise', model: model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })) chunks.push(chunk)
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'usage' }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('treats null usage fields as unavailable usage, not as a stream failure', async () => {
    const stream = [
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":null,"completion_tokens":null,"total_tokens":null}}\n\n',
      'data: [DONE]\n\n'
    ].join('')
    const adapter = new EnterpriseLlmAdapter({
      providerName: () => 'BiSheng',
      models: () => [model],
      request: async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'bisheng-enterprise', model: model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })) chunks.push(chunk)
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'usage' }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('maps prompt cache details to DSH cache token usage fields', async () => {
    await expect(usageFrom({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: {
        cached_tokens: 80,
        cache_creation_tokens: null
      }
    })).resolves.toEqual({
      inputTokens: 20,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 80
    })
  })

  it('treats missing or null cache details as unavailable cache data', async () => {
    for (const payload of [
      { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: null },
      { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: {} },
      {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: {
          cached_tokens: null,
          cache_creation_tokens: null
        }
      }
    ]) {
      await expect(usageFrom(payload)).resolves.toEqual({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120
      })
    }
  })

  it('does not synthesize a zero for a missing cache detail field', async () => {
    await expect(usageFrom({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: {
        cached_tokens: 25
      }
    })).resolves.toEqual({
      inputTokens: 75,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 25
    })
  })

  it('preserves explicit zero cache counts and omits unknown null counts', async () => {
    await expect(usageFrom({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: {
        cached_tokens: 0,
        cache_creation_tokens: 10
      }
    })).resolves.toEqual({
      inputTokens: 90,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 0,
      cacheWriteTokens: 10
    })
  })

  it('ignores invalid cache details without dropping reliable total usage', async () => {
    await expect(usageFrom({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: {
        cached_tokens: 80,
        cache_creation_tokens: 30
      }
    })).resolves.toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120
    })
  })

  it('keeps partial text and terminates on an SSE error without retrying', async () => {
    let requests = 0
    const stream = [
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
      'event: error\ndata: {"error":{"message":"quota reached","type":"quota_error","code":"monthly_token_limit_exceeded"},"request_id":"req-1"}\n\n'
    ].join('')
    const adapter = new EnterpriseLlmAdapter({
      providerName: () => 'BiSheng', models: () => [model],
      request: async () => {
        requests += 1
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
    })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'bisheng-enterprise', model: model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })) chunks.push(chunk)
    expect(requests).toBe(1)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'partial' })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'monthly_token_limit_exceeded', status: 200, requestId: 'req-1' } }
    })
  })

  async function finishFrom(response) {
    let requests = 0
    const adapter = new EnterpriseLlmAdapter({
      providerName: () => 'BiSheng', models: () => [model],
      request: async () => {
        requests += 1
        return response
      }
    })
    const chunks = []
    try {
      for await (const chunk of adapter.stream({
        provider: 'bisheng-enterprise', model: model.id,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
      })) chunks.push(chunk)
      return { requests, failure: chunks.at(-1)?.reason?.failure }
    } catch (error) {
      return { requests, error }
    }
  }

  it('keeps the BiSheng context sentence while reporting the harness overflow code', async () => {
    const exact = await finishFrom(new Response(
      'event: error\ndata: {"error":{"message":"Model context length exceeded","code":"context_length_exceeded"}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ))
    const detailed = await finishFrom(new Response(
      'event: error\ndata: {"error":{"message":"This model\'s maximum context length is 128000 tokens.","code":"context_length_exceeded"}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ))
    expect(exact.failure).toMatchObject({
      code: 'CONTEXT_WINDOW_EXCEEDED',
      message: 'Model context length exceeded'
    })
    expect(detailed.failure).toMatchObject({
      code: 'CONTEXT_WINDOW_EXCEEDED',
      message: 'Model context length exceeded'
    })
  })

  it('keeps an in-stream upstream failure code and does not retry', async () => {
    const stream = 'event: error\ndata: {"error":{"message":"Upstream model request failed","type":"upstream_error","code":"upstream_error"},"request_id":"req-up"}\n\n'
    const result = await finishFrom(new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }))
    expect(result.requests).toBe(1)
    expect(result.failure).toMatchObject({ code: 'upstream_error', requestId: 'req-up' })
  })

  it('maps a codeless monthly-limit sentence without treating an upstream sentence as quota', async () => {
    const monthly = await finishFrom(new Response(
      'event: error\ndata: {"error":{"message":"Monthly token limit reached"}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ))
    const upstream = await finishFrom(new Response(
      'event: error\ndata: {"error":{"message":"Upstream model request failed"}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    ))
    expect(monthly.failure.code).toBe('monthly_token_limit_exceeded')
    expect(upstream.failure.code).not.toBe('monthly_token_limit_exceeded')
  })

  it('keeps chat platform codes that used to collapse or show as a badge', async () => {
    const cases = [
      ['internal_error', 'Platform request failed.'],
      ['seat_revoked', 'DSH seat revoked'],
      ['invalid_access_token', 'Invalid DSH access token'],
      ['user_disabled', 'User account unavailable']
    ]
    for (const [code, message] of cases) {
      const result = await finishFrom(new Response(
        `event: error\ndata: ${JSON.stringify({ error: { message, code } })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      ))
      expect(result.requests).toBe(1)
      expect(result.failure.code).toBe(code)
      expect(result.failure.code).not.toBe('AUTH')
    }
  })

  it('maps codeless local chat sentences without guessing an upstream failure', async () => {
    const assigned = await finishFrom(new Response(JSON.stringify({
      error: 'Model is not assigned to this account.'
    }), { status: 403, headers: { 'content-type': 'application/json' } }))
    const busy = await finishFrom(new Response(JSON.stringify({
      error: 'Too many enterprise chats.'
    }), { status: 429, headers: { 'content-type': 'application/json' } }))
    const internal = await finishFrom(new Response(JSON.stringify({
      error: { message: 'Internal error.' }
    }), { status: 500, headers: { 'content-type': 'application/json' } }))
    expect(assigned.error.failure.code).toBe('UNKNOWN_MODEL')
    expect(busy.error.failure.code).toBe('enterprise_chat_busy')
    expect(internal.error.failure.code).toBe('internal_error')
    expect(internal.error.failure.code).not.toBe('SERVER')
  })

  it('keeps a JSON request id when the response header is absent', async () => {
    const result = await finishFrom(new Response(JSON.stringify({
      error: { message: 'Monthly token limit reached', code: 'monthly_token_limit_exceeded' },
      request_id: 'body-req'
    }), { status: 429, headers: { 'content-type': 'application/json' } }))
    expect(result.error.failure).toMatchObject({
      code: 'monthly_token_limit_exceeded',
      requestId: 'body-req'
    })
  })

  it('does not surface HTML from an unknown platform error', async () => {
    const result = await finishFrom(new Response(JSON.stringify({
      error: { message: '<html><body>gateway</body></html>', code: 'novel_platform_code' }
    }), { status: 502, headers: { 'content-type': 'application/json' } }))
    expect(result.error.failure.code).toBe('novel_platform_code')
    expect(result.error.failure.message).not.toContain('<')
  })
})
