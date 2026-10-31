// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { createAboutPresentation } from '../src/preload/about-presentation'

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); document.body.replaceChildren() })

it('publishes the About foreground and preserves focus across rerenders, close and reopen', () => {
  const origin = document.createElement('button')
  const host = document.createElement('div')
  const shadow = host.attachShadow({ mode: 'closed' })
  document.body.append(origin, host)
  const presentation = createAboutPresentation(document, window)
  cleanups.push(presentation.dispose)
  origin.focus()
  for (let attempt = 0; attempt < 2; attempt++) {
    const close = document.createElement('button')
    shadow.replaceChildren(close)
    presentation.show(close)
    expect(document.documentElement.hasAttribute('data-dsh-about-open')).toBe(true)
    expect(shadow.activeElement).toBe(close)
    const nextClose = document.createElement('button')
    shadow.replaceChildren(nextClose)
    presentation.show(nextClose)
    for (const shiftKey of [false, true]) {
      const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true })
      window.dispatchEvent(tab)
      expect(tab.defaultPrevented).toBe(true)
      expect(shadow.activeElement).toBe(nextClose)
    }
    presentation.close()
    expect(document.documentElement.hasAttribute('data-dsh-about-open')).toBe(false)
    expect(document.activeElement).toBe(origin)
  }
})

it('releases foreground and keyboard handling when the document is disposed', () => {
  const button = document.createElement('button')
  document.body.append(button)
  const presentation = createAboutPresentation(document, window)
  presentation.show(button)
  presentation.dispose()
  expect(document.documentElement.hasAttribute('data-dsh-about-open')).toBe(false)
  const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
  window.dispatchEvent(tab)
  expect(tab.defaultPrevented).toBe(false)
})
