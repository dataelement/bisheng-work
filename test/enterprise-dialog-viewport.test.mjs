import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import { chatDialogViewportScript } from '../src/main/enterprise/chat-dialog-viewport'

it('preserves transparent client overlays while expanding and restoring the native viewport', () => {
  const dom = new JSDOM('<head><style>.dsh-knowledge-overlay { background: transparent; }</style></head><body><main id="root"></main><div class="dsh-knowledge-overlay"></div><div role="dialog">Upload</div></body>', { runScripts: 'outside-only' })
  try {
    const { document } = dom.window
    const bounds = { x: 280, y: 40, width: 800, height: 900 }
    for (const theme of ['light', 'dark']) {
      document.documentElement.className = theme
      dom.window.eval(chatDialogViewportScript(bounds))
      expect(document.documentElement.dataset.dshWindowDialog).toBe('open')
      expect(dom.window.getComputedStyle(document.querySelector('.dsh-knowledge-overlay')).backgroundColor).toBe('rgba(0, 0, 0, 0)')
      expect(dom.window.getComputedStyle(document.getElementById('root')).left).toBe('280px')
      dom.window.eval(chatDialogViewportScript(bounds))
      expect(document.querySelectorAll('#dsh-window-dialog-viewport')).toHaveLength(1)
      dom.window.eval(chatDialogViewportScript(undefined))
      expect(document.documentElement.dataset.dshWindowDialog).toBeUndefined()
      expect(document.getElementById('dsh-window-dialog-viewport')).toBeNull()
    }
  } finally { dom.window.close() }
})
