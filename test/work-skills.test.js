import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEnterpriseSkills, enterpriseSkillName, skillContentHash } from '../packages/dsh-desktop-enterprise/work-skills.js'
const homes = []
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }) })
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'work-skills-')); homes.push(home)
  let state = { connected: true, connectionKey: 'key-a', base: 'https://a.example', tenant: { id: 2 }, user: { id: 3 } }
  let files = { 'SKILL.md': Buffer.from('---\nname: office\ndescription: office\n---\nEnterprise instructions'), 'scripts/run.py': Buffer.from('print(42)'), 'templates/file.bin': Buffer.from([0, 255, 42]) }
  const version = () => skillContentHash(new Map(Object.entries(files).map(([key, data]) => [key, { data }])))
  let enabled = true
  const request = vi.fn(async body => body.operation === 'dependencies' ? [7] : body.operation === 'list' ? (enabled ? [{ id: 7, name: 'office', display_name: 'Office', description: 'Create documents', content_hash: version() }] : []) : Buffer.from(zipSync(files)))
  const skills = createEnterpriseSkills({ state: () => state, request, home })
  return { skills, request, setState: value => { state = value }, state, disable: () => { enabled = false }, update: () => { files = { ...files, 'SKILL.md': Buffer.from('Updated instructions') } } }
}
describe('enterprise Work skill provider', () => {
  it('keeps local names independent and loads the complete verified bundle', async () => {
    const { skills } = await setup()
    const [row] = await skills.catalog()
    expect(row.name).not.toBe('office')
    expect(row.name).toMatch(/^bisheng-[a-f0-9]+-7$/)
    const loaded = await skills.load(row.name)
    expect(loaded.content).toContain('Enterprise instructions')
    expect(loaded.content).toContain('mcp__bisheng__bisheng_tool_7')
    expect(await readFile(join(loaded.resourceBase.path, 'templates/file.bin'))).toEqual(Buffer.from([0, 255, 42]))
    expect(await readFile(join(loaded.resourceBase.path, 'scripts/run.py'), 'utf8')).toBe('print(42)')
  })
  it('rechecks authorization before using cached files and refreshes edited versions', async () => {
    const { skills, update, disable, request } = await setup()
    const [row] = await skills.catalog()
    const first = await skills.load(row.name)
    await skills.load(row.name)
    expect(request.mock.calls.filter(([body]) => body.operation === 'bundle')).toHaveLength(1)
    update()
    const next = await skills.load(row.name)
    expect(next.path).not.toBe(first.path)
    expect(next.content).toContain('Updated instructions')
    disable()
    await expect(skills.load(row.name)).rejects.toThrow('no longer available')
  })
  it('isolates users, tenants, and logout, including account changes during downloads', async () => {
    const { skills, setState, state, request } = await setup()
    const [row] = await skills.catalog()
    setState({ ...state, user: { id: 4 }, connectionKey: 'key-b' }); skills.clear()
    expect((await skills.catalog())[0].name).not.toBe(row.name)
    await expect(skills.load(row.name)).rejects.toThrow('no longer available')
    setState(state)
    const original = request.getMockImplementation()
    request.mockImplementation(async body => { const result = await original(body); if (body.operation === 'bundle') setState({ ...state, connected: false }); return result })
    await expect(skills.load(row.name)).rejects.toThrow('account changed')
    expect(await skills.catalog()).toEqual([])
  })
  it('rejects bundle content substitutions and unsafe archive paths', async () => {
    const { skills, request } = await setup()
    const [row] = await skills.catalog()
    const original = request.getMockImplementation()
    request.mockImplementation(async body => body.operation !== 'bundle' ? original(body) : Buffer.from(zipSync({ '../outside': Buffer.from('x') })))
    await expect(skills.load(row.name)).rejects.toThrow('Unsafe ZIP')
    request.mockImplementation(async body => body.operation !== 'bundle' ? original(body) : Buffer.from(zipSync({ 'SKILL.md': Buffer.from('substituted') })))
    await expect(skills.load(row.name)).rejects.toThrow('verification failed')
  })
})

it('coexists with a same-named local skill in the actual Harness registry', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: SkillRegistry, renderSkillContent } = await import('@deepseek-ai/dsh-skill')
  const { applyEnterpriseSkills } = await import('../packages/dsh-desktop-enterprise/work-skills.js')
  const fixture = await setup()
  const ctx = new Context()
  const fork = ctx.plugin(SkillRegistry, {})
  await fork
  let disposeProvider = () => {}
  try {
    ctx.skills.register({ name: 'office', description: 'Local office', content: 'Local instructions', source: 'local' })
    applyEnterpriseSkills({ skills: { registerProvider: create => { disposeProvider = ctx.skills.registerProvider(create) } }, connection: { fetch: { register() {} } } }, {
      state: () => fixture.state, request: fixture.request, refreshState: async () => {}, home: homes.at(-1)
    })
    const catalog = await ctx.skills.list()
    expect(catalog).toHaveLength(2)
    const enterprise = catalog.find(row => row.provider === 'bisheng-enterprise')
    expect((await ctx.skills.get('office')).content).toBe('Local instructions')
    const loaded = await ctx.skills.get(enterprise.name)
    expect(renderSkillContent(loaded)).toContain('Enterprise instructions')
    expect(loaded.resourceBase.kind).toBe('directory')
    fixture.disable()
    await expect(ctx.skills.get(enterprise.name)).rejects.toThrow('no longer available')
  } finally { disposeProvider(); await fork.dispose() }
})
