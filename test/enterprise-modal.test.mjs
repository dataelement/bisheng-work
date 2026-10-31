import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { observeEnterpriseModals } from '../src/preload/enterprise-modal'

let dom, observer, report, frames
beforeEach(() => {
  dom = new JSDOM('<body><main id="root"></main></body>', { url: 'https://enterprise.example/workspace/capabilities', pretendToBeVisual: true })
  for (const key of ['document', 'location', 'Element', 'HTMLDialogElement', 'MutationObserver']) vi.stubGlobal(key, dom.window[key])
  // jsdom has no layout; the Electron regression exercises native checkVisibility.
  dom.window.Element.prototype.checkVisibility = function () {
    return !this.closest('[hidden], [style="display: none;"]')
  }
  frames = new Map()
  let next = 0
  vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++next, callback); return next })
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id))
  report = vi.fn()
  observer = observeEnterpriseModals(report)
})
afterEach(() => { observer.dispose(); vi.unstubAllGlobals(); dom.window.close() })
async function flush() {
  await Promise.resolve()
  const callbacks = [...frames.values()]
  frames.clear()
  callbacks.forEach(callback => callback())
  await Promise.resolve()
}
function portal(markup = '<div role="dialog" aria-modal="true" data-state="open">Upload skill</div>') {
  const node = document.createElement('section')
  node.innerHTML = markup
  document.body.append(node)
  return node
}

it('reports upload portals, keeps the window during closing animation, and restores after removal', async () => {
  await flush()
  expect(report.mock.calls).toEqual([[false]])
  const node = portal()
  await flush()
  expect(report.mock.calls).toEqual([[false], [true]])
  node.firstElementChild.dataset.state = 'closed'
  await flush()
  expect(report).toHaveBeenCalledTimes(2)
  node.remove()
  await flush()
  expect(report.mock.calls).toEqual([[false], [true], [false]])
})

it('keeps the window covered until every nested dialog is dismissed', async () => {
  const details = portal()
  await flush()
  const confirm = portal('<div role="alertdialog" aria-modal="true">Confirm deletion</div>')
  await flush()
  confirm.remove()
  await flush()
  expect(report.mock.calls).toEqual([[true]])
  details.remove()
  await flush()
  expect(report.mock.calls).toEqual([[true], [false]])
})

it('tracks hidden and native dialogs while excluding menus and explicit nonmodal content', async () => {
  const node = portal('<div role="menu">Menu</div><div role="dialog" aria-modal="false">Floating panel</div><div role="dialog">Popover</div><dialog aria-modal="true">Native dialog</dialog><div role="dialog" aria-modal="true" hidden>Hidden dialog</div>')
  await flush()
  expect(report).toHaveBeenLastCalledWith(false)
  node.querySelector('dialog').open = true
  await flush()
  expect(report).toHaveBeenLastCalledWith(true)
  node.querySelector('dialog').open = false
  await flush()
  expect(report).toHaveBeenLastCalledWith(false)
  node.lastElementChild.hidden = false
  await flush()
  expect(report).toHaveBeenLastCalledWith(true)
})

it('recognizes Radix modal background isolation and retains the portal during its exit', async () => {
  const node = portal('<div role="dialog" data-state="open">Radix dialog</div>')
  await flush()
  expect(report).toHaveBeenLastCalledWith(false)
  document.getElementById('root').setAttribute('aria-hidden', 'true')
  await flush()
  expect(report).toHaveBeenLastCalledWith(true)
  document.getElementById('root').removeAttribute('aria-hidden')
  node.firstElementChild.dataset.state = 'closed'
  await flush()
  expect(report.mock.calls).toEqual([[false], [true]])
  node.remove()
  await flush()
  expect(report).toHaveBeenLastCalledWith(false)
})

it('restores content bounds when a surviving floating dialog returns to nonmodal state', async () => {
  portal('<div role="dialog" data-state="open">Floating dialog</div>')
  document.getElementById('root').setAttribute('aria-hidden', 'true')
  await flush()
  expect(report).toHaveBeenLastCalledWith(true)
  document.getElementById('root').removeAttribute('aria-hidden')
  await flush()
  expect(report).toHaveBeenLastCalledWith(false)
})

it('observes portals without scanning streaming content in the application root', async () => {
  await flush()
  document.getElementById('root').innerHTML = '<div role="dialog">Inline panel</div>'
  await Promise.resolve()
  expect(frames.size).toBe(0)
  expect(report.mock.calls).toEqual([[false]])
})

it('refreshes the presentation after navigation and releases observers on disposal', async () => {
  const node = portal()
  await flush()
  dom.window.history.pushState({}, '', '/workspace/skills')
  observer.refresh()
  await flush()
  expect(report.mock.calls).toEqual([[true], [true]])
  observer.dispose()
  node.remove()
  await flush()
  expect(report).toHaveBeenCalledTimes(2)
})

it('pauses hidden documents and refreshes after the window becomes visible', async () => {
  let hidden = true
  Object.defineProperty(document, 'hidden', { get: () => hidden })
  portal()
  await flush()
  expect(report).toHaveBeenCalledTimes(0)
  hidden = false
  document.dispatchEvent(new dom.window.Event('visibilitychange'))
  await flush()
  expect(report).toHaveBeenCalledExactlyOnceWith(true)
})
