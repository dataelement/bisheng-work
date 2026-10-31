import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

export interface DesktopWorkCompletion {
  /** Monotone count of successful, model-entered turns in this session's own log. */
  count: number
  turn: number
  seq: number
  time: number
}
export interface DesktopWorkCompletionState {
  eligible: boolean
  inherited: number
  activeTurn: number | null
  enteredStep: boolean
  completion: DesktopWorkCompletion
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { desktopWorkCompletion: DesktopWorkCompletion }
  interface SessionProjectionStateMap { desktopWorkCompletion: DesktopWorkCompletionState }
}
export const COMPLETION_KEY: 'desktopWorkCompletion'
export const completionProjection: ProjectionDefinition<'desktopWorkCompletion'>
