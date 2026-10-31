/** Native Chromium check of the shipped search and shared history components with fixture stores. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'

const root = resolve(import.meta.dirname, '..')
const dir = await mkdtemp(join(tmpdir(), 'bisheng-session-search-'))
try {
  const workspace = await readFile(join(root, 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js'), 'utf8')
  const desktop = await readFile(join(root, 'packages/dsh-desktop-client-ui/client.js'), 'utf8')
  await build({ stdin: { contents: `
    import { createSessionSearchFixture } from './test/helpers/session-search-fixture.mjs'
    const workspace = ${JSON.stringify(workspace)}
    const desktop = ${JSON.stringify(desktop)}
    window.mountSearch = async options => {
      window.fixture?.unmount()
      window.fixture = createSessionSearchFixture(workspace, desktop, options)
      window.fixture.mount()
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  `, resolveDir: root }, bundle: true, platform: 'browser', outfile: join(dir, 'renderer.js'), define: { 'process.env.NODE_ENV': '"production"' } })
  await writeFile(join(dir, 'index.html'), '<!doctype html><meta charset="UTF-8"><title>Session search fixture</title><script src="renderer.js"></script>')
  await writeFile(join(dir, 'main.cjs'), `
    const assert = require('node:assert/strict')
    const { app, BrowserWindow } = require('electron')
    app.setPath('userData', ${JSON.stringify(join(dir, 'profile'))})
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true } })
      await win.loadFile(${JSON.stringify(join(dir, 'index.html'))})
      const run = code => win.webContents.executeJavaScript(code)
      const step = code => run('(async () => { ' + code + '; await new Promise(r => setTimeout(r, 350)) })()')
      const history = async () => {
        const text = await run('document.body.textContent')
        assert.ok(text.includes('会话 one') && text.includes('会话 two'), 'Both sessions visible')
      }
      let cases = 0
      for (const shared of [false, true]) for (const groupBy of ['flat', 'workspace-tree']) {
        await run('mountSearch(' + JSON.stringify({ shared, groupBy }) + ')')
        await history()
        await step('fixture.openSearch()')
        await history()
        await step('fixture.type("one")')
        assert.ok((await run('document.body.textContent')).includes('会话 one'))
        await step('fixture.host.querySelector("[role=treeitem]").click()')
        assert.deepEqual(await run('fixture.opened'), ['work:one'])
        await history()
        await step('fixture.openSearch()')
        await step('fixture.type("missing")')
        assert.ok((await run('document.body.textContent')).includes(shared ? 'recentSearchEmpty' : 'search.noMatches'))
        await step('fixture.clear()')
        await history()
        if (shared) {
          await step('fixture.openSearch()')
          await step('fixture.type("云端")')
          await step('fixture.host.querySelector("[data-history-kind=chat]").click()')
          assert.deepEqual(await run('fixture.opened'), ['work:one', 'chat:cloud'])
          await step('fixture.escape()')
          await history()
        }
        cases++
      }
      console.log(JSON.stringify({ cases, hostPlatform: process.platform, electron: process.versions.electron, scope: 'shipped components with fixture stores' }))
      win.destroy(); app.exit(0)
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [join(dir, 'main.cjs')], { env, stdio: 'inherit', signal: AbortSignal.timeout(60_000) })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  assert.equal(code, 0, 'Native search fixture passed')
} finally { await rm(dir, { recursive: true, force: true }) }
