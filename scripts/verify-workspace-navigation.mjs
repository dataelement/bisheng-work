import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// Native Chromium layout and input fixture. Run on Windows for Windows OS acceptance.
// Keep animation frames progressing while other verification windows have focus.
const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-workspace-navigation-'))
try {
  const source = await readFile(join(root, 'packages/dsh-desktop-client-ui/client.js'), 'utf8')
  const styles = source.match(/function installDesktopModes\(ctx\)[\s\S]*?style\.textContent = `([\s\S]*?)`/)
  assert.ok(styles, 'Desktop mode stylesheet is available')
  await build({ stdin: { contents: `
    import { mountWindowsTitlebarLayout } from './src/preload/windows-titlebar'
    mountWindowsTitlebarLayout({ document, ipcRenderer: { invoke: async () => undefined } })
  `, resolveDir: root, loader: 'ts' }, outfile: join(temporary, 'host.js'), bundle: true, platform: 'browser' })
  await writeFile(join(temporary, 'host.html'), `<!doctype html><html><head><style>
    html,body{margin:0;width:100%;height:100%}.dshModes{position:absolute;top:40px;left:280px;right:0;bottom:0}
    ${styles[1]}
  </style></head><body><div class="dshModes"><header class="dshModesHeader">Chat / Work</header></div><script src="host.js"></script></body></html>`)
  const entry = join(temporary, 'main.cjs')
  await build({ stdin: { contents: `
    import assert from 'node:assert/strict'
    import { app, BrowserWindow, WebContentsView } from 'electron'
    import { chatLayoutCss } from './src/main/enterprise/chat-layout'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ width:1080,height:700,show:true,frame:false,
        webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false} })
      await win.loadFile(${JSON.stringify(join(temporary, 'host.html'))})
      const view = new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
      win.contentView.addChildView(view)
      let cases = 0
      for (const platform of ['win32','darwin']) {
        await win.webContents.executeJavaScript('document.documentElement.dataset.platform = ' + JSON.stringify(platform))
        const host = await win.webContents.executeJavaScript(
          '({content:getComputedStyle(document.querySelector(".dshModesHeader")).webkitAppRegion,caption:getComputedStyle(document.getElementById("dsh-desktop-windows-drag-region")).webkitAppRegion})')
        assert.equal(host.content, platform === 'darwin' ? 'drag' : 'none', 'content region on ' + platform)
        assert.equal(host.caption, 'drag', 'Windows caption retains its drag region')
        for (const sidebar of [280,0]) for (const zoom of [0.8,1,1.25]) for (const dark of [false,true]) for (const locale of ['en','zh']) {
          view.setBounds({x:sidebar,y:40,width:1080-sidebar,height:660})
          await view.webContents.loadURL('data:text/html,' + encodeURIComponent(
            '<style>body{margin:0;background:'+(dark?'#161616;color:white':'white;color:black')+';font:14px sans-serif}header{height:64px;display:flex;align-items:center;gap:8px;padding:0 16px}button{height:32px}#chat[hidden],#files[hidden]{display:none}</style>' +
            '<main id="chat" class="dsh-chat-surface"><header class="dsh-chat-header"><button id="open">Files</button></header></main>' +
            '<main id="files" hidden><header><button id="back" aria-label="Back"><svg width="16" height="16"><path d="M10 2 4 8l6 6" stroke="currentColor" fill="none"/></svg></button><button id="directory"><span>'+(locale==='zh'?'目录':'Folder')+'</span><svg width="16" height="16"><path d="m3 5 5 5 5-5" stroke="currentColor" fill="none"/></svg></button></header><div id="menu" hidden><button id="parent">Workspace</button></div><div id="path">Workspace / Folder</div></main>' +
            '<script>const files=document.getElementById("files"),chat=document.getElementById("chat"),menu=document.getElementById("menu");document.getElementById("open").onclick=()=>{chat.hidden=true;files.hidden=false};document.getElementById("directory").onclick=()=>{menu.hidden=!menu.hidden};document.getElementById("back").onclick=()=>{document.getElementById("path").textContent="Workspace"};document.getElementById("parent").onclick=()=>{document.getElementById("path").textContent="Workspace";menu.hidden=true}</script>'))
          await view.webContents.insertCSS(chatLayoutCss(platform))
          view.webContents.setZoomFactor(zoom)
          const region = await view.webContents.executeJavaScript('getComputedStyle(document.querySelector(".dsh-chat-header")).webkitAppRegion')
          assert.equal(region, platform === 'darwin' ? 'drag' : 'none', 'embedded header on ' + platform)
          win.focus(); view.webContents.focus()
          const click = async selector => {
            await view.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
            const point = await view.webContents.executeJavaScript('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
            point.x = Math.round(point.x * zoom); point.y = Math.round(point.y * zoom)
            view.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1})
            view.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1})
            await new Promise(r=>setTimeout(r,50))
          }
          console.log('SCENARIO', platform, sidebar, zoom, dark, locale)
          await click('#open')
          assert.equal(await view.webContents.executeJavaScript('document.getElementById("files").hidden'), false)
          await click('#directory svg')
          assert.equal(await view.webContents.executeJavaScript('document.getElementById("menu").hidden'), false)
          await click('#parent')
          assert.equal(await view.webContents.executeJavaScript('document.getElementById("path").textContent'), 'Workspace')
          await view.webContents.executeJavaScript('document.getElementById("path").textContent="Workspace / Folder"')
          await click('#back svg')
          assert.equal(await view.webContents.executeJavaScript('document.getElementById("path").textContent'), 'Workspace')
          cases++
        }
      }
      console.log(JSON.stringify({cases,hostPlatform:process.platform,electron:process.versions.electron,windowsAcceptance:process.platform==='win32'}))
      view.webContents.close(); win.destroy(); app.exit(0)
    }).catch(error=>{console.error(error);app.exit(1)})
  `, resolveDir: root, loader: 'ts' }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [entry], {
    env: environment, stdio: 'inherit', signal: AbortSignal.timeout(60_000)
  })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, 'Workspace navigation fixture failed')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
