import { parseHarnessLocale, type HarnessLocale, type NativeLocaleBridge } from '../shared/native-locale'

export function createNativeLocaleBridge(options: {
  read(): Promise<unknown>
  publish(locale: HarnessLocale): Promise<unknown>
  changed(locale: HarnessLocale): void
  failed(error: unknown): void
}): NativeLocaleBridge {
  return Object.freeze({
    read: () => options.read(),
    onChange(value: string): void {
      try {
        const locale = parseHarnessLocale(value)
        options.changed(locale)
        void options.publish(locale).catch(options.failed)
      } catch (error) {
        options.failed(error)
      }
    }
  })
}
