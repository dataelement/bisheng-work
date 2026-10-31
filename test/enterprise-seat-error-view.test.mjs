import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React, { act } from 'react'
import * as jsx from 'react/jsx-runtime'
import { Context } from '@deepseek-ai/cordis'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
// Coverage AC: AC-03, AC-30, AC-31, AC-56.
const source = await readFile(new URL('../packages/dsh-desktop-enterprise/client.js', import.meta.url), 'utf8')
const localeSource = await readFile(new URL('../node_modules/@deepseek-ai/dsh-client-locale/lib/client.js', import.meta.url), 'utf8')
it.each(['zh', 'en'])('renders legacy-server upgrade guidance without a request id in %s', async language => {
  const dom = new JSDOM('<html><div id="root"></div></html>', { url: 'http://localhost/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const state = { connected: false, secureStorageAvailable: true, phase: 'idle', error: 'seat not assigned', errorCode: 'seat_not_assigned', requestId: 'req-no-seat' }
  const definitions = new Map()
  dom.window.__ModuleLoader__ = { load: value => definitions.set(value.id, value) }
  vm.runInNewContext(localeSource + '\n' + source, { window: dom.window, document: dom.window.document, Date, AbortController, fetch: async () => ({ ok: true, json: async () => state }), CustomEvent: dom.window.CustomEvent })
  const extension = definitions.get('dsh-desktop-enterprise').factory(name => { if (name === 'react') return React; throw new Error(name) })
  const { LocaleRuntime } = definitions.get('@deepseek-ai/dsh-client-locale').factory(name =>
    name === 'react' ? React : name === 'react/jsx-runtime' ? jsx : {})
  const localeContext = new Context()
  const locale = new LocaleRuntime(localeContext, undefined, { languages: [language === 'zh' ? 'zh-CN' : 'en-US'], preference: null })
  const root = createRoot(dom.window.document.getElementById('root'))
  const disposers = []
  try {
    await act(async () => {
      extension.apply({ locale, effect: callback => { const dispose = callback(); if (dispose) disposers.push(dispose) }, slots: {
        inject: (_slot, callback) => callback(),
        register: (config, component) => { if (config.id === 'enterprise-account') root.render(React.createElement(component, config.inject())); return () => {} }
      } })
    })
    const alert = dom.window.document.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe(language === 'zh'
      ? '当前服务版本不支持直接登录，请联系管理员升级平台。'
      : 'This server uses a legacy sign-in policy. Ask your administrator to upgrade the platform.')
    expect(alert?.textContent).not.toContain('req-no-seat')
  } finally {
    await act(async () => { disposers.reverse().forEach(dispose => dispose()); root.unmount() })
    await localeContext.fiber.dispose()
    dom.window.close()
    vi.unstubAllGlobals()
  }
})
