import { describe, expect, it } from 'vitest'
import { darwinApplicationMenuRoles } from '../src/main/darwin-application-menu'

describe('macOS application menu roles', () => {
  it('labels hide, hide others, show all, and quit in Chinese while keeping their actions and shortcuts', () => {
    const roles = darwinApplicationMenuRoles('zh', 'BISHENG')
    expect(roles.hide).toMatchObject({ role: 'hide', label: '隐藏 BISHENG', accelerator: 'Command+H' })
    expect(roles.hideOthers).toMatchObject({ role: 'hideOthers', label: '隐藏其他', accelerator: 'Command+Alt+H' })
    expect(roles.showAll).toMatchObject({ role: 'unhide', label: '全部显示' })
    expect(roles.showAll.accelerator).toBeUndefined()
    expect(roles.quit).toMatchObject({ role: 'quit', label: '退出 BISHENG', accelerator: 'CommandOrControl+Q' })
  })

  it('labels the same actions in English', () => {
    const roles = darwinApplicationMenuRoles('en', 'BISHENG')
    expect(roles.hide.label).toBe('Hide BISHENG')
    expect(roles.hideOthers.label).toBe('Hide Others')
    expect(roles.showAll.label).toBe('Show All')
    expect(roles.quit.label).toBe('Quit BISHENG')
    expect(roles.hide.role).toBe('hide')
    expect(roles.quit.role).toBe('quit')
  })
})
