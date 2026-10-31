// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import React, { act } from 'react'
import * as jsx from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(path.resolve('node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js'), 'utf8')
function region(name) {
  const start = source.indexOf(`//#region ${name}`)
  const end = source.indexOf('//#endregion', start)
  if (start < 0 || end < 0) throw new Error(`Missing runtime region: ${name}`)
  return source.slice(start, end)
}

const { menuReduce, MenuView } = vm.runInNewContext(`(() => {
  ${region('lib/types/core/menu.js')}
  ${region('lib/types/client/MenuView.js')}
  return { menuReduce, MenuView }
})()`, {
  react: React,
  react_jsx_runtime: jsx,
  document,
  window,
  getComputedStyle,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  Node,
  clsx: (...values) => values.filter(Boolean).join(' '),
  MenuView_module_css_default: new Proxy({}, { get: (_, key) => String(key) }),
  _deepseek_ai_dsh_client_ui_primitives: {
    MenuSurface: React.forwardRef((props, ref) => React.createElement('div', { ...props, ref })),
    useAnchoredMaxHeight: (_, cap) => cap
  }
})

describe('input trigger menu scroll ownership', () => {
  let root, host, state, listeners, dispatch, scrollIntoView
  const headers = { subscribe: () => () => {}, getSnapshot: () => emptyHeaders }
  const emptyHeaders = new Map()
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    listeners = new Set()
    state = {
      open: true, hit: null, generation: 1,
      groups: [{
        source: 'command', status: 'ready',
        items: Array.from({ length: 10 }, (_, i) => ({ name: `command-${i}`, section: i < 4 ? '添加' : '指令' }))
      }],
      highlight: { source: 'command', index: 0 }
    }
    scrollIntoView = vi.fn()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.getAttribute('role') === 'listbox') return { top: 100, bottom: 492 }
      if (this.getAttribute('role') === 'option') {
        const index = Number(this.id.split('-').at(-1))
        const scroll = this.parentElement.scrollTop
        return { top: 123 + index * 40 - scroll, bottom: 157 + index * 40 - scroll, height: 34 }
      }
      return { top: 96, bottom: 496 }
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(1000)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    dispatch = event => {
      state = menuReduce(state, event)
      listeners.forEach(fn => fn())
    }
    await act(async () => root.render(React.createElement(MenuView, {
      menu: { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => state },
      headers, t: key => key, onDismiss() {}, onPick() {}, onCrumb() {},
      onHover: (source, index) => dispatch({ type: 'hover', source, index })
    })))
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    delete HTMLElement.prototype.scrollIntoView
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const hoverLast = async host => act(async () => {
    host.querySelectorAll('[role=option]')[9].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  })

  it('opens at the top and preserves the menu height when hovering a clipped last row', async () => {
    const list = host.querySelector('[role=listbox]')
    const menu = host.querySelector('[data-trigger-menu]')
    expect(list.scrollTop).toBe(0)
    const height = menu.style.maxHeight
    await hoverLast(host)
    expect(host.querySelectorAll('[role=option]')[9].getAttribute('aria-selected')).toBe('true')
    expect(list.scrollTop).toBe(0)
    expect(menu.style.maxHeight).toBe(height)
    expect(scrollIntoView).toHaveBeenCalledTimes(0)
  })

  it('preserves a manually scrolled position across pointer highlights and result refreshes', async () => {
    const list = host.querySelector('[role=listbox]')
    list.scrollTop = 12
    await hoverLast(host)
    await act(async () => dispatch({ type: 'source-settled', source: 'command', generation: 1, items: [...state.groups[0].items] }))
    expect(list.scrollTop).toBe(12)
    expect(scrollIntoView).toHaveBeenCalledTimes(0)
  })

  it('reveals an offscreen row for keyboard navigation and wraps back without scrolling ancestors', async () => {
    const list = host.querySelector('[role=listbox]')
    host.scrollTop = 41
    await act(async () => dispatch({ type: 'move', dir: -1 }))
    expect(list.scrollTop).toBe(25)
    expect(host.scrollTop).toBe(41)
    await act(async () => dispatch({ type: 'move', dir: 1 }))
    expect(list.scrollTop).toBe(23)
    expect(host.scrollTop).toBe(41)
    expect(scrollIntoView).toHaveBeenCalledTimes(0)
  })

  it('resumes keyboard reveal after a pointer highlight', async () => {
    const list = host.querySelector('[role=listbox]')
    await hoverLast(host)
    await act(async () => dispatch({ type: 'move', dir: -1 }))
    await act(async () => dispatch({ type: 'move', dir: 1 }))
    expect(list.scrollTop).toBe(25)
    expect(state.highlight.origin).toBe('keyboard')
  })
})
