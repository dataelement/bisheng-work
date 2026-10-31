import { createHash } from 'node:crypto'
import { stream as streamResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import { normalizeAuditContext } from './contract.js'
import { contentSafetyFormatterForStream, parseSseEvents, projectEnterpriseMessagesForTextModel, requestFailure, responseFailure, streamAttributionHeaders } from './openai.js'
import { enforceEnterpriseRequestSize, projectEnterpriseOffloadedImages, readEnterpriseRequestImages } from './request-images.js'

const TRANSPORT_URL = 'https://enterprise.invalid/v1/responses'
const LIMITS = { event: 8 * 1024 * 1024, total: 32 * 1024 * 1024 }
const hashContent = (content) => createHash('sha256').update(JSON.stringify(content)).digest('hex')
const text = (blocks) => blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
const callId = (id) => String(id).split('|')[0]

function completeToolArguments(value) {
  if (typeof value !== 'string') return false
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    // pi-ai repairs partial JSON for streaming display; that is insufficient for tool execution.
    return false
  }
}

function nativeContent(blocks, images) {
  return blocks.flatMap((block) => {
    if (block.type === 'text') return [{ type: 'input_text', text: block.text }]
    if (block.type !== 'image') return []
    const image = images.get(block.attachment.attachmentId)
    if (!image) throw new LlmError('Image attachment is unavailable.', 'UNSUPPORTED_CONTENT')
    return [{ type: 'input_image', image_url: image.url, detail: 'auto' }]
  })
}

/** Preserve native output only while both account/model and visible message still match. */
export function serializeResponsesRequest(options, model, images, connectionKey, onReplayDegrade) {
  const input = []
  if (options.system !== undefined) input.push({ type: 'message', role: 'system', content: options.system })
  for (const message of options.messages) {
    if (message.role === 'assistant') {
      const saved = message.source?.replayState?.response
      if (saved?.kind === 'enterprise-responses' && saved.version === 1 && saved.connectionKey === connectionKey &&
          saved.model === model.id && message.source.model === model.id && message.source.provider === options.provider &&
          saved.contentHash === hashContent(message.content) && Array.isArray(saved.output)) {
        input.push(...saved.output)
      } else {
        if (saved?.kind === 'enterprise-responses') {
          const reason = saved.version !== 1 ? 'version' : saved.connectionKey !== connectionKey ? 'account'
            : saved.model !== model.id || message.source.model !== model.id || message.source.provider !== options.provider ? 'model'
              : 'content'
          onReplayDegrade?.(reason)
        }
        const visible = text(message.content)
        if (visible) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: visible, annotations: [] }] })
        for (const block of message.content) {
          if (block.type === 'tool-call') input.push({ type: 'function_call', call_id: callId(block.id), name: block.name, arguments: block.arguments })
        }
      }
      continue
    }
    if (message.role === 'tool') {
      const output = nativeContent(message.content, images)
      input.push({ type: 'function_call_output', call_id: callId(message.toolCallId), output: output.length ? output : '(no output)' })
      continue
    }
    for (const block of message.content) {
      if (block.type === 'tool-result') {
        const output = nativeContent(block.content, images)
        input.push({ type: 'function_call_output', call_id: callId(block.toolCallId), output: output.length ? output : '(no output)' })
      }
    }
    const content = nativeContent(message.content, images)
    if (content.length) input.push({ type: 'message', role: message.role === 'system' ? 'system' : 'user', content })
  }
  const effort = options.reasoningEffort ?? model.reasoning?.defaultEffort
  if (effort !== undefined && !model.reasoning?.efforts.some((item) => item.id === effort)) {
    throw new LlmError('BiSheng model does not support reasoning effort.', 'UNSUPPORTED_REASONING_EFFORT')
  }
  if (options.tools?.length && !model.capabilities.tools) throw new LlmError('BiSheng model does not support tools.', 'UNSUPPORTED_OPTION')
  if (options.stop?.length) throw new LlmError('Native Responses does not support stop sequences.', 'UNSUPPORTED_OPTION')
  return {
    model: model.id, input, stream: true, store: false, include: ['reasoning.encrypted_content'],
    ...(effort === undefined ? {} : { reasoning: { effort, summary: 'auto' } }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
    ...(options.tools?.length ? { tools: options.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })) } : {})
  }
}

/** Use pi-ai's public Responses engine with a transport owned by the enterprise broker. */
export async function* streamEnterpriseResponses(options, model, hooks, connectionKey, session) {
  const localizeContentSafety = contentSafetyFormatterForStream(options, hooks)
  if (!connectionKey || !hooks.requestResponses) throw new LlmError('Enterprise models are unavailable.', 'MISSING_CREDENTIAL')
  const assertAccount = () => {
    options.signal?.throwIfAborted()
    if (connectionKey !== hooks.connectionKey?.()) throw new LlmError('Enterprise session changed.', 'MISSING_CREDENTIAL')
  }
  assertAccount()
  const history = model.capabilities.vision ? projectEnterpriseOffloadedImages(options.messages) : projectEnterpriseMessagesForTextModel(options.messages)
  const images = model.capabilities.vision ? await readEnterpriseRequestImages(history, hooks.readImage, options.signal) : new Map()
  const headers = streamAttributionHeaders(options.sessionId, options.purpose)
  const auditContext = normalizeAuditContext({
    conversation_id: options.sessionId,
    request_kind: options.purpose ?? 'chat',
    session_origin: session?.session_origin,
    parent_conversation_id: session?.parent_conversation_id
  }, hooks.auditFields?.() ?? [])
  const serialize = (messages, onReplayDegrade) => ({
    ...serializeResponsesRequest({ ...options, messages }, model, images, connectionKey, onReplayDegrade),
    ...(auditContext ? { audit_context: auditContext } : {})
  })
  enforceEnterpriseRequestSize(history, serialize, headers, { connectionKey })
  const request = serialize(history, hooks.onReplayDegrade)
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  let terminal
  let terminalUsage
  let frames
  let failure
  let invalidToolArguments = false
  let sequence = -1
  const transport = async (url, init) => {
    if (String(url) !== TRANSPORT_URL || init?.method !== 'POST') throw new LlmError('Invalid enterprise transport route.', 'INVALID_REQUEST')
    assertAccount()
    let response
    try {
      response = await hooks.requestResponses(request, signal, headers, connectionKey)
      assertAccount()
      if (!response.ok) throw await responseFailure(response, localizeContentSafety)
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) throw new LlmError('Expected enterprise SSE response.', 'INVALID_RESPONSE')
    } catch (error) {
      // pi-ai wraps transport errors; retain the broker's structured safety failure.
      failure = error
      throw error
    }
    frames = parseSseEvents(response.body, signal, LIMITS)
    return new Response(new ReadableStream({
      async pull(out) {
        try {
          assertAccount()
          const frame = await frames.next()
          if (frame.done) { out.close(); return }
          const payload = JSON.parse(frame.value.data)
          // Terminal Gateway errors have no sequence_number and must win over data validation.
          if (payload.type === 'error' || frame.value.event === 'error') {
            throw requestFailure(200, response.headers.get('x-request-id') ?? undefined, payload, localizeContentSafety)
          }
          if (terminal || !Number.isSafeInteger(payload.sequence_number) || payload.sequence_number <= sequence) throw new LlmError('Invalid Responses event sequence.', 'INVALID_RESPONSE')
          sequence = payload.sequence_number
          if (payload.type === 'response.function_call_arguments.done' && !completeToolArguments(payload.arguments)) invalidToolArguments = true
          if (payload.type === 'response.output_item.done' && payload.item?.type === 'function_call' && !completeToolArguments(payload.item.arguments)) {
            invalidToolArguments = true
          }
          if (['response.completed', 'response.failed', 'response.incomplete'].includes(payload.type)) {
            terminal = payload.response
            terminalUsage = terminal?.usage
            if (payload.type === 'response.completed' && (terminal?.status !== 'completed' || !Array.isArray(terminal.output))) {
              throw new LlmError('Responses terminal status is invalid.', 'INVALID_RESPONSE')
            }
            if (payload.type === 'response.completed') {
              for (const item of terminal.output) {
                if (item.type === 'function_call' && !completeToolArguments(item.arguments)) invalidToolArguments = true
              }
            }
          }
          out.enqueue(new TextEncoder().encode(`event: ${frame.value.event}\ndata: ${frame.value.data}\n\n`))
        } catch (error) {
          failure = error
          out.error(error)
          await frames.return()
        }
      },
      async cancel() { await frames.return() }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const piModel = {
    id: model.id, name: model.display_name, api: 'openai-responses', provider: 'openai',
    baseUrl: 'https://enterprise.invalid/v1', reasoning: !!model.reasoning, input: model.capabilities.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 32768
  }
  // The SDK requires an API-key value; this public sentinel never leaves the injected transport.
  const events = streamResponses(piModel, { messages: [] }, {
    apiKey: 'enterprise-broker-transport', fetch: transport, onPayload: () => request, signal, maxRetries: 0
  })
  const completed = new Map()
  const tools = new Map()
  try {
    for await (const event of events) {
      const index = event.contentIndex
      if (event.type === 'text_start' || event.type === 'thinking_start' || event.type === 'toolcall_start') {
        if (event.type === 'toolcall_start') tools.set(index, event.partial.content[index])
        yield { type: 'block-start', index, blockType: event.type === 'text_start' ? 'text' : event.type === 'thinking_start' ? 'reasoning' : 'tool-call' }
      } else if (event.type === 'text_delta' || event.type === 'thinking_delta') {
        yield { type: event.type === 'text_delta' ? 'text-delta' : 'reasoning-delta', index, text: event.delta }
      } else if (event.type === 'toolcall_delta') {
        const tool = tools.get(index)
        yield { type: 'tool-call-delta', index, id: ToolCallId(tool.id), name: tool.name, argumentsDelta: event.delta }
      } else if (['text_end', 'thinking_end', 'toolcall_end'].includes(event.type)) {
        if (event.type === 'toolcall_end' && (event.toolCall.argumentsError || event.toolCall.arguments === null ||
            typeof event.toolCall.arguments !== 'object' || Array.isArray(event.toolCall.arguments))) invalidToolArguments = true
        const block = event.type === 'text_end' ? { type: 'text', text: event.content }
          : event.type === 'thinking_end' ? { type: 'reasoning', text: event.content }
            : { type: 'tool-call', id: ToolCallId(event.toolCall.id), name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments) }
        completed.set(index, block)
        // Arguments may be complete while a later output domain still causes a safety error.
        if (block.type !== 'tool-call') yield { type: 'block-end', index, block }
      } else if (event.type === 'error') {
        if (failure) throw failure
        signal.throwIfAborted()
        throw new LlmError('Enterprise Responses generation failed.', 'UPSTREAM_ERROR')
      } else if (event.type === 'done') {
        if (failure) throw failure
        assertAccount()
        if (!terminal || terminal.status === 'failed' || !Array.isArray(terminal.output)) throw new LlmError('Responses stream closed without valid output.', 'STREAM_CLOSED')
        const reason = event.reason === 'toolUse' ? { kind: 'tool-calls' } : event.reason === 'length' ? { kind: 'max-tokens' } : { kind: 'stop' }
        if (reason.kind !== 'max-tokens') {
          if (invalidToolArguments) throw new LlmError('Responses tool arguments are incomplete.', 'INVALID_RESPONSE')
          for (const [index, block] of [...completed.entries()].sort(([a], [b]) => a - b)) {
            if (block.type === 'tool-call') yield { type: 'block-end', index, block }
          }
        }
        const u = terminalUsage
        if (u && [u.input_tokens, u.output_tokens, u.total_tokens].every((n) => Number.isSafeInteger(n) && n >= 0) && u.input_tokens + u.output_tokens === u.total_tokens) {
          const read = Number.isSafeInteger(u.input_tokens_details?.cached_tokens) && u.input_tokens_details.cached_tokens >= 0 ? u.input_tokens_details.cached_tokens : undefined
          const write = Number.isSafeInteger(u.input_tokens_details?.cache_creation_tokens) && u.input_tokens_details.cache_creation_tokens >= 0 ? u.input_tokens_details.cache_creation_tokens : undefined
          const cached = (read ?? 0) + (write ?? 0)
          const safe = cached <= u.input_tokens
          yield { type: 'usage', usage: {
            inputTokens: safe ? u.input_tokens - cached : u.input_tokens, outputTokens: u.output_tokens, totalTokens: u.total_tokens,
            ...(safe && read !== undefined ? { cacheReadTokens: read } : {}),
            ...(safe && write !== undefined ? { cacheWriteTokens: write } : {})
          } }
        }
        const content = [...completed.entries()].sort(([a], [b]) => a - b).map(([, block]) => block)
        yield { type: 'finish', reason, replayState: { response: {
          kind: 'enterprise-responses', version: 1, connectionKey, model: model.id,
          contentHash: hashContent(content), output: terminal.output
        } } }
        return
      }
    }
    throw new LlmError('Responses stream closed before completion.', 'STREAM_CLOSED')
  } finally {
    completed.clear()
    tools.clear()
    controller.abort()
    await frames?.return()
  }
}
