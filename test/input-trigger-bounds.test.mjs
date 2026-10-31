// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const source = readFileSync('node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js', 'utf8')
const start = source.indexOf('//#region lib/types/client/MenuView.js')
const observers = []
const { useMenuLayout } = vm.runInNewContext(`(() => {
  ${source.slice(start, source.indexOf('//#endregion', start))}
  return { useMenuLayout }
})()`, {
  react: React, window, getComputedStyle,
  ResizeObserver: class {
    constructor(callback) { this.callback = callback; this.elements = []; this.disconnect = vi.fn(); observers.push(this) }
    observe(element) { this.elements.push(element) }
  }
})
let root, host, geometry, render
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  observers.length = 0
  geometry = { clip: 130, bottom: 360, lineHeight: 20 }
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(1600)
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1600)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.getAttribute('role') === 'option') return { height: 34 }
    if (this.hasAttribute('data-anchor')) return { top: geometry.bottom + 4, height: 0 }
    return this.hasAttribute('data-menu')
      ? { top: geometry.bottom - 200, bottom: geometry.bottom, height: 200 }
      : { top: this.hasAttribute('data-clip') ? geometry.clip : 0, height: 800 }
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  function Fixture({ open }) {
    const ref = React.useRef(null)
    const layout = useMenuLayout(ref, open)
    return React.createElement('div', { 'data-clip': '', style: { overflowY: 'auto' } },
      open && React.createElement('div', { 'data-anchor': '' }, React.createElement('div', { ref, 'data-menu': '', style: layout },
        React.createElement('button', { role: 'option', style: { lineHeight: geometry.lineHeight + 'px' } }, 'Menu item'))))
  }
  render = async open => act(async () => root.render(React.createElement(Fixture, { open })))
  await render(true)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const height = () => parseFloat(host.querySelector('[data-menu]').style.maxHeight)

it('fits the menu above its anchor inside the nearest scroll boundary', () => {
  expect(height()).toBe(222)
})

it('tracks a resized header and composer without menu state changes', async () => {
  geometry.clip = 180
  geometry.bottom = 330
  await act(async () => observers[0].callback())
  expect(height()).toBe(142)
  geometry.bottom = 310
  await act(async () => window.dispatchEvent(new Event('resize')))
  expect(height()).toBe(122)
})

it('keeps complete rows available in a short pane and restores the original anchor as space grows', async () => {
  geometry.bottom = 200
  await act(async () => observers[0].callback())
  expect(height()).toBe(108)
  expect(host.querySelector('[data-menu]').style.getPropertyValue('--dsh-trigger-menu-shift')).toBe('46px')
  geometry.bottom = 500
  await act(async () => observers[0].callback())
  expect(height()).toBe(362)
  expect(host.querySelector('[data-menu]').style.getPropertyValue('--dsh-trigger-menu-shift')).toBe('0px')
})

it('scales the design cap with row typography while preserving the visible bound', async () => {
  geometry.bottom = 1200
  await act(async () => observers[0].callback())
  expect(height()).toBe(400)
  host.querySelector('[role=option]').style.lineHeight = '30px'
  await act(async () => observers[0].callback())
  expect(height()).toBe(600)
  geometry.bottom = 500
  await act(async () => observers[0].callback())
  expect(height()).toBe(362)
})

it('accounts for outer clipping, including borders, and releases observation on close', async () => {
  host.style.overflowY = 'hidden'
  host.getBoundingClientRect = () => ({ top: 240, height: 800 })
  Object.defineProperty(host, 'clientTop', { value: 2, configurable: true })
  await act(async () => observers[0].callback())
  expect(height()).toBe(110)
  expect(observers[0].elements).toContain(host.querySelector('[role=option]'))
  await render(false)
  expect(observers[0].disconnect).toHaveBeenCalledOnce()
  await render(true)
  expect(height()).toBe(110)
  expect(observers).toHaveLength(2)
})
