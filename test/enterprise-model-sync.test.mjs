import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../packages/dsh-desktop-enterprise/client.js', import.meta.url), 'utf8')
const start = source.indexOf('    function bindEnterpriseModelSync()')
const end = source.indexOf('    async function api(', start)
const accountChanged = 'test:account-changed'
let dispose

afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers() })

function fixture() {
  vi.useFakeTimers()
  const window = Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval })
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const api = vi.fn(async () => ({}))
  const warn = vi.fn()
  const bind = vm.runInNewContext(`${source.slice(start, end)}; bindEnterpriseModelSync`, {
    window, document, api, AbortController, ACCOUNT_CHANGED_EVENT: accountChanged, console: { warn }
  })
  return { window, document, api, warn, start() { dispose = bind() } }
}

it('refreshes on startup, foreground focus, account changes and the visible 30-second interval', async () => {
  const f = fixture()
  f.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.api).toHaveBeenCalledWith('/api/enterprise.models.refresh', {}, expect.any(AbortSignal))
  f.window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(0)
  f.window.dispatchEvent(new Event(accountChanged))
  await vi.advanceTimersByTimeAsync(30_000)
  expect(f.api).toHaveBeenCalledTimes(4)
  f.document.visibilityState = 'hidden'
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.api).toHaveBeenCalledTimes(4)
  f.document.visibilityState = 'visible'
  f.document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(0)
  expect(f.api).toHaveBeenCalledTimes(5)
})

it('coalesces simultaneous foreground events and cancels requests and listeners on disposal', async () => {
  const f = fixture()
  f.api.mockImplementation(() => new Promise(() => {}))
  f.start()
  const signal = f.api.mock.calls[0][2]
  f.window.dispatchEvent(new Event('focus'))
  f.document.dispatchEvent(new Event('visibilitychange'))
  expect(f.api).toHaveBeenCalledTimes(1)
  dispose()
  expect(signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  f.window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.api).toHaveBeenCalledTimes(1)
})

it('retries after a failed refresh and bounds each request lifetime', async () => {
  const f = fixture()
  f.api.mockRejectedValueOnce(new Error('offline'))
  f.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.warn).toHaveBeenCalledTimes(1)
  f.api.mockImplementation((_path, _body, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))
  f.window.dispatchEvent(new Event('focus'))
  const signal = f.api.mock.calls[1][2]
  await vi.advanceTimersByTimeAsync(30_000)
  expect(signal.aborted).toBe(true)
  f.window.dispatchEvent(new Event('focus'))
  expect(f.api).toHaveBeenCalledTimes(3)
})
