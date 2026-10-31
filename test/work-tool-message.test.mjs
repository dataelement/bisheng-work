import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

const client = readFileSync(new URL('../packages/dsh-desktop-client-ui/client.js', import.meta.url), 'utf8')
const harness = readFileSync(new URL('../node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', import.meta.url), 'utf8')
function region(name) {
  const start = harness.indexOf(`//#region ${name}`)
  if (start < 0) throw new Error(`Harness region missing: ${name}`)
  return harness.slice(start, harness.indexOf('//#endregion', start))
}
// Run the installed Harness evaluator and renderer, including range validation,
// rule precedence and raw-text fallback; business code supplies only its slot.
const UserTextDocument = vm.runInNewContext(`${region('lib/types/client/conversation/user-text-document.js')}; UserTextDocument`)
const renderStart = harness.indexOf('function UserText({')
const renderEnd = harness.indexOf('//#endregion', renderStart)
const UserText = vm.runInNewContext(`${harness.slice(renderStart, renderEnd)}; UserText`, {
  react: React, react_jsx_runtime: jsx,
  UserText_module_css_default: { root: 'userText', ellipsis: 'ellipsis' },
  _deepseek_ai_dsh_client_ui_primitives: { UserTextRun: ({ text }) => React.createElement('span', null, text) }
})
const sinkStart = harness.indexOf('sinkSerialized(attempt, draft, mode) {')
const sinkEnd = harness.indexOf('\n\t\t\tnotifySubmission(', sinkStart)
const sinkSerialized = new Function(`return ({${harness.slice(sinkStart, sinkEnd)}}).sinkSerialized`)()

function setup(language = 'zh') {
  const dom = new JSDOM('<!doctype html><head></head><body></body>')
  const fetch = vi.fn(async () => Response.json({ ok: true }))
  let plugin
  vm.runInNewContext(client, {
    document: dom.window.document, fetch,
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(name => name === 'react' ? React : {}) } } }
  })
  let install
  // Discover the production registration through apply, independent of the
  // optional skills/commands service that mounts the composer controls.
  plugin.apply({
    effect() {}, slots: { inject() {} }, locale: { bind: () => key => key }, remote: {},
    inject: (deps, callback) => { if (deps.includes('uiConversation')) install = callback }
  })
  const rules = new Map(), slots = new Map(), locales = new Map(), disposers = []
  const ctx = {
    effect: setup => { const dispose = setup(); if (dispose) disposers.push(dispose) },
    locale: {
      register: (ns, copy) => { locales.set(ns, copy); return () => locales.delete(ns) },
      bind: ns => key => locales.get(ns)[language][key]
    },
    uiConversation: { userText: { register: rule => {
      if (rules.has(rule.id)) throw new Error('Duplicate rule')
      rules.set(rule.id, rule)
      return () => rules.delete(rule.id)
    } } },
    slots: {
      inject: (_name, register) => { disposers.push(register()) },
      register: (config, component) => {
        slots.set(config.key, { config, component })
        return () => slots.delete(config.key)
      }
    }
  }
  const mount = () => install(ctx)
  const dispose = () => { for (const off of disposers.splice(0).reverse()) off() }
  mount()
  function render(text, extraRules = []) {
    const evaluator = new UserTextDocument()
    const errors = vi.fn()
    const html = renderToStaticMarkup(React.createElement(UserText, {
      text, facts: {}, useUserTextRevision() {},
      createUserTextEvaluator: () => input => evaluator.evaluate(input, [...rules.values(), ...extraRules].sort((a, b) => a.order - b.order)),
      reportTransformFailure: errors,
      renderSlot: (_name, props, options) => {
        const slot = slots.get(options.entryKey)
        return slot ? React.createElement(slot.component, { ...props, ...slot.config.inject() }) : options.fallback
      }
    }))
    return JSDOM.fragment(html)
  }
  return { plugin, fetch, dom, render, dispose, mount, rules, slots }
}
const name = 'mcp__bisheng__bisheng_tool_38'
const reference = (label = '联网搜索', toolName = name) => JSON.stringify({ name: toolName, label, connectionKey: 'test-account' })

// Exercise the actual chip expansion and plain-text resend paths before the
// prompt sink. The network boundary remains a fixture for availability checks.
function submit(source, draft, occurrences = []) {
  const defaultSink = vi.fn(async text => text)
  const result = new Promise((resolve, reject) => {
    sinkSerialized.call({
      notifySubmission() {}, attachmentIds: [], projection: { occurrences }, detachedDrafts: new Map(), rev: 1,
      deps: { defaultSink, inputTriggers: () => ({ serializeReference: (_source, ref, signal) => source.codec.serialize(ref, signal) }) },
      settleSink: (_attempt, promise) => { promise.then(resolve, reject) },
      settleDetachedFailure: (_attempt, message) => reject(new Error(message)), dead: () => false
    }, { seq: 1, signal: new AbortController().signal }, draft, 'next-turn')
  })
  return { result, defaultSink }
}

describe('Work tool messages', () => {
  it('submits the tool identity and label, renders its name, and retains it after history reload and edited-text resend', async () => {
    const first = setup()
    const source = first.plugin.toolReferenceSource
    const ref = reference(), clip = source.codec.clipboardText(ref)
    const { result } = submit(source, `${clip} 北京天气`, [{ source: source.name, ref, offset: 0, length: clip.length }])
    const text = await result
    expect(text).toBe(`[Selected tool: ${name}; label: "联网搜索"]  北京天气`)
    const view = first.render(text)
    expect(view.textContent).toBe('联网搜索  北京天气')
    expect(view.querySelector('.dshWorkToolReference').title).toBe('联网搜索')
    expect(view.querySelectorAll('svg')).toHaveLength(1)
    expect(view.querySelector('button, a')).toBeNull()
    expect(view.textContent).not.toContain('mcp__')
    expect(text).not.toContain('test-account')
    expect(JSON.parse(first.fetch.mock.calls[0][1].body)).toEqual({ operation: 'validate', names: [name], connectionKey: 'test-account' })

    const persisted = JSON.parse(JSON.stringify({ content: text }))
    first.dispose()
    const reopened = setup()
    reopened.fetch.mockRejectedValue(new Error('Signed out'))
    expect(reopened.render(persisted.content).textContent).toBe(view.textContent)
    const resent = await submit(reopened.plugin.toolReferenceSource, persisted.content.replace('北京天气', '上海天气')).result
    expect(reopened.render(resent).textContent).toBe('联网搜索  上海天气')
    expect(resent).toContain(name)
    expect(reopened.fetch).not.toHaveBeenCalled()
  })

  it('preserves prose, repeated selections and different tools in their original order', async () => {
    const { plugin, render } = setup()
    const a = await plugin.toolReferenceSource.codec.serialize(reference())
    const b = await plugin.toolReferenceSource.codec.serialize(reference('当前时间', 'mcp__bisheng__bisheng_tool_7'))
    const view = render(`开始${a}中间${b}再次${a}结束`)
    expect(view.textContent).toBe('开始 联网搜索 中间 当前时间 再次 联网搜索 结束')
    expect([...view.querySelectorAll('.dshWorkToolReference')].map(node => node.title)).toEqual(['联网搜索', '当前时间', '联网搜索'])
  })

  it.each(['引号 "、反斜线 \\、方括号 ] [ 与 emoji 🔎', '<img src=x onerror=alert(1)>', '超长工具名称'.repeat(100)])('round-trips the complete label as text: %s', async label => {
    const { plugin, render } = setup()
    const text = await plugin.toolReferenceSource.codec.serialize(reference(label))
    const view = render(text)
    expect(view.textContent).toBe(` ${label} `)
    expect(view.querySelector('.dshWorkToolReference').title).toBe(label)
    expect(view.querySelector('img, script, a')).toBeNull()
  })

  it.each([['zh', '已选工具'], ['en', 'Selected tool']])('renders ID-only history safely in %s without resolving a different account', (language, label) => {
    const { render, fetch } = setup(language)
    const view = render(`[Selected tool: ${name}] 北京天气`)
    expect(view.textContent).toBe(`${label} 北京天气`)
    expect(view.querySelector('.dshWorkToolReference').title).toBe(label)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    '[Selected tool: bash; label: "Bash"]',
    `[Selected tool: ${name}; label: "bad\\q"]`,
    `[Selected tool: ${name}; label: ""]`,
    `[Selected tool: ${name}; label: "line\\nfeed"]`,
    `[Selected tool: ${name}; label: "unfinished"`,
    '普通文本 /联网搜索 [Selected tool: example]'
  ])('preserves unrecognized or malformed text: %s', text => {
    const { render } = setup()
    expect(render(text).textContent).toBe(text)
    expect(render(text).querySelector('.dshWorkToolReference')).toBeNull()
  })

  it('continues matching after a malformed reference and composes with existing session references', async () => {
    const { plugin, render } = setup()
    const tool = await plugin.toolReferenceSource.codec.serialize(reference())
    const sessionRules = vm.runInNewContext(`${region('lib/types/client/user-text/session-reference-rule.js')}; sessionReferenceRule`)
    const text = `[Selected tool: ${name}; label: "\\q"]${tool}@[会话](dsh-session:one)`
    const view = render(text, [sessionRules])
    expect(view.querySelectorAll('.dshWorkToolReference')).toHaveLength(1)
    expect(view.textContent).toContain('联网搜索')
    expect(view.textContent).toContain('@[会话](dsh-session:one)')
  })

  it.each(['', ' ', '\nname', 'name\u0000', 'name\u007f'])('rejects an invalid selected label before submission: %j', async label => {
    const { plugin, fetch } = setup()
    const ref = reference(label)
    const { result, defaultSink } = submit(plugin.toolReferenceSource, '/tool', [{ ref, offset: 0, length: 5 }])
    await expect(result).rejects.toThrow('Invalid tool reference')
    expect(defaultSink).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the send blocked when availability or account validation fails', async () => {
    const { plugin, fetch } = setup()
    fetch.mockResolvedValueOnce(Response.json({ error: 'Tool access revoked' }, { status: 403 }))
    const { result, defaultSink } = submit(plugin.toolReferenceSource, '/联网搜索 北京天气', [{ ref: reference(), offset: 0, length: 5 }])
    await expect(result).rejects.toThrow('Tool access revoked')
    expect(defaultSink).not.toHaveBeenCalled()
  })

  it('disposes and reinstalls the rule, slot, locale and stylesheet once', async () => {
    const state = setup()
    const text = await state.plugin.toolReferenceSource.codec.serialize(reference())
    expect(state.dom.window.document.querySelectorAll('[data-plugin="dsh-desktop-tool-message"]')).toHaveLength(1)
    state.dispose()
    expect(state.rules.size).toBe(0)
    expect(state.slots.size).toBe(0)
    expect(state.dom.window.document.querySelectorAll('[data-plugin="dsh-desktop-tool-message"]')).toHaveLength(0)
    expect(state.render(text).textContent).toBe(text)
    state.mount()
    expect(state.rules.size).toBe(1)
    expect(state.render(text).textContent).toBe(' 联网搜索 ')
    expect(state.dom.window.document.querySelectorAll('[data-plugin="dsh-desktop-tool-message"]')).toHaveLength(1)
  })
})
