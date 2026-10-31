import { describe, expect, it, vi } from 'vitest'
import { CONTENT_SAFETY_ERROR_COPY } from '../packages/dsh-desktop-enterprise/error-copy.js'

// Coverage AC: AC-03, AC-30, AC-31, AC-56.
// Event delivery is a port double only. The missing production helper owns all
// pending/active state; this test never supplies that behavior itself.
const code = 'CONTENT_FILTERED'
const fixed = language => Object.freeze(Object.fromEntries(Object.entries(CONTENT_SAFETY_ERROR_COPY).map(([key, values]) => [key, values[language]])))
const agent = id => Object.freeze({ id })
const message = (id, text = 'Synthetic queued request') => Object.freeze({
  id, role: 'user', source: Object.freeze({ kind: 'user', rpcId: 'synthetic-rpc-' + id }),
  content: Object.freeze([Object.freeze({ type: 'text', text })])
})
const session = owner => ({ id: owner.id, header: { id: owner.id } })

async function setup() {
  const { createContentSafetyLocaleScope } = await import('../packages/dsh-desktop-enterprise/content-safety-locale.js')
  const listeners = new Map()
  const ctx = { on: vi.fn((event, listener) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(listener)
    return () => listeners.get(event).delete(listener)
  }) }
  let current
  const requestLocale = vi.fn(() => current)
  const scope = createContentSafetyLocaleScope(ctx, requestLocale)
  return {
    scope, ctx, requestLocale,
    select(language) { current = language ? fixed(language) : undefined },
    emit(event, ...args) { for (const listener of listeners.get(event) ?? []) listener(...args) },
    listenerCount() { return [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0) },
    formatter(sessionId, purpose = 'chat') { return scope.formatterFor({ sessionId, purpose }) }
  }
}

function insert(port, owner, item) { port.emit('agent/inbox/inserted', { agent: owner, message: item }) }
function claim(port, owner, item, turn = 1) { port.emit('agent/inbox/claimed', { agent: owner, message: item, turn }) }
function turnEnd(port, owner, turn) { port.emit('session/event', session(owner), { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }) }

describe('Host content-safety locale public-event scope', () => {
  it('keeps future inserted requests pending and freezes each formatter at its claimed turn', async () => {
    const port = await setup(), owner = agent('session-a'), first = message('first'), queued = message('queued')
    port.select('zh'); insert(port, owner, first); claim(port, owner, first)
    const firstFormatter = port.formatter(owner.id)
    port.select('ja'); insert(port, owner, queued)
    expect(port.formatter(owner.id)(code, 'fallback')).toBe(fixed('zh')[code])
    claim(port, owner, queued, 2)
    expect(port.formatter(owner.id)(code, 'fallback')).toBe(fixed('ja')[code])
    expect(firstFormatter(code, 'fallback')).toBe(fixed('zh')[code])
    port.scope.dispose()
  })

  it('keeps a claimed missing display selection instead of reviving the older driver context', async () => {
    const port = await setup(), owner = agent('session-a'), queued = message('without-locale')
    port.select(undefined); insert(port, owner, queued)
    // The driver may still carry the first request's ALS while claiming a later request.
    port.select('zh'); claim(port, owner, queued, 2)
    expect(port.formatter(owner.id)).toBeUndefined()
    port.scope.dispose()
  })

  it('associates stable Message.id inside its session even if an event projection supplies a different object', async () => {
    const port = await setup(), owner = agent('session-a'), accepted = message('stable-message')
    port.select('ja'); insert(port, owner, accepted)
    port.select('en'); claim(port, owner, structuredClone(accepted))
    expect(port.formatter(owner.id)(code, 'fallback')).toBe(fixed('ja')[code])
    port.scope.dispose()
  })

  it('isolates concurrent sessions even for equal message ids', async () => {
    const port = await setup(), left = agent('left-session'), right = agent('right-session')
    port.select('zh'); insert(port, left, message('shared-id'))
    port.select('ja'); insert(port, right, message('shared-id'))
    claim(port, right, message('shared-id')); claim(port, left, message('shared-id'))
    expect(port.formatter(left.id)(code, 'fallback')).toBe(fixed('zh')[code])
    expect(port.formatter(right.id)(code, 'fallback')).toBe(fixed('ja')[code])
    port.scope.dispose()
  })

  it('discarding and replacing a queued message cannot resurrect its previous display context', async () => {
    const port = await setup(), owner = agent('session-a'), original = message('edited-id')
    port.select('ja'); insert(port, owner, original)
    port.emit('agent/inbox/discarded', { agent: owner, message: original })
    port.select(undefined)
    const replacement = message('edited-id', 'Synthetic replacement without a request display context')
    insert(port, owner, replacement); claim(port, owner, replacement)
    expect(port.formatter(owner.id)).toBeUndefined()
    port.scope.dispose()
  })

  it('only the matching turn end clears the current active selection while pending requests survive', async () => {
    const port = await setup(), owner = agent('session-a'), first = message('first'), second = message('second')
    port.select('zh'); insert(port, owner, first); claim(port, owner, first, 1)
    port.select('ja'); insert(port, owner, second)
    const firstFormatter = port.formatter(owner.id)
    turnEnd(port, owner, 1)
    port.select('en')
    expect(port.formatter(owner.id)(code, 'fallback')).toBe(fixed('en')[code])
    claim(port, owner, second, 2)
    turnEnd(port, owner, 1)
    expect(port.formatter(owner.id)(code, 'fallback')).toBe(fixed('ja')[code])
    expect(firstFormatter(code, 'fallback')).toBe(fixed('zh')[code])
    port.scope.dispose()
  })

  it.each(['agent/disposed', 'session/disposed'])('%s clears active and pending metadata before a session id is reused', async event => {
    const port = await setup(), owner = agent('reused-session'), active = message('active'), pending = message('pending')
    port.select('zh'); insert(port, owner, active); claim(port, owner, active)
    port.select('ja'); insert(port, owner, pending)
    if (event === 'agent/disposed') port.emit(event, { agent: owner })
    else port.emit(event, session(owner))
    port.select(undefined)
    const resumed = agent(owner.id)
    claim(port, resumed, message('pending'), 2)
    expect(port.formatter(resumed.id)).toBeUndefined()
    port.scope.dispose()
  })

  it('uses the original request context for direct calls without session identity and freezes it', async () => {
    const port = await setup()
    port.select('zh')
    const formatter = port.formatter(undefined)
    port.select('ja')
    expect(formatter(code, 'fallback')).toBe(fixed('zh')[code])
    expect(port.formatter(undefined)(code, 'fallback')).toBe(fixed('ja')[code])
    port.scope.dispose()
  })

  it.each(['session-title', 'compaction'])('%s captures its own request context independently of current and queued chat turns', async purpose => {
    const port = await setup(), owner = agent('session-a'), first = message('first'), queued = message('queued')
    port.select('zh'); insert(port, owner, first); claim(port, owner, first)
    port.select('en')
    const auxiliary = port.formatter(owner.id, purpose)
    port.select('ja'); insert(port, owner, queued); claim(port, owner, queued, 2)
    expect(auxiliary(code, 'fallback')).toBe(fixed('en')[code])
    expect(port.formatter(owner.id)(code, 'fallback')).toBe(fixed('ja')[code])
    port.scope.dispose()
  })

  it('returns no formatter when neither a claimed context nor the request has display metadata', async () => {
    const port = await setup()
    expect(port.formatter(undefined)).toBeUndefined()
    expect(port.formatter('unknown-session')).toBeUndefined()
    port.scope.dispose()
  })

  it('uses fallback text for codes outside the two fixed safety messages without changing a user message', async () => {
    const port = await setup(), owner = agent('session-a'), accepted = message('first')
    const original = JSON.stringify(accepted)
    port.select('zh'); insert(port, owner, accepted); claim(port, owner, accepted)
    const formatter = port.formatter(owner.id)
    expect(formatter('ACCOUNT_SIGNED_OUT', 'Original account message')).toBe('Original account message')
    expect(formatter('UNKNOWN', 'Original unknown message')).toBe('Original unknown message')
    expect(JSON.stringify(accepted)).toBe(original)
    expect(JSON.stringify(accepted)).not.toContain('CONTENT_FILTERED')
    port.scope.dispose()
  })

  it('unloads idempotently, removes every listener and leaves already captured formatters stable', async () => {
    const port = await setup(), owner = agent('session-a'), accepted = message('first')
    port.select('zh'); insert(port, owner, accepted); claim(port, owner, accepted)
    const formatter = port.formatter(owner.id)
    expect(port.listenerCount()).toBeGreaterThan(0)
    port.scope.dispose(); port.scope.dispose()
    expect(port.listenerCount()).toBe(0)
    port.select('ja')
    insert(port, owner, message('after-unload')); claim(port, owner, message('after-unload'), 2)
    expect(formatter(code, 'fallback')).toBe(fixed('zh')[code])
  })
})
