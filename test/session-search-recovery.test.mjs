// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSessionSearchFixture } from './helpers/session-search-fixture.mjs'

const workspaceSource = await readFile('node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js', 'utf8')
const desktopSource = await readFile('packages/dsh-desktop-client-ui/client.js', 'utf8')
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
let fixture
beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(async () => {
  if (fixture) await act(async () => fixture.unmount())
  fixture = undefined
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll)
  else delete HTMLElement.prototype.scrollIntoView
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function mount(options) {
  fixture = createSessionSearchFixture(workspaceSource, desktopSource, options)
  await act(async () => fixture.mount())
  return fixture
}
async function settle() { await act(async () => vi.advanceTimersByTimeAsync(300)) }
function expectCatalog() {
  expect(fixture.host.textContent).toContain('会话 one')
  expect(fixture.host.textContent).toContain('会话 two')
}

it.each([
  { groupBy: 'flat', shared: false },
  { groupBy: 'workspace-tree', shared: false },
  { groupBy: 'flat', shared: true },
  { groupBy: 'workspace-tree', shared: true }
])('keeps history usable through search and recovery: $groupBy, shared=$shared', async options => {
  const f = await mount(options)
  const original = JSON.stringify([f.catalog, f.cloud])
  expectCatalog()
  await act(async () => f.openSearch())
  expectCatalog()
  await act(async () => f.type('one'))
  await settle()
  expect(f.host.textContent).toContain('会话 one')
  expect(f.host.textContent).not.toContain('会话 two')
  await act(async () => f.host.querySelector('[role="treeitem"]').click())
  expect(f.opened).toEqual(['work:one'])
  expectCatalog()
  await act(async () => f.openSearch())
  await act(async () => f.type('missing'))
  await settle()
  expect(f.host.textContent).toContain(options.shared ? 'recentSearchEmpty' : 'search.noMatches')
  await act(async () => f.clear())
  expectCatalog()
  if (options.shared) {
    expect(f.host.textContent).toContain('云端会话')
    await act(async () => f.openSearch())
    await act(async () => f.type('云端'))
    await settle()
    await act(async () => f.host.querySelector('[data-history-kind="chat"]').click())
    expect(f.opened).toEqual(['work:one', 'chat:cloud'])
    await act(async () => f.escape())
    expectCatalog()
  }
  expect(JSON.stringify([f.catalog, f.cloud])).toBe(original)
})

it('clears pending search and ignores its late response without replacing history', async () => {
  let resolveSearch, signal
  const f = await mount({ searchSessions: (_, currentSignal) => {
    signal = currentSignal
    return new Promise(resolve => { resolveSearch = resolve })
  } })
  await act(async () => f.openSearch())
  await act(async () => f.type('missing'))
  await settle()
  expect(f.host.querySelector('[aria-label="search.pending"]')).toBeTruthy()
  await act(async () => f.clear())
  expect(signal.aborted).toBe(true)
  await act(async () => resolveSearch({ items: [], hasMore: false }))
  expectCatalog()
  expect(f.host.textContent).toContain('云端会话')
})

it('keeps local matches and restores history after a remote search error', async () => {
  const f = await mount({ searchSessions: async () => { throw new Error('Search unavailable') } })
  await act(async () => f.openSearch())
  await act(async () => f.type('one'))
  await settle()
  expect(f.host.textContent).toContain('会话 one')
  await act(async () => f.escape())
  expectCatalog()
})
