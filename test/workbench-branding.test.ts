import { describe, expect, it } from 'vitest'
import { parseEnterpriseNavigation, parseWorkbenchBranding } from '../src/shared/enterprise-chat-view'

describe('workbench welcome presentation', () => {
  const branding = { welcomeMessage: 'Team workspace', assistantIcon: { enabled: true, image: 'https://files.example/logo.svg?signature=test' } }
  it('keeps only public display fields and supports hidden icons', () => {
    expect(parseEnterpriseNavigation({ entries: [], branding: { ...branding, token: 'ignored' } }).branding).toEqual(branding)
    expect(parseWorkbenchBranding({ ...branding, assistantIcon: { ...branding.assistantIcon, enabled: false } }).assistantIcon.enabled).toBe(false)
  })
  it.each(['javascript:alert(1)', 'data:image/svg+xml,test', 'file:///tmp/logo', 'https://user:password@example.com/logo'])('rejects unsupported logo source %s', image => {
    expect(() => parseWorkbenchBranding({ ...branding, assistantIcon: { enabled: true, image } })).toThrow()
  })
  it('bounds incoming content while preserving older navigation reports', () => {
    expect(() => parseWorkbenchBranding({ ...branding, welcomeMessage: 'x'.repeat(1001) })).toThrow()
    expect(parseEnterpriseNavigation({ entries: [] })).toEqual({ entries: [], homeLabel: '' })
  })
})


it('accepts the complete capability navigation and keeps existing module entries', () => {
  const entries = ['capabilities', 'knowledge', 'channel', 'apps', 'skills', 'square'].map(id => ({ id, path: `/${id}`, label: id, active: false, primary: true }));
  expect(parseEnterpriseNavigation({ entries }).entries.map(row => row.id)).toEqual(entries.map(row => row.id));
  expect(() => parseEnterpriseNavigation({ entries: [{ ...entries[0], path: '/admin' }] })).toThrow();
  expect(() => parseEnterpriseNavigation({ entries: [...entries, entries[0]] })).toThrow();
});
