import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// Native Chromium checks the installed menu, material and layout hook together.
// Account services are replaced by an in-memory menu store.
const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-composer-menu-'))
const evidence = resolve(process.env.DSH_MENU_EVIDENCE ?? join(temporary, 'evidence'))
await mkdir(evidence, { recursive: true })
const region = (source, name) => {
  const start = source.indexOf(`//#region lib/types/${name}.js`)
  const end = source.indexOf('//#endregion', start)
  assert.ok(start >= 0 && end > start, `Installed runtime region: ${name}`)
  return source.slice(start, end)
}
try {
  const trigger = await readFile(join(process.env.DSH_MENU_SOURCE ?? root, 'node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js'), 'utf8')
  const primitives = await readFile(join(root, 'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js'), 'utf8')
  const styleStart = trigger.indexOf('\t\tconst css = ')
  const styleEnd = trigger.indexOf('//#endregion', styleStart)
  assert.ok(styleStart >= 0 && styleEnd > styleStart)
  await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import * as react from 'react'
    import React from 'react'
    import { Fragment, forwardRef, useId, useRef, useState, useLayoutEffect } from 'react'
    import * as react_jsx_runtime from 'react/jsx-runtime'
    import { jsx, jsxs } from 'react/jsx-runtime'
    import { createRoot } from 'react-dom/client'
    import { createPortal, flushSync } from 'react-dom'
    import css$14 from './node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/MenuSurface.module.css'
    const clsx = (...values) => values.filter(Boolean).join(' ')
    ${['overlay-top-margin', 'useAnchoredMaxHeight', 'MenuSurface'].map(name => region(primitives, name)).join('\n')}
    const _deepseek_ai_dsh_client_ui_primitives = { MenuSurface, useAnchoredMaxHeight }
    ${trigger.slice(styleStart, styleEnd)}
    ${region(trigger, 'core/menu')}
    ${region(trigger, 'client/MenuView')}
    window.addEventListener('error', event => console.error(JSON.stringify(window.scenario) + ' ' + event.error?.stack))
    const root = createRoot(document.getElementById('root'))
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
    const settle = async () => { for (let i = 0; i < 5; i++) await frame() }
    let state, listeners
    const dispatch = event => { state = menuReduce(state, event); listeners.forEach(fn => fn()) }
    const measure = () => {
      const menu = document.querySelector('[data-trigger-menu]')
      const list = document.querySelector('[role=listbox]')
      const bounds = menu.getBoundingClientRect()
      const clip = document.querySelector('.scroller').getBoundingClientRect()
      return { top: bounds.top, bottom: bounds.bottom, height: bounds.height, clipTop: clip.top,
        maxHeight: parseFloat(menu.style.maxHeight), scrollTop: list.scrollTop, fontSize: parseFloat(getComputedStyle(list.querySelector('[role=option]')).fontSize),
        fits: bounds.top >= clip.top - 1 && bounds.bottom <= clip.bottom + 1 }
    }
    const rowVisible = row => {
      const r = row.getBoundingClientRect(), l = row.parentElement.getBoundingClientRect()
      const c = document.querySelector('.scroller').getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return r.top >= Math.max(l.top, c.top) - 1 && r.bottom <= Math.min(l.bottom, c.bottom) + 1 && row.contains(hit)
    }
    window.setup = async ({ font, phase, theme }) => {
      flushSync(() => root.render(null))
      window.scenario = { font, phase, theme, width: innerWidth, height: innerHeight }
      document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark')
      document.documentElement.style.setProperty('--fixture-font', font + 'px')
      listeners = new Set()
      state = { open: false, hit: null, generation: 1, groups: [], highlight: null }
      const empty = new Map()
      flushSync(() => root.render(<section className="work">
        <header>聊天　　工作</header><div className={'scroller ' + phase}>
          {phase === 'active' && <div className="history">Existing conversation</div>}
          <div className="seat"><div data-composer-card className="card">
            <div className="anchor"><MenuView menu={{ subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => state }}
              headers={{ subscribe: () => () => {}, getSnapshot: () => empty }} t={key => key}
              onPick={(source, index) => { window.picked = index }} onCrumb={() => {}}
              onDismiss={() => { state = { ...state, open: false }; listeners.forEach(fn => fn()) }}
              onHover={(source, index) => dispatch({ type: 'hover', source, index })} /></div>
            <textarea aria-label="Message" defaultValue="Preserved draft" />
            <button id="add" onClick={() => {
              state = { ...state, open: true, groups: [{ source: 'commands', status: 'ready',
                items: Array.from({ length: 18 }, (_, i) => ({ name: 'command-' + i, label: '菜单选项 ' + i, section: i < 4 ? '添加' : '指令' })) }],
                highlight: { source: 'commands', index: 0 } }
              listeners.forEach(fn => fn())
            }}>＋</button>
          </div></div>
        </div></section>))
      if (phase === 'active') document.querySelector('.scroller').scrollTop = 9999
      document.querySelector('textarea').style.height = '78px'
      document.getElementById('add').click()
      await settle()
      const initial = measure()
      const list = document.querySelector('[role=listbox]'), rows = list.querySelectorAll('[role=option]')
      list.scrollTop = 0
      await settle()
      const firstVisible = rowVisible(rows[0])
      list.scrollTop = list.scrollHeight
      await settle()
      const lastVisible = rowVisible(rows[rows.length - 1])
      // Keyboard wrap must reveal both ends inside the same clipped list.
      dispatch({ type: 'move', dir: -1 }); await settle()
      const keyboardLast = rowVisible(rows[rows.length - 1])
      dispatch({ type: 'move', dir: 1 }); await settle()
      const keyboardFirst = rowVisible(rows[0])
      rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      return { ...initial, firstVisible, lastVisible, keyboardLast, keyboardFirst,
        picked: window.picked, draft: document.querySelector('textarea').value }
    }
    window.resizeCheck = async () => { await settle(); return measure() }
    window.growCheck = async () => {
      document.querySelector('textarea').style.height = '170px'
      document.documentElement.style.setProperty('--fixture-font', '26px')
      await settle()
      const result = measure(), list = document.querySelector('[role=listbox]'), rows = list.querySelectorAll('[role=option]')
      list.scrollTop = 0; await settle()
      result.firstVisible = rowVisible(rows[0])
      list.scrollTop = list.scrollHeight; await settle()
      result.lastVisible = rowVisible(rows[rows.length - 1])
      return result
    }
  ` }, bundle: true, outfile: join(temporary, 'renderer.js'), loader: { '.css': 'local-css' }, define: { 'process.env.NODE_ENV': '"production"' } })
  await writeFile(join(temporary, 'index.html'), `<!doctype html><html data-platform="win32"><head><link rel="stylesheet" href="renderer.css"><style>
    html,body,#root{margin:0;width:100%;height:100%;font-family:sans-serif}
    :root{--dsw-alias-label-primary:#202020;--dsw-specific-menu:#fafafa;--dsw-menu-surface-fill:#fafafa;--dsw-alias-border-l1:#ddd;--dsw-radius-lg:14px;--dsw-radius-md:8px}
    body[data-ds-dark-theme]{--dsw-alias-label-primary:#eee;--dsw-menu-surface-fill:#292929;--dsw-specific-menu:#292929;background:#222;color:#eee}
    .work{position:absolute;inset:40px 0 0 220px;display:flex;flex-direction:column;overflow:hidden}
    header{height:90px;flex:none;display:grid;place-items:center}
    .scroller{flex:1;min-height:0;display:flex;flex-direction:column;overflow-y:auto;padding:0 24px}
    .hero{justify-content:center}.history{height:1000px;flex:none}.seat{flex:none}.active .seat{position:sticky;bottom:0}
    .card{position:relative;background:var(--dsw-specific-menu);border:1px solid #ccc;border-radius:16px;padding:12px}
    .anchor{position:absolute;height:0;inset:0 0 auto}.card textarea{box-sizing:border-box;width:100%;height:78px;font-size:var(--fixture-font)}
    #add{display:block;width:30px;height:30px;margin-top:8px}
    [data-trigger-menu] [role=option]{font-size:var(--fixture-font);line-height:1.55}
  </style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  const entry = join(temporary, 'main.cjs')
  await writeFile(entry, `
    const assert = require('node:assert/strict')
    const { writeFileSync } = require('node:fs')
    const { app, BrowserWindow } = require('electron')
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ show: false, width: 1280, height: 900,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      window.webContents.on('console-message', event => console.log('renderer: ' + event.message))
      await window.loadFile(${JSON.stringify(join(temporary, 'index.html'))})
      const results = []
      for (const zoom of [1, 1.25, 1.5, 2]) for (const phase of ['hero', 'active']) for (const font of [13, 18, 24]) for (const theme of ['light', 'dark']) {
        window.setSize(1280, 900)
        window.webContents.setZoomFactor(zoom)
        const scenario = { zoom, phase, font, theme }
        const result = await window.webContents.executeJavaScript('window.setup(' + JSON.stringify(scenario) + ')')
        window.setSize(1100, 720)
        const resized = await window.webContents.executeJavaScript('window.resizeCheck()')
        const grown = await window.webContents.executeJavaScript('window.growCheck()')
        results.push({ ...scenario, ...result, resized, grown })
        if (zoom === 1.5 && phase === 'hero' && font === 18 && theme === 'light') {
          writeFileSync(${JSON.stringify(join(evidence, 'menu.png'))}, (await window.webContents.capturePage()).toPNG())
        }
      }
      writeFileSync(${JSON.stringify(join(evidence, 'results.json'))}, JSON.stringify({ platform: process.platform, results }, null, 2))
      const failures = results.filter(r => r.fontSize !== r.font || !r.fits || !r.firstVisible || !r.lastVisible || !r.keyboardLast || !r.keyboardFirst || !r.resized.fits || !r.grown.fits || !r.grown.firstVisible || !r.grown.lastVisible || r.picked !== 0 || r.draft !== 'Preserved draft')
      console.log(JSON.stringify({ platform: process.platform, scenarios: results.length, failures: failures.length, example: failures[0] }))
      assert.equal(failures.length, 0, 'Menu and every scroll destination fit the actual clipping boundary')
      window.destroy(); app.exit(0)
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [entry], { env: environment, stdio: 'inherit', signal: AbortSignal.timeout(120_000) })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, 'Native composer menu verification failed')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
