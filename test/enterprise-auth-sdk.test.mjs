import { Context } from '@deepseek-ai/cordis'
import { mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMarketRuntime } from '../packages/dsh-desktop-enterprise/market-runtime.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyEnterpriseAuth, bindEnterpriseAuth, createEnterpriseAuthTransport, EnterpriseAuthError } from '../packages/dsh-desktop-enterprise/enterprise-auth.js'

const cleanup = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.unstubAllGlobals(); vi.useRealTimers() })

function fixture() {
  const ctx = new Context()
  applyEnterpriseAuth(ctx)
  cleanup.push(() => ctx.fiber.dispose())
  return ctx
}
const state = { connected: false, sessionVersion: '1' }
async function bind(ctx, value = state) {
  const transport = { state: vi.fn(async () => value), request: vi.fn(async () => new Response('ok')) }
  const dispose = await bindEnterpriseAuth(ctx, transport)
  cleanup.push(dispose)
  return { transport, dispose }
}

describe('enterpriseAuth instance SDK', () => {
  it('exists disconnected but denies unbound and forged intercept contexts', async () => {
    const ctx = fixture()
    expect(ctx.enterpriseAuth).toBeDefined()
    expect(() => ctx.enterpriseAuth.getState()).toThrow(EnterpriseAuthError)
    const forged = ctx.intercept('enterpriseAuth', { pluginId: 'authorized', instanceId: 'known' })
    await expect(forged.enterpriseAuth.request('/api/test')).rejects.toMatchObject({ errorCode: 'authorization_denied' })
    await bind(forged)
    expect(forged.enterpriseAuth.getState()).toEqual(state)
    expect(() => ctx.enterpriseAuth.getState()).toThrow(EnterpriseAuthError)
  })

  it('traces real child plugins and keeps sibling bindings independent', async () => {
    const ctx = fixture(), first = ctx.extend(), second = ctx.extend()
    const a = await bind(first), b = await bind(second, { connected: true, enterpriseId: 'e', userId: 'u', sessionVersion: '2' })
    let pluginCtx
    await first.plugin({ inject: ['enterpriseAuth'], apply(scoped) { pluginCtx = scoped } })
    expect(pluginCtx.enterpriseAuth.getState()).toEqual(state)
    const copy = second.enterpriseAuth.getState()
    copy.sessionVersion = 'forged'
    await second.enterpriseAuth.request('/api/test')
    expect(b.transport.request).toHaveBeenCalledWith('/api/test', expect.objectContaining({ sessionVersion: '2', signal: expect.any(AbortSignal) }))
    a.dispose()
    await expect(pluginCtx.enterpriseAuth.request('/api/test')).rejects.toMatchObject({ errorCode: 'authorization_denied' })
    expect(second.enterpriseAuth.getState().connected).toBe(true)
  })

  it('refreshes sync snapshots and aborts requests when revoked', async () => {
    vi.useFakeTimers()
    const ctx = fixture(), scoped = ctx.extend()
    const { transport, dispose } = await bind(scoped)
    transport.state.mockResolvedValue({ connected: true, sessionVersion: 'next' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(scoped.enterpriseAuth.getState()).toEqual({ connected: true, sessionVersion: 'next' })
    transport.request.mockImplementation((_path, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))))
    const pending = scoped.enterpriseAuth.request('/stream')
    dispose()
    await expect(pending).rejects.toMatchObject({ errorCode: 'authorization_denied' })
  })
})

describe('enterpriseAuth request recovery', () => {
  it('reports failure then success only after the response body completes', async () => {
    const ctx = fixture().extend(), settled = vi.fn()
    let stream
    const transport = { state: async () => state, request: vi.fn() }
    transport.request.mockRejectedValueOnce(new Error('request timed out'))
    transport.request.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { stream = controller } })))
    cleanup.push(await bindEnterpriseAuth(ctx, transport, settled))
    await expect(ctx.enterpriseAuth.request('/search')).rejects.toThrow('request timed out')
    expect(settled).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'request timed out' }))
    const response = await ctx.enterpriseAuth.request('/search')
    expect(settled).toHaveBeenCalledTimes(1)
    const body = response.text()
    stream.enqueue(new TextEncoder().encode('result')); stream.close()
    expect(await body).toBe('result')
    expect(settled).toHaveBeenLastCalledWith(undefined)
  })

  it('does not call success for HTTP failure, stream failure or cancellation', async () => {
    const ctx = fixture().extend(), settled = vi.fn()
    const transport = { state: async () => state, request: vi.fn() }
    cleanup.push(await bindEnterpriseAuth(ctx, transport, settled))
    transport.request.mockResolvedValueOnce(new Response('denied', { status: 403 }))
    expect((await ctx.enterpriseAuth.request('/search')).status).toBe(403)
    expect(settled).toHaveBeenLastCalledWith(expect.any(Error))
    transport.request.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) { controller.error(new Error('stream failed')) } })))
    await expect((await ctx.enterpriseAuth.request('/search')).text()).rejects.toThrow('stream failed')
    expect(settled).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'stream failed' }))
    transport.request.mockResolvedValueOnce(new Response('cancelled'))
    const response = await ctx.enterpriseAuth.request('/search')
    await response.body.cancel()
    expect(settled).toHaveBeenCalledTimes(2)
  })

  it('ignores completion from an older request or a revoked instance', async () => {
    const ctx = fixture().extend(), settled = vi.fn()
    const transport = { state: async () => state, request: vi.fn(async () => new Response('ok')) }
    const dispose = await bindEnterpriseAuth(ctx, transport, settled)
    cleanup.push(dispose)
    const old = await ctx.enterpriseAuth.request('/old')
    transport.request.mockRejectedValueOnce(new Error('new failure'))
    await expect(ctx.enterpriseAuth.request('/new')).rejects.toThrow('new failure')
    await old.text()
    expect(settled).toHaveBeenCalledTimes(1)
    const late = await ctx.enterpriseAuth.request('/late')
    dispose()
    await late.text()
    expect(settled).toHaveBeenCalledTimes(1)
  })
})

describe('enterpriseAuth market lifecycle', () => {
  it('grants host record identities independently and revokes on disposal and failed activation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enterprise-sdk-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const root = join(directory, 'node_modules', 'sdk-fixture')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }))
    await writeFile(join(root, 'index.js'), "export const inject = ['enterpriseAuth', 'probe']; export function apply(ctx, config) { ctx.probe.accept(ctx); if (config.fail) throw new Error('fixture activation failed'); ctx.effect(() => () => ctx.probe.disposed(), 'fixture cleanup') }")
    const ctx = fixture(), contexts = [], disposed = vi.fn()
    ctx.provide('probe', { accept(value) { contexts.push(value) }, disposed })
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(directory + '/').href })
    await writeFile(join(directory, 'cordis.yml'), '[]')
    await mountRootInclude(ctx, join(directory, 'cordis.yml'))
    await ctx.loader.await()
    const grant = vi.fn(async () => ({ state: async () => state, request: async () => new Response('ok') }))
    const revoke = vi.fn(async () => {})
    let load
    const settled = vi.fn()
    ctx.provide('runtimeFactory', { create(scoped) { load = createMarketRuntime(scoped, { grant, revoke }, settled) } })
    const owner = join(directory, 'owner.mjs')
    await writeFile(owner, "export const inject = ['runtimeFactory']; export function apply(ctx) { ctx.runtimeFactory.create(ctx) }")
    const ownerId = await ctx.loader.create({ name: pathToFileURL(owner).href })
    await ctx.loader.store[ownerId].fiber.await()
    const record = { directory, name: 'sdk-fixture', plugin_id: 'host-record-id', config: { pluginId: 'forged' } }
    const secondRecord = { ...record, plugin_id: 'second-host-record-id' }
    const first = await load(record), second = await load(secondRecord)
    await expect(load(record)).rejects.toThrow(/unique entry id/)
    cleanup.push(() => second.dispose(), () => first.dispose())
    expect([...ctx.loader.entries()].filter(entry => entry.options.name.endsWith('/sdk-fixture/index.js'))).toHaveLength(2)
    expect(grant.mock.calls[0][0]).toMatchObject({ pluginId: 'host-record-id', instanceId: expect.any(String) })
    expect(grant.mock.calls[0][0].instanceId).not.toBe(grant.mock.calls[1][0].instanceId)
    expect(contexts[0].enterpriseAuth.getState()).toEqual(state)
    const oldSdk = contexts[0].enterpriseAuth
    await first.dispose()
    await first.dispose()
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(() => oldSdk.getState()).toThrow(EnterpriseAuthError)
    expect(contexts[1].enterpriseAuth.getState()).toEqual(state)
    const result = await contexts[1].enterpriseAuth.request('/search')
    expect(settled).not.toHaveBeenCalled()
    await result.text()
    expect(settled).toHaveBeenCalledWith(secondRecord, undefined)
    await expect(load({ ...record, plugin_id: 'failed-host-record-id', config: { fail: true } })).rejects.toThrow()
    expect(revoke).toHaveBeenCalledTimes(2)
    await second.dispose()
    expect(revoke).toHaveBeenCalledTimes(3)
  })
})

describe('enterpriseAuth wire transport', () => {
  it('encodes binary upload and preserves streaming binary business failures', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0, 255, 8])); controller.close() } }), { status: 422, headers: { 'content-type': 'application/octet-stream', 'x-request-id': 'business' } })
    const fetch = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetch)
    const transport = createEnterpriseAuthTransport('http://127.0.0.1:1', 'instance-secret')
    const result = await transport.request('/api/binary', { method: 'POST', body: new Uint8Array([0, 255]), sessionVersion: 'v', headers: { accept: 'application/octet-stream' } })
    expect(result).toBeInstanceOf(Response)
    expect(result.status).toBe(422)
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([0, 255, 8])
    const [url, init] = fetch.mock.calls[0]
    expect(url.pathname).toBe('/v1/auth/request')
    expect(init.headers.authorization).toBe('Bearer instance-secret')
    expect(JSON.parse(init.body)).toEqual({ path: '/api/binary', method: 'POST', body: 'AP8=', bodyEncoding: 'base64', headers: { accept: 'application/octet-stream' }, sessionVersion: 'v' })
    expect(Object.values(transport)).not.toContain('instance-secret')
  })

  it('maps stream failures and cancellation without consuming the response eagerly', async () => {
    let cancel
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull() {}, cancel(reason) { cancel = reason } }))))
    const transport = createEnterpriseAuthTransport('http://127.0.0.1:1', 'instance')
    const response = await transport.request('/stream', { sessionVersion: '1' })
    await response.body.cancel('consumer stopped')
    expect(cancel).toBe('consumer stopped')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError('socket closed')) } }))))
    const failed = await transport.request('/stream', { sessionVersion: '1' })
    await expect(failed.arrayBuffer()).rejects.toMatchObject({ errorCode: 'request_failed' })
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull() { controller.abort() } }, { highWaterMark: 0 }))))
    const aborted = await transport.request('/stream', { signal: controller.signal, sessionVersion: '1' })
    await expect(aborted.arrayBuffer()).rejects.toMatchObject({ errorCode: 'request_aborted' })
  })

  it('revokes unread and delayed-read bodies without delivering late chunks', async () => {
    const ctx = fixture(), scoped = ctx.extend()
    let resolveRead
    const sourceReader = {
      read: vi.fn(() => new Promise(resolve => { resolveRead = resolve })),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn()
    }
    vi.stubGlobal('fetch', vi.fn(async url => url.pathname === '/v1/auth/state' ? Response.json(state) : {
      status: 200, statusText: 'OK', headers: new Headers(), body: { getReader: () => sourceReader }
    }))
    const transport = createEnterpriseAuthTransport('http://127.0.0.1:1', 'instance')
    const dispose = await bindEnterpriseAuth(scoped, transport)
    cleanup.push(dispose)
    const response = await scoped.enterpriseAuth.request('/stream')
    expect(sourceReader.read).not.toHaveBeenCalled()
    const pending = response.body.getReader().read()
    const rejected = expect(pending).rejects.toMatchObject({ errorCode: 'authorization_denied' })
    await Promise.resolve()
    expect(sourceReader.read).toHaveBeenCalledOnce()
    dispose()
    await rejected
    resolveRead({ done: false, value: new Uint8Array([99]) })
    await Promise.resolve()
    expect(sourceReader.cancel).toHaveBeenCalledOnce()
    expect(sourceReader.releaseLock).toHaveBeenCalledOnce()

    const idle = ctx.extend()
    const unbindIdle = await bindEnterpriseAuth(idle, transport)
    cleanup.push(unbindIdle)
    const unread = await idle.enterpriseAuth.request('/stream')
    unbindIdle()
    await expect(unread.arrayBuffer()).rejects.toMatchObject({ errorCode: 'authorization_denied' })
    expect(sourceReader.cancel).toHaveBeenCalledTimes(2)
    expect(sourceReader.releaseLock).toHaveBeenCalledTimes(2)
  })

  it('only the infrastructure error header converts responses into typed errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ errorCode: 'session_changed', error: 'Session changed.' }, { status: 409, headers: { 'x-dsh-enterprise-error': 'session_changed' } })))
    const transport = createEnterpriseAuthTransport('http://127.0.0.1:1', 'instance')
    await expect(transport.request('/api/test', { sessionVersion: 'old' })).rejects.toMatchObject({ name: 'EnterpriseAuthError', errorCode: 'session_changed', status: 409 })
  })

  it('forwards cancellation and rejects invalid paths and unsupported bodies', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { expect(init.signal).toBe(controller.signal); controller.abort(); throw controller.signal.reason }))
    const transport = createEnterpriseAuthTransport('http://127.0.0.1:1', 'instance')
    await expect(transport.request('/api/test', { signal: controller.signal })).rejects.toMatchObject({ errorCode: 'request_aborted' })
    await expect(transport.request('https://evil.example')).rejects.toMatchObject({ errorCode: 'invalid_request' })
    await expect(transport.request('/api/test', { body: {} })).rejects.toMatchObject({ errorCode: 'invalid_request' })
    await expect(transport.request('/api/test', { headers: { 'invalid header': 'value' } })).rejects.toMatchObject({ errorCode: 'invalid_request' })
  })
})
