import { z } from 'zod'

export const COMPLETION_KEY = 'desktopWorkCompletion'
const completionSchema = z.object({ count: z.number().int().nonnegative(), turn: z.number().int().nonnegative(), seq: z.number().int(), time: z.number().int().nonnegative() }).strict()
const stateSchema = z.object({
  eligible: z.boolean(), inherited: z.number().int().nonnegative(),
  activeTurn: z.number().int().nullable(), enteredStep: z.boolean(), completion: completionSchema
}).strict()

/** Host-owned successful-turn facts. The standard authenticated projection stream carries them. */
export const completionProjection = {
  key: COMPLETION_KEY,
  stateVersion: 1,
  stateSchema,
  init: (header, inherited) => ({
    eligible: header.origin !== 'subagent', inherited, activeTurn: null, enteredStep: false,
    completion: { count: 0, turn: 0, seq: -1, time: 0 }
  }),
  apply(state, event) {
    if (!state.eligible || event.seq < state.inherited) return state
    if (event.type === 'turn/start') return { ...state, activeTurn: event.data.turn, enteredStep: false }
    if (event.type === 'step/start' && event.data.turn === state.activeTurn) return { ...state, enteredStep: true }
    if (event.type !== 'turn/end' || event.data.turn !== state.activeTurn) return state
    const completion = state.enteredStep && event.data.reason.kind === 'completed'
      ? { count: state.completion.count + 1, turn: event.data.turn, seq: event.seq, time: event.time }
      : state.completion
    return { ...state, activeTurn: null, enteredStep: false, completion }
  },
  wire: { viewSchema: completionSchema, view: state => state.completion }
}
