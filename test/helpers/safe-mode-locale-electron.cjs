const { app, BrowserWindow, ipcMain } = require('electron')
const { createServer } = require('node:http')
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const [dir, root] = process.argv.slice(2)
const { buildSafeModeViewModel, SafeModeFrame, registerNativeLocaleHandlers } = require(join(dir, 'model.cjs'))
app.setPath('userData', join(dir, 'profile'))
app.setPath('logs', join(dir, 'logs'))
const recovery = {
  zh: '正常配置恢复需要处理。自动维护已暂停，恢复材料已保留。',
  en: 'Normal Profile recovery needs attention. Automatic maintenance is paused and recovery material is preserved.',
  detail: 'plugin restore recovery state is unreadable: backup path resolves outside the recovery root'
}
const host = '<!doctype html><html lang="en"><body style="margin:0;font-family:sans-serif"><aside data-dsh-sidebar-root data-dsh-sidebar-wide="true" style="width:260px;height:100vh;display:flex;flex-direction:column;background:#f7f8fa"><div style="flex:1">BISHENG</div><div data-dsh-sidebar-settings style="padding:16px">设置</div></aside><main></main></body></html>'
const html = readFileSync(join(root, 'build/safe-mode.html'))
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url.startsWith('/safe-mode.html') ? html : host) })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, check) {
  for (let count = 0; count < 100; count++) { const value = await read(); if (check(value)) return value; await delay(30) }
  throw new Error('Timed out waiting for locale presentation')
}
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const win = new BrowserWindow({ width: 1200, height: 800, show: false,
    webPreferences: { preload: join(root, 'out/preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  const frame = new SafeModeFrame(win, () => {})
  let locale = 'en', theme = 'light', locked = true, releaseStatus
  const status = new Promise(resolve => { releaseStatus = resolve })
  const model = () => buildSafeModeViewModel({ locale, plugins: ['example'], recoveryLocked: locked, notice: recovery, noticeTone: 'error' })
  const update = () => frame.applyUpdate({ seq: '1', model: model() })
  registerNativeLocaleHandlers(ipcMain, {
    assertTrusted: event => { assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame) },
    systemLanguages: () => ['en-US'],
    changed: next => { locale = next; update() }
  })
  ipcMain.on('dsh:storage-load-sync', event => { event.returnValue = {} })
  ipcMain.handle('safe-mode:status', () => status)
  ipcMain.handle('desktop-titlebar:set-theme', () => ({}))
  ipcMain.handle('mobile:status', () => ({ connected: false }))
  ipcMain.handle('harness:renderer-healthy', () => ({}))
  ipcMain.handle('updates:status', () => ({ phase: 'idle' }))
  ipcMain.handle('safe-mode:action', () => ({ ok: true }))
  const bannerActions = []
  ipcMain.handle('safe-mode:manage', () => { bannerActions.push('manage'); return { ok: true } })
  ipcMain.handle('safe-mode:exit', () => { bannerActions.push('exit'); return { blocked: true } })
  await win.loadURL(origin)
  const show = () => frame.show(`${origin}/safe-mode.html?seq=1&theme=${theme}&state=${encodeURIComponent(JSON.stringify(model()))}`)
  show()
  const read = () => win.webContents.executeJavaScript(`(() => { const f = document.querySelector('#dsh-desktop-safe-mode-frame iframe'); const d = f?.contentDocument; return { title: d?.getElementById('page-title')?.textContent, notice: d?.getElementById('notice-preview')?.textContent, restart: d?.getElementById('restart')?.textContent, lang: d?.documentElement.lang, theme: d?.documentElement.dataset.theme, count: document.querySelectorAll('#dsh-desktop-safe-mode-banner').length }; })()`)
  await until(read, value => value.title === 'Manage plugins')
  const change = value => win.webContents.executeJavaScript(`document.documentElement.lang = ${JSON.stringify(value)}; window.__DSH_LOCALE__.onChange(${JSON.stringify(value)}); void 0`)
  await change('zh')
  // Model and banner status may arrive after the actual in-app language.
  releaseStatus({ active: true, locale: 'en' })
  const chinese = await until(read, value => value.title === '管理插件' && value.count === 1)
  assert.equal(chinese.notice, recovery.zh)
  assert.equal(chinese.restart, '退出安全模式并重启')
  win.webContents.debugger.attach('1.3')
  const bannerText = async () => {
    const { strings } = await win.webContents.debugger.sendCommand('DOMSnapshot.captureSnapshot', { computedStyles: [] })
    return strings.join('\n')
  }
  assert.match(await bannerText(), /安全模式：管理插件/)
  assert.match(await bannerText(), /停用或启用第三方插件/)
  const output = join(root, 'artifacts/safe-mode-locale')
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'zh-light.png'), (await win.webContents.capturePage()).toPNG())
  // Check both themes and repeat updates on an existing page.
  for (theme of ['dark', 'light']) {
    show()
    await until(read, value => value.title === '管理插件' && value.theme === theme)
    for (const value of ['en', 'zh', 'zh']) {
      await change(value)
      await until(read, result => result.title === (value === 'zh' ? '管理插件' : 'Manage plugins'))
      assert.equal((await read()).count, 1)
      assert.match(await bannerText(), value === 'zh' ? /安全模式：管理插件/ : /Safe Mode: manage plugins/)
    }
  }
  // Selection remains intact across real iframe updates.
  locked = false
  show()
  await until(() => win.webContents.executeJavaScript("document.querySelector('iframe')?.contentDocument.querySelector('.list-card')?.hidden === false"), Boolean)
  await win.webContents.executeJavaScript("document.querySelector('iframe').contentDocument.querySelector('.plugin input').click()")
  await change('en')
  await until(read, value => value.title === 'Manage plugins')
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('iframe').contentDocument.querySelector('.plugin input').checked"), true)
  frame.close()
  // The macOS report is the sidebar on the ordinary page, with the manager closed.
  // Inspect the actual closed shadow tree and exercise its existing IPC actions.
  await change('zh')
  await until(() => win.webContents.executeJavaScript("document.querySelector('#dsh-desktop-safe-mode-frame') === null"), Boolean)
  await win.webContents.executeJavaScript(`
    document.documentElement.style.cssText = '--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#aaa;--dsw-alias-bg-layer-1:#242424;--dsw-alias-border-l2:#444;--dsw-alias-interactive-bg-hover:#333;color-scheme:dark';
    document.body.style.background = '#141414';
    document.querySelector('aside').style.background = '#1c1c1c';
    document.body.style.color = '#eee';
  `)
  const descendants = node => [node, ...(node.children || []).flatMap(descendants), ...(node.shadowRoots || []).flatMap(descendants)]
  const bannerNodes = async () => {
    const { root: document } = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true })
    const banner = descendants(document).find(node => {
      const attributes = node.attributes || []
      return attributes.some((value, index) => index % 2 === 0 && value === 'id' && attributes[index + 1] === 'dsh-desktop-safe-mode-banner')
    })
    assert.ok(banner, 'The sidebar owns a mounted Safe Mode banner')
    return descendants(banner)
  }
  const textContent = node => descendants(node).filter(child => child.nodeType === 3).map(child => child.nodeValue).join('')
  const nodes = await bannerNodes()
  const texts = nodes.filter(node => node.nodeType === 3).map(node => node.nodeValue)
  for (const expected of ['安全模式', '已暂时停用所有第三方插件，可停用有问题的插件后重启。', '管理插件', '退出安全模式']) assert.ok(texts.includes(expected), expected)
  for (const original of ['Safe Mode', 'Manage plugins', 'Exit Safe Mode']) assert.equal(texts.includes(original), false)
  writeFileSync(join(output, 'zh-dark-sidebar.png'), (await win.webContents.capturePage()).toPNG())
  const clickBannerButton = async label => {
    const button = (await bannerNodes()).find(node => node.nodeName === 'BUTTON' && textContent(node) === label)
    assert.ok(button, label)
    const { object } = await win.webContents.debugger.sendCommand('DOM.resolveNode', { nodeId: button.nodeId })
    await win.webContents.debugger.sendCommand('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { this.click() }' })
    await win.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId: object.objectId })
  }
  await clickBannerButton('管理插件')
  await until(async () => bannerActions.length, count => count === 1)
  await clickBannerButton('退出安全模式')
  await until(async () => bannerActions.length, count => count === 2)
  assert.deepEqual(bannerActions, ['manage', 'exit'])
  // A recovery-blocked exit keeps the same translated, usable controls.
  await until(async () => (await bannerNodes()).filter(node => node.nodeName === 'BUTTON').every(node => !(node.attributes || []).includes('disabled')), Boolean)
  await win.webContents.executeJavaScript("document.querySelector('aside').dataset.dshSidebarWide = 'false'; const settings = document.querySelector('[data-dsh-sidebar-settings]'); settings.replaceWith(settings.cloneNode(true))")
  await until(() => win.webContents.executeJavaScript("document.querySelector('#dsh-desktop-safe-mode-banner').dataset.compact"), value => value === 'true')
  assert.match(await bannerText(), /安全模式：管理插件/)
  win.destroy()
  server.close()
  console.log(JSON.stringify({ result: 'passed', platform: process.platform, checks: ['production-preload', 'isolated-ipc', 'late-locale', 'stale-status-response', 'live-manager-and-banner', 'zh-en', 'light-dark', 'repeat-update', 'selection-preserved', 'macos-dark-sidebar', 'banner-visible-copy', 'banner-action-ipc', 'blocked-exit-controls', 'compact-sidebar'], windowsInstalledAcceptance: 'pending' }))
  app.quit()
}).catch(error => { console.error(error); server.close(); app.exit(1) })
setTimeout(() => app.exit(2), 30000).unref()
