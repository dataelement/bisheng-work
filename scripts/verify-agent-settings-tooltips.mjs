import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import ts from 'typescript'

// Native Chromium fixture: render the installed preset section and Tooltip.
// Remote data and unrelated dialogs use deterministic stubs; no user profile is loaded.
const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-settings-tooltip-'))
try {
  const source = await readFile(process.env.PRESET_SOURCE || join(root, 'node_modules/@deepseek-ai/dsh-client-ui-agent-preset/lib/client.js'), 'utf8')
  const ast = ts.createSourceFile('client.js', source, ts.ScriptTarget.Latest, true)
  const declarations = new Map()
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(ast))
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, 'const ' + node.getText(ast) + ';')
    ts.forEachChild(node, visit)
  }
  visit(ast)
  const section = declarations.get('AgentPresetSection')
  const classes = declarations.get('AgentPresetSection_module_css_default')
  assert.ok(section && classes)
  const stylesheet = source.match(/const css = ("[^\n]+rtSEdW_section[^\n]+");/)?.[1]
  assert.ok(stylesheet)
  const primitiveSource = await readFile(join(root, 'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js'), 'utf8')
  const region = name => {
    const marker = `//#region lib/types/${name}.js`
    const start = primitiveSource.indexOf(marker)
    assert.ok(start >= 0)
    return primitiveSource.slice(start + marker.length, primitiveSource.indexOf('//#endregion', start))
  }
  await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import * as react from 'react'
    const React = react
    import { cloneElement, createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
    import * as react_jsx_runtime from 'react/jsx-runtime'
    import { jsx, jsxs } from 'react/jsx-runtime'
    import { createRoot } from 'react-dom/client'
    import { flushSync, createPortal } from 'react-dom'
    import css$23 from './node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/Tooltip.module.css'
    ${['input-modality', 'useDismissOnOutsidePointer', 'Tooltip'].map(region).join('\n')}
    const _deepseek_ai_dsh_client_ui_primitives = {
      Tooltip, Button: ({children, variant, icon, ...props}) => <button {...props}>{children}</button>,
      Tag: ({children}) => <span>{children}</span>, Modal: () => null,
      IconBrowseOutlineRegular: () => <span>▤</span>, IconArchiveOutlineRegular: () => null,
    }
    const CardDescription = ({text}) => <span>{text}</span>
    const PresetGuideDialog = () => null
    const isBuiltInPreset = row => row.builtIn
    const requiresCodingTools = () => false
    const presetDisplayText = row => row
    const presetGuide = () => undefined
    ${classes}
    ${section}
    const root = createRoot(document.getElementById('root'))
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
    window.checkScenario = async ({language, keyboard, dark, index}) => {
      flushSync(() => root.render(null))
      document.documentElement.lang = language
      document.body.dataset.dark = String(dark)
      const label = language === 'zh' ? '查看配置' : 'View configuration'
      const rows = ['Standard mode', 'PTC mode', 'Minimal mode', 'Creator mode'].map((name, i) => ({
        id: 'preset-' + i, name, builtIn: true, isDefault: i === 0, description: 'Preset tools and configuration'
      }))
      const calls = []
      flushSync(() => root.render(<div className="settings"><aside>Settings</aside><main>
        <AgentPresetSection useAgentPresetSection={fn => fn({rows, view: null, error: null, saving: false})}
          useDeveloperTools={fn => fn(true)} load={() => {}} closeView={() => {}} view={id => calls.push(id)}
          makeDefault={() => {}} t={key => key === 'view' ? label : key} />
        <div style={{height: 400}} />
      </main></div>))
      const main = document.querySelector('main')
      main.scrollTop = 35
      await new Promise(resolve => setTimeout(resolve, 80))
      await frame()
      const button = document.querySelectorAll('button[aria-label^="' + label + '"]')[index]
      if (keyboard) {
        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true}))
        button.dispatchEvent(new FocusEvent('focusin', {bubbles: true}))
      } else button.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}))
      let bubble
      for (let i = 0; i < 30; i++) {
        await frame()
        bubble = document.querySelector('[role=tooltip]')
        if (bubble && getComputedStyle(bubble).visibility === 'visible') break
      }
      if (!bubble) throw new Error('Configuration tooltip must use the shared visible overlay: ' + JSON.stringify({language, keyboard, dark, index}))
      const a = button.getBoundingClientRect(), b = bubble.getBoundingClientRect()
      const result = {
        text: bubble.textContent, label,
        portal: bubble.parentElement === document.body,
        withinViewport: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight,
        rightAligned: Math.abs(b.right - a.right) < 1.5,
        gap: a.top - b.bottom,
        legacy: button.hasAttribute('data-tip'),
        horizontalOverflow: main.scrollWidth > main.clientWidth,
      }
      button.click()
      await frame()
      result.opened = calls.length === 1 && calls[0] === rows[index].id
      result.dismissed = document.querySelector('[role=tooltip]') === null
      flushSync(() => root.render(null))
      result.cleaned = document.querySelector('[role=tooltip]') === null
      return result
    }
  ` }, bundle: true, outfile: join(temporary, 'renderer.js'), loader: { '.css': 'local-css' }, define: { 'process.env.NODE_ENV': '"production"' } })
  await writeFile(join(temporary, 'index.html'), `<!doctype html><html><head><link rel="stylesheet" href="renderer.css"><style>
    :root{--dsw-alias-label-primary:#202124;--dsw-alias-tooltip-bg:#151618;--dsw-static-neutral-bluish-00:#fff;--dsw-radius-sm:6px}
    body{margin:0;background:#ddd;font:14px sans-serif}body[data-dark=true]{background:#222;color:#eee;--dsw-alias-label-primary:#eee;--dsw-alias-tooltip-bg:#444}
    .settings{position:absolute;inset:60px 12%;display:flex;overflow:hidden;border-radius:24px;background:#fff}
    body[data-dark=true] .settings{background:#333}aside{width:150px;flex-shrink:0;padding:20px}
    main{overflow:auto;flex:1;min-width:0;padding:20px}button{font:inherit}
    ${JSON.parse(stylesheet)}
  </style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  const entry = join(temporary, 'main.cjs')
  await writeFile(entry, `
    const assert = require('node:assert/strict')
    const {app, BrowserWindow} = require('electron')
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.whenReady().then(async () => {
      const window = new BrowserWindow({show:false, width:1400, height:900, webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false}})
      await window.loadFile(${JSON.stringify(join(temporary, 'index.html'))})
      let count = 0
      for (const width of [1100, 1500]) for (const zoom of [0.8, 1, 1.25]) {
        window.setSize(width, 900)
        window.webContents.setZoomFactor(zoom)
        for (const language of ['en','zh']) for (const dark of [false,true]) for (const keyboard of [false,true]) {
          const scenario = {language, dark, keyboard, index:3}
          const result = await window.webContents.executeJavaScript('window.checkScenario(' + JSON.stringify(scenario) + ')')
          assert.equal(result.text, result.label)
          for (const key of ['portal','withinViewport','rightAligned','opened','dismissed','cleaned']) assert.equal(result[key], true, key + JSON.stringify({width,zoom,...scenario,...result}))
          assert.equal(result.legacy, false)
          assert.equal(result.horizontalOverflow, false)
          assert.ok(Math.abs(result.gap - 8) < 1.5)
          count++
        }
      }
      console.log('PASS: ' + count + ' Agent settings tooltip geometry/interaction scenarios')
      window.destroy(); app.exit(0)
    }).catch(error => {console.error(error); app.exit(1)})
  `)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [entry], {
    env: environment, stdio: 'inherit', signal: AbortSignal.timeout(60_000)
  })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, 'Agent settings tooltip verification')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
