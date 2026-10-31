import { Service } from '@deepseek-ai/cordis'
import { observeRequestResponse } from './request-status.js'

const bindings = new WeakMap()

export class EnterpriseAuthError extends Error {
  constructor(errorCode, message, status = 503) {
    super(message)
    this.name = 'EnterpriseAuthError'
    this.errorCode = errorCode
    this.status = status
  }
}

function abortError(signal) {
  return signal.reason instanceof EnterpriseAuthError ? signal.reason : new EnterpriseAuthError('request_aborted', 'Enterprise request was cancelled.', 499)
}

function bindingFor(ctx) {
  for (let current = ctx; current; current = Object.getPrototypeOf(current)) {
    const binding = bindings.get(current)
    if (binding) {
      if (binding.active) return binding
      break
    }
  }
  throw new EnterpriseAuthError('authorization_denied', 'This plugin instance is not authorized.', 403)
}

function publicState(value) {
  if (!value || typeof value.connected !== 'boolean' || typeof value.sessionVersion !== 'string') {
    throw new EnterpriseAuthError('request_failed', 'Invalid enterprise authentication state.')
  }
  return Object.freeze({
    connected: value.connected,
    ...(typeof value.enterpriseId === 'string' ? { enterpriseId: value.enterpriseId } : {}),
    ...(typeof value.userId === 'string' ? { userId: value.userId } : {}),
    sessionVersion: value.sessionVersion
  })
}

/** Intercept configuration is not identity; Cordis traces the calling context. */
export function applyEnterpriseAuth(ctx) {
  ctx.provide('enterpriseAuth', {
    [Service.tracker]: { property: 'ctx' },
    getState() { return { ...bindingFor(this.ctx).state } },
    async request(path, init = {}) { return bindingFor(this.ctx).request(path, init) }
  })
}

/** Attach an already prepared grant synchronously before a new fiber applies.
 * Never attach to a reusable Loader entry or to the shared root context. */
export function inheritEnterpriseAuth(target, source) {
  bindings.set(target, bindingFor(source))
}

/** Only the trusted loader binds an actual per-instance context. */
export async function bindEnterpriseAuth(ctx, transport, onRequestSettled) {
  const lifetime = new AbortController()
  const binding = { active: true, state: publicState(await transport.state(lifetime.signal)), request }
  bindings.set(ctx, binding)
  let refreshing, requestRevision = 0
  const refresh = () => refreshing ??= transport.state(lifetime.signal).then(value => {
    if (binding.active) binding.state = publicState(value)
  }).catch(() => {
    if (binding.active) binding.state = Object.freeze({ connected: false, sessionVersion: binding.state.sessionVersion })
  }).finally(() => { refreshing = undefined })
  const timer = setInterval(() => { void refresh() }, 1000)
  timer.unref?.()
  async function request(path, init) {
    if (!binding.active) throw new EnterpriseAuthError('authorization_denied', 'This plugin instance was revoked.', 403)
    const signal = init.signal ? AbortSignal.any([init.signal, lifetime.signal]) : lifetime.signal
    if (signal.aborted) throw abortError(signal)
    const revision = ++requestRevision
    const settle = error => {
      if (binding.active && !signal.aborted && revision === requestRevision) onRequestSettled?.(error)
    }
    try {
      const response = await transport.request(path, { ...init, signal, sessionVersion: binding.state.sessionVersion })
      return onRequestSettled ? observeRequestResponse(response, signal, settle) : response
    } catch (error) {
      settle(error)
      throw error
    } finally { if (binding.active) void refresh() }
  }
  return () => {
    binding.active = false
    clearInterval(timer)
    lifetime.abort(new EnterpriseAuthError('authorization_denied', 'This plugin instance was revoked.', 403))
    // Retain a tombstone so old contexts cannot inherit another authorization.
  }
}

/** Capabilities remain in transport closures, never SDK properties. */
export function createEnterpriseAuthTransport(origin, capability) {
  const send = async (path, body, signal) => {
    if (signal?.aborted) throw abortError(signal)
    let response
    try {
      response = await fetch(new URL(path, origin), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${capability}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      throw new EnterpriseAuthError('request_failed', 'Enterprise authentication broker is unavailable.')
    }
    if (signal?.aborted) {
      await response.body?.cancel(signal.reason).catch(() => undefined)
      throw abortError(signal)
    }
    const errorCode = response.headers.get('x-dsh-enterprise-error')
    if (errorCode) {
      const payload = await response.json().catch(() => ({}))
      if (signal?.aborted) throw abortError(signal)
      throw new EnterpriseAuthError(errorCode, typeof payload.error === 'string' ? payload.error : 'Enterprise authentication request failed.', response.status)
    }
    if (!response.body) return response
    const reader = response.body.getReader()
    let ended = false, abortListener, cleanup
    const finish = (reason, cancel) => {
      signal?.removeEventListener('abort', abortListener)
      return cleanup ??= (async () => {
        try { if (cancel) await reader.cancel(reason) }
        finally { reader.releaseLock() }
      })()
    }
    const bodyStream = new ReadableStream({
      start(controller) {
        abortListener = () => {
          if (ended) return
          ended = true
          const error = abortError(signal)
          controller.error(error)
          // The public body already carries the cancellation error; cleanup failure cannot replace it.
          void finish(error, true).catch(() => undefined)
        }
        signal?.addEventListener('abort', abortListener, { once: true })
        if (signal?.aborted) abortListener()
      },
      async pull(controller) {
        try {
          if (signal?.aborted) throw abortError(signal)
          const chunk = await reader.read()
          if (signal?.aborted) throw abortError(signal)
          if (ended) return
          if (chunk.done) {
            ended = true
            controller.close()
            await finish(undefined, false)
          } else controller.enqueue(chunk.value)
        } catch (error) {
          if (ended) return
          ended = true
          const failure = signal?.aborted ? abortError(signal) : error instanceof EnterpriseAuthError ? error : new EnterpriseAuthError('request_failed', 'Enterprise response stream failed.')
          controller.error(failure)
          // Preserve the original stream failure while releasing the transport reader.
          await finish(failure, true).catch(() => undefined)
        }
      },
      cancel(reason) {
        ended = true
        return finish(reason, true)
      }
    }, { highWaterMark: 0 })
    return new Response(bodyStream, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  return {
    async state(signal) { return publicState(await (await send('/v1/auth/state', undefined, signal)).json()) },
    async request(path, init = {}) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
        throw new EnterpriseAuthError('invalid_request', 'An enterprise-relative request path is required.', 400)
      }
      let headers
      try { headers = Object.fromEntries(new Headers(init.headers)) }
      catch { throw new EnterpriseAuthError('invalid_request', 'Invalid enterprise request headers.', 400) }
      let body = init.body, bodyEncoding
      if (body != null && typeof body !== 'string') {
        if (body instanceof ArrayBuffer) body = new Uint8Array(body)
        if (!ArrayBuffer.isView(body)) throw new EnterpriseAuthError('invalid_request', 'Unsupported request body.', 400)
        body = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64')
        bodyEncoding = 'base64'
      }
      return send('/v1/auth/request', {
        path, ...(init.method === undefined ? {} : { method: init.method }), headers,
        ...(body == null ? {} : { body }), ...(bodyEncoding ? { bodyEncoding } : {}), sessionVersion: init.sessionVersion
      }, init.signal)
    }
  }
}
