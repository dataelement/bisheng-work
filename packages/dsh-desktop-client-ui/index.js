import { completionProjection } from './completion-projection.js'

/** Desktop completion facts share Harness's authenticated, reconnecting control stream. */
export const inject = ['sessionProjections']
export function apply(ctx) {
  ctx.sessionProjections.register(completionProjection)
}
