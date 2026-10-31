export type HarnessLocale = 'en' | 'zh'

export function resolveHarnessLocale(
  preference: unknown,
  preferredSystemLanguages: readonly string[]
): HarnessLocale {
  if (preference === 'zh' || preference === 'en') return preference

  return preferredSystemLanguages[0]?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * Locale for native menus and dialogs. The Client publishes the live Profile
 * language; until that arrives, follow the system language. The retired
 * settings.yaml is not a source after Harness moves it into the Profile.
 */
export function resolveShellLocale(
  active: HarnessLocale | undefined,
  preferredSystemLanguages: readonly string[]
): HarnessLocale {
  if (active) return active
  return resolveHarnessLocale(undefined, preferredSystemLanguages)
}
