import { describe, expect, it } from 'vitest'
import { parseWorkSkillRequest, readSkillBytes } from '../src/main/enterprise/work-skills'
describe('host skill transport', () => {
  it('accepts fixed operations and rejects caller supplied routes and invalid identities', () => {
    expect(parseWorkSkillRequest({ connectionKey: 'a', operation: 'list' }).operation).toBe('list')
    for (const value of [{ connectionKey: 'a', operation: 'list', path: '/admin' }, { connectionKey: 'a', operation: 'bundle', id: '../x', version: 'a'.repeat(64) }, { connectionKey: 'a', operation: 'bundle', id: 1, version: 'old' }]) expect(() => parseWorkSkillRequest(value)).toThrow()
  })
  it('bounds response bytes and propagates denied requests', async () => {
    await expect(readSkillBytes(new Response('abcd'), 3)).rejects.toThrow('supported size')
    await expect(readSkillBytes(new Response('', { status: 403 }), 100)).rejects.toMatchObject({ status: 403 })
    expect((await readSkillBytes(new Response('ok'), 3)).toString()).toBe('ok')
  })
})
