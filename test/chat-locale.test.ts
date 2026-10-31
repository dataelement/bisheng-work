import vm from 'node:vm'
import { expect, it } from 'vitest'
import { chatLocaleScript } from '../src/main/enterprise/chat-locale'

it('delivers only the host locale and a page event without touching web preferences', () => {
  const root = { dataset: {} }
  const events: Array<{ type: string; detail: unknown }> = []
  const sandbox = {
    document: { documentElement: root },
    window: { dispatchEvent: (event: typeof events[number]) => events.push(event) },
    CustomEvent: class {
      constructor(public type: string, public options: { detail: unknown }) {}
      get detail() { return this.options.detail }
    }
  }
  vm.runInNewContext(chatLocaleScript('zh'), sandbox)
  expect(root.dataset).toEqual({ dshHostLocale: 'zh' })
  expect(events[0]).toMatchObject({ type: 'dsh:locale', detail: { locale: 'zh' } })
  vm.runInNewContext(chatLocaleScript('en'), sandbox)
  expect(root.dataset).toEqual({ dshHostLocale: 'en' })
  expect(events[1]).toMatchObject({ detail: { locale: 'en' } })
})
