import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readBundleZip } from './offline-bundle.js'

const PROVIDER = 'bisheng-enterprise'
const hash = value => createHash('sha256').update(value).digest('hex')
const identity = state => state.connected && state.connectionKey && state.base && state.tenant?.id != null && state.user?.id != null
  ? hash(JSON.stringify([state.base, String(state.tenant.id), String(state.user.id)])) : null
export const enterpriseSkillName = (account, id) => `bisheng-${account.slice(0, 24)}-${id}`

// Matches the platform's content-addressed file mapping, including binary assets.
export function skillContentHash(files) {
  const digest = createHash('sha256')
  for (const name of [...files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    digest.update(name).update('\0').update(createHash('sha256').update(files.get(name).data).digest()).update('\0')
  }
  return digest.digest('hex')
}

export function createEnterpriseSkills({ state, request, home = process.env.DSH_HOME }) {
  let revision = 0
  const pending = new Map()
  const catalog = async signal => {
    const account = state(), key = identity(account), started = revision
    if (!key) return []
    const rows = await request({ operation: 'list', connectionKey: account.connectionKey }, signal)
    signal?.throwIfAborted()
    if (revision !== started || identity(state()) !== key || state().connectionKey !== account.connectionKey) throw new Error('Enterprise account changed.')
    if (!Array.isArray(rows) || rows.length > 10000) throw new Error('Invalid enterprise skill catalog.')
    const ids = new Set()
    return rows.map(row => {
      if (!Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id) || typeof row.name !== 'string' ||
          !/^[a-f0-9]{64}$/.test(row.content_hash) || typeof row.description !== 'string' || typeof row.display_name !== 'string') throw new Error('Invalid enterprise skill metadata.')
      ids.add(row.id)
      return { name: enterpriseSkillName(key, row.id), description: row.description || row.display_name,
        invocation: { modelInvocable: true, userInvocable: true }, source: 'bisheng', provider: PROVIDER, rank: 500,
        locator: { id: row.id, key, connectionKey: account.connectionKey, version: row.content_hash, originalName: row.name, displayName: row.display_name } }
    })
  }
  const materialize = async (candidate, signal) => {
    if (!home) throw new Error('Desktop skill storage is unavailable.')
    const loc = candidate.locator, started = revision
    const assertCurrent = () => {
      signal?.throwIfAborted()
      if (started !== revision || identity(state()) !== loc.key || state().connectionKey !== loc.connectionKey) throw new Error('Enterprise account changed.')
    }
    assertCurrent()
    // A fresh authorization check happens in load() before every cache use.
    const path = join(home, 'enterprise-skills', loc.key, String(loc.id), loc.version)
    let files
    try {
      const bytes = await readFile(join(path, 'bundle.zip'))
      files = readBundleZip(bytes)
      if (skillContentHash(files) !== loc.version) throw new Error('Skill cache checksum mismatch.')
      for (const [name, file] of files) {
        const target = join(path, 'files', name)
        if (!(await lstat(target)).isFile() || !(await readFile(target)).equals(file.data)) throw new Error('Skill cache requires refresh.')
      }
    } catch {
      const bytes = await request({ operation: 'bundle', connectionKey: loc.connectionKey, id: loc.id, version: loc.version }, signal)
      assertCurrent()
      files = readBundleZip(bytes)
      if (skillContentHash(files) !== loc.version || !files.has('SKILL.md')) throw new Error('Skill bundle content verification failed.')
      const temporary = `${path}.${randomUUID()}.tmp`
      await mkdir(temporary, { recursive: true, mode: 0o700 })
      try {
        for (const [name, file] of files) {
          const target = join(temporary, 'files', name)
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await writeFile(target, file.data, { mode: 0o600 })
        }
        await writeFile(join(temporary, 'bundle.zip'), bytes, { mode: 0o600 })
        assertCurrent()
        await rm(path, { recursive: true, force: true })
        await rename(temporary, path)
      } finally { await rm(temporary, { recursive: true, force: true }) }
    }
    assertCurrent()
    const toolIds = await request({ operation: 'dependencies', connectionKey: loc.connectionKey, id: loc.id, version: loc.version }, signal)
    assertCurrent()
    if (!Array.isArray(toolIds) || toolIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid enterprise tool dependencies.')
    const dependencies = toolIds.map(id => `- Tool ${id}: mcp__bisheng__bisheng_tool_${id}`).join('\n')
    const skill = files.get('SKILL.md')
    if (!skill) throw new Error('Skill instructions are missing.')
    const directory = join(path, 'files')
    return { ...candidate, path: join(directory, 'SKILL.md'), resourceBase: { kind: 'directory', path: directory },
      content: `Enterprise skill: ${loc.displayName}\nOriginal bundle name: ${loc.originalName}\nRun this skill in the current Work environment using its available tools and permissions. Resolve bundled scripts and templates relative to the skill resource base. Report any unavailable tool or runtime dependency.\n\n${skill.data.toString('utf8')}${dependencies ? `\n\nEnterprise tools available in this Work task:\n${dependencies}` : ''}` }
  }
  const load = async (name, signal) => {
    const candidate = (await catalog(signal)).find(row => row.name === name)
    if (!candidate) throw new Error('This enterprise skill is no longer available. Refresh the skill list.')
    // Coalesce only loads with the same authorization identity and revision.
    const key = `${candidate.locator.connectionKey}:${name}:${candidate.locator.version}`
    if (pending.has(key)) await pending.get(key).catch(() => undefined)
    signal?.throwIfAborted()
    const loading = materialize(candidate, signal)
    pending.set(key, loading)
    try { return await loading } finally { if (pending.get(key) === loading) pending.delete(key) }
  }
  return { catalog, load, clear: () => { revision++ } }
}

export function applyEnterpriseSkills(ctx, options) {
  const skills = createEnterpriseSkills(options)
  let invalidate = () => undefined
  ctx.skills.registerProvider(control => {
    invalidate = control.invalidate
    const timer = setInterval(control.invalidate, 30_000)
    timer.unref?.()
    control.signal.addEventListener('abort', () => { clearInterval(timer); skills.clear() }, { once: true })
    return { name: PROVIDER, list: async ({ signal }) => { await options.refreshState(); return skills.catalog(signal) },
      get: async (candidate, { signal }) => { await options.refreshState(); return skills.load(candidate.name, signal) } }
  })
  ctx.connection.fetch.register({ path: '/api/enterprise.work-skills', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const text = await request.text()
        if (text.length > 16384) throw new Error('Skill request is too large.')
        const body = JSON.parse(text)
        await options.refreshState()
        if (body.operation === 'catalog') {
          const rows = await skills.catalog(request.signal)
          invalidate()
          return Response.json({ skills: rows.map(row => ({ name: row.name, displayName: row.locator.displayName })) }, { headers: { 'cache-control': 'no-store' } })
        }
        if (body.operation !== 'validate' || !Array.isArray(body.names) || body.names.length > 50 || body.names.some(name => typeof name !== 'string')) throw new Error('Invalid skill selection.')
        for (const name of new Set(body.names)) await skills.load(name, request.signal)
        return Response.json({ ok: true })
      } catch (error) { return Response.json({ error: error.message }, { status: 400 }) }
    }
  })
  return { clear: () => { skills.clear(); invalidate() } }
}
