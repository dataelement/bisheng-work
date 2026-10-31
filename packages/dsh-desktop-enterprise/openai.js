import { normalizeAuditContext } from './contract.js'
import { CONTENT_SAFETY_ERROR_COPY, resolveContentSafetyError } from './error-copy.js'
import {
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ToolCallId,
  attributionHeaders,
  contentHasImage,
  projectImagesForTextModel,
  requestImageHandleText,
  textOnlyImageText
} from '@deepseek-ai/dsh-llm'
import {
  enforceEnterpriseRequestSize,
  projectEnterpriseOffloadedImages,
  readEnterpriseRequestImages
} from './request-images.js'

export const ALLOWED_ATTRIBUTION_HEADERS = Object.freeze(['user-agent', 'x-dsh-conversation-id', 'x-dsh-request-purpose'])

export function pickAttributionHeaders(headers = {}) {
  const picked = {}
  for (const key of ALLOWED_ATTRIBUTION_HEADERS) {
    const value = headers[key] ?? headers[key.toUpperCase()]
    if (typeof value === 'string' && value.length > 0) picked[key] = value
  }
  return picked
}

const KNOWN_REQUEST_PURPOSES = new Set(['chat', 'compaction', 'session-title'])

/**
 * Forward conversation attribution only for fields this connection negotiated.
 * Callers that do not pass capabilities keep the header fallback used by Responses.
 * An unknown purpose is omitted so it cannot fail the model call.
 */
export function streamAttributionHeaders(sessionId, purpose, auditFields) {
  const base = attributionHeaders()
  if (sessionId === undefined) return pickAttributionHeaders(base)
  const negotiated = Array.isArray(auditFields)
  const requested = purpose ?? 'chat'
  return pickAttributionHeaders({
    ...base,
    ...(!negotiated || auditFields.includes('conversation_id') ? { 'x-dsh-conversation-id': String(sessionId) } : {}),
    ...(KNOWN_REQUEST_PURPOSES.has(requested) && (!negotiated || auditFields.includes('request_kind'))
      ? { 'x-dsh-request-purpose': requested }
      : {})
  })
}

function textContent(blocks) {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError('Image input is unavailable for this model or message role.', 'UNSUPPORTED_CONTENT')
  }
}

function assertRoleAllowsImages(message) {
  if (message.role === 'user' || message.role === 'tool') return
  assertTextOnly(message.content)
  for (const block of message.content ?? []) {
    if (block.type === 'tool-result') assertTextOnly(block.content)
  }
}

// Text-only routes stay usable by replacing images with the upstream placeholder.
// The shared projection does not recurse into legacy tool-result blocks.
export function projectEnterpriseMessagesForTextModel(messages) {
  return projectImagesForTextModel(messages).map((message) => {
    if (!message.content?.some((block) => block.type === 'tool-result' && contentHasImage(block.content ?? []))) {
      return message
    }
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type !== 'tool-result' || !contentHasImage(block.content ?? [])) return block
        return {
          ...block,
          content: block.content.map((inner) => (
            inner.type === 'image'
              ? { type: 'text', text: textOnlyImageText(inner.attachment) }
              : inner
          ))
        }
      })
    }
  })
}

function imageUrlPart(block, images) {
  const image = images.get(block.attachment.attachmentId)
  if (!image) throw new LlmError('Image attachment is unavailable.', 'UNSUPPORTED_CONTENT')
  return { type: 'image_url', image_url: { url: image.url } }
}

function assistantMessage(message, includeReasoning) {
  const content = textContent(message.content)
  const reasoning = message.content
    .filter((block) => block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
  const toolCalls = message.content
    .filter((block) => block.type === 'tool-call')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments }
    }))
  return {
    role: 'assistant',
    content,
    ...(includeReasoning && reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  }
}

export function serializeEnterpriseRequest(options, model, images = new Map(), onMessage) {
  const history = model.capabilities.vision
    ? options.messages
    : projectEnterpriseMessagesForTextModel(options.messages)
  const messages = []
  const append = (message, sources = []) => {
    const index = messages.length
    messages.push(message)
    onMessage?.(index, sources)
  }
  // 109 accepts image_url on user messages, not image arrays on tool.content.
  // Keep each tool call contiguous, then flush retained images once.
  const pendingToolImages = []
  const pendingToolSources = []
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return
    append({ role: 'user', content: pendingToolImages.splice(0) }, pendingToolSources.splice(0))
  }
  const queueToolImages = (toolCallId, blocks, source) => {
    if (!model.capabilities.vision) return
    for (const block of blocks ?? []) {
      if (block.type !== 'image') continue
      const image = images.get(block.attachment.attachmentId)
      if (!image) throw new LlmError('Image attachment is unavailable.', 'UNSUPPORTED_CONTENT')
      pendingToolImages.push({
        type: 'text',
        text: `Tool call ${toolCallId}. ${requestImageHandleText(block.attachment, image)}`
      })
      pendingToolImages.push(imageUrlPart(block, images))
      pendingToolSources.push(source)
    }
  }
  const pushToolResult = (toolCallId, blocks, source) => {
    append({
      role: 'tool',
      tool_call_id: toolCallId,
      content: textContent(blocks) || '(no output)'
    }, [source])
    queueToolImages(toolCallId, blocks, source)
  }
  if (options.system !== undefined) append({ role: 'system', content: options.system })
  for (const message of history) {
    if (model.capabilities.vision) assertRoleAllowsImages(message)
    if (message.role === 'system') {
      flushToolImages()
      append({ role: 'system', content: textContent(message.content) }, [message.source])
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      append(assistantMessage(message, model.capabilities.reasoning_content), [message.source])
      continue
    }
    // Harness carries tool results as messages; the call ID belongs to the message.
    if (message.role === 'tool') {
      pushToolResult(message.toolCallId, message.content, message.source)
      continue
    }
    const toolResults = message.content.filter((block) => block.type === 'tool-result')
    if (toolResults.length === 0) flushToolImages()
    for (const result of toolResults) pushToolResult(result.toolCallId, result.content, message.source)
    if (toolResults.length > 0) flushToolImages()
    const regularText = textContent(message.content)
    const parts = message.content.filter(block => block.type === 'text' || block.type === 'image')
    const hasImages = parts.some(block => block.type === 'image')
    const content = hasImages ? parts.map(block => (
      block.type === 'text' ? block : imageUrlPart(block, images)
    )) : regularText
    if (hasImages || regularText || toolResults.length === 0) append({ role: 'user', content }, [message.source])
  }
  flushToolImages()
  const tools = options.tools?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))
  if (tools && tools.length > 0 && !model.capabilities.tools) {
    throw new LlmError(`BiSheng model "${model.id}" does not support tools.`, 'UNSUPPORTED_OPTION')
  }
  const reasoningEffort = options.reasoningEffort ?? model.reasoning?.defaultEffort
  if (reasoningEffort !== undefined && !model.reasoning?.efforts.some((effort) => effort.id === reasoningEffort)) {
    throw new LlmError(`BiSheng model "${model.id}" does not support reasoning effort "${reasoningEffort}".`, 'UNSUPPORTED_REASONING_EFFORT')
  }
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_completion_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    n: 1
  }
}

export async function* parseSseEvents(body, signal, limits) {
  if (!body) throw new LlmError('BiSheng returned an empty event stream.', 'STREAM_CLOSED')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let total = 0
  let pendingCr = false
  const onAbort = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      total += value?.byteLength ?? 0
      if (limits && total > limits.total) throw new LlmError('BiSheng stream exceeds the size limit.', 'INVALID_RESPONSE')
      let decoded = (pendingCr ? '\r' : '') + decoder.decode(value ?? new Uint8Array(), { stream: !done })
      pendingCr = !done && decoded.endsWith('\r')
      if (pendingCr) decoded = decoded.slice(0, -1)
      buffer += decoded.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        if (limits && Buffer.byteLength(frame) > limits.event) throw new LlmError('BiSheng event exceeds the size limit.', 'INVALID_RESPONSE')
        buffer = buffer.slice(boundary + 2)
        if (!frame || frame.startsWith(':')) continue
        let event = 'message'
        const data = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''))
        }
        if (data.length > 0) yield { event, data: data.join('\n') }
      }
      if (limits && Buffer.byteLength(buffer) > limits.event) throw new LlmError('BiSheng event exceeds the size limit.', 'INVALID_RESPONSE')
      if (done) break
    }
    if (buffer.trim() && !buffer.trimStart().startsWith(':')) {
      throw new LlmError('BiSheng event stream ended with an incomplete frame.', 'STREAM_CLOSED')
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const LOCAL_CHAT_FAILURES = Object.freeze({
  'Enterprise models are unavailable.': {
    zh: '企业模型暂不可用。',
    en: 'Enterprise models are unavailable.'
  },
  'Enterprise session changed.': {
    zh: '企业会话已变更。',
    en: 'Enterprise session changed.'
  },
  'Enterprise model response timed out.': {
    zh: '模型响应超时，请稍后手动重试。',
    en: 'The model response timed out. Try again manually later.'
  }
})

function isChineseLocale(language) {
  return String(language || '').toLowerCase().startsWith('zh')
}

function readUiLanguage() {
  return typeof navigator === 'object' && navigator && typeof navigator.language === 'string'
    ? navigator.language
    : 'en'
}

const CHAT_PLATFORM_CODES = new Set([
  'upstream_error',
  'upstream_timeout',
  'monthly_token_limit_exceeded',
  'quota_unavailable',
  'usage_unavailable',
  'model_not_allowed',
  'invalid_request',
  'unsupported_parameter',
  'authorization_unavailable',
  'internal_error',
  'invalid_access_token',
  'session_expired',
  'session_revoked',
  'seat_revoked',
  'dsh_disabled',
  'user_disabled',
  'tenant_unavailable',
  'enterprise_models_unavailable',
  'enterprise_session_changed',
  'enterprise_chat_busy',
  'UNKNOWN_MODEL'
])

const LEGACY_CHAT_PHRASES = Object.freeze({
  'monthly token limit exceeded': 'monthly_token_limit_exceeded',
  'monthly token limit reached': 'monthly_token_limit_exceeded',
  'authorization unavailable': 'authorization_unavailable',
  'dsh authorization is temporarily unavailable': 'authorization_unavailable',
  'quota unavailable': 'quota_unavailable',
  'dsh quota state is temporarily unavailable': 'quota_unavailable',
  'usage unavailable': 'usage_unavailable',
  'actual request usage could not be confirmed': 'usage_unavailable',
  'seat revoked': 'seat_revoked',
  'dsh seat revoked': 'seat_revoked',
  'session revoked': 'session_revoked',
  'dsh session revoked': 'session_revoked',
  'session expired': 'session_expired',
  'dsh session expired': 'session_expired',
  'invalid access token': 'invalid_access_token',
  'invalid dsh access token': 'invalid_access_token',
  'internal error': 'internal_error',
  'user disabled': 'user_disabled',
  'tenant unavailable': 'tenant_unavailable',
  'dsh disabled': 'dsh_disabled'
})

const LOCAL_CHAT_PHRASES = Object.freeze({
  'enterprise models are unavailable': 'enterprise_models_unavailable',
  'enterprise session changed': 'enterprise_session_changed',
  'model is not assigned to this account': 'UNKNOWN_MODEL',
  'too many enterprise chats': 'enterprise_chat_busy'
})

const CHAT_MESSAGE_LIMIT = 300

function payloadError(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) &&
    payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error
    : null
}

function rawChatMessage(payload) {
  const objectMessage = payloadError(payload)?.message
  if (typeof objectMessage === 'string' && objectMessage.length > 0) return objectMessage
  return payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.error === 'string'
    ? payload.error
    : ''
}

function normalizeChatPhrase(value) {
  return value.trim().replace(/\.$/u, '').trim().toLowerCase()
}

function messageLooksLikeHtml(value) {
  return /<[a-z!/][^>]*>/iu.test(value)
}

function sanitizeChatMessage(value) {
  return value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, CHAT_MESSAGE_LIMIT)
}

function formatEnterpriseChatFailure(status, payload, language) {
  if (platformChatCode(payload) === 'context_length_exceeded') return 'Model context length exceeded'
  const zh = isChineseLocale(language)
  const raw = rawChatMessage(payload)
  const local = LOCAL_CHAT_FAILURES[raw]
  if (local) return zh ? local.zh : local.en
  const fallback = zh ? `毕昇模型请求失败（${status}）。` : `BiSheng model request failed (${status}).`
  if (!raw || messageLooksLikeHtml(raw)) {
    const stripped = raw ? sanitizeChatMessage(raw) : ''
    return stripped || fallback
  }
  return sanitizeChatMessage(raw) || fallback
}

function platformChatCode(payload) {
  const carried = payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.errorCode === 'string'
    ? payload.errorCode.trim()
    : ''
  if (carried && carried !== 'request_failed' && CHAT_PLATFORM_CODES.has(carried)) return carried
  const code = payloadError(payload)?.code
  if (typeof code === 'string' && code.trim() && code.trim() !== 'request_failed') return code.trim()
  const phrase = normalizeChatPhrase(rawChatMessage(payload))
  return LEGACY_CHAT_PHRASES[phrase] || LOCAL_CHAT_PHRASES[phrase] || 'request_failed'
}

function classifyChatFailure(code, status) {
  // Compaction retries only this harness code. The chat UI localizes the BiSheng sentence on its own.
  if (code === 'context_length_exceeded') return 'CONTEXT_WINDOW_EXCEEDED'
  if (CHAT_PLATFORM_CODES.has(code)) return code
  if (code !== 'request_failed') return code
  if (status >= 500) return 'SERVER'
  if (status === 429) return 'RATE_LIMIT'
  return 'PROVIDER_ERROR'
}

function requestIdFrom(headerId, payload) {
  if (typeof headerId === 'string' && headerId.length > 0) return headerId
  const bodyId = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload.request_id
    : undefined
  return typeof bodyId === 'string' && bodyId.length > 0 ? bodyId : undefined
}

const GATEWAY_CHECK_UNAVAILABLE_MESSAGES = new Set([
  'Content safety check unavailable',
  'Content check unavailable'
])

function contentSafetyMessage(safety, locale, localizeContentSafety) {
  const fallback = CONTENT_SAFETY_ERROR_COPY[safety.code][locale]
  const gatewayDefault = safety.code === 'CONTENT_CHECK_UNAVAILABLE' && GATEWAY_CHECK_UNAVAILABLE_MESSAGES.has(safety.message)
  // Every explicit blocked reply belongs to the tenant, including text equal to fixed copy.
  if (safety.message && !gatewayDefault) return safety.message
  if (typeof localizeContentSafety !== 'function') return safety.message ?? fallback
  try {
    const localized = localizeContentSafety(safety.code, fallback)
    if (typeof localized === 'string') {
      const safe = resolveContentSafetyError(safety.code, localized)?.message
      if (safe) return safe
    } else {
      // Optional async display results are ignored, but their rejection must be observed.
      void Promise.resolve(localized).catch(() => {})
    }
  } catch {
    // Localization is optional; a failing hook cannot replace or leak the safety failure.
  }
  return fallback
}

export function requestFailure(status, requestId, payload, localizeContentSafety) {
  console.warn('[enterprise] model response failed', {
    status, requestId: requestIdFrom(requestId, payload),
    code: platformChatCode(payload), message: sanitizeChatMessage(rawChatMessage(payload))
  })
  const safety = resolveContentSafetyError(payloadError(payload)?.code, rawChatMessage(payload))
    ?? resolveContentSafetyError(payload?.code, payload?.message)
    ?? resolveContentSafetyError(payload?.errorCode, rawChatMessage(payload))
  const safetyBodyId = typeof payload?.request_id === 'string' && payload.request_id.trim() ? payload.request_id : undefined
  const resolvedId = safety ? safetyBodyId ?? requestIdFrom(requestId, null) : requestIdFrom(requestId, payload)
  const language = readUiLanguage().toLowerCase()
  const locale = language.startsWith('zh') ? 'zh' : language.startsWith('ja') ? 'ja' : 'en'
  return new LlmError(
    safety ? contentSafetyMessage(safety, locale, localizeContentSafety)
      : formatEnterpriseChatFailure(status, payload, language),
    safety?.code ?? classifyChatFailure(platformChatCode(payload), status),
    {
      status,
      ...(resolvedId ? { requestId: ProviderRequestId(resolvedId) } : {})
    }
  )
}

export async function responseFailure(response, localizeContentSafety) {
  const payload = await response.json().catch(() => ({}))
  return requestFailure(response.status, response.headers.get('x-request-id') ?? undefined, payload, localizeContentSafety)
}

export function contentSafetyFormatterForStream(options, hooks) {
  const fallback = hooks.localizeContentSafety
  try {
    if (typeof hooks.contentSafetyFormatterFor !== 'function') return fallback
    const formatter = hooks.contentSafetyFormatterFor({
      sessionId: options.sessionId,
      purpose: options.purpose ?? 'chat'
    })
    if (typeof formatter === 'function') return formatter
    // Observe invalid async results without adopting them or leaking a rejected Promise.
    void Promise.resolve(formatter).catch(() => {})
    return fallback
  } catch {
    // Display context is optional and cannot interrupt ordinary model requests.
    return fallback
  }
}

function validUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prompt = value.prompt_tokens
  const completion = value.completion_tokens
  const total = value.total_tokens
  if (prompt === null && completion === null && total === null) return undefined
  if (
    !Number.isSafeInteger(prompt) || prompt < 0 ||
    !Number.isSafeInteger(completion) || completion < 0 ||
    !Number.isSafeInteger(total) || total < 0 ||
    total !== prompt + completion
  ) return undefined
  const details = value.prompt_tokens_details
  const read = details && typeof details === 'object' && !Array.isArray(details)
    ? optionalTokenCount(details.cached_tokens)
    : undefined
  const write = details && typeof details === 'object' && !Array.isArray(details)
    ? optionalTokenCount(details.cache_creation_tokens)
    : undefined
  const cached = (read ?? 0) + (write ?? 0)
  const safeCache = cached <= prompt
  return {
    inputTokens: safeCache ? prompt - cached : prompt,
    outputTokens: completion,
    totalTokens: total,
    ...(safeCache && read !== undefined ? { cacheReadTokens: read } : {}),
    ...(safeCache && write !== undefined ? { cacheWriteTokens: write } : {})
  }
}

function optionalTokenCount(value) {
  if (value === null || value === undefined) return undefined
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function finishReason(value, payload, requestId, localizeContentSafety) {
  if (value === 'stop') return { kind: 'stop' }
  if (value === 'length') return { kind: 'max-tokens' }
  if (value === 'tool_calls') return { kind: 'tool-calls' }
  if (value === 'content_filter') {
    return {
      kind: 'error',
      failure: requestFailure(200, requestId, {
        error: { code: 'content_blocked', message: payload?.content_safety?.message },
        request_id: payload?.request_id
      }, localizeContentSafety).failure
    }
  }
  return undefined
}

export class EnterpriseLlmAdapter extends LlmAdapter {
  /**
   * @param {object} options
   * @param {() => string} options.providerName
   * @param {() => import('./contract.js').EnterpriseModel[]} options.models
   * @param {() => readonly string[]} [options.auditFields] Current trusted connection capability; not persisted.
   * @param {Function} options.request Existing credential broker transport.
   * @param {Function} [options.readImage]
   * @param {(code: string, defaultMessage: string) => string} [options.localizeContentSafety] Current UI locale's fixed safety copy.
   * @param {Function} [options.contentSafetyFormatterFor] Synchronous factory captured once per protocol stream.
   * @param {Function} [options.onComplete]
   */
  constructor(options) {
    super()
    this.options = options
  }

  providerInfo(provider) {
    return { id: provider, name: this.options.providerName() }
  }

  providerRetryPolicy() {
    return { mode: 'normal', maxRetries: 0, retryableCodes: ['TRANSPORT'] }
  }

  listModels(provider) {
    return Promise.resolve(this.options.models().map((model) => ({
      provider,
      id: model.id,
      name: model.display_name,
      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      inputModalities: model.capabilities.vision ? ['text', 'image'] : ['text']
    })))
  }

  resolveModel(provider, id) {
    const model = this.options.models().find((candidate) => candidate.id === id)
    if (!model) throw new LlmError(`BiSheng provider has no authorized model "${id}".`, 'UNKNOWN_MODEL')
    return Promise.resolve({
      provider,
      id,
      name: model.display_name,
      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      inputModalities: model.capabilities.vision ? ['text', 'image'] : ['text']
    })
  }

  async *stream(options) {
    const model = this.options.models().find((candidate) => candidate.id === options.model)
    if (!model) throw new LlmError(`BiSheng provider has no authorized model "${options.model}".`, 'UNKNOWN_MODEL')
    let session
    try {
      session = this.options.resolveAuditSession?.(options.sessionId)
    } catch {
      // Optional live-session metadata must not interrupt a model call.
      session = undefined
    }
    if (model.capabilities.responses === true) {
      const connectionKey = this.options.connectionKey?.()
      const { streamEnterpriseResponses } = await import('./responses.js')
      yield* streamEnterpriseResponses(options, model, this.options, connectionKey, session)
      return
    }
    const localizeContentSafety = contentSafetyFormatterForStream(options, this.options)
    const history = model.capabilities.vision
      ? projectEnterpriseOffloadedImages(options.messages)
      : projectEnterpriseMessagesForTextModel(options.messages)
    const images = model.capabilities.vision
      ? await readEnterpriseRequestImages(history, this.options.readImage, options.signal)
      : new Map()
    options.signal?.throwIfAborted()
    const auditFields = this.options.auditFields?.() ?? []
    const headers = streamAttributionHeaders(options.sessionId, options.purpose, auditFields)
    const serialize = (messages) => serializeEnterpriseRequest({ ...options, messages }, model, images)
    enforceEnterpriseRequestSize(history, serialize, headers)
    const sourceItems = []
    let truncated = false
    const onMessage = auditFields.includes('message_sources') ? (message_index, sources) => {
      const known = sources.filter(source => source && typeof source.kind === 'string')
      if (sources.length > 1 && known.length !== sources.length) truncated = true
      if (!known.length) return
      if (sourceItems.length >= 128) { truncated = true; return }
      sourceItems.push({ message_index, sources: known.map(source => ({ kind: source.kind, ...(source.form === undefined ? {} : { form: source.form }) })) })
    } : undefined
    const request = serializeEnterpriseRequest({ ...options, messages: history }, model, images, onMessage)
    const auditContext = normalizeAuditContext({
      conversation_id: options.sessionId,
      request_kind: options.purpose === undefined ? 'chat' : options.purpose,
      session_origin: session?.session_origin,
      parent_conversation_id: session?.parent_conversation_id,
      ...(sourceItems.length || truncated ? { message_sources: { items: sourceItems, truncated } } : {})
    }, auditFields, request.messages.length)
    if (auditContext) request.audit_context = auditContext
    const response = await this.options.request(
      request,
      options.signal,
      headers
    )
    if (!response.ok) throw await responseFailure(response, localizeContentSafety)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('text/event-stream')) {
      throw new LlmError('BiSheng returned a non-SSE model response.', 'INVALID_RESPONSE', {
        status: response.status
      })
    }

    const blocks = []
    const tools = new Map()
    let textBlock
    let reasoningBlock
    let usage
    let stopped
    let done = false

    const startBlock = (type) => {
      const block = { index: blocks.length, type, text: '' }
      blocks.push(block)
      return block
    }

    for await (const event of parseSseEvents(response.body, options.signal)) {
      if (event.data === '[DONE]') {
        done = true
        break
      }
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        throw new LlmError('BiSheng event stream contains invalid JSON.', 'INVALID_RESPONSE')
      }
      if (event.event === 'error' || payload?.error) {
        for (const block of blocks) {
          if (block.type === 'text') yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
          else if (block.type === 'reasoning') yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
        }
        tools.clear()
        const failure = requestFailure(200, response.headers.get('x-request-id') ?? undefined, payload, localizeContentSafety)
        yield { type: 'finish', reason: { kind: 'error', failure: failure.failure } }
        return
      }
      const parsedUsage = validUsage(payload?.usage)
      if (parsedUsage) usage = parsedUsage
      const choices = Array.isArray(payload?.choices) ? payload.choices : []
      for (const choice of choices) {
        if (!choice || typeof choice !== 'object' || choice.index !== 0) continue
        const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {}
        if (model.capabilities.reasoning_content && typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          if (!reasoningBlock) {
            reasoningBlock = startBlock('reasoning')
            yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
          }
          reasoningBlock.text += delta.reasoning_content
          yield { type: 'reasoning-delta', index: reasoningBlock.index, text: delta.reasoning_content }
        }
        if (typeof delta.content === 'string' && delta.content) {
          if (!textBlock) {
            textBlock = startBlock('text')
            yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
          }
          textBlock.text += delta.content
          yield { type: 'text-delta', index: textBlock.index, text: delta.content }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const item of delta.tool_calls) {
            if (!item || !Number.isSafeInteger(item.index) || item.index < 0) continue
            let tool = tools.get(item.index)
            if (!tool) {
              tool = { index: undefined, id: '', name: '', arguments: '', pendingArguments: '' }
              tools.set(item.index, tool)
            }
            if (typeof item.id === 'string' && item.id) tool.id = item.id
            if (typeof item.function?.name === 'string') tool.name += item.function.name
            if (typeof item.function?.arguments === 'string') tool.pendingArguments += item.function.arguments
            if (tool.id && tool.index === undefined) {
              const block = startBlock('tool-call')
              tool.index = block.index
              block.id = tool.id
              block.name = tool.name
              block.arguments = ''
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
            }
            if (tool.index !== undefined && tool.pendingArguments) {
              const block = blocks[tool.index]
              block.name = tool.name
              block.arguments += tool.pendingArguments
              yield {
                type: 'tool-call-delta',
                index: tool.index,
                id: ToolCallId(tool.id),
                ...(tool.name ? { name: tool.name } : {}),
                argumentsDelta: tool.pendingArguments
              }
              tool.pendingArguments = ''
            }
          }
        }
        const nextStop = finishReason(choice.finish_reason, payload, response.headers.get('x-request-id') ?? undefined, localizeContentSafety)
        if (nextStop) stopped = nextStop
        if (stopped?.kind === 'error') {
          // A confirmed filter is terminal even if DONE is absent or a malformed tail follows.
          for (const block of blocks) {
            if (block.type === 'text' || block.type === 'reasoning') {
              yield { type: 'block-end', index: block.index, block: { type: block.type, text: block.text } }
            }
          }
          tools.clear()
          yield { type: 'finish', reason: stopped }
          return
        }
      }
    }

    if (!done || !stopped) throw new LlmError('BiSheng event stream closed before completion.', 'STREAM_CLOSED')
    if (blocks.length === 0 && stopped.kind !== 'error') {
      throw new LlmError('BiSheng event stream completed without model output.', 'EMPTY_RESPONSE')
    }
    for (const block of blocks) {
      if (block.type === 'text') {
        yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
      } else if (block.type === 'reasoning') {
        yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
      } else if (stopped.kind !== 'error' && stopped.kind !== 'max-tokens') {
        if (!block.id || !block.name) throw new LlmError('BiSheng returned an incomplete tool call.', 'INVALID_RESPONSE')
        try {
          JSON.parse(block.arguments)
        } catch {
          throw new LlmError('BiSheng returned incomplete tool arguments.', 'INVALID_RESPONSE')
        }
        yield {
          type: 'block-end',
          index: block.index,
          block: {
            type: 'tool-call',
            id: ToolCallId(block.id),
            name: block.name,
            arguments: block.arguments
          }
        }
      }
    }
    tools.clear()
    if (usage) yield { type: 'usage', usage }
    if (stopped.kind !== 'error') await this.options.onComplete?.(options.model)
    yield { type: 'finish', reason: stopped }
  }
}
