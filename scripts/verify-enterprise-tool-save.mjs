import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, copyFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// Native browser save -> production host observer -> local renderer IPC.
// Uses an isolated profile and loopback fixture; no enterprise credentials are read.
const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-tool-save-'))
try {
  await mkdir(join(temporary, 'main'))
  await mkdir(join(temporary, 'preload'))
  await copyFile(join(root, 'out/preload/enterprise-chat.cjs'), join(temporary, 'preload/enterprise-chat.cjs'))
  await writeFile(join(temporary, 'owner.cjs'), `
    const {ipcRenderer} = require('electron')
    ipcRenderer.on('enterprise-chat:tools-changed', () => ipcRenderer.send('fixture:tools-changed'))
  `)
  const entry = join(temporary, 'main/main.mjs')
  await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
    import assert from 'node:assert/strict'
    import {createServer} from 'node:http'
    import {app, BrowserWindow, ipcMain} from 'electron'
    import {EnterpriseChatView} from './src/main/enterprise/chat-view.ts'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    const waitFor = async check => {
      for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
      throw new Error('Native save verification timed out')
    }
    app.whenReady().then(async () => {
    const server = createServer((request, response) => {
      if (request.url.startsWith('/api/')) {
        response.writeHead(request.url.includes('/39/') ? 403 : 200, {'content-type':'application/json'})
        response.end(JSON.stringify({status_code:200, data:null}))
      } else {
        response.writeHead(200, {'content-type':'text/html'})
        response.end('<html><body>Isolated tool save fixture</body></html>')
      }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + server.address().port
    const owner = new BrowserWindow({show:false, webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false, preload:${JSON.stringify(join(temporary, 'owner.cjs'))}}})
    let count = 0
    ipcMain.on('fixture:tools-changed', event => { if (event.sender === owner.webContents) count++ })
    const enterprise = {
      snapshot: () => ({connected:true, connectionKey:'fixture-account'}), subscribe: () => () => {},
      webSession: async () => ({base:origin, cookieName:'fixture', cookie:'synthetic', expiresAt:Date.now()+300000})
    }
    const host = new EnterpriseChatView(enterprise, line => console.log(line))
    try {
      await owner.loadURL(origin + '/owner')
      host.present(owner, {visible:true, theme:'light', bounds:{x:0,y:0,width:900,height:650}})
      await waitFor(() => host.snapshot().phase === 'ready')
      const view = owner.contentView.children.find(view => view.webContents?.getURL().includes('/workspace'))
      assert.ok(view, 'Production remote browser is mounted')
      const save = async (id, method) => view.webContents.executeJavaScript(
        'fetch(' + JSON.stringify(origin + '/api/v1/dsh/capabilities/' + id + '/availability') +
        ', {method:' + JSON.stringify(method) + ',headers:{"content-type":"application/json"},body:' +
        (method === 'PUT' ? JSON.stringify('{"enabled":false}') : 'undefined') + '}).then(r=>r.status)')
      assert.equal(await save(38, 'GET'), 200)
      assert.equal(await save(39, 'PUT'), 403)
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(count, 0, 'Reads and rejected writes keep the current directory')
      assert.equal(await save(38, 'PUT'), 200)
      await waitFor(() => count === 1)
      assert.equal(await save(38, 'PUT'), 200)
      await waitFor(() => count === 2)
      console.log('PASS: native Electron save completion emits one tool refresh per accepted PUT; GET and 403 emit none')
    } finally {
      host.dispose(); owner.destroy(); server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    app.exit(0)
    }).catch(error => { console.error(error); app.exit(1) })
  ` }, bundle: true, platform: 'node', format: 'esm', external: ['electron'], outfile: entry })
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [entry], {
    env: environment, stdio: 'inherit', signal: AbortSignal.timeout(45_000)
  })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, 'Native enterprise tool save verification')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
