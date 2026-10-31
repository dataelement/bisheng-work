import { expect, it, vi } from 'vitest'
import { applyMacosWindowBackdrop } from '../src/main/macos-window-backdrop'

it('keeps the rendered theme across minimize and restore, including an explicit light override', () => {
  let visible = true
  let minimized = false
  const window = { isDestroyed: () => false, isMinimized: () => minimized, isVisible: () => visible,
    setVibrancy: vi.fn(), setBackgroundColor: vi.fn() }
  for (const dark of [true, false, true]) {
    applyMacosWindowBackdrop(window, dark)
    expect(window.setVibrancy).toHaveBeenLastCalledWith(dark ? 'sidebar' : null)
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(dark ? '#00000000' : '#f9fafb')
    for (const state of ['minimized', 'hidden']) {
      minimized = state === 'minimized'
      visible = state !== 'hidden'
      applyMacosWindowBackdrop(window)
      expect(window.setVibrancy).toHaveBeenLastCalledWith(null)
      expect(window.setBackgroundColor).toHaveBeenLastCalledWith(dark ? '#1b1b1c' : '#f9fafb')
    }
    visible = true
    minimized = false
    applyMacosWindowBackdrop(window)
    expect(window.setVibrancy).toHaveBeenLastCalledWith(dark ? 'sidebar' : null)
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(dark ? '#00000000' : '#f9fafb')
  }
})
