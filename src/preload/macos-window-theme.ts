import type { IpcRenderer } from 'electron'

/** Harness resolves explicit and system preferences before marking the body. */
export function mountMacosWindowTheme(doc: Document, ipc: Pick<IpcRenderer, 'invoke'>): () => void {
  const sync = (): void => {
    void ipc.invoke('desktop-titlebar:set-theme', doc.body.hasAttribute('data-ds-dark-theme'))
      .catch((error: unknown) => console.warn('[desktop-theme] unable to synchronize window backdrop', error))
  }
  const observer = new MutationObserver(sync)
  observer.observe(doc.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  sync()
  return () => observer.disconnect()
}
