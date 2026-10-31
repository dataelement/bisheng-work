import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const project = resolve(import.meta.dirname, '..')
process.chdir(project)
const require = createRequire(join(project, 'package.json'))
const { build } = require('esbuild')
const root = await mkdtemp(join(tmpdir(), 'dsh-delete-native-'))
const evidence = resolve(process.argv[2] || 'artifacts/host-dialog')
await mkdir(evidence, { recursive: true })
const frontend = resolve('node_modules/@deepseek-ai/dsh-web-frontend/dist')
const html = await readFile(join(frontend, 'index.html'), 'utf8')
const stylesheets = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(match => '<link rel="stylesheet" href="' + pathToFileURL(resolve(frontend, match[1])).href + '">').join('')
assert.ok(stylesheets, 'Harness frontend stylesheets are available')
const themeSource = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-theme/client'), 'utf8')
const themeCss = [...themeSource.matchAll(/var \w+_css_default = ("(?:[^"\\]|\\.)*");/g)].map(match => JSON.parse(match[1])).join('\n')
assert.ok(themeCss.includes('--dsw-alias-bg-layer-2'), 'Harness theme tokens are available')
const entry = resolve(frontend, html.match(/<script[^>]*src="([^"?]+)/)[1])
await build({ entryPoints: [entry], bundle: true, format: 'iife', outfile: join(root, 'frontend.js') })
const client = await readFile(process.env.DSH_TEST_HOST_DIALOG_CLIENT_SOURCE || 'packages/dsh-desktop-client-ui/client.js', 'utf8')
const renderer = String.raw`
const React = window.__fixtureModules.react; const { createRoot } = window.__fixtureModules['react-dom/client'];
const primitives = window.__fixtureModules['@deepseek-ai/dsh-client-ui-primitives'];
let plugin, locale = 'zh', calls = 0, resolveDelete, rejectDelete;
const localeListeners = new Set();
const snapshot = {connected:true,phase:'ready',epoch:1,conversationId:'new',settingsProtocolVersion:1};
window.dshEnterpriseChat = {state:async()=>snapshot,subscribe:()=>()=>{},present:window.fixtureBridge.present,history:async()=>({epoch:1,items:[],hasMore:false}),open:async()=>{}};
const entries = new Map(), dictionaries = new Map(), effects = [];
window.confirm = () => { throw new Error('Native confirm used') };
window.alert = () => { throw new Error('Native alert used') };
window.__ModuleLoader__ = { load({ factory }) { plugin = factory(id => id === 'react' ? React : primitives) } };
${client}
plugin.apply({ inject() {}, remote:{}, uiWorkspace:{registerNavigationHandler:()=>()=>{},startSession(){}}, sessions:{list:{getSnapshot:()=>({phase:'ready',byId:{}}),subscribe:()=>()=>{}}}, layout:{selectPanel(){},panelInfo:{getSnapshot:()=>({activePanelId:null}),subscribe:()=>()=>{}}}, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose) }, get: () => ({ deleteSession: () => { calls++; return new Promise((resolve, reject) => { resolveDelete = resolve; rejectDelete = reject }) } }),
  locale: { getSnapshot:()=>({active:locale}),subscribe:fn=>{localeListeners.add(fn);return()=>localeListeners.delete(fn)},register: (ns, values) => { dictionaries.set(ns, values); return () => {} }, bind: ns => (key, args = {}) => dictionaries.get(ns)[locale][key].replace(/\{(\w+)\}/g, (_, name) => args[name]) },
  slots: { inject: (name, fn) => { if (['shell.overlay', 'sidebar.workspaces.session.menu.item','desktop.mode.content'].includes(name)) fn() }, register: (meta, component) => entries.set(meta.id, { meta, component }) } });
const menu = entries.get('desktop-delete-session'), overlay = entries.get('desktop-delete-session-dialog');
const props = menu.meta.inject(), dialogProps = overlay.meta.inject();
const modes=entries.get('desktop-chat-work'),modeProps=modes.meta.inject();
function App() { const [open, setOpen] = React.useState(false); return React.createElement(React.Fragment, null,
  React.createElement('aside',{className:'fixture-sidebar'},React.createElement(primitives.Menu, { open, onClose: () => setOpen(false), portal: true,
    anchor: React.createElement('button', { id: 'trigger', onClick: () => setOpen(true) }, '会话操作') },
    React.createElement(menu.component, { ...props, sessionId: 'fixture-session', displayTitle: '中文按钮验证', useMenuOpenState: () => [open, setOpen] }))),
  React.createElement('main',{className:'fixture-content'},React.createElement(modes.component,{...modeProps,columns:'1fr 0px',work:React.createElement('textarea',{defaultValue:'retained draft'})})),React.createElement(overlay.component, dialogProps)); }
const root = createRoot(document.getElementById('root')); const render = () => root.render(React.createElement(App)); render();
window.fixture = { dispose: () => { root.unmount(); effects.reverse().forEach(fn => fn()) }, select: mode=>modeProps.navigation.select(mode),language: value => { locale = value;localeListeners.forEach(fn=>fn());render() }, calls: () => calls, resolve: () => resolveDelete(), reject: () => rejectDelete(new Error('fixture failure')) };
`
await build({ stdin: { contents: 'setTimeout(() => {' + renderer + '}, 0)', resolveDir: project }, bundle: true, format: 'iife', outfile: join(root, 'ui.js') })
await writeFile(join(root, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8">' + stylesheets + '<style>' + themeCss + '</style><style>body{margin:0;font-family:var(--dsw-font-family);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#root{display:flex;height:100vh}.fixture-sidebar{width:280px;flex-shrink:0;padding:24px;box-sizing:border-box;background:var(--dsw-specific-sidebar-fill)}.fixture-content{flex:1;min-width:0;display:flex;flex-direction:column}</style><div id="root"></div><script>window.__ModuleLoader__={create(options){window.__fixtureModules=options.staticModules;throw new Error("Fixture: shared modules captured")}}</script><script src="frontend.js"></script><script src="ui.js"></script></html>')
const main = `
const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron'); const assert = require('node:assert/strict'); const fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(root, 'profile'))}); app.commandLine.appendSwitch('lang', 'en-US'); app.enableSandbox();
const watchdog = setTimeout(() => app.exit(2), 45000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,preload: ${JSON.stringify(join(root, 'preload.cjs'))} } });
  const chat=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.contentView.addChildView(chat);chat.setVisible(false);await chat.webContents.loadURL('data:text/html,<body style="background:white">Remote Chat fixture</body>');
  ipcMain.handle('fixture:present',(event,input)=>{assert.equal(event.sender.id,win.webContents.id);assert.equal(typeof input.visible,'boolean');chat.setBounds(Object.fromEntries(Object.entries(input.bounds).map(([k,v])=>[k,Math.round(v)])));chat.setVisible(input.visible);return {connected:true,phase:'ready'}});
  win.webContents.on('console-message', event => console.log('RENDERER', event.message));
  const js = source => win.webContents.executeJavaScript(source);
  const settle = () => new Promise(resolve => setTimeout(resolve, 100));
  const click = async label => { await js('Array.from(document.querySelectorAll("button")).find(b => b.textContent === ' + JSON.stringify(label) + ').click()'); await settle() };
  const open = async label => { await click('会话操作'); await click(label) };
  const waitVisible = async expected => {for(let i=0;i<100;i++){if(chat.getVisible()===expected)return;await settle()}throw Error('Native visibility expected '+expected)};
  const dialog = () => js('!!document.querySelector("[role=dialog]")');
  await win.loadFile(${JSON.stringify(join(root, 'index.html'))}); await settle();
  await js('fixture.select("chat")');await waitVisible(true);const contentBounds=chat.getBounds();
  await open('永久删除会话');await waitVisible(false);
  assert.deepEqual(await js('Array.from(document.querySelectorAll("[role=dialog] button")).map(b=>b.textContent)'), ['', '取消', '删除会话']);
  assert.equal(await js('document.activeElement.textContent'), '取消');
  assert.match(await js('document.querySelector("[role=dialog]").textContent'), /中文按钮验证/);
  assert.equal(await js('!!document.querySelector("[role=menu]")'), false);
  assert.equal(await js('(() => { const d = document.querySelector("[role=dialog]").getBoundingClientRect(); return d.width > 200 && d.height > 80 && d.left >= 0 && d.top >= 0 && d.right <= innerWidth && d.bottom <= innerHeight && document.elementFromPoint(d.x+d.width/2,d.y+d.height/2).closest("[role=dialog]") !== null })()'), true);
  fs.writeFileSync(${JSON.stringify(join(evidence, 'chinese-dialog.png'))}, (await win.webContents.capturePage()).toPNG());
  const lightBackground = await js('getComputedStyle(document.querySelector("[role=dialog]")).backgroundColor');
  await js('document.body.setAttribute("data-ds-dark-theme", "")'); await settle(); assert.equal(chat.getVisible(), false);
  assert.notEqual(await js('getComputedStyle(document.querySelector("[role=dialog]")).backgroundColor'), lightBackground);
  fs.writeFileSync(${JSON.stringify(join(evidence, 'chinese-dialog-dark.png'))}, (await win.webContents.capturePage()).toPNG());
  await js('document.body.removeAttribute("data-ds-dark-theme")'); win.setSize(1000, 700); await settle(); assert.equal(chat.getVisible(), false); win.setSize(1200, 800); await settle();
  await click('取消');await waitVisible(true);assert.deepEqual(chat.getBounds(),contentBounds);assert.equal(await dialog(), false); assert.equal(await js('fixture.calls()'), 0);
  console.log('PASS Chinese labels, menu lifecycle, initial focus, light/dark theme, resize, cancel');
  await open('永久删除会话');
  await js('document.querySelectorAll("[role=dialog] button")[2].focus()');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'}); await settle();
  assert.equal(await js('document.activeElement.getAttribute("aria-label")'), '关闭');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'}); await settle();
  assert.equal(await dialog(), false);await waitVisible(true);assert.equal(await js('document.activeElement.id'), 'trigger');
  console.log('PASS native Tab trap, Escape, focus return');
  await open('永久删除会话'); await js('fixture.language("en")'); await settle();
  assert.deepEqual(await js('Array.from(document.querySelectorAll("[role=dialog] button")).map(b=>b.textContent)'), ['', 'Cancel', 'Delete session']);
  await click('Delete session'); await click('Deleting session…');
  assert.equal(await js('fixture.calls()'), 1);
  await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))'); await settle();
  assert.equal(await dialog(), true);assert.equal(chat.getVisible(),false);
  await js('fixture.reject()'); await settle();
  assert.match(await js('document.querySelector("[role=alert]").textContent'), /Deletion failed.*fixture failure/);
  await click('Delete session'); await js('fixture.resolve()'); await settle();
  assert.equal(await dialog(), false);await waitVisible(true);assert.equal(await js('fixture.calls()'), 2);
  await open('Delete session permanently');await waitVisible(false);await js('fixture.select("work")');await click('Cancel');await settle();assert.equal(chat.getVisible(),false);
  await js('fixture.select("chat")');await waitVisible(true);assert.deepEqual(chat.getBounds(),contentBounds);
  console.log('PASS live English switch, busy lock, single submit, failure, retry, success');
  console.log('Electron ' + process.versions.electron + ' / ' + process.platform + '/' + process.arch);
  await js('fixture.dispose()'); await settle(); ipcMain.removeHandler('fixture:present'); clearTimeout(watchdog); win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1) });
`
await writeFile(join(root, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixtureBridge',{present:input=>ipcRenderer.invoke('fixture:present',input)});`)
await writeFile(join(root, 'main.cjs'), main)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), [join(root, 'main.cjs')], { env, encoding: 'utf8', timeout: 55000 })
await writeFile(join(evidence, 'native.log'), result.stdout + '\n' + result.stderr)
console.log(result.stdout); console.error(result.stderr)
await rm(root, { recursive: true, force: true })
if (result.error) console.error(result.error)
if (result.status !== 0) process.exitCode = 1
