import { afterEach, expect, it, vi } from 'vitest'
import { mobileBridgePort, harnessPreferredPort } from '../src/main/desktop-ports'
afterEach(() => vi.unstubAllEnvs())
it('isolates concurrent development profiles while retaining release ports', () => {
  vi.stubEnv('BISHENG_DEV_PORT_OFFSET', '101')
  expect(mobileBridgePort(true)).toBe(43328)
  expect(harnessPreferredPort(true)).toBe(43330)
  expect(mobileBridgePort(false)).toBe(43227)
  expect(harnessPreferredPort(false)).toBe(43229)
})
it('retains default development ports and rejects invalid configured offsets', () => {
  vi.stubEnv('BISHENG_DEV_PORT_OFFSET', '')
  expect(mobileBridgePort(true)).toBe(43228)
  for (const offset of ['0', '-1', '1.5', '99999', 'abc']) {
    vi.stubEnv('BISHENG_DEV_PORT_OFFSET', offset)
    expect(() => harnessPreferredPort(true)).toThrow('BISHENG_DEV_PORT_OFFSET')
  }
})
