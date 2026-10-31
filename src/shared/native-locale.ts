export type HarnessLocale = 'en' | 'zh'

export const NATIVE_LOCALE_BRIDGE = '__DSH_LOCALE__'
export const NATIVE_LOCALE_READ = 'desktop:locale-read'
export const NATIVE_LOCALE_CHANGE = 'desktop:locale-change'

export interface NativeLocaleBootstrap {
  languages: readonly string[]
  preference: string | null
}

/** The official Harness native bridge; the Profile remains the preference owner. */
export interface NativeLocaleBridge {
  read(): Promise<unknown>
  onChange(locale: string): void
}

export function parseHarnessLocale(value: unknown): HarnessLocale {
  if (value !== 'zh' && value !== 'en') throw new TypeError('Invalid desktop locale.')
  return value
}

/** The Client writes `en` or `zh-CN` onto `<html lang>`. Other tags stay unresolved. */
export function localeFromHtmlLang(lang: string | null | undefined): HarnessLocale | undefined {
  const value = lang?.trim().toLowerCase()
  if (!value) return undefined
  if (value === 'zh' || value.startsWith('zh-')) return 'zh'
  if (value === 'en' || value.startsWith('en-')) return 'en'
  return undefined
}
