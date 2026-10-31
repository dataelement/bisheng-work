import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { HarnessRuntime } from '../src/main/runtime/harness-runtime'
import { resolveTestNodeExecutable } from './node-executable'

it('publishes renamed enterprise models in a running Harness through the authenticated sync route', async () => {
  const root = resolve(import.meta.dirname, '..')
  const home = await mkdtemp(join(tmpdir(), 'dsh-model-display-'))
  const profile = join(home, 'profiles', 'web')
  vi.stubEnv('DEEPSEEK_API_KEY', '')
  vi.stubEnv('DSH_DESKTOP_ENTERPRISE_BROKER_URL', '')
  vi.stubEnv('DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY', '')
  let revision = 1
  let displayName = '阿里云百炼 / qwen-max'
  const broker = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer model-sync-test') {
      response.writeHead(401).end()
      return
    }
    if (request.url === '/v1/models/refresh' && request.method === 'POST') {
      revision += 1
      displayName = '阿里云百炼 / 1111'
    } else if (request.url !== '/v1/state') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      connected: true, phase: 'connected', revision, modelsAvailable: true,
      connectionKey: 'model-sync-account', base: 'https://fixture.invalid',
      tenant: { id: 'tenant', name: 'Enterprise' }, user: { id: 'user' },
      models: [{ id: 'bisheng:2', display_name: displayName,
        capabilities: { streaming: true, tools: true, vision: false, reasoning_content: false } }]
    }))
  })
  await new Promise<void>(resolve => broker.listen(0, '127.0.0.1', resolve))
  const address = broker.address()
  if (!address || typeof address === 'string') throw new Error('Broker port required')
  const runtime = new HarnessRuntime({
    dshEntryPath: join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    nodeEntryPath: join(root, 'build/harness-node-entry.mjs'),
    nodeExecutablePath: resolveTestNodeExecutable(),
    dshPatchPath: join(root, 'build/dsh-desktop.patch.yml'),
    dshSafePatchPath: join(root, 'build/dsh-desktop-safe.patch.yml'),
    dshHome: home,
    logPath: join(home, 'runtime.log'),
    preferredPort: 0,
    startupTimeoutMs: 30_000,
    launchProcess: (executable, args, options) => spawn(executable, args, options),
    extraEnvironment: {
      DSH_DESKTOP_ENTERPRISE_BROKER_URL: `http://127.0.0.1:${address.port}`,
      DSH_DESKTOP_ENTERPRISE_BROKER_CAPABILITY: 'model-sync-test'
    },
    onChanged() {}
  })
  try {
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'model-display-test-profile', private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
    }))
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    await runtime.start(home)
    expect(runtime.snapshot().phase, runtime.snapshot().logs.join('\n')).toBe('ready')
    const { url, authToken } = runtime.snapshot()
    if (!url || !authToken) throw new Error('Harness endpoint is required')
    const login = await fetch(`${url}/?token=${encodeURIComponent(authToken)}`, { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    let sequence = 0
    const invoke = async (method: string, args = {}) => {
      const response = await fetch(new URL(`/api/${method}`, url), {
        method: 'POST',
        headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: `catalog-${sequence++}`, method, payload: { args }
        })
      })
      expect(response.status).toBe(200)
      const envelope = await response.json()
      expect(envelope.error, JSON.stringify(envelope)).toBeUndefined()
      expect(envelope.result?.ok, JSON.stringify(envelope)).toBe(true)
      return envelope.result.value
    }
    const model = async () => {
      const result = await invoke('session/modelCatalog')
      const groups = result.groups as Array<{ id: string; models: Array<{ id: string; name: string }> }>
      return groups.find(group => group.id === 'bisheng-enterprise')?.models[0]
    }
    await fetch(new URL('/api/enterprise.state', url), { headers: { Cookie: cookie } })
    expect(await model()).toMatchObject({ id: 'bisheng:2', name: '阿里云百炼 / qwen-max' })
    const refresh = await fetch(new URL('/api/enterprise.models.refresh', url), {
      method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' }, body: '{}'
    })
    expect(refresh.status).toBe(200)
    expect(await model()).toMatchObject({ id: 'bisheng:2', name: '阿里云百炼 / 1111' })
  } finally {
    await runtime.stop()
    await new Promise<void>((resolve, reject) => broker.close(error => error ? reject(error) : resolve()))
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 60_000)
