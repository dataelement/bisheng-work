import { expect, it, vi } from 'vitest'
import { parseWorkMcpRequest, sendWorkMcp } from '../src/main/enterprise/work-mcp'

const input = { connectionKey: 'account', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }

it('admits only bounded MCP messages and rejects arbitrary host operations', () => {
  expect(parseWorkMcpRequest(input).message.method).toBe('tools/list')
  for (const value of [{ ...input, url: 'https://other.test' }, { ...input, message: { ...input.message, method: 'exec' } },
    { ...input, protocolVersion: 'x\r\nX-Key: value' }, { ...input, message: { ...input.message, params: 'x'.repeat(300000) } }]) {
    expect(() => parseWorkMcpRequest(value)).toThrow()
  }
})

it('keeps credentials in host headers, fixes the endpoint and drops stale responses', async () => {
  let current = true
  const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } }))
  const options = { request: parseWorkMcpRequest(input), credential: { base: 'http://127.0.0.1:9999', cookie: 'private-cookie', cookieName: 'access_token_cookie', expiresAt: Date.now() + 300000, connectionKey: 'account' },
    assertCurrent: () => { if (!current) throw new Error('changed') }, allowInsecureLoopback: true, fetchImpl }
  expect(await sendWorkMcp(options)).toMatchObject({ result: { tools: [] } })
  expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9999/api/v1/dsh/work/mcp')
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit
  expect(init.headers).toMatchObject({ cookie: 'access_token_cookie=private-cookie' })
  expect(init.body).not.toContain('private-cookie')
  fetchImpl.mockImplementation(async () => { current = false; return Response.json({ result: 'stale' }) })
  await expect(sendWorkMcp(options)).rejects.toThrow('changed')
})

it('preserves HTTP failure and rejects redirect and oversized results', async () => {
  const options = { request: parseWorkMcpRequest(input), credential: { base: 'http://127.0.0.1:9999', cookie: 'private', cookieName: 'access_token_cookie', expiresAt: 1, connectionKey: 'account' },
    assertCurrent() {}, allowInsecureLoopback: true }
  await expect(sendWorkMcp({ ...options, fetchImpl: async () => new Response('private error', { status: 403 }) })).rejects.toThrow('(403)')
  await expect(sendWorkMcp({ ...options, fetchImpl: async () => new Response('x'.repeat(25 * 1024 * 1024), { headers: { 'content-type': 'application/json' } }) })).rejects.toThrow('size')
})


it('uses the authenticated platform cookie name for isolated preview environments', async () => {
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ jsonrpc: '2.0', id: 1, result: {} }))
  await sendWorkMcp({ request: parseWorkMcpRequest(input),
    credential: { base: 'http://127.0.0.1:3007', cookie: 'host-owned-cookie', cookieName: 'bs_credits_3007', expiresAt: 1, connectionKey: 'account' },
    assertCurrent() {}, fetchImpl, allowInsecureLoopback: true })
  expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('cookie')).toBe('bs_credits_3007=host-owned-cookie')
})
