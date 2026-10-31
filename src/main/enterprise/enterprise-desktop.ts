import type { EnterpriseWebSession } from './web-session'
import { join } from 'node:path'
import { parseThirdPartyPolicy } from 'dsh-desktop-enterprise/contract'
import { sweepWorkbenchVerifyDirectory } from './workbench-artifact'
import {
  startEnterpriseCredentialBroker,
  type EnterpriseCredentialBroker
} from './credential-broker'
import { EnterpriseService, type EnterprisePublicState } from './enterprise-service'
import type { EnterpriseFetch } from './platform-fetch'
import {
  ENTERPRISE_VAULT_FILENAME,
  type SafeStorageCryptoAdapter,
  SecureEnterpriseCredentialVault
} from './secure-credential-vault'

export interface EnterpriseDesktopRuntime {
  snapshot(): EnterprisePublicState
  webSession(connectionKey: string): Promise<EnterpriseWebSession>
  subscribe(listener: (state: EnterprisePublicState) => void): () => void
  readThirdPartyPolicy(): Promise<{ allowThirdPartyPlugins: boolean, allowThirdPartyWorkbenches: boolean }>
  harnessEnvironment(): NodeJS.ProcessEnv
  rotateCapability(): void
  stop(): Promise<void>
}

export async function startEnterpriseDesktop(options: {
  desktopVersion?: string
  activateDesktop?: () => Promise<void> | void
  userDataPath: string
  safeStorage: SafeStorageCryptoAdapter
  fetchImpl: EnterpriseFetch
  allowInsecureLoopback: boolean
  note?: (line: string) => void
}): Promise<EnterpriseDesktopRuntime> {
  await sweepWorkbenchVerifyDirectory().catch(() => undefined)
  const vault = new SecureEnterpriseCredentialVault(
    join(options.userDataPath, ENTERPRISE_VAULT_FILENAME),
    options.safeStorage
  )
  const listeners = new Set<(state: EnterprisePublicState) => void>()
  const service = new EnterpriseService({
    onStateChange: (state) => {
      for (const listener of listeners) {
        try { listener(state) }
        catch { options.note?.('[enterprise] state_listener_failed') }
      }
    },
    desktopVersion: options.desktopVersion,
    activateDesktop: options.activateDesktop,
    vault,
    fetchImpl: options.fetchImpl,
    allowInsecureLoopback: options.allowInsecureLoopback,
    note: (entry) => {
      const parts = [`[enterprise] ${entry.event}`]
      if (entry.status) parts.push(`status=${entry.status}`)
      if (entry.requestId) parts.push(`requestId=${entry.requestId}`)
      if (entry.originHash) parts.push(`origin=${entry.originHash}`)
      if (entry.pluginId) parts.push(`plugin=${JSON.stringify(entry.pluginId)}`)
      if (entry.path) parts.push(`path=${JSON.stringify(entry.path)}`)
      if (entry.duration !== undefined) parts.push(`durationMs=${entry.duration}`)
      options.note?.(parts.join(' '))
    }
  })
  await service.restore()

  let broker: EnterpriseCredentialBroker | undefined
  try {
    broker = await startEnterpriseCredentialBroker(service, {
      allowInsecureLoopback: options.allowInsecureLoopback
    })
  } catch {
    options.note?.('[enterprise] broker_start_failed')
  }

  return {
    snapshot: () => service.snapshot(),
    webSession: (key) => service.webSession(key),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async readThirdPartyPolicy() {
      const closed = { allowThirdPartyPlugins: false, allowThirdPartyWorkbenches: false }
      const state = service.snapshot()
      if (!state.connected || !state.connectionKey) return closed
      try {
        const result = await service.marketRequest({
          path: '/api/v1/dsh/market/capabilities',
          connectionKey: state.connectionKey
        })
        const envelope = JSON.parse(result.bytes.toString('utf8')) as { status_code?: unknown, data?: unknown }
        return parseThirdPartyPolicy(envelope?.status_code === 200 ? envelope.data : undefined)
      } catch {
        return closed
      }
    },
    harnessEnvironment: () => broker?.environment() ?? {},
    rotateCapability() {
      broker?.rotateCapability()
    },
    async stop() {
      await broker?.stop()
      await service.stop()
    }
  }
}
