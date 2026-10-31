/** Render the production sidebar/history controller in an isolated Electron window. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-history-cache-'))
try {
  const source = await readFile(join(root, 'packages/dsh-desktop-client-ui/client.js'), 'utf8')
  await build({ stdin: { contents: `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { flushSync } from 'react-dom'
    let plugin
    window.__ModuleLoader__ = { load({ factory }) {
      plugin = factory(name => {
        if (name === 'react') return React
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
        throw new Error(name)
      })
    } }
    new Function(${JSON.stringify(source)})()
    const registrations = new Map(), cleanups = []
    const snapshot = { connected: true, epoch: 1, phase: 'ready', conversationId: 'new' }
    const items = Array.from({ length: 40 }, (_, i) => ({ id: 'row-' + i, title: 'Conversation ' + i, updatedAt: '2026-10-30' }))
    let pending, calls = 0
    window.dshEnterpriseChat = {
      state: async () => snapshot, subscribe: () => () => {}, open: async () => {},
      history: async () => { calls++; return pending ? pending.promise : { epoch: 1, items, hasMore: false } }
    }
    const emptyStore = { getSnapshot: () => ({ phase: 'ready', byId: {}, activePanelId: null }), subscribe: () => () => {} }
    plugin.apply({
      inject() {}, remote: {},
      locale: { register() {}, bind: () => key => key },
      sessions: { list: emptyStore },
      layout: { panelInfo: emptyStore, selectPanel() {} },
      uiWorkspace: { registerNavigationHandler: () => () => {} },
      effect(fn) { const stop = fn(); if (typeof stop === 'function') cleanups.push(stop) },
      slots: { inject(name, fn) { if (name === 'sidebar.workspaces.collection') fn() }, register(spec, component) { registrations.set(spec.name, { component, props: spec.inject() }) } }
    })
    const entry = registrations.get('sidebar.workspaces.collection')
    const navigation = entry.props.navigation
    const stop = navigation.start()
    const reactRoot = createRoot(document.getElementById('list'))
    flushSync(() => reactRoot.render(React.createElement(entry.component, { ...entry.props, projects: () => null, items: [], mode: 'projects', query: '', archivedOnly: false })))
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
    const check = (value, message) => { if (!value) throw new Error(message) }
    window.verifyHistory = async () => {
      while (document.querySelectorAll('[data-history-kind=chat]').length !== 40) await frame()
      const scroller = document.getElementById('list')
      const rows = [...document.querySelectorAll('[data-history-kind=chat]')]
      scroller.scrollTop = 190
      const top = scroller.scrollTop
      let resolve
      pending = { promise: new Promise(done => { resolve = done }) }
      const before = calls
      window.dispatchEvent(new CustomEvent('dsh-desktop:enterprise-account-changed'))
      for (let i = 0; i < 30; i++) {
        await frame()
        if (i === 8) window.dispatchEvent(new CustomEvent('dsh-desktop:enterprise-account-changed'))
        const visible = [...document.querySelectorAll('[data-history-kind=chat]')]
        check(visible.length === 40 && visible.every((row, index) => row === rows[index]), 'Rows changed during refresh frame ' + i)
        check(scroller.scrollTop === top, 'Scroll moved during refresh')
        check(!document.querySelector('[role=status]'), 'Background loading shifted the list')
      }
      check(calls === before + 1, 'Refresh requests were duplicated')
      resolve({ epoch: 1, items: items.map(item => ({ ...item, title: 'Updated ' + item.id })), hasMore: false })
      while (!rows[0].title.startsWith('Updated')) await frame()
      check(scroller.scrollTop === top, 'Scroll moved after replacement')
      check(document.querySelector('[data-history-kind=chat]') === rows[0], 'Stable row remounted')
      pending = undefined
      return { frames: 30, rows: rows.length, scrollTop: top }
    }
    window.disposeFixture = () => { stop(); reactRoot.unmount(); cleanups.reverse().forEach(fn => fn()) }
  `, resolveDir: root, loader: 'js' }, bundle: true, platform: 'browser', outfile: join(temporary, 'renderer.js') })
  await writeFile(join(temporary, 'index.html'), '<style>:root{--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#888}body{margin:0;font:14px sans-serif}#list{height:400px;overflow:auto}</style><div id="list"></div><script src="renderer.js"></script>')
  await writeFile(join(temporary, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ width: 400, height: 500, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      for (const width of [300, 400, 520]) {
        window.setSize(width, 500)
        for (const theme of ['light', 'dark']) {
          await window.loadFile(${JSON.stringify(join(temporary, 'index.html'))})
          await window.webContents.executeJavaScript('document.body.toggleAttribute("data-ds-dark-theme", ' + (theme === 'dark') + ')')
          const result = await window.webContents.executeJavaScript('window.verifyHistory()')
          console.log('PASS width=' + width + ' theme=' + theme + ' ' + JSON.stringify(result))
          await window.webContents.executeJavaScript('window.disposeFixture()')
        }
      }
      console.log('Electron ' + process.versions.electron + ' / ' + process.platform)
      window.destroy(); app.exit(0)
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [join(temporary, 'main.cjs')], { env, stdio: 'inherit', signal: AbortSignal.timeout(60_000) })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, 'Electron history cache verification failed')
} finally { await rm(temporary, { recursive: true, force: true }) }
