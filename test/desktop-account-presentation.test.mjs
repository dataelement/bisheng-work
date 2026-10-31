import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'

let cleanup
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.unstubAllGlobals() })

const HOST_COLORS = {
  '--dsw-alias-bg-layer-2': 'rgb(44, 44, 46)',
  '--dsw-specific-input-major': 'rgb(40, 41, 45)',
  '--dsw-alias-bg-layer-3': 'rgb(53, 54, 56)',
  '--dsw-alias-bg-overlay': 'rgb(97, 102, 107)',
  '--dsw-alias-label-primary': 'rgb(249, 250, 251)',
  '--dsw-alias-label-secondary': 'rgb(207, 211, 214)',
  '--dsw-alias-label-tertiary': 'rgb(173, 178, 184)',
  '--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.12)',
  '--dsw-alias-border-l3': 'rgba(255, 255, 255, 0.16)'
}

/** jsdom keeps `var()` verbatim, so the stub resolves the probe's token the way a browser would. */
function hostStyles(colors) {
  return node => {
    const declared = node.style?.color || ''
    const token = Object.keys(colors).find(name => declared.includes(name))
    return { color: token ? colors[token] : declared }
  }
}

/** Mount the single Chat/Work presenter and return its latest presentation. */
async function presenter({ computedStyle } = {}) {
  const dom = new JSDOM('<html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let definition, Component
  const value = { mode: 'chat', connected: true, phase: 'ready', settingsProtocolVersion: 1, settingsOpen: false, approvalsOpen: false }
  const effects = []
  const navigation = { start: vi.fn(() => vi.fn()), snapshot: () => value, subscribe: () => () => {} }
  dom.window.dshEnterpriseChat = { present: vi.fn(async () => {}) }
  dom.window.__ModuleLoader__ = { load: next => { definition = next } }
  const source = await readFile(new URL('../packages/dsh-desktop-client-ui/client.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, { window: dom.window, document: dom.window.document, ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: dom.window.MutationObserver, ...(computedStyle ? { getComputedStyle: computedStyle } : {}) })
  const plugin = definition.factory(id => { if (id === 'react') return React; if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}; throw new Error(id) })
  const locale = { register() {}, bind: () => key => key, getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} }
  plugin.apply({
    locale, remote: { session: {} },
    effect: setup => { const dispose = setup(); if (dispose) effects.push(dispose) },
    slots: {
      inject: (_name, setup) => { const result = setup(); if (result?.[Symbol.iterator]) [...result]; return result },
      register: (options, component) => { if (options.name === 'desktop.mode.content') Component = component; return () => {} }
    }
  })
  const root = createRoot(document.getElementById('root'))
  cleanup = async () => { await act(async () => { root.unmount(); effects.reverse().forEach(dispose => dispose()) }); dom.window.close() }
  await act(async () => root.render(React.createElement(Component, { navigation, locale, t: key => key, work: React.createElement('div') })))
  return { presented: () => dom.window.dshEnterpriseChat.present.mock.calls.at(-1)[0], dom }
}

it('sends the resolved host palette with the presentation and flattens translucent tokens', async () => {
  const f = await presenter({ computedStyle: hostStyles(HOST_COLORS) })
  expect(f.presented().palette).toEqual({
    mask: [1, 1, 2, 3], surface: [44, 44, 46], raised: [53, 54, 56], strong: [97, 102, 107], composer: [40, 41, 45],
    labelPrimary: [249, 250, 251], labelSecondary: [207, 211, 214], labelTertiary: [173, 178, 184],
    // Translucent host borders are composited over the surface they sit on.
    borderBase: [69, 69, 71], borderDeep: [78, 78, 79]
  })
  // The probe is measurement scaffolding and never stays in the host document.
  expect(f.dom.window.document.querySelectorAll('span[aria-hidden=true]')).toHaveLength(0)
})

it('presents without a palette when a host token does not resolve', async () => {
  const { '--dsw-alias-bg-overlay': _missing, ...partial } = HOST_COLORS
  const f = await presenter({ computedStyle: hostStyles(partial) })
  expect(f.presented().palette).toBeUndefined()
  expect(f.presented().theme).toBe('light')
})

it('presents without a palette when the host cannot be measured at all', async () => {
  const f = await presenter()
  expect(f.presented().palette).toBeUndefined()
})

it('presents approvals independently while preserving native Settings presentation', async () => {
  const dom = new JSDOM('<html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let definition, Component, value = { mode: 'chat', connected: true, phase: 'ready', settingsProtocolVersion: 1, settingsOpen: false, approvalsOpen: false }
  const listeners = new Set(), effects = []
  const navigation = { start: vi.fn(() => vi.fn()), snapshot: () => value, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
  const update = async patch => { await act(async () => { value = { ...value, ...patch }; listeners.forEach(listener => listener()) }) }
  dom.window.dshEnterpriseChat = { present: vi.fn(async () => {}) }
  dom.window.__ModuleLoader__ = { load: next => { definition = next } }
  const source = await readFile(new URL('../packages/dsh-desktop-client-ui/client.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, { window: dom.window, document: dom.window.document, ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: dom.window.MutationObserver })
  const plugin = definition.factory(id => { if (id === 'react') return React; if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}; throw new Error(id) })
  const locale = { register() {}, bind: () => key => key, getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} }
  plugin.apply({
    locale, remote: { session: {} },
    effect: setup => { const dispose = setup(); if (dispose) effects.push(dispose) },
    slots: {
      inject: (_name, setup) => { const result = setup(); if (result?.[Symbol.iterator]) [...result]; return result },
      register: (options, component) => { if (options.name === 'desktop.mode.content') Component = component; return () => {} }
    }
  })
  const root = createRoot(document.getElementById('root'))
  cleanup = async () => { await act(async () => { root.unmount(); effects.reverse().forEach(dispose => dispose()) }); dom.window.close() }
  await act(async () => root.render(React.createElement(Component, { navigation, locale, t: key => key, work: React.createElement('div', null, 'Work remains mounted') })))
  const presented = () => window.dshEnterpriseChat.present.mock.calls.at(-1)[0]
  expect(presented().visible).toBe(true)
  await update({ approvalsOpen: true })
  // Never show the previous Chat page while the approvals surface is mounting.
  expect(presented().visible).toBe(false)
  const bounds = { x: 300, y: 180, width: 900, height: 500 }
  await update({ settingsSurface: { section: 'my-tasks', bounds } })
  expect(presented()).toMatchObject({ visible: true, settings: 'my-tasks', bounds })
  expect(value.settingsOpen).toBe(false)
  await update({ approvalsOpen: false, settingsSurface: undefined })
  expect(presented()).toMatchObject({ visible: true })
  expect(presented().settings).toBeUndefined()
  expect(document.body.textContent).toContain('Work remains mounted')
  await update({ settingsOpen: true, settingsSurface: { section: 'desktop-usage', bounds } })
  expect(presented()).toMatchObject({ visible: true, settings: 'desktop-usage' })
  await update({ settingsProtocolVersion: undefined })
  expect(presented().visible).toBe(false)
  // A sidebar account dialog has no remote surface, so the native view yields the whole region.
  await update({ settingsProtocolVersion: 1, settingsOpen: false, settingsSurface: undefined, accountDialogOpen: true })
  expect(presented().visible).toBe(false)
  await update({ accountDialogOpen: false })
  expect(presented().visible).toBe(true)
})
