import type { MenuItemConstructorOptions } from 'electron'

export interface DarwinApplicationMenuRoles {
  hide: MenuItemConstructorOptions
  hideOthers: MenuItemConstructorOptions
  showAll: MenuItemConstructorOptions
  quit: MenuItemConstructorOptions
}

/**
 * Hide, Hide Others, Show All, and Quit keep their AppKit actions. Their labels
 * are ours: a role alone follows the Chromium `lang` locked in before ready,
 * which stays English even when the Mac and the in-app language are Chinese.
 */
export function darwinApplicationMenuRoles(
  locale: 'en' | 'zh',
  appName: string
): DarwinApplicationMenuRoles {
  const zh = locale === 'zh'
  return {
    hide: {
      role: 'hide',
      label: zh ? `隐藏 ${appName}` : `Hide ${appName}`,
      accelerator: 'Command+H'
    },
    hideOthers: {
      role: 'hideOthers',
      label: zh ? '隐藏其他' : 'Hide Others',
      accelerator: 'Command+Alt+H'
    },
    showAll: {
      role: 'unhide',
      label: zh ? '全部显示' : 'Show All'
    },
    quit: {
      role: 'quit',
      label: zh ? `退出 ${appName}` : `Quit ${appName}`,
      accelerator: 'CommandOrControl+Q'
    }
  }
}
