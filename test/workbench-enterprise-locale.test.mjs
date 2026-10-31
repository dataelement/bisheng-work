import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React, { act } from 'react'
import * as jsx from 'react/jsx-runtime'
import { Context } from '@deepseek-ai/cordis'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'

const source = await readFile(new URL('../packages/dsh-desktop-workbenches/client.js', import.meta.url), 'utf8')
const localeSource = await readFile(new URL('../node_modules/@deepseek-ai/dsh-client-locale/lib/client.js', import.meta.url), 'utf8')
let cleanup
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.unstubAllGlobals() })

async function mountMarket(language) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  dom.window.localStorage.setItem('dsh-workbench-enabled', 'true')
  dom.window.__dshEnterpriseWorkbenchSnapshot = { known: true, connected: true, allowThirdPartyWorkbenches: true }
  const definitions = new Map()
  dom.window.__ModuleLoader__ = { load: definition => definitions.set(definition.id, definition) }
  vm.runInNewContext(localeSource + '\n' + source, { window: dom.window, document: dom.window.document, setTimeout, clearTimeout, AbortController })
  const { LocaleRuntime } = definitions.get('@deepseek-ai/dsh-client-locale').factory(name =>
    name === 'react' ? React : name === 'react/jsx-runtime' ? jsx : {})
  const localeContext = new Context()
  const locale = new LocaleRuntime(localeContext, undefined, { languages: [language], preference: null })
  const client = definitions.get('dsh-desktop-workbenches').factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/cordis') return { Service: { tracker: Symbol('tracker') } }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Switch: () => null, Toast: () => null }
    throw new Error(`Unexpected module ${name}`)
  })
  const disposers = []
  let service
  client.apply({
    locale,
    reflect: { provide: (_name, value) => { service = value } },
    effect: (callback, label) => {
      if (['workbenches: service', 'workbenches: enterprise locale'].includes(label)) {
        const dispose = callback()
        if (dispose) disposers.push(dispose)
      }
    },
    slots: { inject: () => {} }
  })
  service.ready = true
  service.catalogLoaded = true
  service.enterpriseCatalogStatus = 'empty'
  service.publish()
  const root = createRoot(document.getElementById('root'))
  cleanup = async () => {
    await act(async () => root.unmount())
    service.dispose()
    disposers.reverse().forEach(dispose => dispose())
    await localeContext.fiber.dispose()
    dom.window.close()
  }
  await act(async () => root.render(React.createElement(client.Market, { service })))
  return { locale, tab: () => document.getElementById('dsh-workbench-enterprise-tab') }
}

it.each(['en-US', 'zh-CN'])('localizes the enterprise workbench tab and preserves selection across language changes from %s', async language => {
  const ui = await mountMarket(language)
  const tab = ui.tab()
  expect(tab.textContent).toBe(language === 'en-US' ? 'From enterprise' : '来自企业')
  expect(tab.getAttribute('role')).toBe('tab')
  await act(async () => tab.click())
  expect(tab.getAttribute('aria-selected')).toBe('true')
  expect(document.getElementById(tab.getAttribute('aria-controls'))).toBeTruthy()
  for (const [language, label] of [['zh', '来自企业'], ['en', 'From enterprise'], ['zh', '来自企业']]) {
    await act(async () => ui.locale.setLocale(language))
    expect(ui.tab()).toBe(tab)
    expect(tab.textContent).toBe(label)
    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(tab.tabIndex).toBe(0)
  }
})
