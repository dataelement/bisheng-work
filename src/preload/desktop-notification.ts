import { contextBridge, ipcRenderer } from 'electron'
import { NOTIFICATION_BRIDGE, WORK_COMPLETED, WORK_NOTIFICATION_CLICKED, type DesktopNotificationBridge } from '../shared/desktop-notification'

/** A named capability; native display and permission decisions belong to main. */
export function setupDesktopNotificationBridge(): void {
  const bridge: DesktopNotificationBridge = {
    completed: value => ipcRenderer.invoke(WORK_COMPLETED, value),
    onClicked(listener) {
      const receive = (_event: Electron.IpcRendererEvent, sessionId: unknown): void => {
        if (typeof sessionId === 'string') listener(sessionId)
      }
      ipcRenderer.on(WORK_NOTIFICATION_CLICKED, receive)
      const dispose = (): void => {
        ipcRenderer.removeListener(WORK_NOTIFICATION_CLICKED, receive)
        window.removeEventListener('unload', dispose)
      }
      window.addEventListener('unload', dispose, { once: true })
      return dispose
    }
  }
  contextBridge.exposeInMainWorld(NOTIFICATION_BRIDGE, Object.freeze(bridge))
}
