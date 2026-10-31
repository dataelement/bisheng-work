import type { Context } from '@deepseek-ai/cordis'
import type { MarketRuntimeFiber } from './market-runtime.js'
import type { EnterpriseAuthHost } from './enterprise-auth.js'
export interface InstalledMarketPlugin {
  name: string; version: string; digest: string; directory: string; generation_id: string; plugin_id: string;
  version_id: string; revision: number; enabled: boolean; status: string; display_name: string; error?: string; config?: Record<string, unknown>; description?: string; integrity?: string
}
export interface MarketAccount {
  connected: boolean; desktopVersion?: string; base?: string; user?: { id: string }; tenant?: { id: string; name?: string }; sessionExpiresAt?: string
}
export interface MarketState extends MarketAccount { configured: boolean; target: string; desktopVersion: string; accountKey: string | null; connected: boolean; online: boolean; installed: Omit<InstalledMarketPlugin, 'directory' | 'config'>[]; error?: string; failureCode?: string }
export interface MarketController {
  state(): MarketState
  synchronize(): Promise<void>
  catalog(query?: string, page?: number): Promise<MarketState & { data: unknown[]; total: number; installReady?: boolean }>
  act(input: { action: string; plugin_id: string; expectedAccountKey?: string; version_id?: string; config?: Record<string, unknown> }): Promise<MarketState>
  stop(): Promise<void>
  tick(): Promise<void>
}
export declare function hostDshEntryPath(): string

export declare function createMarketController(ctx: Context, account: {
  state(): MarketAccount
  marketRequest(path: string, body?: unknown, binary?: boolean): Promise<unknown>
}, options?: { home?: string; target?: string; desktopVersion?: string; dshEntryPath?: string;
  auth?: EnterpriseAuthHost; load?: (record: InstalledMarketPlugin) => Promise<MarketRuntimeFiber> }): MarketController

export declare function applyEnterpriseMarket(ctx: Context, account: {
  state(): MarketAccount
  refreshState?(): Promise<unknown>
  refreshProfile?(): Promise<unknown>
  marketRequest(path: string, body?: unknown, binary?: boolean): Promise<unknown>
}, options?: { auth?: EnterpriseAuthHost }): MarketController

export declare function isMarketVersionCompatible(version: string, minimum: string): boolean
