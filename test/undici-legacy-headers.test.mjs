import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const Dispatcher1Wrapper = require('undici/lib/dispatcher/dispatcher1-wrapper.js')

it.each(['object', 'array'])('preserves %s response headers for legacy fetch and decompresses gzip', async (shape) => {
  const headers = { 'content-type': 'application/json', 'content-encoding': 'gzip' }
  const rawHeaders = shape === 'object' ? headers : Object.entries(headers).flat().map(value => Buffer.from(value))
  const controller = { rawHeaders, resume() {}, pause() {}, abort() {} }
  const dispatcher = new Dispatcher1Wrapper({ dispatch(_options, handler) {
    queueMicrotask(() => {
      handler.onRequestStart(controller)
      handler.onResponseStart(controller, 200, headers, 'OK')
      handler.onResponseData(controller, gzipSync(JSON.stringify({ ok: true })))
      handler.onResponseEnd(controller, {})
    })
    return true
  } })
  // Node's bundled fetch consumes the legacy Dispatcher API, as do older plugins.
  const response = await fetch('https://example.test/diagnostic', { dispatcher })
  expect(response.headers.get('content-type')).toBe('application/json')
  expect(response.headers.get('content-encoding')).toBe('gzip')
  expect(await response.json()).toEqual({ ok: true })
})

it('converts HTTP/2 trailer objects to the legacy flat array', () => {
  let trailers
  const handler = Dispatcher1Wrapper.wrapHandler({ onComplete(value) { trailers = value } })
  handler.onResponseEnd({ rawTrailers: { 'x-check': 'done' } }, {})
  expect(trailers.map(value => value.toString())).toEqual(['x-check', 'done'])
})

it('preserves duplicate headers, streaming chunks, and request options', async () => {
  const requestBody = 'unchanged request'
  const headers = { 'content-type': 'text/event-stream', 'set-cookie': ['one=1', 'two=2'] }
  const controller = { rawHeaders: headers, resume() {}, pause() {}, abort() {} }
  let request
  const dispatcher = new Dispatcher1Wrapper({ dispatch(options, handler) {
    request = options
    queueMicrotask(() => {
      handler.onRequestStart(controller)
      handler.onResponseStart(controller, 200, headers, 'OK')
      handler.onResponseData(controller, Buffer.from('data: first\n\n'))
      handler.onResponseData(controller, Buffer.from('data: second\n\n'))
      handler.onResponseEnd(controller, {})
    })
    return true
  } })
  const response = await fetch('https://example.test/stream', { method: 'POST', body: requestBody, dispatcher })
  expect(request.method).toBe('POST')
  expect(response.headers.getSetCookie()).toEqual(['one=1', 'two=2'])
  expect(await response.text()).toBe('data: first\n\ndata: second\n\n')
})

it('keeps HTTP/1.1 upgrade headers and trailers arrays unchanged', () => {
  const headers = [Buffer.from('upgrade'), Buffer.from('websocket')]
  let receivedHeaders, receivedTrailers
  const handler = Dispatcher1Wrapper.wrapHandler({
    onUpgrade(_status, value) { receivedHeaders = value },
    onComplete(value) { receivedTrailers = value }
  })
  handler.onRequestUpgrade({ rawHeaders: headers }, 101, {}, {})
  handler.onResponseEnd({ rawTrailers: headers }, {})
  expect(receivedHeaders).toBe(headers)
  expect(receivedTrailers).toBe(headers)
})


it('preserves callback receivers across the complete legacy handler lifecycle', () => {
  const events = []
  let resume
  const controller = {
    rawHeaders: { 'content-type': 'text/plain' },
    rawTrailers: { 'x-finished': 'yes' },
    pause() { events.push('pause') },
    resume() { events.push('resume') },
    abort(reason) { events.push(reason) }
  }
  class LegacyHandler {
    #events = events
    onConnect(abort) { this.#events.push('connect'); abort('synthetic abort') }
    onResponseStarted() { this.#events.push('response-started') }
    onBodySent(chunk) { this.#events.push(chunk.toString()) }
    onRequestSent() { this.#events.push('request-sent') }
    onHeaders(_status, headers, next) { this.#events.push(headers[0].toString()); resume = next; return false }
    onData(chunk) { this.#events.push(chunk.toString()); return false }
    onComplete(trailers) { this.#events.push(trailers[0].toString()) }
    onError(error) { this.#events.push(error.message) }
    onUpgrade(_status, headers) { this.#events.push(headers[0].toString()) }
  }
  const dispatcher = new Dispatcher1Wrapper({ dispatch(_options, handler) {
    handler.onRequestStart(controller)
    handler.onResponseStarted()
    handler.onBodySent(Buffer.from('request-body'))
    handler.onRequestSent()
    handler.onResponseStart(controller, 200, {}, 'OK')
    resume()
    handler.onResponseData(controller, Buffer.from('response-body'))
    handler.onResponseEnd(controller, {})
    handler.onResponseError(controller, new Error('synthetic failure'))
    handler.onRequestUpgrade(controller, 101, {}, {})
    return true
  } })
  expect(dispatcher.dispatch({ origin: 'https://example.test', path: '/', method: 'GET' }, new LegacyHandler())).toBe(true)
  expect(events).toEqual(['connect', 'synthetic abort', 'response-started', 'request-body', 'request-sent', 'content-type', 'pause', 'resume', 'response-body', 'pause', 'x-finished', 'synthetic failure', 'content-type'])
})

it.each([false, true])('keeps private modern handler and controller state with frozen=%s', frozen => {
  const events = []
  const reason = new Error('synthetic abort')
  class Controller {
    #paused = false
    #reason = null
    #headers = { 'content-type': 'text/plain' }
    #trailers = { 'x-finished': 'yes' }
    get rawHeaders() { return this.#headers }
    set rawHeaders(value) { this.#headers = value }
    get rawTrailers() { return this.#trailers }
    set rawTrailers(value) { this.#trailers = value }
    get paused() { return this.#paused }
    get aborted() { return this.#reason !== null }
    get reason() { return this.#reason }
    pause() { this.#paused = true; events.push('pause') }
    resume() { this.#paused = false; events.push('resume') }
    abort(value) { this.#reason = value; events.push('abort') }
  }
  const controller = new Controller()
  if (frozen) Object.freeze(controller)
  class ModernHandler {
    #events = events
    onRequestStart(value) { this.#events.push('start'); expect(value).toBe(controller) }
    onResponseStarted() { this.#events.push('response-started') }
    onBodySent(chunk) { this.#events.push(chunk.toString()) }
    onRequestSent() { this.#events.push('request-sent') }
    onResponseStart(value) {
      this.#events.push(value.rawHeaders[0].toString())
      expect(value).toBeInstanceOf(Controller)
      expect(value.paused).toBe(false)
      value.pause()
      expect(value.paused).toBe(true)
      value.resume()
      expect(value.paused).toBe(false)
      value.abort(reason)
      expect(value.aborted).toBe(true)
      expect(value.reason).toBe(reason)
    }
    onResponseData(value, chunk) { this.#events.push(chunk.toString()); expect(value).toBe(controller) }
    onResponseEnd(value) { this.#events.push(value.rawTrailers[0].toString()); value.resume() }
    onResponseError(value, error) { this.#events.push(error.message); expect(value).toBe(controller) }
    onRequestUpgrade(value) { this.#events.push(value.rawHeaders[0].toString()); value.pause() }
  }
  const handler = new ModernHandler()
  if (frozen) Object.freeze(handler)
  const dispatcher = new Dispatcher1Wrapper({ dispatch(_options, adapted) {
    adapted.onRequestStart(controller)
    adapted.onResponseStarted()
    adapted.onBodySent(Buffer.from('request-body'))
    adapted.onRequestSent()
    adapted.onResponseStart(controller, 200, {}, 'OK')
    adapted.onResponseData(controller, Buffer.from('response-body'))
    adapted.onResponseEnd(controller, {})
    adapted.onResponseError(controller, new Error('synthetic failure'))
    adapted.onRequestUpgrade(controller, 101, {}, {})
    return true
  } })
  expect(dispatcher.dispatch({ origin: 'https://example.test', path: '/', method: 'GET' }, handler)).toBe(true)
  expect(events).toEqual(['start', 'response-started', 'request-body', 'request-sent', 'content-type', 'pause', 'resume', 'abort', 'response-body', 'x-finished', 'resume', 'synthetic failure', 'content-type', 'pause'])
})

it('keeps array-backed controllers and byte lists unchanged through dispatch', () => {
  const headers = [Buffer.from('content-type'), Buffer.from('text/plain')]
  const trailers = [Buffer.from('x-finished'), Buffer.from('yes')]
  const controller = Object.freeze({ rawHeaders: headers, rawTrailers: trailers })
  const dispatcher = new Dispatcher1Wrapper({ dispatch(_options, handler) {
    handler.onResponseStart(controller, 200, {}, 'OK')
    handler.onResponseEnd(controller, {})
    return true
  } })
  dispatcher.dispatch({ origin: 'https://example.test', path: '/', method: 'GET' }, {
    onRequestStart() {},
    onResponseStart(value) { expect(value).toBe(controller); expect(value.rawHeaders).toBe(headers) },
    onResponseEnd(value) { expect(value).toBe(controller); expect(value.rawTrailers).toBe(trailers) }
  })
})


it('preserves writable raw headers and trailers through the original private setters', () => {
  class Controller {
    #headers = { 'content-type': 'text/plain' }
    #trailers = { 'x-finished': 'yes' }
    #writes = 0
    get rawHeaders() { return this.#headers }
    set rawHeaders(value) { this.#headers = value; this.#writes++ }
    get rawTrailers() { return this.#trailers }
    set rawTrailers(value) { this.#trailers = value; this.#writes++ }
    get writes() { return this.#writes }
  }
  const controller = Object.freeze(new Controller())
  const headers = [Buffer.from('x-changed'), Buffer.from('yes')]
  const trailers = [Buffer.from('x-finished'), Buffer.from('updated')]
  const dispatcher = new Dispatcher1Wrapper({ dispatch(_options, handler) {
    handler.onResponseStart(controller, 200, {}, 'OK')
    handler.onResponseEnd(controller, {})
    return true
  } })
  class Handler {
    onRequestStart() {}
    onResponseStart(value) {
      expect(Array.isArray(value.rawHeaders)).toBe(true)
      value.rawHeaders = headers
      expect(value.rawHeaders).toBe(headers)
      expect(controller.rawHeaders).toBe(headers)
    }
    onResponseEnd(value) {
      expect(Array.isArray(value.rawTrailers)).toBe(true)
      value.rawTrailers = trailers
      expect(value.rawTrailers).toBe(trailers)
      expect(controller.rawTrailers).toBe(trailers)
    }
  }
  dispatcher.dispatch({ origin: 'https://example.test', path: '/', method: 'GET' }, new Handler())
  expect(controller.writes).toBe(2)
})
