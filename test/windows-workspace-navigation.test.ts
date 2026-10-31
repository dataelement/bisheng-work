import { describe, expect, it } from 'vitest'
import { chatLayoutCss } from '../src/main/enterprise/chat-layout'

describe('enterprise content window chrome', () => {
  it.each(['win32', 'linux'] as const)('keeps %s content in the client area', platform => {
    const css = chatLayoutCss(platform)
    expect(css).toContain('height: 48px')
    expect(css).toContain('-webkit-app-region: no-drag')
    expect(css.match(/-webkit-app-region:\s*drag\s*;/gu) ?? []).toHaveLength(0)
  })

  it('gives the macOS Chat header its native drag region', () => {
    expect(chatLayoutCss('darwin')).toContain('.dsh-chat-surface .dsh-chat-header { -webkit-app-region: drag; }')
  })
})
