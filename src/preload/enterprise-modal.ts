const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'

/** Body portals belong to the native window; the application root keeps its content bounds. */
export function observeEnterpriseModals(report: (open: boolean) => void): { refresh: () => void; dispose: () => void } {
  const portals = new Map<Element, MutationObserver>()
  const active = new WeakSet<Element>()
  const root = document.getElementById('root')
  let frame = 0
  let disposed = false
  let previous: string | undefined
  const visibleDialog = (element: Element): boolean => {
    if (element.getAttribute('aria-modal') === 'false') return false
    if (element instanceof HTMLDialogElement && !element.open) return false
    if (!element.checkVisibility({ checkVisibilityCSS: true })) return false
    // Radix modal dialogs hide the application root; nonmodal popovers also use role=dialog.
    const modal = element.getAttribute('aria-modal') === 'true' || element.matches(':modal') || root?.inert || root?.getAttribute('aria-hidden') === 'true'
    if (modal) active.add(element)
    // Keep the native window through the portal's exit animation.
    return Boolean(modal || (active.has(element) && element.getAttribute('data-state') === 'closed'))
  }
  const scan = (): void => {
    frame = 0
    if (disposed || document.hidden) return
    const children = new Set([...document.body.children].filter(element => element.id !== 'root' && !element.matches('script, style, link')))
    for (const [element, observer] of portals) {
      if (children.has(element)) continue
      observer.disconnect()
      portals.delete(element)
    }
    for (const element of children) {
      if (portals.has(element)) continue
      const observer = new MutationObserver(refresh)
      observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal', 'open', 'hidden', 'style', 'class', 'data-state'] })
      portals.set(element, observer)
    }
    const dialogs = [...children].flatMap(element => [
      ...(element.matches(DIALOG_SELECTOR) ? [element] : []), ...element.querySelectorAll(DIALOG_SELECTOR)
    ])
    const open = dialogs.filter(visibleDialog).length > 0
    const key = `${location.pathname}:${open}`
    if (key === previous) return
    previous = key
    report(open)
  }
  function refresh(): void {
    if (disposed || frame || document.hidden) return
    frame = requestAnimationFrame(scan)
  }
  const bodyObserver = new MutationObserver(refresh)
  bodyObserver.observe(document.body, { childList: true })
  const rootObserver = new MutationObserver(refresh)
  if (root) rootObserver.observe(root, { attributes: true, attributeFilter: ['inert', 'aria-hidden'] })
  document.addEventListener('visibilitychange', refresh)
  refresh()
  return {
    // A navigation can reset native bounds while retaining the same DOM portals.
    refresh: () => { previous = undefined; refresh() },
    dispose: () => {
      disposed = true
      cancelAnimationFrame(frame)
      bodyObserver.disconnect()
      rootObserver.disconnect()
      for (const observer of portals.values()) observer.disconnect()
      portals.clear()
      document.removeEventListener('visibilitychange', refresh)
    }
  }
}
