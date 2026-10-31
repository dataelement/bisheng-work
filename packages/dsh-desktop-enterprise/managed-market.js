import { randomUUID } from 'node:crypto'

const PREFIX = 'enterprise:'
const TARGET = /^enterprise:([a-f0-9]{64}):([a-f0-9]{32})$/u

/**
 * An account-scoped source for the host Plugin Manager. Ordinary Profile
 * composition must never persist these bundles: authorization is checked on
 * every activation, including restoration after reconnecting.
 */
export function createManagedMarketSource(market) {
  const pending = new Map()
  const targetFor = (id) => {
    const key = market.state().accountKey
    if (!key || !/^[a-f0-9]{32}$/u.test(id)) throw new Error('Sign in and select an enterprise plugin.')
    return `${PREFIX}${key}:${id}`
  }
  return {
    accepts: target => typeof target === 'string' && target.startsWith(PREFIX),
    listBundles() {
      const state = market.state()
      return state.installed.map(record => ({
        name: `${PREFIX}${state.accountKey}:${record.plugin_id}`,
        description: `${record.display_name || record.name} (${record.name})`,
        version: record.version, official: false, availability: 'profile',
        installed: true, enabled: record.status === 'enabled', optional: false,
        removable: true, rows: [], overrides: [],
        ...(record.error ? { error: { code: 'operation-error', diagnostic: record.error } } : {})
      }))
    },
    prepare(input) {
      const target = targetFor(input.plugin_id)
      const ticket = `${target}:${randomUUID()}`
      pending.set(ticket, { ...input, expectedAccountKey: market.state().accountKey })
      return { target, ticket, release: () => pending.delete(ticket) }
    },
    async change(request) {
      let input
      if (request.action === 'install') {
        if (request.enabled === false) throw new Error('Enterprise installs require authorized activation.')
        input = pending.get(request.target)
        pending.delete(request.target)
        if (!input) throw new Error('Enterprise installation is no longer authorized. Refresh the market.')
      } else {
        const match = TARGET.exec(request.target)
        if (!match || !['enable', 'disable', 'uninstall'].includes(request.action)) throw new Error('Invalid enterprise plugin operation.')
        input = { action: request.action, plugin_id: match[2], expectedAccountKey: match[1] }
      }
      if (input.expectedAccountKey !== market.state().accountKey) throw new Error('Enterprise account changed.')
      const before = market.state()
      const after = await market.act(input)
      const record = after.installed.find(item => item.plugin_id === input.plugin_id)
      return {
        target: `${PREFIX}${after.accountKey}:${input.plugin_id}`,
        bundle: `${PREFIX}${after.accountKey}:${input.plugin_id}`,
        ...(record ? { version: record.version, enabled: record.status === 'enabled' } : {}),
        stage: input.action === 'uninstall' ? 'remove' : 'enable',
        application: 'applied', changed: JSON.stringify(before.installed) !== JSON.stringify(after.installed), warnings: []
      }
    }
  }
}

/** Preserve the Manager outcome, including failures and restart requirements. */
export function requireManagedSuccess(result) {
  if (!result || !['applied', 'restart-required'].includes(result.application)) {
    throw new Error(result?.error?.diagnostic || result?.error?.message || result?.error?.code || 'Plugin Manager did not apply the operation.')
  }
  return result
}

export async function performMarketAction(manager, source, market, input) {
  if (!manager) throw new Error('Plugin Manager is unavailable.')
  // Configuration belongs to the enterprise instance, not the shared Profile.
  if (input.action === 'configure') return market.act(input)
  if (!['install', 'enable', 'disable', 'uninstall'].includes(input.action)) throw new Error('Unknown plugin operation.')
  const prepared = source.prepare(input)
  try {
    const result = input.action === 'install'
      ? await manager.installBundle(prepared.ticket)
      : input.action === 'uninstall'
        ? await manager.removeBundle(prepared.target)
        : await manager.setBundleEnabled(prepared.target, input.action === 'enable')
    requireManagedSuccess(result)
    return { ...market.state(), result }
  } finally { prepared.release() }
}
