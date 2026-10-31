import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { buildSafeModeViewModel } from '../src/main/safe-mode'
import { renderSafeModeBannerLocale } from '../src/preload/safe-mode-locale'

const notice = {
  zh: '正常配置恢复需要处理。自动维护已暂停，恢复材料已保留。',
  en: 'Normal Profile recovery needs attention. Automatic maintenance is paused and recovery material is preserved.',
  detail: 'plugin restore recovery state is unreadable: backup path resolves outside the recovery root'
}
const model = (locale, extra = {}) => buildSafeModeViewModel({ locale, plugins: ['example'], notice, noticeTone: 'error', ...extra })

function page(locale = 'en', extra = {}) {
  const action = vi.fn().mockResolvedValue({ ok: true })
  const dom = new JSDOM(readFileSync(new URL('../build/safe-mode.html', import.meta.url), 'utf8'), {
    url: `https://desktop.test/safe-mode.html?seq=1&state=${encodeURIComponent(JSON.stringify(model(locale, extra)))}`,
    runScripts: 'dangerously',
    beforeParse(window) { window.dshSafeMode = { action } }
  })
  const doc = dom.window.document
  const update = (locale, extra = {}, seq = '1') => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: dom.window, data: { type: 'dsh-safe-mode:model', seq, model: model(locale, extra) }
  }))
  return { dom, doc, action, update }
}

describe('Safe Mode live language', () => {
  it('localizes recovery guidance at render time and retains original diagnostic detail', () => {
    expect(model('zh').noticeSummary).toBe(notice.zh)
    expect(model('zh').notice).toContain(notice.detail)
    expect(model('en').noticeSummary).toBe(notice.en)
  })

  it('updates an already open recovery page after Chinese arrives, then switches back', () => {
    const f = page('en', { recoveryLocked: true })
    try {
      expect(f.doc.getElementById('page-title').textContent).toBe('Manage plugins')
      f.update('zh', { recoveryLocked: true })
      expect(f.doc.documentElement.lang).toBe('zh-CN')
      expect(f.doc.getElementById('page-title').textContent).toBe('管理插件')
      expect(f.doc.getElementById('notice-preview').textContent).toBe(notice.zh)
      expect(f.doc.getElementById('notice-full').textContent).toContain(notice.detail)
      expect(f.doc.getElementById('notice-details').hidden).toBe(false)
      expect(f.doc.getElementById('notice-details').open).toBe(false)
      expect(f.doc.getElementById('restart').textContent).toBe('退出安全模式并重启')
      expect(f.doc.getElementById('quit').textContent).toBe('退出 BISHENG')
      expect(f.doc.getElementById('recovery-open').textContent).toBe('打开恢复材料目录')
      expect(f.doc.getElementById('repair-agent').textContent).toBe('让智能修复助手分析日志 →')
      f.update('en', { recoveryLocked: true })
      expect(f.doc.getElementById('notice-preview').textContent).toBe(notice.en)
      expect(f.doc.documentElement.lang).toBe('en')
    } finally { f.dom.window.close() }
  })

  it('preserves selection, expanded diagnostics and pending actions during updates', () => {
    const f = page()
    try {
      const checkbox = f.doc.querySelector('.plugin input')
      checkbox.click()
      const details = f.doc.getElementById('notice-details')
      details.open = true
      f.update('zh')
      expect(checkbox.checked).toBe(true)
      expect(details.open).toBe(true)
      expect(f.doc.querySelector('.plugin-action').textContent).toContain('停用')
      f.doc.getElementById('apply').click()
      expect(f.action).toHaveBeenCalledWith('apply', { plugins: ['example'], issues: [] })
      f.update('en')
      expect(f.doc.getElementById('apply').textContent).toBe('Disabling…')
      expect(f.doc.getElementById('apply').disabled).toBe(true)
      expect(f.doc.getElementById('restart').disabled).toBe(true)
      expect(checkbox.checked).toBe(true)
      f.update('zh', {}, 'stale')
      expect(f.doc.documentElement.lang).toBe('en')
    } finally { f.dom.window.close() }
  })

  it('sends the repair prompt in the language active when clicked', () => {
    const f = page()
    try {
      f.update('zh')
      f.doc.getElementById('repair-agent').click()
      expect(f.action).toHaveBeenCalledWith('agent', { prompt: expect.stringContaining('诊断事实') })
    } finally { f.dom.window.close() }
  })

  it('updates banner labels and accessible names without replacing controls or resetting busy state', () => {
    const dom = new JSDOM()
    try {
      const make = tag => dom.window.document.createElement(tag)
      const elements = { label: make('span'), description: make('span'), manage: make('button'), exit: make('button'), compact: make('button') }
      renderSafeModeBannerLocale(elements, 'en')
      elements.exit.disabled = true
      renderSafeModeBannerLocale(elements, 'zh')
      expect(elements.label.textContent).toBe('安全模式')
      expect(elements.manage.textContent).toBe('管理插件')
      expect(elements.exit.getAttribute('aria-label')).toBe('退出安全模式并重启')
      expect(elements.compact.title).toBe('安全模式：管理插件')
      expect(elements.exit.disabled).toBe(true)
      renderSafeModeBannerLocale(elements, 'en')
      expect(elements.manage.textContent).toBe('Manage plugins')
      expect(elements.compact.getAttribute('aria-label')).toBe('Safe Mode: manage plugins')
    } finally { dom.window.close() }
  })
})
