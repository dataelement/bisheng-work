import { contextBridge, ipcRenderer } from 'electron'
import { observeEnterpriseModals } from './enterprise-modal'

let modals: ReturnType<typeof observeEnterpriseModals> | undefined
const refreshModals = (): void => modals?.refresh()
window.addEventListener('DOMContentLoaded', () => {
  modals = observeEnterpriseModals(open => ipcRenderer.send('enterprise-chat:modal', { open, path: window.location.pathname }))
  ipcRenderer.on('enterprise-chat:sync-modal', refreshModals)
}, { once: true })
window.addEventListener('pagehide', () => {
  modals?.dispose()
  ipcRenderer.removeListener('enterprise-chat:sync-modal', refreshModals)
}, { once: true })

/** Presentation-only channel. Remote Chat receives no local execution or account APIs. */
contextBridge.exposeInMainWorld('dshChatPresentation', Object.freeze({
  reportNavigation(navigation: unknown): void {
    ipcRenderer.send('enterprise-chat:navigation', { navigation, path: window.location.pathname })
  },
  reportKnowledgeDialog(open: unknown): void {
    if (typeof open === 'boolean') refreshModals()
  },
  reportLanding(landing: unknown): void {
    if (typeof landing === 'boolean') ipcRenderer.send('enterprise-chat:landing', { landing, path: window.location.pathname })
  },
  reportSettings(section: unknown): void {
    ipcRenderer.send('enterprise-chat:settings-ready', { section, path: window.location.pathname })
  },
  requestSettingsClose(): void {
    ipcRenderer.send('enterprise-chat:settings-close', { path: window.location.pathname })
  },
  requestSettingsFocus(direction: unknown): void {
    if (direction === 'previous' || direction === 'next') ipcRenderer.send('enterprise-chat:settings-focus', { direction, path: window.location.pathname })
  }
}))
