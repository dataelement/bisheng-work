/** Narrow, host-owned MCP transport. Platform credentials never leave the host. */
import { createEnterpriseFetch, type EnterpriseFetch } from './platform-fetch'
import { resolveEnterpriseEndpoint } from './enterprise-request'
import type { EnterpriseWebSession } from './web-session'

const METHODS = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read'])
const MAX_RESPONSE = 24 * 1024 * 1024

export interface WorkMcpRequest {
  connectionKey: string
  message: Record<string, unknown> & { jsonrpc: '2.0', method: string }
  protocolVersion?: string
}

export function parseWorkMcpRequest(value: unknown): WorkMcpRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Work MCP request.')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['connectionKey', 'message', 'protocolVersion'].includes(key)) ||
      typeof row.connectionKey !== 'string' || !row.connectionKey || row.connectionKey.length > 512 ||
      !row.message || typeof row.message !== 'object' || Array.isArray(row.message)) throw new Error('Invalid Work MCP request.')
  const message = row.message as Record<string, unknown>
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !METHODS.has(message.method) ||
      Object.keys(message).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key)) ||
      (message.id !== undefined && typeof message.id !== 'string' && !Number.isSafeInteger(message.id))) throw new Error('Unsupported MCP message.')
  if (Buffer.byteLength(JSON.stringify(message)) > 256 * 1024) throw new Error('MCP request exceeds the allowed size.')
  if (row.protocolVersion !== undefined && (typeof row.protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.protocolVersion))) throw new Error('Invalid MCP protocol version.')
  return { connectionKey: row.connectionKey, message: { ...message, jsonrpc: '2.0', method: message.method },
    ...(typeof row.protocolVersion === 'string' ? { protocolVersion: row.protocolVersion } : {}) }
}

export async function sendWorkMcp(options: {
  request: WorkMcpRequest
  credential: EnterpriseWebSession
  assertCurrent(): void
  fetchImpl: EnterpriseFetch
  allowInsecureLoopback: boolean
  allowInsecurePrivateHttp?: boolean
  signal?: AbortSignal
}): Promise<unknown> {
  const { request, credential, assertCurrent } = options
  const { endpoint } = await resolveEnterpriseEndpoint(credential.base, '/api/v1/dsh/work/mcp',
    options.allowInsecureLoopback, options.allowInsecurePrivateHttp)
  assertCurrent()
  const timeout = AbortSignal.timeout(65_000)
  const response = await createEnterpriseFetch(options.fetchImpl)(endpoint.toString(), {
    method: 'POST', signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    headers: { cookie: `${credential.cookieName}=${credential.cookie}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', ...(request.protocolVersion ? { 'mcp-protocol-version': request.protocolVersion } : {}) },
    body: JSON.stringify(request.message)
  })
  assertCurrent()
  if (!response.ok) {
    await response.body?.cancel()
    throw Object.assign(new Error(`Enterprise MCP request failed (${response.status}).`), { status: response.status })
  }
  if (response.status === 202 || response.status === 204) return null
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel()
    throw new Error('Enterprise MCP requires a JSON response.')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Enterprise MCP returned an empty response.')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      assertCurrent()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE) throw new Error('Enterprise MCP response exceeds the allowed size.')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  assertCurrent()
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
