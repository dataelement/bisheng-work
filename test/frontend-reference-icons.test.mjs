import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { JSDOM, VirtualConsole } from 'jsdom'
import { expect, it } from 'vitest'
import { prepareReferenceIcons } from '../scripts/prepare-reference-icons.mjs'

const frontend = new URL('../node_modules/@deepseek-ai/dsh-web-frontend/dist/', import.meta.url)
const html = readFileSync(new URL('index.html', frontend), 'utf8')
const entry = new URL(html.match(/<script[^>]*src="([^"?]+)/)[1], frontend)
const bundle = readFileSync(entry, 'utf8')
const primitives = readFileSync(new URL('../node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js', import.meta.url), 'utf8')

it('loads the actual frontend shared module and renders every reference icon', async () => {
  // Execute the complete shipped web entry + vendor graph. Capture the exact
  // staticModules handed to Harness's loader, rather than mocking primitives.
  const built = await build({ entryPoints: [fileURLToPath(entry)], bundle: true, format: 'iife', write: false, logLevel: 'silent' })
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', url: 'http://localhost', virtualConsole: new VirtualConsole() })
  let modules
  dom.window.__ModuleLoader__ = { create: options => { modules = options.staticModules; throw new Error('Test: shared modules captured') } }
  dom.window.eval(built.outputFiles[0].text)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(modules).toBeDefined()
  const React = modules.react
  const root = modules['react-dom/client'].createRoot(dom.window.document.getElementById('root'))
  try {
    modules['react-dom'].flushSync(() => root.render(React.createElement('div', {},
      ...['skill', 'tool', 'folder', 'file', 'session'].map(kind => React.createElement('span', { key: kind, 'data-kind': kind },
        React.createElement(modules['@deepseek-ai/dsh-client-ui-primitives'].ReferenceIconRegular, { kind, size: 14, className: 'reference-icon' }))))))
    for (const kind of ['skill', 'tool', 'folder', 'file', 'session']) {
      const svg = dom.window.document.querySelector(`[data-kind="${kind}"] svg`)
      expect(svg, `${kind} must render from the shipped shared module`).not.toBeNull()
      expect(svg.getAttribute('width')).toBe('14')
      expect(svg.getAttribute('class')).toBe('reference-icon')
      expect(svg.querySelector('path')).not.toBeNull()
    }
  } finally { root.unmount(); dom.window.close() }
})

it('reproduces identical output and rejects upstream contract drift', () => {
  const upstream = bundle.replace(/\/\* BISHENG_REFERENCE_ICONS_BEGIN \*\/[\s\S]*?\/\* BISHENG_REFERENCE_ICONS_END \*\//, '')
  expect(prepareReferenceIcons(upstream, primitives)).toBe(bundle)
  expect(prepareReferenceIcons(bundle, primitives)).toBe(bundle)
  expect(() => prepareReferenceIcons(bundle.replace('ReferenceIconRegular:', 'RenamedIcon:'), primitives)).toThrow('public ReferenceIconRegular export')
  expect(() => prepareReferenceIcons(bundle, primitives.replace('function HammerReferenceArtwork', 'function ChangedArtwork'))).toThrow('HammerReferenceArtwork')
})
