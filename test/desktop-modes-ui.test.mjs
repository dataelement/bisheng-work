// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root, container
const disposers = []
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  document.documentElement.removeAttribute('data-dsh-safe-mode-page')
  document.documentElement.removeAttribute('data-dsh-about-open')
  document.body.removeAttribute('data-ds-dark-theme')
  disposers.splice(0).reverse().forEach(dispose => dispose())
  delete window.dshEnterpriseChat
  delete window.__ModuleLoader__
  vi.unstubAllGlobals()
})
async function mount(connected = false, collection = {}, inert = false, workbench) {
  let workbenchSnapshot = workbench
  let bindWorkbench, disposeWorkbench
  const workbenchListeners = new Set()
  const attachWorkbench = () => bindWorkbench({
    desktopWorkbenches: {
      getSnapshot: () => workbenchSnapshot,
      subscribe: fn => { workbenchListeners.add(fn); return () => workbenchListeners.delete(fn) }
    },
    effect(fn) { disposeWorkbench = fn() }
  })
  disposers.push(() => disposeWorkbench?.())
  let snapshot = { connected, phase: 'ready', epoch: 1, conversationId: 'new', settingsProtocolVersion: 1 }
  let chatListener
  window.dshEnterpriseChat = {
    subscribe: fn => { chatListener = fn; return () => { chatListener = undefined } },
    state: vi.fn(async () => ({ ...snapshot })),
    present: vi.fn(async () => ({ ...snapshot })),
    retry: vi.fn(async () => {}),
    history: vi.fn(async () => ({ epoch: 1, items: [{ id: 'cloud-a', title: 'Cloud chat', updatedAt: '2026-10-16' }], hasMore: false })),
    openPage: vi.fn(async () => {}),
    open: vi.fn(async () => {})
  }
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  let plugin, navigate
  let sessionList = { phase: 'ready', byId: { draft: { id: 'draft', blank: true, retainedBy: { mainView: 1 } } } }
  let liveState = { blank: true, pendingSubmissions: [], running: false, awaitingFirstTurn: false }
  const liveListeners = new Set()
  const liveSession = { getSnapshot: () => liveState, subscribe: fn => { liveListeners.add(fn); return () => liveListeners.delete(fn) } }
  let panelState = { activePanelId: null }
  const sessionListeners = new Set(), panelListeners = new Set()
  const localeListeners = new Set()
  let activeLocale = 'en'
  const setSessions = value => { sessionList = value; sessionListeners.forEach(fn => fn()) }
  const setPanel = id => { panelState = { activePanelId: id }; panelListeners.forEach(fn => fn()) }
  const registrations = new Map()
  window.__ModuleLoader__ = { load({ factory }) {
    plugin = factory(name => {
      if (name === 'react') return React
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Button: ({ variant, size, ...props }) => React.createElement('button', props), Modal: ({ children, title, footer, onClose, closeLabel }) => createPortal(React.createElement('div', { role: 'dialog', 'aria-modal': true, 'aria-label': title }, React.createElement('button', { onClick: onClose, 'aria-label': closeLabel }, closeLabel), children, footer), document.body), Menu: ({ anchor, open, items, onSelect }) => React.createElement('div', null, anchor, open && items.map(item => React.createElement('button', { key: item.id, role: 'menuitem', onClick: () => onSelect(item.id) }, item.label))) }
      throw new Error(name)
    })
  } }
  new Function(await readFile('packages/dsh-desktop-client-ui/client.js', 'utf8'))()
  plugin.apply({
    inject(names, callback) {
      if (names.includes('desktopWorkbenches')) {
        bindWorkbench = callback
        if (workbenchSnapshot) attachWorkbench()
      }
    },
    uiWorkspace: { registerNavigationHandler: (fn) => { navigate = fn; return () => {} }, startSession: () => { navigate('new'); setSessions({ phase: 'ready', byId: { draft: { id: 'draft', blank: true, retainedBy: { mainView: 1 } } } }); setPanel(null) } },
    sessions: { binding: id => id === 'draft' ? { session: liveSession } : undefined, list: { getSnapshot: () => sessionList, subscribe: fn => { sessionListeners.add(fn); return () => sessionListeners.delete(fn) } } },
    layout: { selectPanel: setPanel, panelInfo: { getSnapshot: () => panelState, subscribe: fn => { panelListeners.add(fn); return () => panelListeners.delete(fn) } } },
    remote: {}, locale: { register() {}, bind: () => key => key, getSnapshot: () => ({ active: activeLocale }), subscribe: fn => { localeListeners.add(fn); return () => localeListeners.delete(fn) } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    slots: {
      inject(name, fn) { if (['desktop.mode.content', 'sidebar.workspaces.collection', 'sidebar.primaryNavigation'].includes(name)) fn() },
      register(options, component) { registrations.set(options.name, { component, props: options.inject() }) }
    }
  })
  container = document.createElement('div')
  container.id = 'root'
  // jsdom reflects the host interaction boundary through this browser property.
  Object.defineProperty(container, 'inert', { get() { return this.hasAttribute('inert') }, set(value) { this.toggleAttribute('inert', value) } })
  container.inert = inert
  document.body.append(container)
  root = createRoot(container)
  const content = registrations.get('desktop.mode.content'), history = registrations.get('sidebar.workspaces.collection'), primary = registrations.get('sidebar.primaryNavigation')
  await act(async () => root.render(React.createElement(React.Fragment, null,
    React.createElement('aside', null, React.createElement('button', { 'data-navigation-id': 'new', onClick: () => navigate('new') }, 'New session'), React.createElement(primary.component, { ...primary.props, wide: true, renderAction: ({ id, label, onClick, expanded, active }) => React.createElement('button', { 'data-navigation-id': id, 'aria-expanded': expanded, 'aria-current': active ? 'page' : undefined, onClick }, label), panels: [{ id: 'plugins', label: 'Plugins' }], startSession: (...args) => { expect(args).toHaveLength(0); navigate('new') }, selectPanel: setPanel, renderPanelIcon: () => null }), React.createElement(history.component, { ...history.props, mode: 'projects', query: '', archivedOnly: false, projects: () => React.createElement('div', { 'data-project': true }, 'Project task'), items: [{ id: 'local-a', updatedAt: Date.parse('2026-10-17'), render: active => React.createElement('button', { 'data-local-row': true, 'aria-current': active ? 'page' : undefined, onClick: () => navigate('open') }, 'Local task') }], ...collection })),
    React.createElement(content.component, { ...content.props, columns: '1fr 0px', work: React.createElement('textarea', { 'aria-label': 'work draft', defaultValue: 'retained draft' }) })
  )))
  return {
    async workbench(active, enabled = true) {
      await act(async () => {
        workbenchSnapshot = { state: { active }, enabled }
        if (disposeWorkbench) workbenchListeners.forEach(fn => fn())
        else attachWorkbench()
      })
    },
    async unloadWorkbench() { await act(async () => { disposeWorkbench(); disposeWorkbench = undefined }) },
    workbenchListenerCount: () => workbenchListeners.size,
    async locale(value) { await act(async () => { activeLocale = value; localeListeners.forEach(fn => fn()) }) },
    localeListenerCount: () => localeListeners.size,
    async navigation(entries, path = '/skills') { snapshot = { ...snapshot, navigation: { entries, homeLabel: 'Welcome' }, path, conversationId: undefined }; await act(async () => chatListener(snapshot)) },
    navigate: (...args) => navigate(...args),
    async click(mode) { await act(async () => container.querySelector(`#dsh-mode-${mode}`).click()) },
    async account(next, epoch = 1) {
      snapshot = { connected: next, phase: 'ready', epoch, conversationId: 'new', settingsProtocolVersion: 1 }
      await act(async () => window.dispatchEvent(new CustomEvent('dsh-desktop:enterprise-account-changed')))
    },
    async pushState(patch) { snapshot = { ...snapshot, ...patch }; await act(async () => chatListener(snapshot)) },
    selected: () => container.querySelector('#dsh-panel-chat').hidden ? 'work' : 'chat',
    picker: () => container.querySelector('[role=tablist]'),
    async panel(id) { await act(async () => setPanel(id)) },
    async workSession(blank) { await act(async () => setSessions({ phase: 'ready', byId: { current: { id: 'current', blank, retainedBy: { mainView: 1 } } } })) },
    async cloudSession(id) { snapshot = { ...snapshot, conversationId: id }; await act(async () => window.dispatchEvent(new Event('focus'))) },
    async workLive(patch) { await act(async () => { liveState = { ...liveState, ...patch }; liveListeners.forEach(fn => fn()) }) },
    liveListenerCount: () => liveListeners.size,
    async cloudLanding(landing) { snapshot = { ...snapshot, landing }; await act(async () => chatListener(snapshot)) },
    draft: () => container.querySelector('textarea')
  }
}
it('shows mode selection on the native landing page and restores it after leaving a workbench', async () => {
  const ui = await mount()
  const draft = ui.draft()
  expect(ui.picker()).not.toBeNull()
  await ui.workbench('writer')
  expect(container.querySelector('.dshModesHeader')).toBeNull()
  await ui.workSession(false)
  await ui.workSession(true)
  expect(ui.picker()).toBeNull()
  await ui.workbench('research')
  expect(ui.picker()).toBeNull()
  await ui.workbench(null)
  expect(ui.picker()).not.toBeNull()
  expect(ui.draft()).toBe(draft)
  expect(draft.value).toBe('retained draft')
})

it('respects a restored workbench, the feature switch and optional service unload/reload', async () => {
  const ui = await mount(false, {}, false, { enabled: true, state: { active: 'writer' } })
  expect(ui.picker()).toBeNull()
  await ui.workbench('writer', false)
  expect(ui.picker()).not.toBeNull()
  await ui.workbench('writer')
  expect(ui.picker()).toBeNull()
  expect(ui.workbenchListenerCount()).toBe(1)
  await ui.unloadWorkbench()
  expect(ui.picker()).not.toBeNull()
  expect(ui.workbenchListenerCount()).toBe(0)
  await ui.workbench('writer')
  expect(ui.picker()).toBeNull()
  expect(ui.workbenchListenerCount()).toBe(1)
})

it('keeps Chat landing navigation available while a workbench is retained in Work', async () => {
  const ui = await mount(true, {}, false, { enabled: true, state: { active: 'writer' } })
  expect(ui.selected()).toBe('chat')
  expect(ui.picker()).not.toBeNull()
  await ui.click('work')
  expect(ui.selected()).toBe('work')
  expect(ui.picker()).toBeNull()
  expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
})

it('explains Chat sign-in before opening account settings while keeping the Work draft mounted', async () => {
  const ui = await mount(false, { items: [] })
  expect(ui.selected()).toBe('work')
  const history = container.querySelector('.dshRecentHistory')
  expect(history.textContent).toBe('recentrecentEmpty')
  expect(history.querySelectorAll('button')).toHaveLength(0)
  const draft = ui.draft()
  const open = vi.fn()
  window.addEventListener('dsh-desktop:open-settings-section', open)
  disposers.push(() => window.removeEventListener('dsh-desktop:open-settings-section', open))
  await ui.click('chat')
  expect(open).toHaveBeenCalledTimes(0)
  const dialog = document.querySelector('[role=dialog]')
  expect(dialog.getAttribute('aria-label')).toBe('signInTitle')
  expect(dialog.textContent).toContain('signInDescription')
  await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === 'signIn').click())
  expect(document.querySelector('[role=dialog]')).toBeNull()
  expect(open.mock.calls[0][0].detail).toEqual({ id: 'enterprise-account' })
  expect(ui.selected()).toBe('work')
  expect(ui.draft()).toBe(draft)
  expect(container.querySelector('#dsh-panel-chat').hidden).toBe(true)
  expect(container.querySelector('#dsh-panel-chat button')).toBeNull()
})
it('opens Chat after enterprise sign-in, respects Work selection on refresh, and returns to Work after logout', async () => {
  const ui = await mount()
  const draft = ui.draft()
  await ui.account(true)
  expect(ui.selected()).toBe('chat')
  await ui.click('work')
  await ui.account(true)
  expect(ui.selected()).toBe('work')
  await ui.click('chat')
  await ui.account(false)
  expect(ui.selected()).toBe('work')
  expect(ui.draft()).toBe(draft)
  expect(draft.value).toBe('retained draft')
})
it('restores the existing enterprise login directly into Chat', async () => {
  const ui = await mount(true)
  expect(ui.selected()).toBe('chat')
  expect(window.dshEnterpriseChat.present).toHaveBeenCalledWith(expect.objectContaining({ visible: true }))
})

it('delivers the active Harness language while settings hides Chat and cleans up its subscription', async () => {
  const ui = await mount(true)
  expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'en' }))
  await act(async () => window.dispatchEvent(new CustomEvent('dsh-desktop:settings-visibility', { detail: { open: true } })))
  await ui.locale('zh')
  expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false, locale: 'zh' }))
  await act(async () => window.dispatchEvent(new CustomEvent('dsh-desktop:settings-visibility', { detail: { open: false } })))
  expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, locale: 'zh' }))
  expect(ui.localeListenerCount()).toBe(1)
  await act(async () => root.unmount())
  root = undefined
  expect(ui.localeListenerCount()).toBe(0)
  const calls = window.dshEnterpriseChat.present.mock.calls.length
  await ui.locale('en')
  expect(window.dshEnterpriseChat.present).toHaveBeenCalledTimes(calls)
})

it('hides Chat while a sidebar account dialog is open and restores it afterwards', async () => {
  await mount(true)
  expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
  await act(async () => window.dispatchEvent(new CustomEvent('dsh-desktop:account-dialog-visibility', { detail: { open: true } })))
  expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
  await act(async () => window.dispatchEvent(new CustomEvent('dsh-desktop:account-dialog-visibility', { detail: { open: false } })))
  expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
})

it('keeps one shared history across modes and routes records to their owner', async () => {
  const ui = await mount(true)
  const sidebar = container.querySelector('aside')
  expect(sidebar.textContent).toContain('Cloud chat')
  expect(sidebar.textContent).toContain('Local task')
  await act(async () => container.querySelector('[data-local-row]').click())
  expect(ui.selected()).toBe('work')
  expect(container.querySelector('aside')).toBe(sidebar)
  await act(async () => container.querySelector('.dshHistoryRow').click())
  expect(ui.selected()).toBe('chat')
  expect(window.dshEnterpriseChat.open).toHaveBeenLastCalledWith('cloud-a')
  expect(container.querySelector('aside')).toBe(sidebar)
  await ui.account(false)
  expect(sidebar.textContent).not.toContain('Cloud chat')
  expect(sidebar.textContent).toContain('Local task')
  expect([...sidebar.querySelectorAll('.dshRecentHistory button')].map(button => button.textContent)).toEqual(['Local task'])
})
it('creates cloud chats through the shared New Session action and clears the view for settings', async () => {
  const ui = await mount(true)
  let handled
  await act(async () => { handled = ui.navigate('new') })
  expect(handled).toBe(true)
  expect(window.dshEnterpriseChat.open).toHaveBeenCalledWith('new')
  await act(async () => window.dispatchEvent(new CustomEvent('dsh-desktop:settings-visibility', { detail: { open: true } })))
  expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
  await act(async () => window.dispatchEvent(new CustomEvent('dsh-desktop:settings-visibility', { detail: { open: false } })))
  expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
  await ui.click('work')
  await act(async () => { handled = ui.navigate('new') })
  expect(handled).toBeUndefined()
})

it('interleaves recent cloud and unassigned local rows while projects appear once', async () => {
  const ui = await mount(true)
  const rows = [...container.querySelectorAll('[data-history-kind]')]
  expect(rows.map(row => row.dataset.historyKind)).toEqual(['work', 'chat'])
  expect(container.querySelectorAll('[data-project]')).toHaveLength(1)
  expect(container.querySelector('.dshRecentHistory').textContent).not.toContain('Project task')
  expect(container.querySelector('[data-local-row]').getAttribute('aria-current')).toBeNull()
  await act(async () => container.querySelector('[data-local-row]').click())
  expect(container.querySelector('[data-local-row]').getAttribute('aria-current')).toBe('page')
  expect(ui.selected()).toBe('work')
})

it('searches cloud titles with local results and keeps archived-only views local', async () => {
  await mount(true, { mode: 'search', query: 'missing phrase', projects: () => null, items: [] })
  expect(container.querySelectorAll('[data-history-kind]')).toHaveLength(0)
  expect(container.textContent).toContain('recentSearchEmpty')
})
it('includes cloud search matches in the shared search collection', async () => {
  await mount(true, { mode: 'search', query: 'CLOUD', projects: () => null, items: [] })
  expect(container.querySelectorAll('[data-history-kind=chat]')).toHaveLength(1)
})
it('preserves archive filtering when cloud history has no archive metadata', async () => {
  await mount(true, { archivedOnly: true })
  expect(container.querySelectorAll('[data-history-kind=chat]')).toHaveLength(0)
  expect(container.querySelectorAll('[data-history-kind=work]')).toHaveLength(1)
})

it('switches modes without a transient light zero-sized presentation', async () => {
  const ui = await mount(true)
  window.dshEnterpriseChat.present.mockClear()
  await ui.click('work')
  expect(window.dshEnterpriseChat.present).toHaveBeenCalledTimes(1)
  expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
  window.dshEnterpriseChat.present.mockClear()
  await ui.click('chat')
  expect(window.dshEnterpriseChat.present).toHaveBeenCalledTimes(1)
  expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
  expect(window.dshEnterpriseChat.open).not.toHaveBeenCalled()
})


it('shows the picker only on the Work landing page and releases the header space on panels and active sessions', async () => {
  const ui = await mount()
  expect(ui.picker()).not.toBeNull()
  await ui.panel('plugins')
  expect(ui.picker()).toBeNull()
  expect(container.querySelector('.dshModesHeader')).toBeNull()
  await ui.panel(null)
  expect(ui.picker()).not.toBeNull()
  await ui.workSession(false)
  expect(ui.picker()).toBeNull()
  await ui.workSession(true)
  expect(ui.picker()).not.toBeNull()
})

it('hides the picker after cloud submission or history navigation and restores it for New Session', async () => {
  const ui = await mount(true)
  expect(ui.picker()).not.toBeNull()
  await ui.cloudSession('cloud-created')
  expect(ui.picker()).toBeNull()
  await act(async () => ui.navigate('new'))
  expect(ui.picker()).not.toBeNull()
  await act(async () => container.querySelector('.dshHistoryRow').click())
  expect(ui.picker()).toBeNull()
})

it('chooses a new Work session when the previously selected local session is active', async () => {
  const ui = await mount(true)
  await ui.workSession(false)
  await ui.click('work')
  expect(ui.selected()).toBe('work')
  expect(ui.picker()).not.toBeNull()
})

it('hides Work mode selection on the local submission echo before catalog admission and restores after rejected send', async () => {
  const ui = await mount()
  expect(ui.picker()).not.toBeNull()
  await ui.workLive({ pendingSubmissions: [{ requestId: 'pending' }] })
  expect(ui.picker()).toBeNull()
  await ui.workLive({ pendingSubmissions: [], blank: false, awaitingFirstTurn: true })
  expect(ui.picker()).toBeNull()
  await ui.workLive({ blank: true, awaitingFirstTurn: false })
  expect(ui.picker()).not.toBeNull()
  await ui.workSession(false)
  expect(ui.liveListenerCount()).toBe(0)
})

it('hides Chat mode selection on pushed local state while the URL is still new', async () => {
  const ui = await mount(true)
  expect(ui.picker()).not.toBeNull()
  await ui.cloudLanding(false)
  expect(ui.picker()).toBeNull()
  await ui.cloudLanding(true)
  expect(ui.picker()).not.toBeNull()
})

it('shares account navigation across Chat and Work and keeps Plugins directly accessible alongside More', async () => {
  const ui = await mount(true)
  await ui.navigation([
    { id: 'knowledge', label: 'Knowledge', path: '/knowledge', primary: true, active: false },
    { id: 'skills', label: 'Skills', path: '/skills', primary: false, active: true }
  ])
  expect(ui.picker()).toBeNull()
  const sidebar = container.querySelector('aside')
  expect(sidebar.textContent).not.toContain('Welcome')
  expect(sidebar.querySelector('[data-navigation-id=knowledge]')).toBeNull()
  const openMore = () => act(async () => sidebar.querySelector('[data-navigation-id=more]').click())
  const choose = label => act(async () => [...sidebar.querySelectorAll('[role=menuitem]')].find(node => node.textContent === label).click())
  await openMore()
  expect([...sidebar.querySelectorAll('[role=menuitem]')].map(node => node.textContent)).toEqual(['Knowledge', 'Skills'])
  await choose('Knowledge')
  expect(window.dshEnterpriseChat.openPage).toHaveBeenLastCalledWith('knowledge')
  await act(async () => sidebar.querySelector('[data-navigation-id=plugins]').click())
  expect(sidebar.querySelector('[data-navigation-id=plugins]').getAttribute('aria-current')).toBe('page')
  expect(sidebar.querySelector('[data-navigation-id=more]').getAttribute('aria-current')).toBeNull()
  expect(ui.selected()).toBe('work')
  expect(ui.picker()).toBeNull()
  await openMore()
  await choose('Skills')
  expect(window.dshEnterpriseChat.openPage).toHaveBeenLastCalledWith('skills')
  expect(ui.selected()).toBe('chat')
  await ui.account(false)
  expect(sidebar.querySelector('[data-navigation-id=plugins]')).not.toBeNull()
  expect(sidebar.querySelector('[data-navigation-id=more]')).toBeNull()
})

it('starts a new conversation without forwarding the click event as a workspace identity', async () => {
  const ui = await mount(true)
  await ui.cloudSession('existing')
  await act(async () => container.querySelector('[data-navigation-id=new]').click())
  expect(ui.picker()).not.toBeNull()
})


it('reserves the native opener after collapse on an active Chat and restores full bounds on expansion', async () => {
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute('data-shell-leading')) return { left: 80, right: 156, bottom: 48 }
    return { x: 0, y: 0, right: 960, width: 960, height: 748 }
  }
  try {
    const ui = await mount(true)
    await ui.cloudSession('existing')
    expect(ui.picker()).toBeNull()
    const present = window.dshEnterpriseChat.present
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ bounds: { x: 0, y: 0, width: 960, height: 748 } }))
    const leading = document.createElement('div')
    leading.dataset.shellLeading = 'true'
    const opener = document.createElement('button')
    opener.textContent = 'Open sidebar'
    opener.onclick = () => leading.remove()
    leading.append(opener)
    await act(async () => container.append(leading))
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ bounds: { x: 156, y: 0, width: 804, height: 748 } }))
    // The retained host chrome invokes the original action; no duplicate controls.
    await act(async () => opener.click())
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ bounds: { x: 0, y: 0, width: 960, height: 748 } }))
    await act(async () => root.unmount())
    root = undefined
    const calls = present.mock.calls.length
    await act(async () => container.append(leading))
    expect(present).toHaveBeenCalledTimes(calls)
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original
  }
})

it('keeps the native sidebar visible when the embedded pane spans the frame', async () => {
  const sidebar = document.createElement('div')
  sidebar.dataset.dshSidebarRoot = ''
  sidebar.getBoundingClientRect = () => ({ right: 56 })
  document.body.append(sidebar)
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () { return { x: 0, y: 48, right: 960, width: 960, height: 700 } }
  try {
    await mount(true)
    expect(window.dshEnterpriseChat.present).toHaveBeenCalledWith(expect.objectContaining({ bounds: { x: 56, y: 48, width: 904, height: 700 } }))
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original
    sidebar.remove()
  }
})


async function mountOnboarding({ acknowledged = false, save = async () => ({ ok: true, json: async () => ({ acknowledged: true }) }) } = {}) {
  let notice
  window.__ModuleLoader__ = { load({ factory }) {
    const plugin = factory(name => {
      if (name === 'react') return React
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
        Button: ({ children, variant, ...props }) => React.createElement('button', props, children),
        IconGlobeOutlineRegular: () => null,
        Modal: ({ children, title }) => createPortal(React.createElement('div', { role: 'dialog', 'aria-modal': true, 'aria-label': title }, children), document.body)
      }
      throw new Error(name)
    })
    const scope = {
      locale: { register() {}, bind: () => key => key },
      configForms: { get: () => ({ getSnapshot: () => ({ mode: 'memory', value: { eligible: true, wizardVersion: acknowledged ? '1' : '' } }), subscribe: () => () => {} }) },
      slots: { inject: (_name, fn) => fn(), register: (options, component) => { notice = { component, props: options.inject() } } }
    }
    plugin.apply({ inject: (_deps, fn) => fn(scope) })
  } }
  vi.stubGlobal('fetch', vi.fn(save))
  new Function(await readFile('packages/dsh-desktop-onboarding/client.js', 'utf8'))()
  const host = document.createElement('div')
  document.body.append(host)
  const noticeRoot = createRoot(host)
  const complete = vi.fn(() => noticeRoot.render(null))
  const openSection = vi.fn(() => window.dispatchEvent(new CustomEvent('dsh-desktop:settings-visibility', { detail: { open: true } })))
  await act(async () => noticeRoot.render(React.createElement(notice.component, { ...notice.props, complete, openSection })))
  return {
    complete, openSection,
    async click(label) { await act(async () => [...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === label).click()) },
    async dispose() { await act(async () => noticeRoot.unmount()); host.remove() }
  }
}

it('keeps native Chat behind the initial host modal boundary and follows its release', async () => {
  const ui = await mount(true, {}, true)
  const present = window.dshEnterpriseChat.present
  expect(present.mock.calls.every(([value]) => value.visible === false)).toBe(true)
  await ui.locale('zh')
  await act(async () => window.dispatchEvent(new Event('resize')))
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false, locale: 'zh' }))
  await act(async () => { container.inert = false })
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
  await act(async () => root.unmount())
  root = undefined
  present.mockClear()
  await act(async () => { container.inert = true })
  expect(present).toHaveBeenCalledTimes(0)
})

it('yields native Chat to onboarding and restores the same chat and Work draft after acknowledgment', async () => {
  const ui = await mount(true)
  const draft = ui.draft()
  const notice = await mountOnboarding()
  try {
    expect(container.inert).toBe(true)
    expect(document.querySelector('[role=dialog]')).toBeTruthy()
    expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
    await notice.click('later')
    expect(fetch).toHaveBeenCalledWith('/api/desktop-onboarding/acknowledge', expect.objectContaining({ method: 'POST' }))
    expect(notice.complete).toHaveBeenCalledTimes(1)
    expect(container.inert).toBe(false)
    expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
    expect(ui.selected()).toBe('chat')
    expect(ui.draft()).toBe(draft)
  } finally { await notice.dispose() }
})

it('hands onboarding directly to model settings while native Chat stays hidden', async () => {
  await mount(true)
  const notice = await mountOnboarding()
  try {
    const present = window.dshEnterpriseChat.present
    present.mockClear()
    await notice.click('configureModel')
    expect(notice.openSection).toHaveBeenCalledWith('models')
    expect(container.inert).toBe(false)
    expect(present.mock.calls.length).toBeGreaterThan(0)
    expect(present.mock.calls.every(([value]) => value.visible === false)).toBe(true)
    await act(async () => window.dispatchEvent(new CustomEvent('dsh-desktop:settings-visibility', { detail: { open: false } })))
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
  } finally { await notice.dispose() }
})

it('keeps onboarding in front through acknowledgment failure and releases its boundary on unmount', async () => {
  await mount(true)
  const notice = await mountOnboarding({ save: async () => ({ ok: false }) })
  try {
    await notice.click('later')
    expect(document.querySelector('[role=alert]').textContent).toBe('saveFailed')
    expect(notice.complete).toHaveBeenCalledTimes(0)
    expect(container.inert).toBe(true)
    expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
  } finally { await notice.dispose() }
  expect(container.inert).toBe(false)
  expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
})

it('lets returning users continue in Chat when onboarding is already acknowledged', async () => {
  await mount(true)
  const notice = await mountOnboarding({ acknowledged: true })
  try {
    expect(notice.complete).toHaveBeenCalledTimes(1)
    expect(container.inert).toBe(false)
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
  } finally { await notice.dispose() }
})


it.each(['continueWork', 'close'])('returns to the existing Work draft when the sign-in prompt is dismissed with %s', async action => {
  const ui = await mount()
  const draft = ui.draft()
  await ui.click('chat')
  await act(async () => [...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === action).click())
  expect(document.querySelector('[role=dialog]')).toBeNull()
  expect(ui.selected()).toBe('work')
  expect(ui.draft()).toBe(draft)
  await ui.click('chat')
  expect(document.querySelectorAll('[role=dialog]')).toHaveLength(1)
})

it('dismisses the sign-in prompt and enters Chat when the account becomes available', async () => {
  const ui = await mount()
  await ui.click('chat')
  expect(document.querySelector('[role=dialog]')).toBeTruthy()
  await ui.account(true)
  expect(document.querySelector('[role=dialog]')).toBeNull()
  expect(ui.selected()).toBe('chat')
  expect(window.dshEnterpriseChat.present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
})

it.each([false, true])('gives the recovery page the pane, including restored state=%s', async (alreadyOpen) => {
  document.documentElement.toggleAttribute('data-dsh-safe-mode-page', alreadyOpen)
  const ui = await mount(true)
  const present = window.dshEnterpriseChat.present
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: !alreadyOpen }))
  await act(async () => document.documentElement.setAttribute('data-dsh-safe-mode-page', ''))
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
  const draft = ui.draft()
  await ui.locale('zh')
  await act(async () => {
    window.dispatchEvent(new Event('resize'))
    document.body.toggleAttribute('data-ds-dark-theme', true)
  })
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false, locale: 'zh', theme: 'dark' }))
  // Remote settings are a foreground surface above the recovery iframe.
  await act(async () => {
    window.dispatchEvent(new CustomEvent('dsh-desktop:settings-visibility', { detail: { open: true } }))
    window.dispatchEvent(new CustomEvent('dsh-desktop:settings-surface', { detail: { section: 'tools', bounds: { x: 200, y: 80, width: 500, height: 400 } } }))
  })
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, settings: 'tools' }))
  await act(async () => window.dispatchEvent(new CustomEvent('dsh-desktop:settings-visibility', { detail: { open: false } })))
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
  await act(async () => document.documentElement.removeAttribute('data-dsh-safe-mode-page'))
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
  expect(ui.draft()).toBe(draft)
  await act(async () => document.documentElement.setAttribute('data-dsh-safe-mode-page', ''))
  await ui.click('work')
  await act(async () => document.documentElement.removeAttribute('data-dsh-safe-mode-page'))
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
  await act(async () => root.unmount())
  root = undefined
  present.mockClear()
  await act(async () => document.documentElement.setAttribute('data-dsh-safe-mode-page', ''))
  expect(present).toHaveBeenCalledTimes(0)
})

it.each([false, true])('gives About the foreground including initial state=%s', async initial => {
  document.documentElement.toggleAttribute('data-dsh-about-open', initial)
  const ui = await mount(true)
  const present = window.dshEnterpriseChat.present
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: !initial }))
  await act(async () => document.documentElement.setAttribute('data-dsh-about-open', ''))
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
  await ui.locale('zh')
  await act(async () => {
    window.dispatchEvent(new Event('resize'))
    document.body.setAttribute('data-ds-dark-theme', '')
    window.dispatchEvent(new CustomEvent('dsh-desktop:settings-visibility', { detail: { open: true } }))
    window.dispatchEvent(new CustomEvent('dsh-desktop:settings-surface', { detail: { section: 'tools', bounds: { x: 200, y: 80, width: 500, height: 400 } } }))
  })
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false, settings: 'tools', locale: 'zh', theme: 'dark' }))
  await act(async () => document.documentElement.removeAttribute('data-dsh-about-open'))
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, settings: 'tools' }))
  await act(async () => window.dispatchEvent(new CustomEvent('dsh-desktop:settings-visibility', { detail: { open: false } })))
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
  await act(async () => document.documentElement.setAttribute('data-dsh-about-open', ''))
  await ui.click('work')
  await act(async () => document.documentElement.removeAttribute('data-dsh-about-open'))
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
  await act(async () => { container.inert = true; document.documentElement.setAttribute('data-dsh-about-open', '') })
  await ui.click('chat')
  await act(async () => document.documentElement.removeAttribute('data-dsh-about-open'))
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
  await act(async () => { container.inert = false })
  expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))
  await act(async () => root.unmount())
  root = undefined
  present.mockClear()
  await act(async () => document.documentElement.setAttribute('data-dsh-about-open', ''))
  expect(present).toHaveBeenCalledTimes(0)
})

function deferredHistory() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const cloudRows = () => [...container.querySelectorAll('[data-history-kind=chat]')]
const historyResult = (items, epoch = 1, hasMore = false) => ({ epoch, items, hasMore })
const historyItem = (id, title = id) => ({ id, title, updatedAt: '2026-10-18' })

it('keeps cached rows and scroll position during same-account refresh, then replaces the list', async () => {
  const ui = await mount(true)
  const row = cloudRows()[0]
  const scroll = container.querySelector('.dshRecentHistory')
  scroll.scrollTop = 48
  const pending = deferredHistory()
  window.dshEnterpriseChat.history.mockReturnValueOnce(pending.promise)
  await ui.account(true)
  expect(cloudRows()[0]).toBe(row)
  expect(scroll.scrollTop).toBe(48)
  expect(scroll.textContent).not.toContain('historyLoading')
  await act(async () => pending.resolve(historyResult([historyItem('cloud-a', 'Renamed chat'), historyItem('cloud-b')])))
  expect(cloudRows().map(item => item.title)).toEqual(['Renamed chat', 'cloud-b'])
  expect(cloudRows()[0]).toBe(row)
})

it('keeps cached rows on refresh failure and replaces them with a successful empty response', async () => {
  const ui = await mount(true)
  const row = cloudRows()[0]
  window.dshEnterpriseChat.history.mockRejectedValueOnce(new Error('offline'))
  await ui.account(true)
  expect(cloudRows()[0]).toBe(row)
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'historyError')
  expect(retry).toBeDefined()
  window.dshEnterpriseChat.history.mockResolvedValueOnce(historyResult([]))
  await act(async () => retry.click())
  expect(cloudRows()).toHaveLength(0)
  expect(container.querySelector('[data-local-row]')).not.toBeNull()
})

it('keeps the last list while an account-state read fails', async () => {
  const ui = await mount(true)
  const row = cloudRows()[0]
  window.dshEnterpriseChat.state.mockRejectedValueOnce(new Error('state unavailable'))
  await ui.account(true)
  expect(cloudRows()[0]).toBe(row)
})

it('coalesces repeated account refresh notifications while history is pending', async () => {
  const ui = await mount(true)
  const pending = deferredHistory()
  window.dshEnterpriseChat.history.mockClear().mockReturnValue(pending.promise)
  await ui.account(true)
  await ui.account(true)
  await ui.account(true)
  expect(window.dshEnterpriseChat.history).toHaveBeenCalledTimes(1)
  expect(cloudRows()).toHaveLength(1)
  await act(async () => pending.resolve(historyResult([historyItem('fresh')])))
  expect(cloudRows()[0].title).toBe('fresh')
})

it.each(['poll', 'push'])('clears account-owned history on %s identity changes and rejects old responses', async source => {
  const ui = await mount(true)
  const oldRequest = deferredHistory(), newRequest = deferredHistory()
  window.dshEnterpriseChat.history.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise)
  await ui.account(true)
  if (source === 'poll') await ui.account(true, 2)
  else await ui.pushState({ connected: true, epoch: 2 })
  expect(cloudRows()).toHaveLength(0)
  await act(async () => oldRequest.resolve(historyResult([historyItem('old-account')], 1)))
  expect(cloudRows()).toHaveLength(0)
  await act(async () => newRequest.resolve(historyResult([historyItem('new-account')], 2)))
  expect(cloudRows().map(row => row.title)).toEqual(['new-account'])
})

it('clears cloud rows immediately on pushed logout and keeps local work rows', async () => {
  const ui = await mount(true)
  await ui.pushState({ connected: false, epoch: 2 })
  expect(cloudRows()).toHaveLength(0)
  expect(container.querySelector('[data-local-row]')).not.toBeNull()
})

it('keeps loaded pages visible until the entire refresh has completed', async () => {
  const ui = await mount(true)
  const firstPage = Array.from({ length: 40 }, (_, i) => historyItem(`page-1-${i}`))
  window.dshEnterpriseChat.history.mockResolvedValueOnce(historyResult(firstPage, 1, true))
  await ui.account(true)
  window.dshEnterpriseChat.history.mockResolvedValueOnce(historyResult([historyItem('page-2')]))
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'more').click())
  const secondPage = deferredHistory()
  window.dshEnterpriseChat.history.mockResolvedValueOnce(historyResult(firstPage.map(item => ({ ...item, title: 'updated' })), 1, true)).mockReturnValueOnce(secondPage.promise)
  await ui.account(true)
  expect(cloudRows()).toHaveLength(41)
  expect(cloudRows().some(row => row.title === 'updated')).toBe(false)
  await act(async () => secondPage.resolve(historyResult([historyItem('page-2-new')])))
  expect(cloudRows()).toHaveLength(41)
  expect(cloudRows().some(row => row.title === 'page-2-new')).toBe(true)
})


it('keeps a confirmed empty state visible while refreshing an empty history', async () => {
  const ui = await mount(true, { items: [] })
  window.dshEnterpriseChat.history.mockResolvedValueOnce(historyResult([]))
  await ui.account(true)
  const history = container.querySelector('.dshRecentHistory')
  expect(history.textContent).toBe('recentrecentEmpty')
  const pending = deferredHistory()
  window.dshEnterpriseChat.history.mockReturnValueOnce(pending.promise)
  await ui.account(true)
  expect(history.textContent).toBe('recentrecentEmpty')
  await act(async () => pending.resolve(historyResult([])))
})
