// Coverage AC: AC-03, AC-30, AC-31, AC-56.
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { zipSync } from 'fflate'
// @ts-expect-error Runtime plugin is authored as JavaScript.
import { skillContentHash } from '../packages/dsh-desktop-enterprise/work-skills.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { apply as applyEnterprise } from '../packages/dsh-desktop-enterprise/index.js'
import { startEnterpriseCredentialBroker } from '../src/main/enterprise/credential-broker'
import { createEnterpriseFetch } from '../src/main/enterprise/platform-fetch'
import { EnterpriseService } from '../src/main/enterprise/enterprise-service'
import { createMockEnterpriseServer } from '../scripts/mock-bisheng-enterprise.mjs'
import {
  ENTERPRISE_VAULT_FILENAME,
  type SafeStorageCryptoAdapter,
  SecureEnterpriseCredentialVault
} from '../src/main/enterprise/secure-credential-vault'

type RegisteredRoute = {
  path: string
  methods: string[]
  requestBody?: string
  fetch: (request: Request) => Promise<Response>
}

function createPluginContext(
  llm?: { registerAdapter: (...args: never[]) => unknown },
  services?: { get?: (name: string) => unknown }
) {
  const routes: RegisteredRoute[] = []
  applyEnterprise({
    provide() {},
    // Locale event behavior is covered through the real Connection in its dedicated suite.
    on() { return () => undefined },
    inject(dependencies: string[], install: (ctx: unknown) => unknown) {
      if (!dependencies.includes('tools') || dependencies.includes('skills') || dependencies.includes('sessions')) return
      const value = install({
        sessions: { get: () => undefined }, on() {}, effect() {},
        connection: { fetch: { register: (route: RegisteredRoute) => { routes.push(route) } } },
        tools: { register() {} }, systemPrompt: { context() {} }
      })
      expect(value === undefined || typeof value === 'function').toBe(true)
    },
    effect(callback: () => (() => unknown) | undefined) {
      const dispose = callback()
      if (dispose) adapterCleanups.push(async () => { await dispose() })
    },
    connection: {
      fetch: {
        register(route: RegisteredRoute) {
          routes.push(route)
          return () => undefined
        }
      }
    },
    ...(services?.get ? { get: services.get } : {}),
    ...(llm ? { llm } : {})
  } as never)
  return routes
}

function listenJson(payload: unknown): Promise<{ url: string, close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Enterprise test broker did not bind a port.'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => {
          server.close((error) => error ? fail(error) : done())
        })
      })
    })
  })
}

async function completeBrowserLogin(origin: string, authorizationUrl: string) {
  const authId = new URL(authorizationUrl).searchParams.get('auth_id')
  const browserResponse = await fetch(`${origin}/__mock/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      auth_id: authId ?? '',
      email: 'alice@demo.bisheng.local',
      password: 'WorkBuddy123!',
      decision: 'allow'
    })
  })
  const html = await browserResponse.text()
  const callbackLiteral = /location\.replace\((".*?")\)/u.exec(html)?.[1]
  expect(callbackLiteral).toBeTruthy()
  const callback = new URL(JSON.parse(callbackLiteral!))
  expect(await fetch(callback).then((response) => response.status)).toBe(200)
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for enterprise adapter.')
}

async function invoke(routes: RegisteredRoute[], path: string, method = 'GET', body?: unknown) {
  const route = routes.find((entry) => entry.path === path)
  expect(route).toBeDefined()
  const request = new Request(`http://127.0.0.1${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return route!.fetch(request)
}

const adapterCleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  delete process.env.DSH_DESKTOP_ENTERPRISE_BROKER_URL
  delete process.env.DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY
  delete process.env.DSH_DESKTOP_ENTERPRISE_ALLOW_INSECURE_LOOPBACK
  while (adapterCleanups.length > 0) await adapterCleanups.pop()?.()
})

function memorySafeStorage(): SafeStorageCryptoAdapter {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (plainText) => Buffer.from(plainText, 'utf8'),
    decryptString: (encrypted) => Buffer.from(encrypted as Buffer).toString('utf8')
  }
}

describe('enterprise adapter without a Broker', () => {
  it('loads and reports a local disabled state', async () => {
    const routes = createPluginContext()
    const response = await invoke(routes, '/api/enterprise.state')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      connected: false,
      secureStorageAvailable: false,
      phase: 'disabled',
      revision: 0,
      models: [],
      modelsAvailable: false,
      allowThirdPartyPlugins: false,
      allowThirdPartyWorkbenches: false
    })
  })

  it('inspects a deep link locally and rejects login until the Broker exists', async () => {
    const routes = createPluginContext()
    const inspected = await invoke(routes, '/api/enterprise.deep-link.inspect', 'POST', {
      url: 'bisheng://login?server=https%3A%2F%2Fbisheng.example.com'
    })
    expect(inspected.status).toBe(200)
    await expect(inspected.json()).resolves.toEqual({ base: 'https://bisheng.example.com' })

    const inspectedBase = await invoke(routes, '/api/enterprise.base.inspect', 'POST', {
      base: 'https://bisheng.example.com'
    })
    expect(inspectedBase.status).toBe(200)
    await expect(inspectedBase.json()).resolves.toEqual({ base: 'https://bisheng.example.com' })

    const inspectedPrivate = await invoke(routes, '/api/enterprise.base.inspect', 'POST', {
      base: 'http://192.168.106.119:30006'
    })
    expect(inspectedPrivate.status).toBe(200)
    await expect(inspectedPrivate.json()).resolves.toEqual({
      base: 'http://192.168.106.119:30006',
      insecurePrivateHttp: true
    })

    const started = await invoke(routes, '/api/enterprise.login.start', 'POST', {
      base: 'https://bisheng.example.com'
    })
    expect(started.status).toBe(503)
    await expect(started.json()).resolves.toMatchObject({
      ok: false,
      error: 'Enterprise login is not available yet.'
    })
  })
})

describe('enterprise adapter with a Broker', () => {
  it('loads skill catalogs and complete bundles after consuming the owner capability', async () => {
    const home = await mkdtemp(join(tmpdir(), 'enterprise-skill-broker-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    adapterCleanups.push(async () => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    })
    const files = { 'SKILL.md': Buffer.from('---\nname: office\ndescription: Create files\n---\nEnterprise instructions'), 'templates/file.bin': Buffer.from([0, 255, 42]) }
    const version = skillContentHash(new Map(Object.entries(files).map(([name, data]) => [name, { data }])))
    const calls: Array<{ operation: string, authorization: string | undefined }> = []
    const capability = 'fixture-skill-owner-capability'
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      if (request.url === '/v1/work-skills') calls.push({ operation: body.operation, authorization: request.headers.authorization })
      const payload = request.url === '/v1/state'
        ? { connected: true, connectionKey: 'account-a', base: 'https://enterprise.example', tenant: { id: 2 }, user: { id: 3 }, models: [] }
        : body.operation === 'list'
          ? [{ id: 7, name: 'office', display_name: 'Office', description: 'Create files', content_hash: version }]
          : body.operation === 'dependencies' ? [] : {}
      response.writeHead(200, { 'content-type': body.operation === 'bundle' ? 'application/zip' : 'application/json' })
      response.end(body.operation === 'bundle' ? Buffer.from(zipSync(files)) : JSON.stringify(payload))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    adapterCleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test broker did not bind.')
    process.env.DSH_DESKTOP_ENTERPRISE_BROKER_URL = `http://127.0.0.1:${address.port}`
    process.env.DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY = capability
    let provider: any
    const controller = new AbortController()
    adapterCleanups.push(async () => { controller.abort() })
    applyEnterprise({
      provide() {},
      inject(dependencies: string[], install: (ctx: unknown) => unknown) {
        if (dependencies.length === 1 && dependencies[0] === 'skills') install({
          skills: { registerProvider(create: (control: unknown) => unknown) { provider = create({ signal: controller.signal, invalidate() {} }) } },
          connection: { fetch: { register() {} } }
        })
      },
      connection: { fetch: { register() {} } },
      effect(callback: () => (() => unknown) | undefined) {
        const dispose = callback()
        if (dispose) adapterCleanups.push(async () => { await dispose() })
      }
    } as never)
    expect(process.env.DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY).toBeUndefined()
    const [skill] = await provider.list({ signal: controller.signal })
    expect(skill.locator.id).toBe(7)
    expect(await provider.list({ signal: controller.signal })).toHaveLength(1)
    const loaded = await provider.get(skill, { signal: controller.signal })
    expect(loaded.content).toContain('Enterprise instructions')
    expect(await readFile(join(loaded.resourceBase.path, 'templates/file.bin'))).toEqual(files['templates/file.bin'])
    expect(calls.map(call => call.operation)).toEqual(['list', 'list', 'list', 'bundle', 'dependencies'])
    expect(calls.every(call => call.authorization === `Bearer ${capability}`)).toBe(true)
  })

  it('keeps workbench verification authorized after consuming the owner capability', async () => {
    const id = '0123456789abcdef0123456789abcdef'
    const versionId = 'fedcba9876543210fedcba9876543210'
    const capability = 'fixture-owner-capability'
    const calls: Array<{ path: string, authorization: string | undefined }> = []
    const server = createServer((request, response) => {
      calls.push({ path: request.url ?? '', authorization: request.headers.authorization })
      request.resume()
      const payload = request.url === '/v1/state'
        ? { connected: true, connectionKey: 'account-a', phase: 'connected', models: [] }
        : request.url === '/v1/market'
          ? { status_code: 200, data: {
            id, identity_kind: 'repository', workbench_key: 'company/workbench', legacy_id: null,
            package_name: 'company-workbench', display_name: 'Workbench', description: '',
            current_version: { id: versionId, version: '1.0.0', sha256: 'a'.repeat(64), size_bytes: 12,
              artifact_url: '/api/v1/dsh/market/workbenches/' + id + '/versions/' + versionId + '/artifact' }
          } }
          : { ok: true }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    adapterCleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test broker did not bind.')
    process.env.DSH_DESKTOP_ENTERPRISE_BROKER_URL = 'http://127.0.0.1:' + address.port
    process.env.DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY = capability
    const routes = createPluginContext()
    expect(process.env.DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY).toBeUndefined()
    const verified = await invoke(routes, '/api/enterprise.workbenches/verify', 'POST', { id })
    expect(verified.status).toBe(200)
    await expect(verified.json()).resolves.toEqual({ ok: true })
    expect(calls.some(call => call.path === '/v1/state')).toBe(true)
    expect(calls.map(call => call.path).filter(path => path !== '/v1/state')).toEqual(['/v1/market', '/v1/workbench/verify'])
    expect(calls.every(call => call.authorization === 'Bearer ' + capability)).toBe(true)
  })

  it('reads the restricted Broker state instead of a local fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enterprise-adapter-'))
    const vault = new SecureEnterpriseCredentialVault(join(directory, ENTERPRISE_VAULT_FILENAME), memorySafeStorage())
    const service = new EnterpriseService({
      vault,
      fetchImpl: createEnterpriseFetch(globalThis.fetch),
      allowInsecureLoopback: true
    })
    const broker = await startEnterpriseCredentialBroker(service, { allowInsecureLoopback: true })
    adapterCleanups.push(async () => {
      await broker.stop()
      await service.stop()
    })
    process.env.DSH_DESKTOP_ENTERPRISE_BROKER_URL = broker.url
    process.env.DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY = broker.capability
    process.env.DSH_DESKTOP_ENTERPRISE_ALLOW_INSECURE_LOOPBACK = '1'

    const routes = createPluginContext()
    const response = await invoke(routes, '/api/enterprise.state')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      connected: false,
      secureStorageAvailable: true,
      phase: 'idle',
      models: [],
      modelsAvailable: false
    })
  })

  it('publishes renamed models through foreground refresh with stable routing', async () => {
    const platform = createMockEnterpriseServer({ port: 0 })
    const origin = await platform.listen()
    adapterCleanups.push(async () => platform.close())

    const directory = await mkdtemp(join(tmpdir(), 'enterprise-adapter-'))
    const vault = new SecureEnterpriseCredentialVault(join(directory, ENTERPRISE_VAULT_FILENAME), memorySafeStorage())
    let displayName = '阿里云百炼 / qwen-max'
    const service = new EnterpriseService({
      vault,
      fetchImpl: createEnterpriseFetch(async (input, init) => {
        const response = await globalThis.fetch(input, init)
        if (String(input).includes('/api/v1/dsh/models') && response.ok) {
          const payload = await response.json() as { data: Array<{ display_name: string }> }
          payload.data.forEach(model => { model.display_name = displayName })
          return Response.json(payload)
        }
        return response
      }),
      allowInsecureLoopback: true
    })
    await service.restore()
    const broker = await startEnterpriseCredentialBroker(service, { allowInsecureLoopback: true })
    adapterCleanups.push(async () => {
      await broker.stop()
      await service.stop()
    })
    process.env.DSH_DESKTOP_ENTERPRISE_BROKER_URL = broker.url
    process.env.DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY = broker.capability
    process.env.DSH_DESKTOP_ENTERPRISE_ALLOW_INSECURE_LOOPBACK = '1'

    const registered: string[][] = []
    let adapter: { listModels(provider: string): Promise<Array<{ id: string; name: string }>> } | undefined
    let replacements = 0
    const routes = createPluginContext({
      registerAdapter(providers: string[], value: typeof adapter) {
        adapter = value
        registered.push(providers)
        return Object.assign(() => undefined, { replace: () => { replacements += 1 } })
      }
    } as never)

    const started = await service.startLogin(origin)
    await completeBrowserLogin(origin, started.authorizationUrl)
    await waitFor(() => service.snapshot().modelsAvailable === true && service.snapshot().models.length > 0)

    const response = await invoke(routes, '/api/enterprise.state')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      modelsAvailable: true,
      phase: expect.stringMatching(/refreshing|connected/)
    })
    expect(registered).toContainEqual(['bisheng-enterprise'])
    const before = await adapter!.listModels('bisheng-enterprise')
    expect(before[0]?.name).toBe(displayName)
    const oldReplacements = replacements
    displayName = '阿里云百炼 / 1111'
    const refreshed = await invoke(routes, '/api/enterprise.models.refresh', 'POST', {})
    expect(refreshed.status).toBe(200)
    const after = await adapter!.listModels('bisheng-enterprise')
    expect(after.map(model => model.id)).toEqual(before.map(model => model.id))
    expect(after[0]?.name).toBe(displayName)
    expect(replacements).toBeGreaterThan(oldReplacements)
  })
})

describe('enterprise image request target', () => {
  it('passes official pixel dimensions and the enterprise byte budget to readImageRequest', async () => {
    const calls: unknown[][] = []
    const broker = await listenJson({
      connected: false,
      secureStorageAvailable: false,
      phase: 'idle',
      revision: 1,
      modelsAvailable: true,
      models: [{ id: 'vision-model' }]
    })
    adapterCleanups.push(() => broker.close())
    process.env.DSH_DESKTOP_ENTERPRISE_BROKER_URL = broker.url
    process.env.DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY = 'test-capability'

    let readImage: ((ref: { width: number, height: number }) => Promise<unknown>) | undefined
    createPluginContext({
      registerAdapter(_providers: unknown, adapter: { options: { readImage: typeof readImage } }) {
        readImage = adapter.options.readImage
        return Object.assign(() => undefined, { replace: () => undefined })
      }
    } as never, {
      get(name: string) {
        if (name !== 'attachments') return undefined
        return {
          readImageRequest: (...args: unknown[]) => {
            calls.push(args)
            return Promise.resolve({ data: new Uint8Array() })
          }
        }
      }
    })

    await waitFor(() => readImage !== undefined)
    const read = readImage
    if (!read) throw new Error('Enterprise image reader was not registered.')
    const small = { width: 100, height: 50 }
    const large = { width: 3000, height: 3000 }
    await read(small)
    await read(large)

    const maxBytes = 5 * 1024 * 1024
    const smallTarget = { ...requestImageDimensions(small.width, small.height, 4_194_304), maxBytes }
    const largeTarget = { ...requestImageDimensions(large.width, large.height, 4_194_304), maxBytes }
    expect(calls.map((call) => call[1])).toEqual([smallTarget, largeTarget])
    expect(smallTarget).toEqual({ width: 100, height: 50, maxBytes })
    expect(largeTarget.width).toBeLessThan(large.width)
    expect(largeTarget.height).toBeLessThan(large.height)
    expect(largeTarget.width * largeTarget.height).toBeLessThanOrEqual(4_194_304)
    expect(Number.isSafeInteger(largeTarget.width) && largeTarget.width > 0).toBe(true)
    expect(Number.isSafeInteger(largeTarget.height) && largeTarget.height > 0).toBe(true)
    expect(calls.every((call) => !Object.hasOwn(call[1] as object, 'maxPixels'))).toBe(true)
    expect(calls.map((call) => call[0])).toEqual([small, large])
  })
})

describe('enterprise chat failure copy', () => {
  async function loadFormatEnterpriseChatFailure() {
    const source = await readFile(join(import.meta.dirname, '../packages/dsh-desktop-enterprise/openai.js'), 'utf8')
    const start = source.indexOf('const LOCAL_CHAT_FAILURES')
    const end = source.indexOf('\nexport function requestFailure')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    return new Function(`${source.slice(start, end)}; return formatEnterpriseChatFailure`)() as (
      status: number,
      payload: unknown,
      language: string
    ) => string
  }

  it('localizes the generic status fallback and known local 409 reasons', async () => {
    const formatEnterpriseChatFailure = await loadFormatEnterpriseChatFailure()
    expect(formatEnterpriseChatFailure(409, {}, 'zh-CN')).toBe('毕昇模型请求失败（409）。')
    expect(formatEnterpriseChatFailure(409, {}, 'en-US')).toBe('BiSheng model request failed (409).')
    expect(formatEnterpriseChatFailure(409, { error: 'Enterprise models are unavailable.' }, 'zh-CN'))
      .toBe('企业模型暂不可用。')
    expect(formatEnterpriseChatFailure(409, { error: 'Enterprise session changed.' }, 'en-US'))
      .toBe('Enterprise session changed.')
  })

  it('classifies a desktop header timeout without replacing an upstream error code', async () => {
    const source = await readFile(join(import.meta.dirname, '../packages/dsh-desktop-enterprise/openai.js'), 'utf8')
    const start = source.indexOf('const LOCAL_CHAT_FAILURES')
    const end = source.indexOf('\nexport function requestFailure')
    const classify = new Function(`${source.slice(start, end)}; return (payload, status) => classifyChatFailure(platformChatCode(payload), status)`)() as (
      payload: unknown,
      status: number
    ) => string
    expect(classify({
      error: 'Enterprise model response timed out.',
      errorCode: 'upstream_timeout'
    }, 504)).toBe('upstream_timeout')
    expect(classify({
      error: { message: 'Access token is invalid.', code: 'invalid_access_token' }
    }, 401)).toBe('invalid_access_token')
  })

  it('keeps an upstream Chinese message instead of replacing it', async () => {
    const formatEnterpriseChatFailure = await loadFormatEnterpriseChatFailure()
    expect(formatEnterpriseChatFailure(429, {
      error: { message: '账户额度不足，请联系服务商咨询用量限制。', code: 'monthly_token_limit_exceeded' }
    }, 'en-US')).toBe('账户额度不足，请联系服务商咨询用量限制。')
  })
})
