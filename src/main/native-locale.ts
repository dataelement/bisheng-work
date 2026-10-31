import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { NATIVE_LOCALE_CHANGE, NATIVE_LOCALE_READ, parseHarnessLocale, type HarnessLocale, type NativeLocaleBootstrap } from '../shared/native-locale'

/** Consume the upstream locale bridge without duplicating Profile preference storage. */
export function registerNativeLocaleHandlers(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  options: {
    assertTrusted(event: IpcMainInvokeEvent): void
    systemLanguages(): readonly string[]
    changed(locale: HarnessLocale): void
  }
): void {
  ipc.removeHandler(NATIVE_LOCALE_READ)
  ipc.handle(NATIVE_LOCALE_READ, (event): NativeLocaleBootstrap => {
    options.assertTrusted(event)
    // configForms supplies the current Profile preference to Harness. A null
    // bootstrap preference preserves its automatic mode and avoids a second reader.
    return { languages: options.systemLanguages(), preference: null }
  })
  ipc.removeHandler(NATIVE_LOCALE_CHANGE)
  ipc.handle(NATIVE_LOCALE_CHANGE, (event, value: unknown) => {
    options.assertTrusted(event)
    options.changed(parseHarnessLocale(value))
  })
}
