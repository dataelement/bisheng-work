import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// Run on macOS. --interactive keeps the isolated fixture open for native mouse
// dragging and logs window positions and control clicks for manual acceptance.
assert.equal(process.platform, 'darwin', 'This verification targets the macOS title bar')
const interactive = process.argv.includes('--interactive')
const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-chat-drag-'))
const entry = join(temporary, 'main.cjs')
try {
  await build({ stdin: { contents: `
    import assert from 'node:assert/strict'
    import { app, BrowserWindow, WebContentsView } from 'electron'
    import { chatLayoutCss } from './src/main/enterprise/chat-layout'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ title: 'Chat window drag verification',
        width: 1000, height: 640, x: 150, y: 150, show: true,
        titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 },
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      const view = new WebContentsView({ webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false } })
      window.contentView.addChildView(view)
      const layout = () => { const [width, height] = window.getContentSize();
        view.setBounds({ x: 240, y: 0, width: width - 240, height }) }
      window.on('resize', layout)
      layout()
      await window.loadURL('data:text/html,' + encodeURIComponent('<body style="background:#f6f7f8;font:16px sans-serif;padding:60px 16px">Desktop sidebar</body>'))
      await view.webContents.loadURL('data:text/html,' + encodeURIComponent(
        '<style>*{box-sizing:border-box}body{margin:0;font:14px sans-serif;background:white;color:#222}.dsh-chat-header{display:grid;padding:9px 16px;border-bottom:1px solid #ddd}.dsh-chat-header-row{display:flex;align-items:center;gap:16px}.dsh-chat-title{flex:1}button,a{padding:5px}input{width:70px}article{padding:32px}#more{margin-top:24px}</style>' +
        '<main class="dsh-chat-surface"><header class="dsh-chat-header"><div class="dsh-chat-header-row"><div class="dsh-chat-title">Chat title</div><button id="action"><span>Action</span></button><a id="link" href="#details">Link</a><input id="input" aria-label="Title"></div><div class="dsh-chat-section-row">Conversation</div></header><article id="message">Drag the blank title bar to move this window.<div id="more"><span role="button" tabindex="0">Role button</span><select><option>Option</option></select><textarea></textarea><span contenteditable="true">Editable</span></div></article></main><section id="work"><header class="dsh-chat-header">Work header</header></section><div id="portal">Portal menu</div>'
      ))
      await view.webContents.insertCSS(chatLayoutCss('darwin'))
      await view.webContents.executeJavaScript(
        'window.clicks = 0; document.querySelector("#action").addEventListener("click", () => { window.clicks++; document.querySelector("#message").firstChild.textContent = "Action clicked " + window.clicks + " times"; console.log("ACTION_CLICK " + window.clicks) })'
      )
      for (const width of [900, 1200]) {
        window.setSize(width, 640)
        layout()
        for (const zoom of [0.8, 1, 1.25]) {
          view.webContents.setZoomFactor(zoom)
          const result = await view.webContents.executeJavaScript(
            '(() => { const region = s => getComputedStyle(document.querySelector(s)).webkitAppRegion; return { header: region(".dsh-chat-surface .dsh-chat-header"), controls: ["#action", "#link", "#input"].map(region), outside: ["#message", "#more", "#work .dsh-chat-header", "#portal"].map(region), selection: getComputedStyle(document.querySelector(".dsh-chat-surface .dsh-chat-header")).userSelect, height: document.querySelector(".dsh-chat-surface .dsh-chat-header").getBoundingClientRect().height } })()'
          )
          assert.equal(result.header, 'drag')
          assert.deepEqual(result.controls, ['no-drag', 'no-drag', 'no-drag'])
          assert.deepEqual(result.outside, ['none', 'none', 'none', 'none'])
          assert.equal(result.selection, 'none')
          assert.equal(result.height, 48)
          console.log('PASS embedded Chat regions width=' + width + ' zoom=' + zoom)
        }
      }
      window.setSize(1000, 640)
      view.webContents.setZoomFactor(1)
      layout()
      window.focus()
      view.webContents.focus()
      await view.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const point = await view.webContents.executeJavaScript('(() => { const r = document.querySelector("#action").getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()')
      view.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      view.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(await view.webContents.executeJavaScript('window.clicks'), 1)
      console.log('PASS header button receives pointer clicks; Electron ' + process.versions.electron)
      if (${interactive}) {
        window.on('moved', () => console.log('WINDOW_MOVED ' + JSON.stringify(window.getBounds())))
        view.webContents.on('console-message', (_event, details) => console.log(details.message))
        window.on('closed', () => app.exit(0))
        window.show(); window.focus()
        console.log('READY_NATIVE_DRAG ' + JSON.stringify(window.getBounds()))
      } else { window.destroy(); app.exit(0) }
    }).catch(error => { console.error(error); app.exit(1) })
  `, resolveDir: root, loader: 'ts' }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [entry], {
    env: environment, stdio: 'inherit', signal: AbortSignal.timeout(interactive ? 600_000 : 30_000)
  })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, 'Native Chat window verification failed')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
