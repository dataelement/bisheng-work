import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnterpriseChatView } from '../src/main/enterprise/chat-view'
import { parseChatPresentation } from '../src/shared/enterprise-chat-view'
import { parseWebSession } from '../src/main/enterprise/web-session'

const fake = vi.hoisted(() => ({ views: [] as any[], sessions: [] as any[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    session: { fromPartition: () => {
      const isolated = { webRequest: { onCompleted: vi.fn() }, fetch: vi.fn(async (url: string) => url.endsWith('usage-summary') || url.endsWith('quota/effective') ? usageResponse(url) : ({ ok: true, json: async () => ({ data: [{ chat_id: 'cloud-a', name: 'Cloud A', flow_type: 15, update_time: '2026-10-16' }] }) })), cookies: { set: vi.fn(async () => {}) }, clearStorageData: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
      fake.sessions.push(isolated)
      return isolated
    } },
    shell: { openExternal: vi.fn(async () => {}) },
    WebContentsView: class {
      webContents: any
      setBounds = vi.fn()
      setVisible = vi.fn()
      setBackgroundColor = vi.fn()
      constructor(public options: any) {
        let url = ''
        this.webContents = Object.assign(new EventEmitter(), { id: fake.views.length + 100, session: options.webPreferences.session, isDestroyed: () => false, setWindowOpenHandler: vi.fn(), focus: vi.fn(), send: vi.fn(), mainFrame: {}, getURL: () => url, getZoomFactor: () => 1, close: vi.fn(), executeJavaScript: vi.fn(async () => {}), insertCSS: vi.fn(async () => 'key'), loadURL: vi.fn(async (next) => { url = next; this.webContents.emit('did-finish-load') }) })
        fake.views.push(this)
      }
    }
  }
})

afterEach(() => { fake.views.length = 0; fake.sessions.length = 0 })
const presentation = { visible: true, theme: 'dark', bounds: { x: 0, y: 56, width: 1100, height: 700 } }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function fixture() {
  let state = { connected: true, connectionKey: 'tenant-a' }
  let change: (state: any) => void = () => {}
  const enterprise = { snapshot: () => state, subscribe: (listener: typeof change) => { change = listener; return vi.fn() }, webSession: vi.fn(async () => ({ base: 'https://enterprise.example', cookie: 'test-cookie', cookieName: 'bs_credits_3007', connectionKey: 'tenant-a', expiresAt: Date.now() + 300_000 })) }
  const owner: any = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentSize: () => [1100, 800], contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, webContents: Object.assign(new EventEmitter(), { send: vi.fn(), focus: vi.fn(), getZoomFactor: () => 1 }) })
  const host = new EnterpriseChatView(enterprise as any, vi.fn())
  return { host, owner, enterprise, change: (next: typeof state) => { state = next; change(next) } }
}

describe('enterprise Chat host boundary', () => {
  it('reads fixed self-service usage with the isolated session and discards logout races', async () => {
    const f = fixture()
    try {
      f.host.present(f.owner, presentation)
      await flush()
      const totals = { message_count: 2, input_tokens: 10, output_tokens: 5, total_tokens: 15, missing_usage_count: 0 }
      const summary = { start_at: '2026-10-22T00:00:00+08:00', end_at: '2026-10-22T12:00:00+08:00', timezone: 'Asia/Shanghai', granularity: 'day', totals, points: [] }
      fake.sessions[0].fetch.mockImplementation(async (url: string) => new Response(JSON.stringify({ status_code: 200, data: url.endsWith('usage-summary') ? summary : [{ resource_type: 'knowledge_space_file', user_used: 0.1, effective: -1 }] })))
      expect(await f.host.usage()).toMatchObject({ summary: { status: 'ready', data: { totals } }, storage: { status: 'ready', data: { used: 0.1, limit: -1 } } })
      expect(fake.sessions[0].fetch.mock.calls.map((call: unknown[]) => call[0])).toEqual(['https://enterprise.example/api/v1/dsh/me/usage-summary', 'https://enterprise.example/api/v1/quota/effective'])
      const finishes: Array<(response: Response) => void> = []
      fake.sessions[0].fetch.mockImplementation(() => new Promise<Response>(resolve => { finishes.push(resolve) }))
      const pending = f.host.usage()
      const rejected = expect(pending).rejects.toThrow('identity changed')
      f.change({ connected: false, connectionKey: 'tenant-a' })
      // Both requests must settle before the identity check.
      for (const finish of finishes) finish(new Response(JSON.stringify({ status_code: 200, data: [] })))
      await rejected
    } finally { f.host.dispose() }
  })

  it('sets a host-only cookie before loading Chat and keeps Work switches reversible', async () => {
    const f = fixture()
    try {
      f.host.present(f.owner, presentation)
      await flush()
      expect(f.host.snapshot().phase).toBe('ready')
      expect(fake.views[0].webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('.dsh-chat-header .dsh-chat-section-row { display: none !important; }'))
      expect(fake.views[0].options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true })
      expect(fake.views[0].options.webPreferences.preload).toMatch(/enterprise-chat\.cjs$/u)
      expect(fake.sessions[0].cookies.set).toHaveBeenCalledWith(expect.objectContaining({ httpOnly: true, sameSite: 'lax', secure: true, name: 'bs_credits_3007' }))
      expect(fake.views[0].webContents.loadURL).toHaveBeenCalledWith('https://enterprise.example/workspace/?embed=dsh&dshTheme=dark')
      f.host.present(f.owner, { ...presentation, visible: false })
      expect(fake.views[0].setVisible).toHaveBeenLastCalledWith(false)
      f.host.present(f.owner, presentation)
      expect(fake.views).toHaveLength(1)
      expect(fake.views[0].setVisible).toHaveBeenLastCalledWith(true)
      f.change({ connected: false, connectionKey: 'tenant-a' })
      await flush()
      expect(fake.views[0].webContents.close).toHaveBeenCalledOnce()
      expect(fake.sessions[0].clearStorageData).toHaveBeenCalledOnce()
    } finally { f.host.dispose() }
  })

  it('discards an exchange finishing after logout', async () => {
    const f = fixture()
    let finish!: (value: any) => void
    f.enterprise.webSession.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    try {
      f.host.present(f.owner, presentation)
      f.change({ connected: false, connectionKey: 'tenant-a' })
      finish({ base: 'https://enterprise.example', cookie: 'stale', expiresAt: Date.now() + 300_000 })
      await flush()
      expect(fake.views).toHaveLength(0)
      expect(f.host.snapshot().connected).toBe(false)
    } finally { f.host.dispose() }
  })

  it('rejects malformed geometry and long-lived server credentials', () => {
    expect(() => parseChatPresentation({ ...presentation, bounds: { ...presentation.bounds, width: NaN } })).toThrow()
    expect(() => parseWebSession({ cookie: 'a'.repeat(40), expires_in: 3600 }, 'https://enterprise.example', 'a')).toThrow()
    for (const locale of ['ja', 'zh-Hans', '', 0, null, { value: 'zh' }]) {
      expect(() => parseChatPresentation({ ...presentation, locale })).toThrow('locale')
    }
  })

  it('validates the ingress cookie name and supports the existing server default', () => {
    const body = { cookie: 'a'.repeat(40), expires_in: 300 }
    expect(parseWebSession(body, 'https://enterprise.example', 'a').cookieName).toBe('access_token_cookie')
    expect(parseWebSession({ ...body, cookie_name: 'bs_credits_3007' }, 'https://enterprise.example', 'a').cookieName).toBe('bs_credits_3007')
    for (const cookie_name of ['', 'a=b', 'a; b', '\r\nCookie: x', null, 3, 'a'.repeat(65)]) {
      expect(() => parseWebSession({ ...body, cookie_name }, 'https://enterprise.example', 'a')).toThrow('cookie name')
    }
  })
})

it('carries host language on first load and updates a hidden document without reloading it', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, { ...presentation, locale: 'zh' })
    await flush()
    const view = fake.views[0]
    expect(view.webContents.loadURL).toHaveBeenLastCalledWith('https://enterprise.example/workspace/?embed=dsh&dshTheme=dark&dshLocale=zh')
    view.setBounds.mockClear()
    f.host.present(f.owner, { ...presentation, visible: false, locale: 'en' })
    expect(view.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('dshHostLocale = "en"'))
    expect(view.setBounds).not.toHaveBeenCalled()
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1)
    await f.host.open('new')
    expect(view.webContents.loadURL).toHaveBeenLastCalledWith('https://enterprise.example/workspace/c/new?embed=dsh&dshTheme=dark&dshLocale=en')
    const loads = view.webContents.loadURL.mock.calls.length
    await f.host.open('new')
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(loads)
    view.webContents.executeJavaScript.mockClear()
    view.webContents.emit('did-navigate-in-page', {}, 'https://enterprise.example/workspace/c/new', true)
    expect(view.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('dshHostLocale = "en"'))
  } finally { f.host.dispose() }
})

it('reads cloud history through a fixed host endpoint and validates selection against that identity', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation)
    await flush()
    const list = await f.host.history(1)
    expect(list.items[0]).toMatchObject({ id: 'cloud-a', title: 'Cloud A' })
    expect(fake.sessions[0].fetch).toHaveBeenCalledWith('https://enterprise.example/api/v1/chat/list?page=1&limit=40', expect.objectContaining({ redirect: 'error' }))
    await f.host.open('cloud-a')
    expect(fake.views[0].webContents.loadURL).toHaveBeenLastCalledWith('https://enterprise.example/workspace/c/cloud-a?embed=dsh&dshTheme=dark')
    const calls = fake.views[0].webContents.loadURL.mock.calls.length
    await f.host.open('cloud-a')
    expect(fake.views[0].webContents.loadURL.mock.calls).toHaveLength(calls)
    await expect(f.host.open('unknown')).rejects.toThrow()
    await expect(f.host.open('../admin')).rejects.toThrow()
    await expect(f.host.history(-1)).rejects.toThrow()
    let finish!: (value: any) => void
    fake.sessions[0].fetch.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const stale = f.host.history(1)
    f.change({ connected: false, connectionKey: 'tenant-a' })
    finish({ ok: true, json: async () => ({ data: [{ chat_id: 'stale' }] }) })
    await expect(stale).rejects.toThrow('identity changed')
  } finally { f.host.dispose() }
})

it('uses in-document conversation navigation and preserves view geometry while Work is visible', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation)
    await flush()
    await f.host.history(1)
    const view = fake.views[0]
    view.webContents.executeJavaScript.mockResolvedValue(true)
    view.setBounds.mockClear()
    view.setBackgroundColor.mockClear()
    f.host.present(f.owner, { ...presentation, visible: false, theme: 'light', bounds: { x: 0, y: 48, width: 0, height: 0 } })
    expect(view.setBounds).not.toHaveBeenCalled()
    expect(view.setBackgroundColor).not.toHaveBeenCalled()
    f.host.present(f.owner, presentation)
    await f.host.open('cloud-a')
    expect(view.webContents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("dsh:navigate"))
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1)
    expect(f.host.snapshot().phase).toBe('ready')
    expect(fake.views).toHaveLength(1)
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
  } finally { f.host.dispose() }
})

it('discards a navigation completion after the enterprise identity changes', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation)
    await flush()
    await f.host.history(1)
    const view = fake.views[0]
    let finish!: (accepted: boolean) => void
    view.webContents.executeJavaScript.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.host.open('cloud-a')
    f.change({ connected: false, connectionKey: 'tenant-a' })
    finish(false)
    await pending
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1)
    expect(f.host.snapshot().connected).toBe(false)
  } finally { f.host.dispose() }
})

it('fills the conversation area when the new-conversation picker closes', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation)
    await flush()
    const view = fake.views[0]
    f.host.present(f.owner, { ...presentation, bounds: { x: 280, y: 0, width: 820, height: 800 } })
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 280, y: 0, width: 820, height: 800 })
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1)
    expect(fake.views).toHaveLength(1)
  } finally { f.host.dispose() }
})

it('pushes landing state from the current remote main frame and rejects stale or foreign presentation reports', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation)
    await flush()
    const wc = fake.views[0].webContents
    await wc.loadURL('https://enterprise.example/workspace/c/new')
    const report = (frame: unknown, input: unknown) => wc.emit('ipc-message', { senderFrame: frame }, 'enterprise-chat:landing', input)
    report(wc.mainFrame, { landing: false, path: '/workspace/c/new' })
    expect(f.host.snapshot()).toMatchObject({ landing: false, conversationId: 'new' })
    expect(f.owner.webContents.send).toHaveBeenLastCalledWith('enterprise-chat:changed', expect.objectContaining({ landing: false }))
    report({}, { landing: true, path: '/workspace/c/new' })
    report(wc.mainFrame, { landing: true, path: '/workspace/c/old' })
    report(wc.mainFrame, { landing: 'true', path: '/workspace/c/new' })
    expect(f.host.snapshot().landing).toBe(false)
    report(wc.mainFrame, { landing: true, path: '/workspace/c/new' })
    expect(f.host.snapshot().landing).toBe(true)
    f.change({ connected: false, connectionKey: 'tenant-a' })
    report(wc.mainFrame, { landing: false, path: '/workspace/c/new' })
    expect(f.host.snapshot().landing).toBeUndefined()
  } finally { f.host.dispose() }
})

it('opens only account-published module entries and clears them with the identity', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation)
    await flush()
    const view = fake.views[0].webContents
    const report = { path: '/workspace/', navigation: { entries: [{ id: 'knowledge', label: 'Knowledge', path: '/knowledge', primary: true, active: false }] } }
    view.emit('ipc-message', { senderFrame: {} }, 'enterprise-chat:navigation', report)
    await expect(f.host.openPage('knowledge')).rejects.toThrow('unavailable')
    view.emit('ipc-message', { senderFrame: view.mainFrame }, 'enterprise-chat:navigation', report)
    await f.host.openPage('knowledge')
    expect(view.loadURL).toHaveBeenLastCalledWith('https://enterprise.example/workspace/knowledge?embed=dsh&dshTheme=dark')
    await expect(f.host.openPage('skills')).rejects.toThrow('unavailable')
    await expect(f.host.openPage('../admin')).rejects.toThrow()
    const count = view.loadURL.mock.calls.length
    await f.host.openPage('knowledge')
    expect(view.loadURL).toHaveBeenCalledTimes(count)
    f.change({ connected: false, connectionKey: 'tenant-a' })
    expect(f.host.snapshot().navigation).toBeUndefined()
    await expect(f.host.openPage('knowledge')).rejects.toThrow('unavailable')
  } finally { f.host.dispose() }
})

it('publishes a reported approval backlog and rejects a malformed one without dropping the identity', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation)
    await flush()
    const view = fake.views[0].webContents
    const entries = [{ id: 'knowledge', label: 'Knowledge', path: '/knowledge', primary: true, active: false }]
    view.emit('ipc-message', { senderFrame: view.mainFrame }, 'enterprise-chat:navigation', { path: '/workspace/', navigation: { entries } })
    expect(f.host.snapshot().navigation?.approvals).toBeUndefined()
    view.emit('ipc-message', { senderFrame: view.mainFrame }, 'enterprise-chat:navigation', { path: '/workspace/', navigation: { entries, approvals: { pending: 7 } } })
    expect(f.host.snapshot().navigation?.approvals).toEqual({ pending: 7 })
    for (const approvals of [{ pending: -1 }, { pending: 1.5 }, { pending: '3' }, { pending: 10_000 }, {}, null]) {
      view.emit('ipc-message', { senderFrame: view.mainFrame }, 'enterprise-chat:navigation', { path: '/workspace/', navigation: { entries, approvals } })
      expect(f.host.snapshot().navigation?.approvals).toEqual({ pending: 7 })
    }
    view.emit('ipc-message', { senderFrame: view.mainFrame }, 'enterprise-chat:navigation', { path: '/workspace/', navigation: { entries, approvals: { pending: 0 } } })
    expect(f.host.snapshot().navigation?.approvals).toEqual({ pending: 0 })
  } finally { f.host.dispose() }
})

it('delivers the host palette to module pages, backs the view with it, and rejects a malformed one', async () => {
  const f = fixture()
  try {
    const palette = {
      surface: [44, 44, 46], raised: [53, 54, 56], strong: [97, 102, 107],
      labelPrimary: [249, 250, 251], labelSecondary: [207, 211, 214], labelTertiary: [173, 178, 184],
      borderBase: [69, 69, 71], borderDeep: [78, 78, 79]
    }
    f.host.present(f.owner, { ...presentation, palette })
    await flush()
    const view = fake.views[0], wc = view.webContents
    // Chat routes keep their own deployed theme, so their backing is unchanged.
    expect(view.setBackgroundColor).toHaveBeenLastCalledWith('#141416')
    f.host.present(f.owner, { ...presentation, palette, settings: 'desktop-usage' })
    await flush()
    expect(wc.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('--bg-page:44 44 46'))
    expect(wc.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('--text-1:249 250 251'))
    // The module page paints the host surface, so the view backs it with the same color.
    expect(view.setBackgroundColor).toHaveBeenLastCalledWith('#2c2c2e')
    // Approvals open in a Modal on the same layer-2 surface; its pages take the same backing.
    for (const section of ['my-tasks', 'my-requests', 'notifications'] as const) {
      f.host.present(f.owner, { ...presentation, palette, settings: section })
      await flush()
      expect(wc.loadURL).toHaveBeenLastCalledWith(`https://enterprise.example/workspace/settings/${section}?dshSettings=1&embed=dsh&dshTheme=dark`)
      expect(view.setBackgroundColor).toHaveBeenLastCalledWith('#2c2c2e')
    }
    for (const invalid of [{ ...palette, surface: [44, 44] }, { ...palette, surface: [44, 44, 256] }, { ...palette, raised: ['53', 54, 56] }, { ...palette, strong: undefined }, { ...palette, composer: [1, 2] }, { ...palette, composer: [0, 0, 256] }, { ...palette, composer: ['40', 41, 45] }, 'dark']) {
      expect(() => f.host.present(f.owner, { ...presentation, palette: invalid })).toThrow('Invalid Chat palette.')
    }
  } finally { f.host.dispose() }
})

it('installs the host module stylesheet and theme script once the document is ready', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation)
    await flush()
    const view = fake.views[0]
    expect(view.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('html.dsh-module-dark'))
    const script = view.webContents.executeJavaScript.mock.calls.at(-1)?.[0] as string
    expect(script).toContain("root.dataset.dshHostTheme = 'dark'")
    expect(script).toContain('new MutationObserver(apply)')
  } finally { f.host.dispose() }
})

it('turns a stalled module navigation into a rejected open instead of a document pinned in loading', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    f.host.present(f.owner, presentation)
    await flush()
    const view = fake.views[0]
    expect(f.host.snapshot().phase).toBe('ready')
    view.webContents.loadURL.mockImplementation(() => new Promise<void>(() => {}))
    const pending = f.host.open('new')
    const outcome = expect(pending).rejects.toThrow('timed out')
    await flush()
    expect(f.host.snapshot().phase).toBe('loading')
    await vi.advanceTimersByTimeAsync(45_000)
    await outcome
  } finally { f.host.dispose(); vi.useRealTimers() }
})

it('fails the session exchange when the first document load stalls, so Reconnect becomes available', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const note = vi.fn()
  const host = new EnterpriseChatView(f.enterprise as any, note)
  try {
    host.present(f.owner, presentation)
    // The view exists after the web-session exchange resolves; its first document load then hangs.
    await Promise.resolve()
    const view = fake.views[0]
    view.webContents.loadURL.mockImplementation(() => new Promise<void>(() => {}))
    await flush()
    await vi.advanceTimersByTimeAsync(45_000)
    await flush()
    expect(host.snapshot().phase).toBe('error')
    expect(note).toHaveBeenCalledWith('[enterprise-chat] session_failed status=timeout')
  } finally { host.dispose(); vi.useRealTimers() }
})

it('opens content-only settings, waits for the current main frame and restores the previous page', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation)
    await flush()
    await f.host.open('new')
    const view = fake.views[0], wc = view.webContents
    f.host.present(f.owner, { ...presentation, settings: 'desktop-usage' })
    await flush()
    expect(wc.loadURL).toHaveBeenLastCalledWith('https://enterprise.example/workspace/settings/desktop-usage?dshSettings=1&embed=dsh&dshTheme=dark')
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    const report = (frame: unknown, section: string, path = '/workspace/settings/desktop-usage') => wc.emit('ipc-message', { senderFrame: frame }, 'enterprise-chat:settings-ready', { section, path })
    report({}, 'desktop-usage')
    report(wc.mainFrame, 'notifications')
    report(wc.mainFrame, 'desktop-usage', '/workspace/settings/notifications')
    expect(f.host.snapshot().settingsReady).toBe(false)
    report(wc.mainFrame, 'desktop-usage')
    expect(f.host.snapshot()).toMatchObject({ settingsSection: 'desktop-usage', settingsReady: true })
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
    wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'enterprise-chat:settings-close', { path: '/workspace/settings/desktop-usage' })
    expect(f.owner.webContents.send).toHaveBeenLastCalledWith('enterprise-chat:close-settings')
    f.host.present(f.owner, { ...presentation, visible: false })
    await flush()
    expect(wc.loadURL).toHaveBeenLastCalledWith('https://enterprise.example/workspace/c/new?embed=dsh&dshTheme=dark')
    f.host.present(f.owner, presentation)
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
    expect(fake.views).toHaveLength(1)
    expect(f.host.snapshot().settingsSection).toBeUndefined()
  } finally { f.host.dispose() }
})

it('restricts settings navigation and rejects stale readiness after an identity change', async () => {
  for (const settings of ['general', '../admin', 'https://other.example/', '', 4, null]) {
    expect(() => parseChatPresentation({ ...presentation, settings })).toThrow('settings')
  }
  const f = fixture()
  try {
    f.host.present(f.owner, { ...presentation, settings: 'desktop-usage' })
    await flush()
    const wc = fake.views[0].webContents
    expect(wc.loadURL).toHaveBeenLastCalledWith(expect.stringContaining('/workspace/settings/desktop-usage?dshSettings=1'))
    f.change({ connected: false, connectionKey: 'tenant-a' })
    wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'enterprise-chat:settings-ready', { section: 'desktop-usage', path: '/workspace/settings/desktop-usage' })
    expect(f.host.snapshot()).toMatchObject({ connected: false, settingsReady: false })
    expect(f.host.snapshot().settingsSection).toBeUndefined()
  } finally { f.host.dispose() }
})

it('hides settings when the ready document navigates away and requires a new report after reload', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, { ...presentation, settings: 'desktop-usage' })
    await flush()
    const view = fake.views[0], wc = view.webContents
    wc.focus = vi.fn()
    const ready = () => wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'enterprise-chat:settings-ready', { section: 'desktop-usage', path: '/workspace/settings/desktop-usage' })
    expect(f.host.snapshot().settingsProtocolVersion).toBe(1)
    ready()
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
    await wc.loadURL('https://enterprise.example/workspace/knowledge/space/example')
    wc.emit('did-navigate-in-page', {}, wc.getURL(), true)
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    expect(f.host.snapshot().settingsReady).toBe(false)
    f.host.focusSettings()
    expect(wc.focus).not.toHaveBeenCalled()
    await wc.loadURL('https://enterprise.example/workspace/settings/desktop-usage?dshSettings=1')
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    ready()
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
    wc.emit('did-start-navigation', {}, wc.getURL(), false, true)
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    expect(f.host.snapshot().settingsReady).toBe(false)
  } finally { f.host.dispose() }
})

it('leaves failed remote settings without blocking the original conversation', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation)
    await flush()
    await f.host.open('new')
    const view = fake.views[0]
    view.webContents.loadURL.mockRejectedValueOnce(Object.assign(new Error('Settings unavailable'), { code: 'ERR_CONNECTION_RESET' }))
    f.host.present(f.owner, { ...presentation, settings: 'desktop-usage' })
    await flush()
    expect(f.host.snapshot().settingsFailure).toBe('load')
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    f.host.present(f.owner, presentation)
    await flush()
    expect(f.host.snapshot().phase).toBe('ready')
    expect(f.host.snapshot().settingsSection).toBeUndefined()
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
  } finally { f.host.dispose() }
})

it('pushes connection failures and logout to mounted settings without waiting for a poll', async () => {
  const f = fixture()
  try {
    f.enterprise.webSession.mockRejectedValueOnce(new Error('Temporary connection failure'))
    f.host.present(f.owner, { ...presentation, settings: 'desktop-usage' })
    await flush()
    expect(f.owner.webContents.send).toHaveBeenLastCalledWith('enterprise-chat:changed', expect.objectContaining({ phase: 'error' }))
    f.host.retry()
    await flush()
    expect(f.host.snapshot().phase).toBe('ready')
    f.change({ connected: false, connectionKey: 'tenant-a' })
    expect(f.owner.webContents.send).toHaveBeenLastCalledWith('enterprise-chat:changed', expect.objectContaining({ connected: false, settingsReady: false }))
  } finally { f.host.dispose() }
})


it.each(['/workspace/c/new', '/workspace/capabilities', '/workspace/skills', '/workspace/knowledge'])('presents body dialogs across the window on %s and restores the content region', async (path) => {
  const f = fixture()
  try {
    const region = { x: 240, y: 56, width: 860, height: 744 }
    f.host.present(f.owner, { ...presentation, bounds: region })
    await flush()
    const view = fake.views[0], wc = view.webContents
    await wc.loadURL('https://enterprise.example' + path)
    const report = (senderFrame: unknown, open: unknown, reportPath = path) =>
      wc.emit('ipc-message', { senderFrame }, 'enterprise-chat:modal', { open, path: reportPath })
    report({}, true)
    report(wc.mainFrame, 'true')
    report(wc.mainFrame, true, '/workspace/c/old')
    expect(view.setBounds).toHaveBeenLastCalledWith(region)
    report(wc.mainFrame, true)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1100, height: 800 })
    expect(view.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
    expect(wc.focus).toHaveBeenCalledTimes(1)
    expect(wc.executeJavaScript.mock.calls.some(([script]: [string]) => script.includes('left: 240px; top: 56px'))).toBe(true)
    report(wc.mainFrame, false)
    expect(view.setBounds).toHaveBeenLastCalledWith(region)
    expect(view.setBackgroundColor).toHaveBeenLastCalledWith('#141416')
    report(wc.mainFrame, true)
    wc.emit('did-navigate-in-page', {}, 'https://enterprise.example/workspace/c/other', true)
    expect(view.setBounds).toHaveBeenLastCalledWith(region)
  } finally { f.host.dispose() }
})

it('retains host-owned settings bounds when an embedded settings page reports a modal', async () => {
  const f = fixture()
  try {
    const region = { x: 380, y: 100, width: 600, height: 600 }
    f.host.present(f.owner, { ...presentation, bounds: region, settings: 'desktop-usage' })
    await flush()
    const view = fake.views[0], wc = view.webContents
    wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'enterprise-chat:modal', { open: true, path: '/workspace/settings/desktop-usage' })
    expect(view.setBounds).toHaveBeenLastCalledWith(region)
    expect(view.setBackgroundColor).toHaveBeenLastCalledWith('#141416')
  } finally { f.host.dispose() }
})

it('validates platform cookie names and applies the isolated cookie to embedded Chat', async () => {
  const value = { cookie: 'a'.repeat(40), expires_in: 300, cookie_name: 'bs_credits_3007' }
  expect(parseWebSession(value, 'https://enterprise.example', 'tenant-a').cookieName).toBe('bs_credits_3007')
  for (const name of ['x; injected=value', 'x\r\nHeader:value', '', 42]) {
    expect(() => parseWebSession({ ...value, cookie_name: name }, 'https://enterprise.example', 'tenant-a')).toThrow()
  }
  const f = fixture()
  f.enterprise.webSession.mockResolvedValue(parseWebSession(value, 'https://enterprise.example', 'tenant-a'))
  try {
    f.host.present(f.owner, presentation)
    await flush()
    expect(fake.sessions[0].cookies.set).toHaveBeenCalledWith(expect.objectContaining({ name: 'bs_credits_3007' }))
  } finally { f.host.dispose() }
})


it('refreshes tools only after a current account browser completes an availability save', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation)
    await flush()
    const view = fake.views[0], isolated = fake.sessions[0]
    const [filter, completed] = isolated.webRequest.onCompleted.mock.calls[0]
    expect(filter.urls).toEqual(['https://enterprise.example/api/v1/dsh/capabilities/*/availability'])
    const saved = { url: 'https://enterprise.example/api/v1/dsh/capabilities/38/availability',
      method: 'PUT', statusCode: 200, webContentsId: view.webContents.id }
    f.owner.webContents.send.mockClear()
    for (const change of [{ method: 'GET' }, { statusCode: 403 }, { statusCode: 500 },
      { webContentsId: 999 }, { webContentsId: undefined },
      { url: 'https://other.example/api/v1/dsh/capabilities/38/availability' },
      { url: 'https://enterprise.example/api/v1/dsh/capabilities/38/run' }]) completed({ ...saved, ...change })
    expect(f.owner.webContents.send).toHaveBeenCalledTimes(0)
    completed(saved)
    expect(f.owner.webContents.send).toHaveBeenCalledExactlyOnceWith('enterprise-chat:tools-changed')
    f.change({ connected: true, connectionKey: 'tenant-b' })
    expect(isolated.webRequest.onCompleted).toHaveBeenLastCalledWith(null)
    f.owner.webContents.send.mockClear()
    completed(saved)
    expect(f.owner.webContents.send).toHaveBeenCalledTimes(0)
  } finally { f.host.dispose() }
})

const usageTotals = { message_count: 2, input_tokens: 10, output_tokens: 5, total_tokens: 15, missing_usage_count: 0 }
const usageSummary = { start_at: '2026-10-28T00:00:00+08:00', end_at: '2026-10-28T12:00:00+08:00', timezone: 'Asia/Shanghai', granularity: 'day', totals: usageTotals, points: [] }
const usageResponse = (url: string) => new Response(JSON.stringify({ status_code: 200, data: url.endsWith('usage-summary') ? usageSummary : [{ resource_type: 'knowledge_space_file', user_used: 0.1, effective: -1 }] }))

it.each(['summary', 'storage'])('preserves the other usage section when %s fails', async failed => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation); await flush()
    fake.sessions[0].fetch.mockImplementation(async (url: string) => (url.endsWith('usage-summary') === (failed === 'summary')) ? new Response('service failed', { status: 500 }) : usageResponse(url))
    const result = await f.host.usage()
    expect(result[failed as 'summary' | 'storage']).toEqual({ status: 'error' })
    expect(result[failed === 'summary' ? 'storage' : 'summary'].status).toBe('ready')
  } finally { f.host.dispose() }
})

it('keeps valid statistics when storage payload validation fails', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation); await flush()
    fake.sessions[0].fetch.mockImplementation(async (url: string) => url.endsWith('usage-summary') ? usageResponse(url) : new Response(JSON.stringify({ status_code: 200, data: [{ resource_type: 'knowledge_space_file', user_used: -2, effective: 1 }] })))
    expect(await f.host.usage()).toMatchObject({ summary: { status: 'ready', data: { totals: usageTotals } }, storage: { status: 'error' } })
  } finally { f.host.dispose() }
})

it('renews one cookie session for concurrent expired usage reads', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation); await flush()
    const attempts = new Map<string, number>()
    fake.sessions[0].fetch.mockImplementation(async (url: string) => {
      const count = (attempts.get(url) ?? 0) + 1; attempts.set(url, count)
      return count === 1 ? new Response('expired', { status: 401 }) : usageResponse(url)
    })
    const result = await f.host.usage()
    expect(result.summary.status).toBe('ready'); expect(result.storage.status).toBe('ready')
    expect(f.enterprise.webSession).toHaveBeenCalledTimes(2)
    expect([...attempts.values()]).toEqual([2, 2])
  } finally { f.host.dispose() }
})

it('bounds authentication retries to one renewal per usage request', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation); await flush()
    fake.sessions[0].fetch.mockImplementation(async () => new Response('expired', { status: 401 }))
    expect(await f.host.usage()).toEqual({ summary: { status: 'error' }, storage: { status: 'error' } })
    expect(fake.sessions[0].fetch).toHaveBeenCalledTimes(4)
    expect(f.enterprise.webSession).toHaveBeenCalledTimes(2)
  } finally { f.host.dispose() }
})

it('recovers a failed Chat session when the user requests usage again', async () => {
  const f = fixture()
  try {
    f.enterprise.webSession.mockRejectedValueOnce(new Error('offline'))
    f.host.present(f.owner, presentation); await flush()
    expect(f.host.snapshot().phase).toBe('error')
    expect(await f.host.usage()).toMatchObject({ summary: { status: 'ready', data: { totals: usageTotals } }, storage: { status: 'ready' } })
    expect(f.enterprise.webSession).toHaveBeenCalledTimes(2)
  } finally { f.host.dispose() }
})

it('discards delayed 401 responses after logout before renewing a session', async () => {
  const f = fixture()
  try {
    f.host.present(f.owner, presentation); await flush()
    const finishers: Array<(value: Response) => void> = []
    fake.sessions[0].fetch.mockImplementation(() => new Promise<Response>(resolve => finishers.push(resolve)))
    const pending = f.host.usage()
    const rejected = expect(pending).rejects.toThrow('identity changed')
    f.change({ connected: false, connectionKey: 'tenant-a' })
    finishers.forEach(finish => finish(new Response('expired', { status: 401 })))
    await rejected
    expect(f.enterprise.webSession).toHaveBeenCalledTimes(1)
  } finally { f.host.dispose() }
})
