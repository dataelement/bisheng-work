/** Optional local integration: Python Bisheng MCP -> host transport -> native Harness. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { apply as applySkillTool } from '@deepseek-ai/dsh-tool-skill'
// @ts-expect-error Enterprise runtime plugin is authored as JavaScript.
import { applyWorkCapabilities } from '../packages/dsh-desktop-enterprise/work-capabilities.js'
import { sendWorkMcp } from '../src/main/enterprise/work-mcp'

const backend = process.env.BISHENG_WORK_BACKEND_ROOT ? path.resolve(process.env.BISHENG_WORK_BACKEND_ROOT) : undefined
const python = process.env.BISHENG_WORK_PYTHON

it.runIf(Boolean(backend && python))('runs approved enterprise tool against the Python MCP server', async () => {
  const child = spawn(python!, [path.resolve('test/fixtures/work-mcp-backend.py')], {
    cwd: backend, env: { ...process.env, PYTHONPATH: backend }, stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = '', sequence = 0
  child.stderr.on('data', chunk => { stderr += chunk })
  const pending = new Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>()
  let ready!: () => void, failed!: (error: Error) => void
  const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
  const reader = createInterface({ input: child.stdout })
  reader.on('line', line => {
    const message = JSON.parse(line)
    if (message.ready) ready()
    else { pending.get(message.id)?.resolve(message.result); pending.delete(message.id) }
  })
  child.once('exit', () => {
    const error = new Error(`Local backend exited: ${stderr}`)
    failed(error); for (const call of pending.values()) call.reject(error)
  })
  const exchange = (body: object): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ ...body, id }) + '\n')
  })
  const ctx = new Context(), forks: any[] = []
  try {
    await started
    for (const plugin of [SystemPrompt, ToolRuntime, SkillRegistry]) { const fork = ctx.plugin(plugin as any, {}); await fork; forks.push(fork) }
    const session = Session.create(SessionId('enterprise-local-integration'))
    const agent = { id: session.id, session }
    const approval = vi.fn(async () => 'allowed-once')
    ctx.provide('approval', { request: approval } as any)
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const result = await exchange({ url, headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body })
      return new Response(result.body || null, { status: result.status, headers: result.headers })
    }
    let api: any
    const fork = ctx.plugin({
      inject: ['tools', 'skills'],
      apply(scoped: Context) {
        api = applyWorkCapabilities({
          tools: scoped.tools, skills: scoped.skills, sessions: { get: (id: string) => id === session.id ? session : undefined },
          on: scoped.on.bind(scoped), effect: scoped.effect.bind(scoped), logger: scoped.logger
        }, {
          state: () => ({ connected: true, connectionKey: 'account-a' }), refreshState: async () => {},
          request: (request: any, signal?: AbortSignal) => sendWorkMcp({ request, signal, fetchImpl,
            credential: { base: 'http://127.0.0.1', cookie: 'fixture-host-cookie', cookieName: 'access_token_cookie', connectionKey: 'account-a', expiresIn: 300 } as any,
            assertCurrent() {}, allowInsecureLoopback: true })
        })
        applySkillTool(scoped)
      }
    }); await fork; forks.push(fork)
    await api.sync()
    const call = (name: string, args: object, caller = agent) => ctx.tools.execute({ name, arguments: args,
      callId: String(++sequence) as any, signal: new AbortController().signal, agent: caller as any })
    const result = await call('mcp__bisheng__bisheng_tool_7', { query: 'Example' })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    expect(JSON.stringify(result)).toContain('Example company')
    expect(approval).toHaveBeenCalledOnce()
    const childResult = await call('mcp__bisheng__bisheng_tool_7', { query: 'Example' }, {
      id: 'child', session: { id: 'child', header: { delegationDepth: 1 } }
    } as any)
    expect(childResult.isError).toBe(true)
    expect(approval).toHaveBeenCalledOnce()
    const audits = await exchange({ control: 'audit' })
    expect(audits.filter((row: any) => row.action === 'call').map((row: any) => row.status)).toEqual(['STARTED', 'SUCCEEDED'])
    expect(audits.every((row: any) => row.actor === 42 && row.tenant === 2)).toBe(true)
    await exchange({ control: 'revoke' })
    expect((await call('mcp__bisheng__bisheng_tool_7', { query: 'Example' })).isError).toBe(true)
  } finally {
    for (const fork of forks.reverse()) await fork.dispose()
    reader.close(); child.stdin.end(); child.kill()
  }
})
