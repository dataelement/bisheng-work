// Run with node_modules/.bin/electron scripts/check-workbench-search-focus.cjs.
// Uses the shipped stylesheet and search markup with light/dark token fixtures.
const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const profile = mkdtempSync(join(tmpdir(), 'bisheng-search-focus-'))
const output = resolve(__dirname, '../artifacts/market-search-focus')
const source = readFileSync(resolve(__dirname, '../packages/dsh-desktop-workbenches/client.js'), 'utf8')
const css = source.match(/const css = `([\s\S]*?)`/)[1]
app.setPath('userData', profile)
mkdirSync(output, { recursive: true })
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 900, height: 340, webPreferences: { sandbox: true, backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const settle = () => new Promise(resolve => setTimeout(resolve, 50))
  const state = () => run(`(() => {
    const input = document.querySelector('input'), style = getComputedStyle(input), rect = input.getBoundingClientRect()
    return { focus: input.matches(':focus-visible'), border: style.borderColor, borderWidth: style.borderWidth,
      outline: style.outlineStyle, shadow: style.boxShadow, width: rect.width, height: rect.height, value: input.value }
  })()`)
  const themes = {
    light: { text: '#18191c', border: '#d9dadd', bg: '#fff', focus: '#5369d9' },
    dark: { text: '#eee', border: '#45464a', bg: '#222326', focus: '#a2afff' }
  }
  const results = []
  try {
    for (const [theme, tokens] of Object.entries(themes)) for (const width of [400, 900]) {
      win.setSize(width, 340)
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html data-platform="darwin"><style>${css}
        body{margin:0;background:${tokens.bg};color:${tokens.text};--dsw-alias-label-primary:${tokens.text};--dsw-alias-label-secondary:${tokens.text};--dsw-alias-border-l2:${tokens.border};--dsw-alias-bg-layer-1:${tokens.bg};--dsw-alias-state-business-primary:${tokens.focus}}
        .dshWbMarketHeader{padding-top:20px}
      </style><div class="dshWb dshWbMarket"><button id="before">搜索前</button><header class="dshWbMarketHeader"><div class="dshWbMarketHeaderText"><h1>工作台</h1><p>有序组织专属界面、会话与资料</p><label class="dshWbSearch"><input type="search" aria-label="搜索工作台" placeholder="搜索名称、作者或分类"></label></div></header><button id="after">搜索后</button></div></html>`))
      win.focus(); win.webContents.focus()
      const idle = await state()
      const focusColor = await run(`(() => {const probe=document.createElement('span');probe.style.color='var(--dsw-alias-state-business-primary)';document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color})()`)
      const checkFocused = current => {
        assert.equal(current.focus, true, 'Search visibly focused')
        assert.equal(current.outline, 'none', 'Search uses a single border')
        assert.equal(current.shadow, 'none', 'Search has one painted edge')
        assert.equal(current.borderWidth, '1px')
        assert.equal(current.border, focusColor, 'Focus uses the native input color token')
        assert.deepEqual([current.width, current.height], [idle.width, idle.height], 'Focus retains input geometry')
      }
      const point = await run(`(() => {const r=document.querySelector('input').getBoundingClientRect();return {x:Math.round(r.x+40),y:Math.round(r.y+r.height/2)}})()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
      await settle()
      checkFocused(await state())
      await win.webContents.insertText('工作台')
      checkFocused(await state())
      assert.equal((await state()).value, '工作台')
      writeFileSync(join(output, `${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
      await run('document.querySelector("#before").focus()')
      const blurred = await state()
      assert.equal(blurred.focus, false)
      assert.equal(blurred.border, idle.border, 'Blur restores the ordinary border')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
      await settle()
      checkFocused(await state())
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
      await settle()
      const button = await run(`(() => {const e=document.querySelector('#after'),s=getComputedStyle(e);return {focused:document.activeElement===e,outline:s.outlineStyle,width:s.outlineWidth}})()`)
      assert.deepEqual(button, { focused: true, outline: 'solid', width: '2px' }, 'Action buttons retain keyboard focus indication')
      results.push({ theme, width, pointer: true, typing: true, blur: true, keyboard: true })
    }
    const result = { platform: process.platform, electron: process.versions.electron, cases: results }
    writeFileSync(join(output, 'native-result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } finally { win.destroy() }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
app.on('will-quit', () => rmSync(profile, { recursive: true, force: true }))
