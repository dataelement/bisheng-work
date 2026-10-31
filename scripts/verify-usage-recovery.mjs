import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'bisheng-usage-'))
try {
  const client = await readFile(join(root, 'packages/dsh-desktop-settings/client.js'), 'utf8')
  const renderer = await build({ stdin: { resolveDir: root, contents: `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    let definition, Component, props, reads = 0, phase = 'error', epoch = 1, mode = 'offline'
    const listeners = new Set(), dictionaries = new Map()
    window.fetch = async () => ({ ok: true, json: async () => ({connected: true}) })
    window.__ModuleLoader__ = { load: value => definition = value }
    ${client}
    const totals = { total_tokens: 1200, input_tokens: 1000, output_tokens: 200, message_count: 12, missing_usage_count: 0 }
    const summary = { status: 'ready', data: { totals, points: [] } }
    const storage = { status: 'ready', data: { used: 0.05, limit: 1 } }
    window.dshEnterpriseChat = {
      state: async () => ({ connected: true, phase, epoch }),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      usage: async () => { reads++; if (mode === 'offline') throw new Error('fixture offline'); return { summary: mode === 'summary-error' ? {status:'error'} : summary, storage: mode === 'storage-error' ? {status:'error'} : storage } }
    }
    const primitives = new Proxy({
      Tooltip: ({ children }) => children,
      SegmentedControl: ({ options, onChange }) => React.createElement('div', null, options.map(item => React.createElement('button', {key:item.value,onClick:()=>onChange(item.value)}, item.label)))
    }, { get: (target, key) => target[key] ?? (() => null) })
    const plugin = definition.factory(id => id === 'react' ? React : primitives)
    plugin.apply({
      locale: { register: (ns, value) => dictionaries.set(ns, value), bind: ns => (key, params={}) => dictionaries.get(ns).zh[key]?.replace(/\\{(\\w+)\\}/g, (_, name) => String(params[name] ?? '')) },
      effect: fn => fn(),
      slots: { inject: (_name, fn) => fn(), register: (options, value) => { if (options.name === 'desktop.account.usage') { Component = value; props = options.inject() } return () => {} } }
    })
    window.fixture = {
      reads: () => reads,
      mode: value => { mode = value },
      phase: value => { phase = value; listeners.forEach(listener => listener({connected:true,phase,epoch})) }
    }
    createRoot(document.getElementById('root')).render(React.createElement(Component, { ...props, credits:'12.0', creditsLabel:'剩余积分', models:React.createElement('p', {id:'models'}, '企业提供的模型') }))
  ` }, bundle: true, platform: 'browser', format: 'iife', write: false })
  const html = join(temporary, 'index.html')
  await writeFile(html, '<meta charset="utf-8"><style>body{font:14px sans-serif;padding:24px;background:#fff;color:#222;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#555}button{padding:6px 14px;margin:8px}</style><div id="root"></div><script>' + renderer.outputFiles[0].text + '</script>')
  const entry = join(temporary, 'main.cjs')
  await build({ stdin: { contents: `
    import assert from 'node:assert/strict'
    import { app, BrowserWindow } from 'electron'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ show: false, width: 900, height: 720, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      await window.loadFile(${JSON.stringify(html)})
      const evaluate = code => window.webContents.executeJavaScript(code)
      const waitFor = async expression => {
        for(let i=0;i<100;i++) { if(await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 20)) }
        throw new Error('Renderer condition timed out: ' + expression)
      }
      await waitFor('!!document.querySelector("[role=alert] button")')
      assert.equal(await evaluate('fixture.reads()'), 1)
      await evaluate('fixture.mode("success")')
      const point = await evaluate('(() => { const r=document.querySelector("[role=alert] button").getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()')
      window.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1})
      window.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1})
      await waitFor('!!document.querySelector(".dshUsageOverview")')
      assert.equal(await evaluate('fixture.reads()'), 2)
      await evaluate('fixture.mode("storage-error");fixture.phase("ready")')
      await waitFor('document.querySelector("[role=alert]")?.textContent.includes("存储空间")')
      assert.equal(await evaluate('!!document.querySelector(".dshUsageOverview")'), true)
      await evaluate('fixture.mode("summary-error");document.querySelector("[role=alert] button").click()')
      await waitFor('document.querySelector("[role=alert]")?.textContent.includes("用量统计")')
      assert.equal(await evaluate('!!document.querySelector(".dshUsageStorage")'), true)
      assert.equal(await evaluate('!!document.querySelector("#models")'), true)
      console.log('PASS native Electron retry click, same-epoch ready recovery, independent summary/storage failures; Electron ' + process.versions.electron + '; OS ' + process.platform)
      window.destroy(); app.exit(0)
    }).catch(error => { console.error(error); app.exit(1) })
  `, resolveDir: root }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [entry], { env, stdio: 'inherit', signal: AbortSignal.timeout(30_000) })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, 'Native usage recovery verification failed')
} finally { await rm(temporary, { recursive: true, force: true }) }
