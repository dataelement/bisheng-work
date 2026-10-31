import type { HarnessLocale } from '../shared/native-locale'

export interface SafeModeBannerElements {
  label: HTMLElement
  description: HTMLElement
  manage: HTMLButtonElement
  exit: HTMLButtonElement
  compact: HTMLButtonElement
}

/** Update text in place so focus, pending actions and compact layout survive. */
export function renderSafeModeBannerLocale(elements: SafeModeBannerElements, locale: HarnessLocale): void {
  const zh = locale === 'zh'
  elements.label.textContent = zh ? '安全模式' : 'Safe Mode'
  elements.description.textContent = zh
    ? '已暂时停用所有第三方插件，可停用有问题的插件后重启。'
    : 'All third-party plugins are temporarily disabled. Disable a problematic plugin, then restart.'
  elements.manage.textContent = zh ? '管理插件' : 'Manage plugins'
  elements.manage.setAttribute('aria-label', zh ? '停用或启用第三方插件' : 'Disable or re-enable third-party plugins')
  elements.exit.textContent = zh ? '退出安全模式' : 'Exit Safe Mode'
  elements.exit.setAttribute('aria-label', zh ? '退出安全模式并重启' : 'Exit Safe Mode and restart')
  elements.compact.title = zh ? '安全模式：管理插件' : 'Safe Mode: manage plugins'
  elements.compact.setAttribute('aria-label', elements.compact.title)
}
