/** Opt-in acceptance against a deployed Bisheng instance and its read-only time fixture. */
import { readFile, writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { apply as applySkillTool } from '@deepseek-ai/dsh-tool-skill'
import { EnterpriseService } from '../src/main/enterprise/enterprise-service'
import { createEnterpriseFetch } from '../src/main/enterprise/platform-fetch'
// @ts-expect-error Runtime plugin is authored as JavaScript.
import { applyEnterpriseSkills } from '../packages/dsh-desktop-enterprise/work-skills.js'
// @ts-expect-error Enterprise runtime plugin is authored as JavaScript.
import { applyWorkCapabilities } from '../packages/dsh-desktop-enterprise/work-capabilities.js'
const fixture = process.env.BISHENG_WORK_LIVE_FIXTURE
it.runIf(Boolean(fixture))('uses real PKCE login, host credential exchange, native tool approval and enterprise Skill loading', async () => {
  const config = JSON.parse(await readFile(fixture!, 'utf8'))
  let generation = 0, stored: any = null
  const vault = { available: true, read: async () => ({ generation, session: stored }),
    replace: async (expected: number, session: any) => { expect(expected).toBe(generation); stored = structuredClone(session); return { generation: ++generation, session: stored } },
    clear: async () => { stored = null; return { generation: ++generation, session: null } } }
  const service = new EnterpriseService({ vault: vault as any, fetchImpl: createEnterpriseFetch(globalThis.fetch), allowInsecureLoopback: false })
  const ctx = new Context(), forks: any[] = []
  try {
    await service.restore()
    const start = await service.startLogin(config.origin, { confirmInsecurePrivateHttp: true })
    const authId = new URL(start.authorizationUrl).searchParams.get('auth_id')
    const approved = await fetch(`${config.origin}/api/v1/dsh/authorize`, { method: 'POST', headers: {
      'content-type': 'application/json', origin: config.origin,
      cookie: Object.entries(config.cookies).map(([name,value]) => `${name}=${value}`).join('; ')
    }, body: JSON.stringify({ auth_id: authId, decision: 'approve' }) })
    expect(approved.status).toBe(200)
    const envelope = await approved.json()
    const connected = await service.submitManualTicket(envelope.data.identity_ticket)
    expect(connected.connected).toBe(true)
    const credential = await service.webSession(connected.connectionKey!)
    expect(credential.cookieName).toBe(config.cookieName)
    for (const plugin of [SystemPrompt, ToolRuntime, SkillRegistry]) { const fork = ctx.plugin(plugin as any, {}); await fork; forks.push(fork) }
    const session = Session.create(SessionId('enterprise-deployed-acceptance')), agent = { id: session.id, session }
    const approval = vi.fn(async () => 'allowed-once')
    ctx.provide('approval', { request: approval } as any)
    let api: any
    const fork = ctx.plugin({ inject: ['tools','skills'], apply(scoped: Context) {
      api = applyWorkCapabilities({ tools: scoped.tools, skills: scoped.skills,
        sessions: { get: (id: string) => id === session.id ? session : undefined },
        on: scoped.on.bind(scoped), effect: scoped.effect.bind(scoped), logger: scoped.logger
      }, { state: () => service.snapshot(), refreshState: async () => {}, request: (body: any, signal?: AbortSignal) => service.workMcp(body,signal) })
      applyEnterpriseSkills(scoped, { state: () => service.snapshot(), refreshState: async () => {},
        request: async (body: any, signal?: AbortSignal) => { const result = await service.workSkills(body, signal); return result.binary ? result.bytes : JSON.parse(result.bytes.toString()) } })
      applySkillTool(scoped)
    } }); await fork; forks.push(fork); await api.sync()
    const catalog = await ctx.skills.list({ sessionId: session.id })
    const skill = catalog.find((row: any) => row.locator?.id === config.skillId)
    expect(skill).toBeTruthy()
    let sequence = 0
    const call = (name: string, args: object) => ctx.tools.execute({ name, arguments: args, callId: String(++sequence) as any, signal: new AbortController().signal, agent: agent as any })
    const loaded = await call('skill', { name: skill!.name })
    expect(loaded.isError).toBe(false)
    const content = await ctx.skills.get(skill!.name, { sessionId: session.id })
    expect(content?.content).toContain(`mcp__bisheng__bisheng_tool_${config.toolId}`)
    const result = await call(`mcp__bisheng__bisheng_tool_${config.toolId}`, { timezone: 'Asia/Shanghai' })
    expect(result.isError).toBe(false)
    expect(approval).toHaveBeenCalledOnce()
    await service.refresh()
    expect(service.snapshot().connected).toBe(true)
    if (config.reportPath) await writeFile(config.reportPath, JSON.stringify({ origin: config.origin, user: connected.user,
      pkce: true, hostCookieExchange: true, cookieName: credential.cookieName, nativeSkillLoaded: skill!.name,
      nativeToolApproval: approval.mock.calls.length, result, accessRefresh: true }, null, 2))
  } finally {
    for (const fork of forks.reverse()) await fork.dispose()
    await service.logout(); await service.stop()
  }
}, 120_000)
