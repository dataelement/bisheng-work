import React from 'react'
import { createRoot } from 'react-dom/client'
import * as jsx from 'react/jsx-runtime'

// Load the shipped components; only host stores and visual primitives are fixtures.
export function createSessionSearchFixture(workspaceSource, desktopSource, { groupBy = 'flat', shared = true, searchSessions = async () => ({ items: [], hasMore: false }) } = {}) {
  const primitives = new Proxy({}, { get: (_, name) => name === 'relativeTime'
    ? () => ({ unit: 'day', n: 1 })
    : name.startsWith('Icon') ? () => null
      : ({ children, anchor }) => React.createElement(React.Fragment, null, anchor || children) })
  const store = { createSnapshotStore(value) {
    const listeners = new Set()
    return { getSnapshot: () => value, set(next) { value = next; listeners.forEach(fn => fn()) }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
  } }
  const modules = { react: React, 'react/jsx-runtime': jsx, '@deepseek-ai/cordis': { Service: class {} }, '@deepseek-ai/dsh-client-store': store, '@deepseek-ai/dsh-client-ui-primitives': primitives }
  function load(source, exports) {
    let runtime
    const previous = window.__ModuleLoader__
    window.__ModuleLoader__ = { load({ factory }) { runtime = factory(name => {
      if (name in modules) return modules[name]
      throw new Error(`Unexpected fixture dependency: ${name}`)
    }) } }
    try { new Function(source.replace('exports.apply = apply', `${exports}; exports.apply = apply`))() }
    finally { window.__ModuleLoader__ = previous }
    return runtime
  }
  const { WorkspaceBrowser, createWorkspaceShortcutControls } = load(workspaceSource, 'exports.WorkspaceBrowser = WorkspaceBrowser; exports.createWorkspaceShortcutControls = createWorkspaceShortcutControls')
  const { SharedCollection } = load(desktopSource, 'exports.SharedCollection = SharedCollection')
  const controls = createWorkspaceShortcutControls()
  const catalog = { phase: 'ready', projectionsBySession: {}, ids: ['one', 'two'], byId: Object.fromEntries(['one', 'two'].map(id => [id, { id, title: `会话 ${id}`, updatedAt: 1, blank: false, retainedBy: {} }])) }
  const workspaces = { phase: 'ready', state: 'ready', items: [], archivedSessionIds: [], pinnedSessionIds: [] }
  const view = { groupBy, orderBy: 'updated', archivedFilter: 'default', groupExpansion: { '': true }, sessionOrderByAccount: {}, unreadSessionIds: [] }
  const cloud = { mode: 'work', historyPhase: 'ready', items: [{ id: 'cloud', title: '云端会话', updatedAt: '2026-01-01T00:00:00Z' }] }
  const opened = []
  const navigation = { snapshot: () => cloud, subscribe: () => () => {}, open: id => opened.push(`chat:${id}`) }
  const actions = Object.fromEntries(['retainAccountKeys', 'syncSessionOrders', 'setGroupExpanded', 'setSessionOrder'].map(name => [name, () => {}]))
  const props = {
    wide: true,
    usePanelInfo: selector => selector({ activePanelId: null }),
    useSessions: selector => selector(catalog),
    useSessionStatus: selector => selector(new Map()),
    useWorkspaces: selector => selector(workspaces),
    useStore: selector => selector(view),
    useHostInfo: selector => selector({ home: '/fixture' }),
    useShortcuts: selector => selector([]),
    useWorkspaceShortcuts: selector => selector(React.useSyncExternalStore(controls.state.subscribe, controls.state.getSnapshot)),
    useSessionVisibility: selector => selector(0),
    useWorkspaceVisibility: selector => selector(0),
    isSessionVisible: () => true,
    isWorkspaceVisible: () => true,
    useDirectoryFlow: selector => selector(false),
    requestSearch: controls.search,
    closeAddWorkspace: controls.closeAdd,
    searchSessions,
    searchResultLimit: 20,
    open: id => opened.push(`work:${id}`),
    actions,
    renderSlot: (name, props, options) => shared && name === 'sidebar.workspaces.collection'
      ? React.createElement(SharedCollection, { ...props, navigation, t: key => key })
      : options?.fallback,
    t: key => key
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  return {
    host, catalog, cloud, opened,
    mount: () => root.render(React.createElement(WorkspaceBrowser, props)),
    openSearch: () => host.querySelector('[aria-label="search.sessions.aria"]').click(),
    type(query) {
      const input = host.querySelector('input[placeholder="search.placeholder"]')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, query)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    clear: () => host.querySelector('[aria-label="search.clear"]').click(),
    escape: () => host.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    unmount() { root.unmount(); host.remove() }
  }
}
