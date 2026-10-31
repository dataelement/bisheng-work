export const WORK_COMPLETED = 'desktop:work-completed'
export const WORK_NOTIFICATION_CLICKED = 'desktop:work-notification-clicked'
export const NOTIFICATION_BRIDGE = 'dshDesktopNotifications'

export interface WorkCompletion {
  sessionId: string
  turn: number
  seq: number
  count: number
}
export type NotificationReceipt = 'requested' | 'foreground' | 'duplicate' | 'unsupported' | 'failed'
export interface DesktopNotificationBridge {
  completed(value: WorkCompletion): Promise<NotificationReceipt>
  onClicked(listener: (sessionId: string) => void): () => void
}

export function parseWorkCompletion(value: unknown): WorkCompletion {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid Work completion.')
  const v = value as Partial<WorkCompletion>
  if (typeof v.sessionId !== 'string' || !/^[\w.:-]{1,200}$/.test(v.sessionId) ||
      !Number.isSafeInteger(v.turn) || (v.turn ?? 0) < 1 ||
      !Number.isSafeInteger(v.seq) || (v.seq ?? -1) < 0 ||
      !Number.isSafeInteger(v.count) || (v.count ?? 0) < 1) throw new TypeError('Invalid Work completion.')
  return { sessionId: v.sessionId, turn: v.turn as number, seq: v.seq as number, count: v.count as number }
}
