import { CONTENT_SAFETY_ERROR_COPY } from './error-copy.js'

const codes = Object.keys(CONTENT_SAFETY_ERROR_COPY)

function idOf(value) {
  return typeof value?.id === 'string' && value.id ? value.id : undefined
}

/** Copy only the fixed, display-only messages already validated at request admission. */
function snapshot(messages) {
  if (!messages || typeof messages !== 'object' || Array.isArray(messages)) return undefined
  if (!codes.every(code => Object.hasOwn(messages, code) &&
    Object.values(CONTENT_SAFETY_ERROR_COPY[code]).includes(messages[code]))) return undefined
  return Object.freeze(Object.fromEntries(codes.map(code => [code, messages[code]])))
}

function formatter(messages) {
  return messages ? (code, fallback) => Object.hasOwn(messages, code) ? messages[code] : fallback : undefined
}

/**
 * Keep request display hints beside the public inbox, never in a message or model payload.
 * @param {{on: (event: string, listener: Function) => Function}} ctx Host event context.
 * @param {() => object | undefined} requestLocale Synchronous current request ALS projection.
 * @returns {{formatterFor: Function, dispose: Function}} Per-stream formatter factory and owner cleanup.
 */
export function createContentSafetyLocaleScope(ctx, requestLocale) {
  const pending = new Map()
  const active = new Map()
  let disposed = false
  const readRequest = () => {
    try { return snapshot(requestLocale()) } catch {
      // Display context is optional and cannot interrupt a model request.
      return undefined
    }
  }
  const clearSession = sessionId => {
    pending.delete(sessionId)
    active.delete(sessionId)
  }
  const disposers = [
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      const sessionId = idOf(agent), messageId = idOf(message)
      if (disposed || !sessionId || !messageId) return
      if (!pending.has(sessionId)) pending.set(sessionId, new Map())
      // Map presence records known missing hints as well as available hints.
      pending.get(sessionId).set(messageId, readRequest())
    }),
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const sessionId = idOf(agent), messageId = idOf(message)
      if (disposed || !sessionId || !messageId) return
      const inbox = pending.get(sessionId)
      const messages = inbox?.get(messageId)
      inbox?.delete(messageId)
      if (inbox?.size === 0) pending.delete(sessionId)
      // An unobserved or missing selection is explicit. Never inherit the old
      // driver's ALS when it claims a later request with no valid display hint.
      active.set(sessionId, { turn, messages })
    }),
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const sessionId = idOf(agent), messageId = idOf(message)
      if (disposed || !sessionId || !messageId) return
      const inbox = pending.get(sessionId)
      inbox?.delete(messageId)
      if (inbox?.size === 0) pending.delete(sessionId)
    }),
    ctx.on('session/event', (session, event) => {
      if (disposed || event.type !== 'turn/end') return
      const sessionId = idOf(session)
      if (active.get(sessionId)?.turn === event.data.turn) active.delete(sessionId)
    }),
    ctx.on('agent/disposed', ({ agent }) => clearSession(idOf(agent))),
    ctx.on('session/disposed', session => clearSession(idOf(session)))
  ]
  return {
    formatterFor({ sessionId, purpose = 'chat' } = {}) {
      if (disposed) return undefined
      if (purpose === 'chat' && sessionId && active.has(sessionId)) return formatter(active.get(sessionId).messages)
      // Auxiliary title/compaction calls and direct calls keep their initiating
      // request scope; queued future chat input never changes an in-flight copy.
      return formatter(readRequest())
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.reverse()) dispose()
      pending.clear()
      active.clear()
    }
  }
}
