import type { PluginManager, ProfileManagedBundleSource, ChangeResult } from '@deepseek-ai/dsh-plugin-manager'
import type { MarketController, MarketState } from './market.js'
type MarketAction = Parameters<MarketController['act']>[0]
export interface ManagedMarketSource extends ProfileManagedBundleSource {
  prepare(input: MarketAction): { target: string; ticket: string; release(): void }
}
export function createManagedMarketSource(market: MarketController): ManagedMarketSource
export function requireManagedSuccess(result: ChangeResult): ChangeResult
export function performMarketAction(manager: PluginManager, source: ManagedMarketSource, market: MarketController, input: MarketAction): Promise<MarketState & { result?: ChangeResult }>
