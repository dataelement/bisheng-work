import { describe, it, expect, vi } from 'vitest'
import { applyWorkResources, createWorkResourceSelections } from '../packages/dsh-desktop-enterprise/work-resources.js'
import { parseWorkResourceRequest, readResourceJson } from '../src/main/enterprise/work-resources'

function setup() {
  let account = { connected: true, connectionKey: 'a' }
  const sessions = new Map([['one', { id: 'one', header: {} }], ['two', { id: 'two', header: {} }]])
  const spaces = [{ id: 7, name: 'Policies' }, { id: 9, name: 'Reports' }]
  const request = vi.fn(async body => body.operation === 'list' ? { spaces } : { chunks: [{ space_id: body.spaceIds[0], content: 'Answer', document_name: 'Policy.pdf' }] })
  return { api: createWorkResourceSelections({ sessionFor: id => sessions.get(id), request, state: () => account }), request, sessions, setAccount: value => { account = value } }
}
describe('Work task knowledge scope', () => {
  it('retrieves exactly the selected IDs and keeps two tasks independent', async () => {
    const { api, request } = setup()
    await api.select('one', [7, 7]); await api.select('two', [9])
    await api.retrieve('one', 'leave policy')
    expect(request).toHaveBeenLastCalledWith({ operation: 'retrieve', connectionKey: 'a', spaceIds: [7], query: 'leave policy' }, undefined)
    expect(api.get('two').map(row => row.id)).toEqual([9])
    await api.select('one', [])
    await expect(api.retrieve('one', 'query')).rejects.toThrow('Select knowledge spaces')
  })
  it('refuses unavailable resources and delegated sessions', async () => {
    const { api, sessions } = setup()
    await expect(api.select('one', [100])).rejects.toThrow('unavailable')
    sessions.set('child', { header: { delegationDepth: 1 } })
    await expect(api.select('child', [7])).rejects.toThrow('main Work task')
    await expect(api.select('missing', [7])).rejects.toThrow('active')
  })
  it('invalidates selections on account changes, logout, or session recreation', async () => {
    const { api, setAccount, sessions } = setup()
    await api.select('one', [7])
    setAccount({ connected: true, connectionKey: 'b' })
    await expect(api.retrieve('one', 'q')).rejects.toThrow('Select knowledge spaces')
    await api.select('one', [9]); setAccount({ connected: false, connectionKey: 'b' })
    expect(api.get('one')).toEqual([])
    setAccount({ connected: true, connectionKey: 'b' }); sessions.set('one', { header: {} })
    expect(api.get('one')).toEqual([])
  })
  it('discards an in-flight retrieval after logout and blocks scope edits during a search', async () => {
    const { api, request, setAccount } = setup()
    await api.select('one', [7])
    let resolve
    request.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = api.retrieve('one', 'q')
    await expect(api.select('one', [9])).rejects.toThrow('Wait')
    setAccount({ connected: false }); resolve({ chunks: [] })
    await expect(pending).rejects.toThrow('identity changed')
  })
  it('propagates permission and cancellation failures without returning content', async () => {
    const { api, request } = setup()
    await api.select('one', [7])
    request.mockRejectedValueOnce(new Error('Forbidden'))
    await expect(api.retrieve('one', 'q')).rejects.toThrow('Forbidden')
    const controller = new AbortController(); controller.abort()
    await expect(api.retrieve('one', 'q', controller.signal)).rejects.toThrow()
  })
})
describe('credential broker fixed resource operations', () => {
  it('rejects arbitrary destinations, extra fields and malformed scope IDs', () => {
    for (const value of [null, { operation: 'list', connectionKey: 'a', url: 'https://other.test' }, { operation: 'retrieve', connectionKey: 'a', query: 'q', spaceIds: [] }, { operation: 'retrieve', connectionKey: 'a', query: 'q', spaceIds: ['7'] }]) expect(() => parseWorkResourceRequest(value)).toThrow()
    expect(parseWorkResourceRequest({ operation: 'retrieve', connectionKey: 'a', query: ' q ', spaceIds: [7, 7] })).toMatchObject({ query: 'q', spaceIds: [7] })
  })
  it('accepts only successful bounded platform envelopes', async () => {
    expect(await readResourceJson(Response.json({ status_code: 200, data: { spaces: [] } }))).toEqual({ spaces: [] })
    await expect(readResourceJson(Response.json({ status_code: 18001, data: null }))).rejects.toThrow('complete')
    await expect(readResourceJson(new Response('private details', { status: 403 }))).rejects.toThrow('(403)')
    await expect(readResourceJson(new Response('x'.repeat(2 * 1024 * 1024 + 1)))).rejects.toThrow('size')
  })
})

it('registers the real tool schema and limits prompt context to the selected main task', async () => {
  let route, tool, context
  const sessions = new Map([['one', { id: 'one', header: {} }], ['child', { id: 'child', header: { delegationDepth: 1 } }]])
  const api = applyWorkResources({
    sessions: { get: id => sessions.get(id) }, on() {}, effect() {},
    connection: { fetch: { register: value => { route = value } } },
    tools: { register: value => { tool = value } },
    systemPrompt: { context: value => { context = value } }
  }, {
    state: () => ({ connected: true, connectionKey: 'a' }), refreshState: async () => {},
    request: async body => body.operation === 'list' ? { spaces: [{ id: 7, name: 'Policies' }] } : { chunks: [] }
  })
  expect(tool.name).toBe('bisheng_knowledge_search')
  await api.select('one', [7])
  expect(context.text({ scope: { session: sessions.get('one') } })).toContain('Policies')
  expect(context.text({ scope: { session: sessions.get('child') } })).toBe('')
  const response = await route.fetch(new Request('http://localhost/api/enterprise.work-resources', { method: 'POST', body: JSON.stringify({ operation: 'get', sessionId: 'one' }) }))
  expect(await response.json()).toEqual({ spaces: [{ id: 7, name: 'Policies' }] })
  api.clear()
  expect(api.get('one')).toEqual([])
})
