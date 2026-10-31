const electron = require('electron')
const { app, BrowserWindow, nativeImage } = electron
const { EventEmitter } = require('node:events')
const { Module } = require('node:module')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const [dir, root] = process.argv.slice(2)
app.setPath('userData', join(dir, 'profile'))
app.setPath('logs', join(dir, 'logs'))
const instances = [], logs = []
class Toast extends EventEmitter {
  static isSupported() { return true }
  constructor(options) { super(); this.options = options; instances.push(this) }
  show() { this.emit('show') }
  close() { this.emit('close') }
}
const bundle = join(dir, 'bridge.cjs')
const mod = new Module(bundle)
mod.paths = module.paths
mod.require = id => id === 'electron' ? { ...electron, Notification: Toast } : require(id)
mod._compile(readFileSync(bundle, 'utf8'), bundle)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 360, height: 220, show: false, skipTaskbar: true,
    webPreferences: { preload: join(dir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const icon = join(root, 'build/app-icon.png')
  assert.equal(nativeImage.createFromPath(icon).isEmpty(), false)
  const dispose = mod.exports.registerDesktopNotificationBridge(() => win, () => icon, () => 'en', (stage, facts) => { logs.push({ stage, ...facts }); mod.exports.writeNotificationAudit(stage, facts) })
  await win.loadURL('data:text/html,<title>Notification integration fixture</title>')
  assert.deepEqual(await win.webContents.executeJavaScript('Object.keys(window.dshDesktopNotifications).sort()'), ['completed', 'onClicked'])
  assert.equal(await win.webContents.executeJavaScript('window.Notification.name'), 'Notification')
  await win.webContents.executeJavaScript('window.__ModuleLoader__ = { load: value => { window.plugin = value.factory(() => ({})) } }; void 0;')
  await win.webContents.executeJavaScript(readFileSync(join(root, 'packages/dsh-desktop-client-ui/client.js'), 'utf8'))
  await win.webContents.executeJavaScript(`
    window.state = { phase: 'ready', ids: ['work'], byId: { work: { projectionValues: { desktopWorkCompletion: {count:0,turn:0,seq:-1,time:0} } } } };
    window.cleanups = []; window.opened = []; window.listeners = new Set();
    plugin.installWorkCompletionNotifications({ effect: fn => cleanups.push(fn()),
      sessions: { list: { getSnapshot: () => state, subscribe: fn => {listeners.add(fn); return () => listeners.delete(fn)} } },
      uiWorkspace: { openSession: id => opened.push(id) }
    }, { select: mode => { window.selectedMode = mode } });
    state.byId.work.projectionValues.desktopWorkCompletion = {count:1,turn:1,seq:8,time:Date.now()};
    listeners.forEach(fn => fn());
  `)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(instances.length, 1)
  assert.equal(instances[0].options.icon, icon)
  assert.deepEqual(logs.map(l => l.stage), ['requested', 'shown'])
  await win.webContents.executeJavaScript('listeners.forEach(fn => fn())')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(instances.length, 1)
  instances[0].emit('failed', {}, 'fixture HRESULT 0x80070490')
  assert.equal(logs.at(-1).stage, 'failed')
  assert.match(readFileSync(join(dir, 'logs/harness.log'), 'utf8'), /fixture HRESULT 0x80070490/)
  instances[0].emit('click')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(win.isVisible(), true)
  assert.deepEqual(await win.webContents.executeJavaScript('({opened, mode: selectedMode})'), { opened: ['work'], mode: 'work' })
  await win.webContents.executeJavaScript('cleanups.forEach(fn => fn())')
  assert.equal(await win.webContents.executeJavaScript('listeners.size'), 0)
  dispose(); win.destroy()
  console.log(JSON.stringify({ result: 'passed', platform: process.platform, checks: ['host-client-completion', 'isolated-preload-ipc', 'packaged-icon', 'duplicate-snapshot', 'failure-audit', 'click-window-and-session', 'disposal'], osToast: 'fixture; Windows native acceptance remains required' }))
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
setTimeout(() => app.exit(2), 20000).unref()
