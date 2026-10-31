import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerNativeLocaleHandlers } from '../src/main/native-locale'
import { createNativeLocaleBridge } from '../src/preload/native-locale'
import { localeFromHtmlLang, NATIVE_LOCALE_CHANGE, NATIVE_LOCALE_READ, type HarnessLocale } from '../src/shared/native-locale'

function fixture() {
  const trusted = {} as IpcMainInvokeEvent
  const untrusted = {} as IpcMainInvokeEvent
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  const handlers = new Map<string, Handler>()
  const changed = vi.fn<(locale: HarnessLocale) => void>()
  registerNativeLocaleHandlers({
    handle: (channel, handler) => { handlers.set(channel, handler) },
    removeHandler: channel => { handlers.delete(channel) }
  }, {
    assertTrusted: event => {
      if (event !== trusted) throw new Error('Untrusted locale sender.')
    },
    systemLanguages: () => ['en-US', 'zh-CN'],
    changed
  })
  const invoke = async (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error('Missing locale handler.')
    return handler(event, ...args)
  }
  return { trusted, untrusted, changed, invoke }
}

describe('native Harness locale bridge', () => {
  it('delivers the live Chinese selection over an English system language and then switches back', async () => {
    const f = fixture()
    const localChanged = vi.fn()
    const failed = vi.fn()
    const bridge = createNativeLocaleBridge({
      read: () => f.invoke(NATIVE_LOCALE_READ, f.trusted),
      publish: locale => f.invoke(NATIVE_LOCALE_CHANGE, f.trusted, locale),
      changed: localChanged,
      failed
    })
    // The server's configForms still supplies the durable preference. The
    // native initialization only supplies the OS language order, without a write.
    await expect(bridge.read()).resolves.toEqual({ languages: ['en-US', 'zh-CN'], preference: null })
    bridge.onChange('zh')
    bridge.onChange('en')
    expect(f.changed.mock.calls).toEqual([['zh'], ['en']])
    expect(localChanged.mock.calls).toEqual([['zh'], ['en']])
    expect(failed).not.toHaveBeenCalled()
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.keys(bridge)).toEqual(['read', 'onChange'])
  })

  it('rejects untrusted initialization and changes before exposing languages or updating state', async () => {
    const f = fixture()
    await expect(f.invoke(NATIVE_LOCALE_READ, f.untrusted)).rejects.toThrow('Untrusted')
    await expect(f.invoke(NATIVE_LOCALE_CHANGE, f.untrusted, 'zh')).rejects.toThrow('Untrusted')
    expect(f.changed).not.toHaveBeenCalled()
  })

  it.each([null, undefined, 'ja', 'zh-CN', {}, ['zh']])('rejects malformed locale %j in main', async value => {
    const f = fixture()
    await expect(f.invoke(NATIVE_LOCALE_CHANGE, f.trusted, value)).rejects.toThrow('Invalid desktop locale')
    expect(f.changed).not.toHaveBeenCalled()
  })

  it.each([
    ['en', 'en'],
    ['EN', 'en'],
    ['en-US', 'en'],
    ['zh', 'zh'],
    ['zh-CN', 'zh'],
    ['zh-Hans-CN', 'zh']
  ] as const)('maps document language %s to %s', (lang, expected) => {
    expect(localeFromHtmlLang(lang)).toBe(expected)
  })

  it.each([null, undefined, '', '   ', 'ja', 'fr-FR'])('leaves document language %j unresolved', lang => {
    expect(localeFromHtmlLang(lang)).toBeUndefined()
  })

  it('does not publish unsupported locales from preload and reports transport failures', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('IPC unavailable'))
    const changed = vi.fn()
    const failed = vi.fn()
    const bridge = createNativeLocaleBridge({ read: vi.fn(), publish, changed, failed })
    bridge.onChange('ja')
    expect(publish).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid desktop locale.' }))
    bridge.onChange('zh')
    await Promise.resolve()
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'IPC unavailable' }))
  })
})
