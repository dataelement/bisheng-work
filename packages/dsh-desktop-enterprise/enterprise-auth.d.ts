import type { Context } from '@deepseek-ai/cordis'

export interface EnterpriseAuthState {
  connected: boolean
  enterpriseId?: string
  userId?: string
  sessionVersion: string
}
export interface EnterpriseAuthRequestInit {
  method?: string
  headers?: HeadersInit
  body?: string | ArrayBuffer | ArrayBufferView
  signal?: AbortSignal
}
export interface EnterpriseAuth {
  /** Synchronous cached public state; refreshed in the background while the instance lives. */
  getState(): EnterpriseAuthState
  /** Business HTTP failures remain Responses; infrastructure failures throw EnterpriseAuthError. */
  request(path: string, init?: EnterpriseAuthRequestInit): Promise<Response>
}
export type EnterpriseAuthErrorCode = 'authorization_denied' | 'invalid_request' | 'session_changed' | 'not_connected' | 'too_many_requests' | 'request_aborted' | 'request_timeout' | 'request_failed' | 'response_too_large' | 'request_too_large' | 'redirect_rejected'
export declare class EnterpriseAuthError extends Error {
  readonly errorCode: EnterpriseAuthErrorCode
  readonly status: number
  constructor(errorCode: EnterpriseAuthErrorCode, message: string, status?: number)
}
export interface EnterpriseAuthTransport {
  state(signal?: AbortSignal): Promise<EnterpriseAuthState>
  request(path: string, init?: EnterpriseAuthRequestInit & { sessionVersion?: string }): Promise<Response>
}
export interface EnterpriseAuthHost {
  grant(identity: { pluginId: string; instanceId: string }): Promise<EnterpriseAuthTransport>
  revoke(transport: EnterpriseAuthTransport): Promise<void>
}
export declare function applyEnterpriseAuth(ctx: Context): void
/** Host-only observer: latest request completion, after full body consumption; cancellation is ignored. */
export declare function bindEnterpriseAuth(ctx: Context, transport: EnterpriseAuthTransport, onRequestSettled?: (error?: unknown) => void): Promise<() => void>
export declare function createEnterpriseAuthTransport(origin: string, capability: string): EnterpriseAuthTransport

export declare function inheritEnterpriseAuth(target: Context, source: Context): void
