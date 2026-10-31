// Coverage AC: AC-30, AC-31, AC-35, AC-56.
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import * as copy from '../packages/dsh-desktop-enterprise/error-copy.js'

const aliases = [
  ['content_blocked', 'CONTENT_FILTERED'],
  ['content_filter', 'CONTENT_FILTERED'],
  ['CONTENT_FILTERED', 'CONTENT_FILTERED'],
  ['  CONTENT_FILTERED  ', 'CONTENT_FILTERED'],
  ['check_unavailable', 'CONTENT_CHECK_UNAVAILABLE'],
  ['CONTENT_CHECK_UNAVAILABLE', 'CONTENT_CHECK_UNAVAILABLE']
]

describe('enterprise content safety copy', () => {
  it.each(aliases)('normalizes explicit protocol code %s without a login error', (wire, expected) => {
    expect(copy.resolveContentSafetyError(wire, '')).toEqual({ code: expected })
    expect(Object.hasOwn(copy.ACCOUNT_ERROR_COPY, wire.trim())).toBe(false)
  })

  it.each(['CONTENT_FILTERED', 'CONTENT_CHECK_UNAVAILABLE'])('provides complete fixed copy in three languages for %s', code => {
    const entry = copy.CONTENT_SAFETY_ERROR_COPY[code]
    expect(Object.keys(entry).sort()).toEqual(['en', 'ja', 'zh'])
    for (const language of ['zh', 'en', 'ja']) {
      expect(typeof entry[language]).toBe('string')
      expect(entry[language].trim().length).toBeGreaterThan(0)
      expect(entry[language]).not.toMatch(/<[a-z!/]/iu)
    }
  })

  it('keeps a tenant-defined safe reply instead of treating it as a translation key', () => {
    const message = 'Tenant custom reply Ω: keep numbers < 5.'
    expect(copy.resolveContentSafetyError('content_blocked', message)).toEqual({
      code: 'CONTENT_FILTERED', message
    })
    expect(copy.resolveContentSafetyError('check_unavailable', message)).toEqual({
      code: 'CONTENT_CHECK_UNAVAILABLE', message
    })
  })

  it('cleans controls and limits untrusted display text', () => {
    expect(copy.resolveContentSafetyError('content_blocked', ' Tenant\ncustom\u0000reply ')).toEqual({
      code: 'CONTENT_FILTERED', message: 'Tenant custom reply'
    })
    const result = copy.resolveContentSafetyError('content_blocked', 'x'.repeat(1024))
    expect(result.message.length).toBeLessThanOrEqual(300)
    expect(result.message.length).toBeGreaterThan(0)
  })

  it('discards an HTML error page and non-string messages', () => {
    expect(copy.resolveContentSafetyError('content_blocked', '<html>proxy failure</html>')).toEqual({ code: 'CONTENT_FILTERED' })
    expect(copy.resolveContentSafetyError('check_unavailable', { body: 'not display text' })).toEqual({ code: 'CONTENT_CHECK_UNAVAILABLE' })
  })

  it.each(['invalid_access_token', 'session_revoked', 'monthly_token_limit_exceeded', 'upstream_error', null, {}])(
    'does not reinterpret another failure as content safety: %s', code => {
      expect(copy.resolveContentSafetyError(code, 'content filtered')).toBeNull()
    }
  )

  it('declares the public copy and normalization interfaces for later adapters', async () => {
    const declaration = await readFile(new URL('../packages/dsh-desktop-enterprise/error-copy.d.ts', import.meta.url), 'utf8')
    expect(declaration).toContain('CONTENT_SAFETY_ERROR_COPY')
    expect(declaration).toContain('resolveContentSafetyError')
    expect(declaration).toContain('CONTENT_FILTERED')
    expect(declaration).toContain('CONTENT_CHECK_UNAVAILABLE')
  })
})
