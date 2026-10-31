import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { registerDesktopNotificationBridge } from '../src/main/desktop-notification'
import { configureNotificationIdentity } from '../src/main/notification-identity'
import { WORK_COMPLETED, WORK_NOTIFICATION_CLICKED } from '../src/shared/desktop-notification'

const mock = vi.hoisted(() => ({
  handle: vi.fn(), removeHandler: vi.fn(), supported: vi.fn(() => true),
  create: vi.fn(), show: vi.fn(), focus: vi.fn()
}))
vi.mock('electron', () => ({
  app: { focus: mock.focus },
  ipcMain: { handle: mock.handle, removeHandler: mock.removeHandler },
  Notification: class extends EventEmitter {
    static isSupported = mock.supported
    constructor(public options: object) { super(); mock.create(this) }
    show = mock.show
    close() { this.emit('close') }
  }
}))
const payload = { sessionId: 'session-1', seq: 8, turn: 1, count: 1 }
const cleanups: Array<() => void> = []
function fixture(locale: 'en' | 'zh' = 'zh') {
  const webContents = { mainFrame: {}, send: vi.fn() }
  const window = {
    webContents, isDestroyed: () => false, isVisible: vi.fn(() => true), isFocused: vi.fn(() => false),
    isMinimized: vi.fn(() => false), restore: vi.fn(), show: vi.fn(), focus: vi.fn()
  }
  const audit = vi.fn()
  const icon = new URL('../build/app-icon.png', import.meta.url).pathname
  // Fixture implements exactly the BrowserWindow/IPC members consumed by this module.
  cleanups.push(registerDesktopNotificationBridge(() => window as unknown as BrowserWindow, () => icon, () => locale, audit))
  const receive = mock.handle.mock.calls.at(-1)?.[1] as (event: IpcMainInvokeEvent, value: unknown) => string
  const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent
  const send = (value: unknown = payload) => receive(event, value)
  return { window, audit, icon, receive, event, send }
}
beforeEach(() => { vi.clearAllMocks(); mock.supported.mockReturnValue(true); mock.show.mockReset() })
afterEach(() => { cleanups.splice(0).forEach(fn => fn()) })

it.each(['background', 'minimized', 'hidden'])('requests a native notification while %s', mode => {
  const f = fixture()
  if (mode === 'minimized') { f.window.isMinimized.mockReturnValue(true); f.window.isFocused.mockReturnValue(true) }
  if (mode === 'hidden') f.window.isVisible.mockReturnValue(false)
  expect(f.send()).toBe('requested')
  const notification = mock.create.mock.calls[0]?.[0]
  expect(notification.options).toEqual({ title: 'Work 任务已完成', body: '点击查看任务结果。', icon: f.icon, silent: false })
  expect(mock.show).toHaveBeenCalledOnce()
  expect(f.audit.mock.calls.map(c => c[0])).toEqual(['requested'])
  notification.emit('show')
  expect(f.audit.mock.calls.map(c => c[0])).toEqual(['requested', 'shown'])
})
it('consumes foreground completions and replayed sequence numbers once', () => {
  const f = fixture()
  f.window.isFocused.mockReturnValue(true)
  expect(f.send()).toBe('foreground')
  f.window.isFocused.mockReturnValue(false)
  expect(f.send()).toBe('duplicate')
  expect(f.send({ ...payload, seq: 7 })).toBe('duplicate')
  expect(f.send({ ...payload, turn: 2, seq: 16 })).toBe('requested')
  expect(mock.create).toHaveBeenCalledOnce()
})
it('restores the minimized window and routes a click to the completed Work session', () => {
  const f = fixture('en')
  f.window.isMinimized.mockReturnValue(true)
  f.send()
  const notification = mock.create.mock.calls[0]?.[0]
  expect(notification.options.title).toBe('Work task completed')
  notification.emit('click')
  expect(f.window.restore).toHaveBeenCalledOnce()
  expect(f.window.show).toHaveBeenCalledOnce()
  expect(f.window.focus).toHaveBeenCalledOnce()
  expect(f.window.webContents.send).toHaveBeenCalledWith(WORK_NOTIFICATION_CLICKED, payload.sessionId)
})
it('rejects foreign windows and child frames before constructing a native notification', () => {
  const f = fixture()
  expect(() => f.receive({ ...f.event, sender: {} } as IpcMainInvokeEvent, payload)).toThrow('main BISHENG')
  expect(() => f.receive({ ...f.event, senderFrame: null }, payload)).toThrow('main BISHENG')
  expect(mock.create).toHaveBeenCalledTimes(0)
})
it.each([null, {}, { ...payload, seq: NaN }, { ...payload, turn: 0 }, { ...payload, count: -1 }, { ...payload, sessionId: '../secret' }])('validates completion payload %j', value => {
  const f = fixture()
  expect(() => f.send(value)).toThrow('Invalid Work completion')
  expect(mock.create).toHaveBeenCalledTimes(0)
})
it('records unsupported, asynchronous native failure and synchronous exceptions distinctly', () => {
  const f = fixture()
  mock.supported.mockReturnValue(false)
  expect(f.send()).toBe('unsupported')
  mock.supported.mockReturnValue(true)
  expect(f.send({ ...payload, seq: 16, turn: 2 })).toBe('requested')
  mock.create.mock.calls[0]?.[0].emit('failed', {}, 'HRESULT 0x80070490 token=private')
  expect(f.audit.mock.calls.at(-1)?.[0]).toBe('failed')
  expect(f.audit.mock.calls.at(-1)?.[1].error).toBe('HRESULT 0x80070490 token=[redacted]')
  mock.show.mockImplementationOnce(() => { throw new Error('HRESULT 0x80004005') })
  expect(f.send({ ...payload, seq: 24, turn: 3 })).toBe('failed')
  expect(f.audit.mock.calls.at(-1)?.[1].error).toContain('0x80004005')
})
it('releases handlers and active notifications on disposal', () => {
  const f = fixture()
  f.send()
  const close = vi.spyOn(mock.create.mock.calls[0]?.[0], 'close')
  cleanups.pop()?.()
  expect(close).toHaveBeenCalledOnce()
  expect(mock.removeHandler).toHaveBeenCalledWith(WORK_COMPLETED)
})
describe('Windows notification identity', () => {
  it('matches production and development NSIS app IDs before notification use', () => {
    const app = { setAppUserModelId: vi.fn() }
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    configureNotificationIdentity(app, 'win32', false)
    expect(app.setAppUserModelId).toHaveBeenLastCalledWith(manifest.build.appId)
    configureNotificationIdentity(app, 'win32', true)
    expect(app.setAppUserModelId).toHaveBeenLastCalledWith(createRequire(import.meta.url)('../electron-builder.dev.cjs').appId)
    configureNotificationIdentity(app, 'darwin', false)
    expect(app.setAppUserModelId).toHaveBeenCalledTimes(2)
  })
})
