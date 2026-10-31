import { app, BrowserWindow, ipcMain, Notification, type IpcMainInvokeEvent } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseWorkCompletion, WORK_COMPLETED, WORK_NOTIFICATION_CLICKED, type NotificationReceipt, type WorkCompletion } from '../shared/desktop-notification'

export type NotificationAudit = (stage: string, facts: Record<string, string | number | boolean>) => void

/** Keep system errors diagnosable without recording prompts, responses or credentials. */
export function writeNotificationAudit(stage: string, facts: Record<string, string | number | boolean>): void {
  const line = `[desktop-notification] ${JSON.stringify({ time: new Date().toISOString(), stage, ...facts })}\n`
  try {
    const directory = app.getPath('logs')
    mkdirSync(directory, { recursive: true })
    appendFileSync(join(directory, 'harness.log'), line, 'utf8')
  } catch (error) {
    console.error('[desktop-notification] log-write-failed', error)
    console.error(line)
  }
}

function failureMessage(error: unknown): string {
  // OS errors sometimes include a path or URL. Keep the diagnostic bounded and redact access values.
  return String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/(token|password|secret|authorization)[=: ]+\S+/gi, '$1=[redacted]')
    .slice(0, 1000)
}

export function registerDesktopNotificationBridge(
  getMainWindow: () => BrowserWindow | undefined,
  getIconPath: () => string,
  getLocale: () => 'en' | 'zh',
  audit: NotificationAudit = writeNotificationAudit
): () => void {
  const active = new Map<string, Notification>()
  const consumed = new Map<string, number>()
  const trustedWindow = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = getMainWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame) {
      audit('rejected', { reason: 'untrusted-sender' })
      throw new Error('Work notifications require the main BISHENG window.')
    }
    return window
  }
  const handleCompleted = (event: IpcMainInvokeEvent, payload: unknown): NotificationReceipt => {
    const window = trustedWindow(event)
    let value: WorkCompletion
    try { value = parseWorkCompletion(payload) } catch (error) {
      audit('rejected', { reason: 'invalid-completion' })
      throw error
    }
    const facts = { ...value, platform: process.platform }
    if (value.seq <= (consumed.get(value.sessionId) ?? -1)) return 'duplicate'
    consumed.set(value.sessionId, value.seq)
    if (window.isVisible() && window.isFocused() && !window.isMinimized()) {
      audit('foreground', facts)
      return 'foreground'
    }
    let notification: Notification | undefined
    try {
      if (!Notification.isSupported()) {
        audit('unsupported', facts)
        return 'unsupported'
      }
      const icon = getIconPath()
      if (!icon || !existsSync(icon)) throw new Error('Packaged notification icon is missing.')
      const zh = getLocale() === 'zh'
      notification = new Notification({
        title: value.count > 1
          ? (zh ? `${value.count} 个 Work 任务已完成` : `${value.count} Work tasks completed`)
          : (zh ? 'Work 任务已完成' : 'Work task completed'),
        body: zh ? '点击查看任务结果。' : 'Click to view the result.',
        icon, silent: false
      })
      const current = notification
      active.get(value.sessionId)?.close()
      active.set(value.sessionId, current)
      const retire = (): void => {
        if (active.get(value.sessionId) === current) active.delete(value.sessionId)
      }
      current.on('show', () => audit('shown', facts))
      current.on('failed', (_event, error) => {
        retire()
        audit('failed', { ...facts, error: failureMessage(error) })
      })
      current.on('click', () => {
        const mainWindow = getMainWindow()
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
          if (process.platform === 'darwin') app.focus({ steal: true })
          mainWindow.webContents.send(WORK_NOTIFICATION_CLICKED, value.sessionId)
        }
        audit('clicked', facts)
        retire()
      })
      current.on('close', retire)
      audit('requested', facts)
      current.show()
      return 'requested'
    } catch (error) {
      if (active.get(value.sessionId) === notification) active.delete(value.sessionId)
      audit('failed', { ...facts, error: failureMessage(error) })
      return 'failed'
    }
  }
  ipcMain.removeHandler(WORK_COMPLETED)
  ipcMain.handle(WORK_COMPLETED, handleCompleted)
  return () => {
    ipcMain.removeHandler(WORK_COMPLETED)
    for (const notification of active.values()) notification.close()
    active.clear()
    consumed.clear()
  }
}
