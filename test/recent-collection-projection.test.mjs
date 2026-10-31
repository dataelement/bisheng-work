import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { expect, it } from 'vitest'

// Execute the installed Harness projection and collection seam, including its fallback.
const source = await readFile('node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js', 'utf8')
const pure = source.slice(source.indexOf('function isWindowsStylePath('), source.indexOf('//#region lib/types/client/stores.js'))
const helpers = source.slice(source.indexOf('const SESSION_WATERMARK_BASE ='), source.indexOf('function SessionTree('))
const tree = source.slice(source.indexOf('function SessionTree('), source.indexOf('\n\t\t/** The flat', source.indexOf('function SessionTree(')))
const jsx = (type, props, key) => ({ type, props, key })
const SessionTree = vm.runInNewContext(`(() => { ${pure}\n${helpers}\n${tree}\nreturn SessionTree })()`, {
  react: { useMemo: fn => fn(), useEffect() {}, useState: value => [value, () => {}], useRef: value => ({ current: value }) },
  react_jsx_runtime: { jsx, jsxs: jsx }, clsx: (...args) => args.filter(Boolean).join(' '),
  WorkspaceBrowser_module_css_default: new Proxy({}, { get: (_, key) => key }),
  _deepseek_ai_dsh_client_ui_primitives: { HoverCardGroup: 'HoverCardGroup' },
  SessionNodeItem: 'NativeSession', ProjectRowItem: 'NativeProject', AnimatedRows: 'NativeRows', EmptySessions: 'Empty',
  console
})
function fixture() {
  const session = (id, time) => ({ id, title: id, updatedAt: time, blank: false, retainedBy: {}, running: false })
  const list = { phase: 'ready', ids: ['assigned', 'loose', 'archived'], byId: { assigned: session('assigned', 30), loose: session('loose', 20), archived: session('archived', 10) }, projectionsBySession: {} }
  list.byId.assigned.retainedBy.mainView = 1
  return { list, workspaces: [{ workspaceId: 'project', title: 'Project', path: '/fixture', sessionIds: ['assigned'], createdAt: '2026-01-01' }] }
}
function collect(props) {
  let collection, fallback
  SessionTree({ ...props, usePanelInfo: fn => fn({ activePanelId: null }), useSessionStatus: fn => fn(new Map()),
    workspaceReady: true, ungroupedSessionIds: ['loose', 'archived'], rowState: { archivedSessionIds: ['archived'], pinnedSessionIds: [], archivedFilter: 'default' },
    groupExpansion: { project: true }, setGroupExpanded() {}, unreadSessionIds: [], shortcuts: [], t: key => key,
    renderSlot(name, owner, options) { if (name === 'sidebar.workspaces.collection') { collection = owner; fallback = options.fallback } return jsx('Collection', owner) }
  })
  return { collection, fallback }
}
function flatten(node) {
  if (Array.isArray(node)) return node.flatMap(flatten)
  return node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : []
}
it('projects assigned sessions once and composes only unassigned visible Work into Recent', () => {
  const { collection, fallback } = collect(fixture())
  expect(collection.items.map(row => row.id)).toEqual(['loose'])
  expect(flatten(collection.projects(true)).filter(node => node.type === 'NativeSession').map(node => node.props.node.id)).toEqual(['assigned'])
  expect(flatten(fallback).filter(node => node.type === 'NativeSession').map(node => node.props.node.id)).toEqual(['assigned'])
  expect(collection.items[0].render(true).props.node.id).toBe('loose')
})
it('clears local selection when cloud Chat owns the right pane and updates membership on regrouping', () => {
  const props = fixture()
  const first = collect(props).collection
  expect(flatten(first.projects(false)).find(node => node.type === 'NativeSession').props.currentId).toBeUndefined()
  expect(flatten(first.projects(true)).find(node => node.type === 'NativeSession').props.currentId).toBe('assigned')
  props.workspaces[0].sessionIds.push('loose')
  const assigned = new Set(props.workspaces.flatMap(project => project.sessionIds))
  // WorkspaceBrowser's authoritative membership projection feeds SessionTree.
  const nextProps = { ...props }
  let next
  SessionTree({ ...nextProps, usePanelInfo: fn => fn({ activePanelId: null }), useSessionStatus: fn => fn(new Map()), workspaceReady: true,
    ungroupedSessionIds: props.list.ids.filter(id => !assigned.has(id)), rowState: { archivedSessionIds: ['archived'], pinnedSessionIds: [], archivedFilter: 'default' },
    groupExpansion: { project: true }, setGroupExpanded() {}, unreadSessionIds: [], shortcuts: [], t: key => key,
    renderSlot(name, owner) { if (name === 'sidebar.workspaces.collection') next = owner; return null }
  })
  expect(next.items).toHaveLength(0)
  expect(flatten(next.projects(true)).filter(node => node.type === 'NativeSession').map(node => node.props.node.id)).toEqual(['assigned', 'loose'])
})
