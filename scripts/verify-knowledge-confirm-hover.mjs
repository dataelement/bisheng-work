import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'

// Exercise the owning component, installed Button/Modal and shipped theme in Chromium.
// Only the remote catalog and composer store use fixtures; the user profile stays isolated.
const root = resolve(import.meta.dirname, '..')
const output = resolve(process.env.KNOWLEDGE_VERIFY_OUTPUT || join(root, 'artifacts/knowledge-confirm-hover'))
const temporary = await mkdtemp(join(tmpdir(), 'bisheng-knowledge-hover-'))
try {
  await mkdir(output, { recursive: true })
  const desktop = await readFile(process.env.KNOWLEDGE_SOURCE || join(root, 'packages/dsh-desktop-client-ui/client.js'), 'utf8')
  const theme = await readFile(join(root, 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'), 'utf8')
  const themeCss = theme.match(/var design_platform_css_default = ("[^\n]+");/)?.[1]
  assert.ok(themeCss, 'Installed theme exposes its stylesheet')
  const frontend = join(root, 'node_modules/@deepseek-ai/dsh-web-frontend/dist')
  const html = await readFile(join(frontend, 'index.html'), 'utf8')
  const entry = html.match(/<script[^>]*src="([^"?]+)/)?.[1]
  assert.ok(entry, 'Shipped frontend entry exists')
  await build({ entryPoints: [join(frontend, entry)], bundle: true, format: 'iife', outfile: join(temporary, 'shared.js') })
  const styles = await Promise.all([...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map(match => readFile(join(frontend, match[1]), 'utf8')))
  await build({ stdin: { resolveDir: root, contents: `
    const modules = window.fixtureModules
    if (!modules) throw new Error('Shipped shared modules must be captured first')
    const React = modules.react
    const {createRoot} = modules['react-dom/client']
    const {flushSync} = modules['react-dom']
    const primitives = modules['@deepseek-ai/dsh-client-ui-primitives']
    const cleanups = [], commands = new Map(), registrations = []
    let language = 'zh', copy, plugin, pending, result = 'ready'
    const catalog = [{id: 7, name: '产品知识空间', group: 'mine', updatedAt: '2026-10-30T00:00:00Z'}]
    window.fetch = async () => {
      if (result === 'loading') await new Promise(resolve => { pending = resolve })
      return {ok: result !== 'error', json: async () => result === 'error' ? {error: 'Fixture catalog unavailable'} : {spaces: catalog}}
    }
    window.__ModuleLoader__ = {load({factory}) { plugin = factory(name => name === 'react' ? React : primitives) }}
    new Function(${JSON.stringify(desktop.replace('exports.apply = apply', 'exports.installWorkResources = installWorkResources; exports.apply = apply'))})()
    plugin.installWorkResources({
      sessions: {}, conversation: {}, inputTriggers: {registerSource: () => () => {}}, on() {},
      effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
      locale: {register(_ns, values) {copy = values}, bind: () => (key, values = {}) => copy[language][key].replaceAll('{count}', String(values.count))},
      commandUi: {register(command) {commands.set(command.name, command)}},
      slots: {inject(_name, setup) {setup()}, register(config, component) {registrations.push({config, component})}}
    })
    const registration = registrations.find(item => item.config.id === 'desktop-work-resources')
    const host = createRoot(document.getElementById('root'))
    window.committed = []
    const pause = () => new Promise(resolve => setTimeout(resolve, 60))
    window.mount = async options => {
      flushSync(() => host.render(null))
      language = options.language; result = options.state || 'ready'
      document.documentElement.dataset.platform = options.platform
      document.body.toggleAttribute('data-ds-dark-theme', options.dark)
      window.committed = []
      flushSync(() => host.render(React.createElement(registration.component, {
        ...registration.config.inject('fixture'),
        inputActions: {captureInsertion: () => ({})},
        knowledge: {read: () => [], update: (_id, spaces) => window.committed.push(spaces.map(space => space.id))}
      })))
      await pause()
      commands.get('knowledge').ui.run({sessionId: 'fixture'})
      await pause()
    }
    window.completeCatalog = () => {result = 'ready'; pending()}
    window.snapshot = () => {
      const button = document.querySelector('.dshWorkKnowledgeConfirm')
      const dialog = document.querySelector('[role=dialog]')
      const rect = button.getBoundingClientRect(), style = getComputedStyle(button)
      const rgb = color => {
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')
        ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1)
        return Array.from(ctx.getImageData(0, 0, 1, 1).data)
      }
      const luminance = color => rgb(color).slice(0, 3).map(value => {
        const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4
      }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
      const bg = luminance(style.backgroundColor), fg = luminance(style.color)
      return {background: rgb(style.backgroundColor), text: rgb(style.color),
        contrast: (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05),
        disabled: button.disabled, opacity: style.opacity, hovered: button.matches(':hover'),
        focused: button.matches(':focus-visible'), outline: style.outlineStyle,
        x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2),
        inside: rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        overflow: dialog.scrollWidth > dialog.clientWidth, label: button.textContent}
    }
  ` }, bundle: true, platform: 'browser', outfile: join(temporary, 'renderer.js'),
    loader: { '.css': 'local-css' }, define: { 'process.env.NODE_ENV': '"production"' } })
  await writeFile(join(temporary, 'index.html'), `<!doctype html><meta charset="utf-8"><style>${styles.join('\n')}${JSON.parse(themeCss)}body{margin:0;font:14px sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}</style><div id="root"></div><script>window.__ModuleLoader__={create(options){window.fixtureModules=options.staticModules;return new Promise(()=>{})}}</script><script src="shared.js"></script><script src="renderer.js"></script>`)
  await writeFile(join(temporary, 'main.cjs'), `
    const assert = require('node:assert/strict'), fs = require('node:fs/promises')
    const {app, BrowserWindow} = require('electron')
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.whenReady().then(async () => {
      const win = new BrowserWindow({show:true, width:1100, height:850, webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false}})
      await win.loadFile(${JSON.stringify(join(temporary, 'index.html'))})
      win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true})
      const run = code => win.webContents.executeJavaScript(code)
      const pause = () => new Promise(resolve => setTimeout(resolve, 60))
      const snapshot = () => run('snapshot()')
      const hover = async target => {win.webContents.sendInputEvent({type:'mouseMove',x:target.x,y:target.y}); await pause()}
      const results = []
      for (const width of [1100, 560]) for (const dark of [false, true]) for (const language of ['zh', 'en']) for (const platform of ['win32', 'darwin']) {
        win.setContentSize(width, 850)
        await hover({x:1,y:1})
        const options = {width,dark,language,platform}
        console.log('Checking ' + JSON.stringify(options))
        await run('mount(' + JSON.stringify(options) + ')')
        const normal = await snapshot()
        assert.equal(normal.disabled, false)
        assert.equal(normal.background[3], 255, 'Normal fill is opaque')
        assert.ok(normal.inside && !normal.overflow, 'Actions fit the dialog')
        await hover(normal)
        const hovered = await snapshot()
        assert.ok(hovered.hovered, 'Native pointer reaches the confirm action')
        assert.equal(hovered.background[3], 255, 'Hovered confirm fill is opaque')
        assert.notDeepEqual(hovered.background, normal.background, 'Hover gives visual feedback')
        assert.ok(hovered.contrast >= normal.contrast, 'Hover preserves or improves text contrast')
        win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:normal.x,y:normal.y})
        await pause()
        const active = await snapshot()
        assert.equal(active.background[3], 255)
        // Release away from the action before checking keyboard and selection behavior.
        await hover({x:1,y:1})
        win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:1,y:1})
        await run('document.querySelector("input[type=search]").focus()')
        let focused
        for (let index=0; index<8; index++) {
          win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'})
          win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'})
          await pause(); focused = await snapshot()
          if (focused.focused) break
        }
        assert.ok(focused.focused && focused.outline !== 'none', 'Keyboard focus is visible: ' + JSON.stringify(focused))
        await run('document.querySelector("input[type=checkbox]").click()')
        await pause()
        if (width === 1100 && language === 'zh' && platform === 'win32') {
          await hover(await snapshot())
          await fs.writeFile(${JSON.stringify(output)} + '/' + (dark ? 'dark' : 'light') + '-hover.png', (await win.webContents.capturePage()).toPNG())
        }
        await run('document.querySelector(".dshWorkKnowledgeConfirm").click()')
        await pause()
        assert.deepEqual(await run('committed'), [[7]])
        assert.equal(await run('document.querySelector("[role=dialog]")'), null)
        for (const state of ['loading','error']) {
          await run('mount(' + JSON.stringify({...options,state}) + ')')
          const disabled = await snapshot()
          await hover(disabled)
          const disabledHover = await snapshot()
          assert.ok(disabledHover.disabled)
          assert.deepEqual(disabledHover.background, disabled.background, 'Disabled hover keeps the fill')
          await run('document.querySelector(".dshWorkKnowledgeConfirm").click()')
          assert.deepEqual(await run('committed'), [])
          if (state === 'loading') {await run('completeCatalog()'); await pause()}
        }
        results.push({options,normal,hovered,active,focused})
      }
      const result = {hostPlatform:process.platform,electron:process.versions.electron,cases:results.length,results}
      await fs.writeFile(${JSON.stringify(join(output, 'result.json'))}, JSON.stringify(result,null,2))
      console.log(JSON.stringify({hostPlatform:result.hostPlatform,electron:result.electron,cases:result.cases}))
      win.destroy(); app.exit(0)
    }).catch(error => {console.error(error); app.exit(1)})
  `)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [join(temporary, 'main.cjs')], { env, stdio: 'inherit', signal: AbortSignal.timeout(60_000) })
  const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', resolve)})
  assert.equal(code, 0, 'Knowledge confirm interaction check passed')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
