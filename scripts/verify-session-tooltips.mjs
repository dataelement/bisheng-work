import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// Run on a native desktop. Real Chromium geometry is required for CSS containment.
const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-session-tooltip-'))
try {
  const source = await readFile(join(root, 'packages/dsh-desktop-client-ui/client.js'), 'utf8')
  const styles = source.match(/function installDesktopModes\(ctx\)[\s\S]*?style\.textContent = `([\s\S]*?)`/)
  assert.ok(styles, 'Desktop mode stylesheet is available')
  // Load the installed Tooltip and its hooks directly; unrelated primitives have
  // build-time-only imports that are intentionally absent from Desktop installs.
  const primitiveSource = await readFile(join(root, 'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js'), 'utf8')
  const region = name => {
    const marker = `//#region lib/types/${name}.js`
    const start = primitiveSource.indexOf(marker)
    assert.ok(start >= 0, `Installed primitive region: ${name}`)
    const end = primitiveSource.indexOf('//#endregion', start)
    assert.ok(end > start)
    return primitiveSource.slice(start + marker.length, end)
  }
  const tooltipSource = ['input-modality', 'useDismissOnOutsidePointer', 'Tooltip'].map(region).join('\n')
  await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React, { cloneElement, createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
    import { jsx, jsxs } from 'react/jsx-runtime'
    import { createRoot } from 'react-dom/client'
    import { flushSync, createPortal } from 'react-dom'
    import css$23 from './node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/Tooltip.module.css'
    ${tooltipSource}
    const root = createRoot(document.getElementById('root'))
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
    window.checkScenario = async ({ sidebar, inspector, scroll, keyboard, side }) => {
      flushSync(() => root.render(
        <div className="fixture" style={{ gridTemplateColumns: sidebar + 'px minmax(0,1fr)' }}>
          <aside>Projects</aside>
          <div className="dshModes">
            <header className="dshModesHeader">Chat / Work</header>
            <section className="dshModeBody dshWorkContent" style={{ gridTemplateColumns: 'minmax(0,1fr) ' + inspector + 'px' }}>
              <article className="conversation">
                <div style={{ height: 180 }} />
                <div className="actions">
                  <Tooltip label="Copy" side={side}><button id="copy" aria-label="Copy">Copy</button></Tooltip>
                  <Tooltip label="Branch" side={side}><button id="branch">Branch</button></Tooltip>
                </div>
                <div style={{ height: 1200 }} />
              </article>
              <aside className="inspector">Changes</aside>
            </section>
          </div>
        </div>
      ))
      document.querySelector('.conversation').scrollTop = scroll
      await frame()
      const button = document.getElementById('copy')
      if (keyboard) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
        button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      } else button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      let bubble
      for (let attempt = 0; attempt < 30; attempt++) {
        await frame()
        bubble = document.querySelector('[role=tooltip]')
        if (bubble && getComputedStyle(bubble).visibility === 'visible') break
      }
      if (!bubble) throw new Error('Tooltip did not open')
      const a = button.getBoundingClientRect(), b = bubble.getBoundingClientRect()
      const result = {
        dx: b.x + b.width / 2 - a.x - a.width / 2,
        gap: side === 'top' ? a.top - b.bottom : b.top - a.bottom,
        visible: getComputedStyle(bubble).visibility,
        withinViewport: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight,
        inspectorWidth: document.querySelector('.inspector').getBoundingClientRect().width,
      }
      button.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
      await frame()
      result.dismissed = document.querySelector('[role=tooltip]') === null
      return result
    }
  ` }, bundle: true, outfile: join(temporary, 'renderer.js'), loader: { '.css': 'local-css' }, define: { 'process.env.NODE_ENV': '"production"' } })
  await writeFile(join(temporary, 'index.html'), `<!doctype html><html><head><link rel="stylesheet" href="renderer.css"><style>
    html,body,#root{margin:0;width:100%;height:100%}body{font-family:sans-serif}
    .fixture{display:grid;position:absolute;inset:48px 0 0}
    .conversation{min-width:0;min-height:0;overflow:auto}.actions{display:flex;justify-content:flex-end;gap:8px;padding:0 32px}
    button{width:48px;height:30px}.inspector{overflow:hidden}
    ${styles[1]}
  </style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  const entry = join(temporary, 'main.cjs')
  await writeFile(entry, `
    const assert = require('node:assert/strict')
    const { app, BrowserWindow } = require('electron')
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ show: false, width: 1400, height: 900,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      await window.loadFile(${JSON.stringify(join(temporary, 'index.html'))})
      let count = 0
      for (const zoom of [0.8, 1, 1.25]) {
        window.webContents.setZoomFactor(zoom)
        for (const [sidebar, inspector] of [[280, 360], [64, 360], [280, 0]]) {
          for (const side of ['top', 'bottom']) {
            for (const keyboard of [false, true]) {
              const scenario = { sidebar, inspector, side, keyboard, scroll: 80 }
              const result = await window.webContents.executeJavaScript('window.checkScenario(' + JSON.stringify(scenario) + ')')
              console.log(JSON.stringify({ zoom, ...scenario, ...result }))
              assert.ok(Math.abs(result.dx) < 1.5, 'Tooltip horizontal anchor: ' + result.dx)
              assert.ok(Math.abs(result.gap - 8) < 1.5, 'Tooltip vertical gap: ' + result.gap)
              assert.equal(result.visible, 'visible')
              assert.equal(result.withinViewport, true)
              assert.equal(result.dismissed, true)
              assert.ok(Math.abs(result.inspectorWidth - inspector) < 1.5)
              count++
            }
          }
        }
      }
      console.log('PASS: ' + count + ' real Electron tooltip placement scenarios')
      window.destroy()
      app.exit(0)
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [entry], {
    env: environment, stdio: 'inherit', signal: AbortSignal.timeout(60_000)
  })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, 'Session tooltip placement verification failed')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
