import { describe, expect, it } from 'vitest'
import { FRAME_DARK_CSS, MODULE_ROUTE_PATTERN, MODULE_THEME_CSS, darkDeclaration, moduleThemePaletteCss, moduleThemeScript } from '../src/main/enterprise/chat-module-theme'
import type { EnterprisePalette } from '../src/shared/enterprise-chat-view'

interface FakeStyle { id: string; textContent: string; isConnected: boolean; remove: () => void }
/** The host script writes a style element, so every sandbox document owns a head it can reach. */
function fakeHead() {
  const children: FakeStyle[] = []
  const head = {
    children,
    appendChild: (child: FakeStyle) => { child.isConnected = true; children.push(child) },
    getElementById: (id: string) => children.find(child => child.id === id) ?? null,
    createElement: (): FakeStyle => {
      const style: FakeStyle = { id: '', textContent: '', isConnected: false, remove: () => { children.splice(children.indexOf(style), 1); style.isConnected = false } }
      return style
    }
  }
  return head
}

describe('enterprise module page theme', () => {
  it('matches module routes but never conversation routes', () => {
    const route = new RegExp(MODULE_ROUTE_PATTERN, 'u')
    // Embedded settings pages, approvals included, sit inside host panels and share the module scope.
    for (const path of ['/workspace/knowledge', '/workspace/knowledge/space-1', '/workspace/channel?x=1', '/workspace/channel/abc/settings', '/workspace/apps', '/workspace/apps/explore', '/workspace/skills', '/workspace/square?type=apps', '/workspace/settings/desktop-usage?dshSettings=1', '/workspace/settings/my-tasks', '/workspace/settings/notifications']) expect(route.test(path)).toBe(true)
    for (const path of ['/workspace/c/new', '/workspace/chat/1/2/3', '/workspace/linsight/x', '/workspace/knowledgebase', '/workspace/channels', '/workspace/appstore', '/workspace/']) expect(route.test(path)).toBe(false)
  })

  it('keeps the dark class on module routes even after the page resets it, and clears it elsewhere', () => {
    const vm = { className: new Set<string>(), dataset: {} as Record<string, string>, events: [] as string[], observers: [] as Array<() => void>, location: { pathname: '/workspace/knowledge' } }
    const classList = {
      contains: (name: string) => vm.className.has(name),
      toggle: (name: string, force: boolean) => { force ? vm.className.add(name) : vm.className.delete(name); vm.observers.forEach(fn => fn()) },
      add: (name: string) => { vm.className.add(name); vm.observers.forEach(fn => fn()) },
      remove: (name: string) => { vm.className.delete(name); vm.observers.forEach(fn => fn()) },
      reset: () => { vm.className.clear(); vm.className.add('light'); vm.observers.forEach(fn => fn()) }
    }
    const root = { dataset: vm.dataset, classList }
    const window = { dispatchEvent: (event: { type: string }) => vm.events.push(event.type) } as Record<string, unknown>
    const head = fakeHead()
    const sandbox = { document: { documentElement: root, head, querySelectorAll: () => [], getElementById: head.getElementById, createElement: head.createElement }, location: vm.location, window, CustomEvent: class { type: string; constructor(type: string) { this.type = type } }, RegExp, WeakSet, MutationObserver: class { constructor(private fn: () => void) {} observe(_target: unknown, options: { attributes?: boolean }) { if (options.attributes) vm.observers.push(this.fn) } } }
    const run = (theme: 'dark' | 'light') => new Function(...Object.keys(sandbox), `return ${moduleThemeScript(theme)}`)(...Object.values(sandbox))
    run('dark')
    expect([...vm.className].sort()).toEqual(['dark', 'dsh-host-dark', 'dsh-module-dark'])
    expect(vm.dataset.dshPage).toBe('knowledge')
    expect(vm.observers).toHaveLength(1)
    // React mounts the ThemeProvider later and pins `light`; the guard restores the host decision.
    classList.reset()
    expect(vm.className.has('dark')).toBe(true)
    expect(vm.className.has('dsh-module-dark')).toBe(true)
    expect(vm.className.has('dsh-host-dark')).toBe(true)
    expect(vm.className.has('light')).toBe(true)
    // Chat routes keep the page's own html.dark handling but still get the host-wide utility scope.
    vm.location.pathname = '/workspace/c/abc'
    run('dark')
    expect(vm.className.has('dark')).toBe(false)
    expect(vm.className.has('dsh-module-dark')).toBe(false)
    expect(vm.className.has('dsh-host-dark')).toBe(true)
    expect(vm.dataset.dshPage).toBeUndefined()
    expect(vm.observers).toHaveLength(1)
    vm.location.pathname = '/workspace/channel'
    run('light')
    expect(vm.className.has('dark')).toBe(false)
    expect(vm.className.has('dsh-host-dark')).toBe(false)
    expect(vm.dataset.dshHostTheme).toBe('light')
    run('dark')
    expect(vm.className.has('dark')).toBe(true)
    expect(vm.events.filter(type => type === 'dsh:appearance')).toHaveLength(4)
    // A chat route where the page itself keeps html.dark: the host neither removes it nor loops on it.
    vm.location.pathname = '/workspace/c/abc'
    run('dark')
    expect(vm.className.has('dark')).toBe(false)
    const before = vm.observers.length
    classList.toggle('dark', true)
    expect(vm.className.has('dark')).toBe(true)
    expect(vm.className.has('dsh-module-dark')).toBe(false)
    expect(vm.observers).toHaveLength(before)
  })

  it('moves the embedded page onto the host palette and withdraws it when the host cannot sample one', () => {
    const palette: EnterprisePalette = {
      surface: [44, 44, 46], raised: [53, 54, 56], strong: [97, 102, 107],
      labelPrimary: [249, 250, 251], labelSecondary: [207, 211, 214], labelTertiary: [173, 178, 184],
      borderBase: [71, 71, 73], borderDeep: [85, 85, 87], composer: [40, 41, 45]
    }
    const css = moduleThemePaletteCss(palette)
    // The page reads `rgb(var(--token))`, so the host writes channels and never a color function.
    expect(css.startsWith('html.dsh-host-dark:root{')).toBe(true)
    expect(css).toContain('html[data-dsh-host-theme=dark] body[data-dsh-chat-theme=dark] .dsh-web-chat{--dsh-composer-bg:40 41 45}')
    expect(moduleThemePaletteCss({ ...palette, composer: undefined })).not.toContain('--dsh-composer-bg')
    expect(css).toContain('--bg-page:44 44 46')
    expect(css).toContain('--arco-gray-1:53 54 56')
    expect(css).toContain('--arco-gray-4:97 102 107')
    expect(css).toContain('--text-1:249 250 251')
    expect(css).toContain('--border-base:71 71 73')
    // The middle surfaces are interpolated between the host's own raised and strong anchors.
    expect(css).toContain('--arco-gray-2:68 70 73')
    expect(css).toContain('--arco-gray-3:82 86 90')
    expect(css).toContain('--fill-1:53 54 56')
    expect(css).toContain('--fill-2:68 70 73')
    // The settings container paints `hsl(var(--background))`, so the shadcn ramp follows the same anchors.
    expect(css).toContain('--background:240 2.2% 17.6%')
    expect(css).toContain('--card:220 2.8% 21.4%')
    expect(css).toContain('--muted:216 3.5% 27.6%')
    expect(css).toContain('--border:240 1.4% 28.2%')
    expect(css).toContain('--foreground:210 20% 98%')
    expect(css).toContain('--muted-foreground:212.7 7.2% 70%')
    expect(css).not.toContain('--primary:')
    expect(css).not.toContain('--destructive:')
    expect(css).not.toContain('--brand-500')
    // The shell re-declares the ramp on its layout root under the chat-theme attribute it derives
    // from the host; the override lands there too, or the embedded settings page keeps its own dark.
    const rules = css.split('\n')
    expect(rules).toHaveLength(3)
    expect(rules[1]).toMatch(/^html\.dsh-module-dark body\[data-dsh-chat-theme\] :is\(\.dsh-web-chat,/u)
    expect(rules[1]?.slice(rules[1].indexOf('{'))).toBe(rules[0]?.slice(rules[0].indexOf('{')))

    const head = fakeHead()
    const className = new Set<string>()
    const classList = { contains: (name: string) => className.has(name), toggle: (name: string, force: boolean) => { force ? className.add(name) : className.delete(name) }, add: (name: string) => className.add(name), remove: (name: string) => className.delete(name) }
    const sandbox = { document: { documentElement: { dataset: {} as Record<string, string>, classList }, head, getElementById: head.getElementById, createElement: head.createElement, querySelectorAll: () => [] }, location: { pathname: '/workspace/settings/desktop-usage' }, window: { dispatchEvent: () => true }, CustomEvent: class {}, RegExp, WeakSet, MutationObserver: class { observe() {} } }
    const run = (theme: 'dark' | 'light', value?: EnterprisePalette) => new Function(...Object.keys(sandbox), `return ${moduleThemeScript(theme, value)}`)(...Object.values(sandbox))
    run('dark', palette)
    expect(head.children.map(child => child.id)).toEqual(['dsh-host-palette'])
    expect(head.children[0]?.textContent).toBe(css)
    // Re-delivery keeps one element rather than stacking a style per theme change.
    run('dark', palette)
    expect(head.children).toHaveLength(1)
    run('dark', { ...palette, surface: [20, 20, 22] })
    expect(head.children).toHaveLength(1)
    expect(head.children[0]?.textContent).toContain('--bg-page:20 20 22')
    run('dark')
    expect(head.children).toHaveLength(0)
  })

  it('styles reachable srcdoc frames on dark module routes and clears them again', () => {
    const makeDoc = () => {
      const head = { children: [] as Array<{ id: string; textContent: string }> }
      const doc = {
        head,
        documentElement: head,
        getElementById: (id: string) => head.children.find(child => child.id === id) ?? null,
        createElement: () => { const style = { id: '', textContent: '', remove: () => { head.children.splice(head.children.indexOf(style), 1) } }; return style }
      }
      head.children = []
      ;(head as { appendChild?: (child: { id: string; textContent: string }) => void }).appendChild = (child) => { head.children.push(child) }
      return doc
    }
    const article = { documentCanvas: false, closest() { return this.documentCanvas ? {} : null }, contentDocument: makeDoc(), listeners: [] as Array<() => void>, addEventListener(_type: string, fn: () => void) { this.listeners.push(fn) } }
    const sandboxed = { closest: () => null, contentDocument: null, listeners: [] as Array<() => void>, addEventListener(_type: string, fn: () => void) { this.listeners.push(fn) } }
    const className = new Set<string>()
    const classList = { contains: (name: string) => className.has(name), toggle: (name: string, force: boolean) => { force ? className.add(name) : className.delete(name) }, add: (name: string) => className.add(name), remove: (name: string) => className.delete(name) }
    const hostHead = fakeHead()
    const sandbox = { document: { documentElement: { dataset: {} as Record<string, string>, classList }, head: hostHead, getElementById: hostHead.getElementById, createElement: hostHead.createElement, querySelectorAll: () => [article, sandboxed] }, location: { pathname: '/workspace/channel/abc' }, window: { dispatchEvent: () => true }, CustomEvent: class {}, RegExp, WeakSet, MutationObserver: class { observe() {} } }
    const run = (theme: 'dark' | 'light') => new Function(...Object.keys(sandbox), `return ${moduleThemeScript(theme)}`)(...Object.values(sandbox))
    run('dark')
    expect(article.contentDocument.head.children.map(child => child.id)).toEqual(['dsh-host-frame-dark'])
    expect(article.contentDocument.head.children[0]?.textContent).toBe(FRAME_DARK_CSS)
    expect(article.listeners).toHaveLength(1)
    expect(sandboxed.listeners).toHaveLength(1)
    // A reload replaces the frame document; the load listener styles the new one once.
    article.contentDocument = makeDoc()
    article.listeners[0]?.()
    article.listeners[0]?.()
    expect(article.contentDocument.head.children).toHaveLength(1)
    run('dark')
    expect(article.listeners).toHaveLength(1)
    article.documentCanvas = true
    run('dark')
    expect(article.contentDocument.head.children).toHaveLength(0)
    run('light')
    expect(article.contentDocument.head.children).toHaveLength(0)
    expect(FRAME_DARK_CSS).toContain('img,video,canvas')
    expect(FRAME_DARK_CSS.startsWith('html{filter:invert(1) hue-rotate(180deg)')).toBe(true)
  })

  it('derives dark replacements from lightness and leaves chromatic or already-dark colors alone', () => {
    expect(darkDeclaration('text', '212121')).toBe('color:rgb(var(--text-1))')
    expect(darkDeclaration('text', '4e5969')).toBe('color:rgb(var(--text-2))')
    expect(darkDeclaration('text', '86909c')).toBe('color:rgb(var(--text-3))')
    expect(darkDeclaration('text', 'c9cdd4')).toBe('color:rgb(var(--text-4))')
    expect(darkDeclaration('text', '111827')).toBe('color:rgb(var(--text-1))')
    expect(darkDeclaration('text', '000d4d')).toBeUndefined()
    expect(darkDeclaration('text', 'ffffff')).toBeUndefined()
    expect(darkDeclaration('text', 'f53f3f')).toBeUndefined()
    expect(darkDeclaration('bg', 'ffffff')).toBe('background-color:rgb(var(--bg-page))')
    expect(darkDeclaration('bg', 'f7f8fa')).toBe('background-color:rgb(var(--arco-gray-1))')
    expect(darkDeclaration('bg', 'fafbfc')).toBe('background-color:rgb(var(--bg-page))')
    expect(darkDeclaration('bg', 'e5e6eb')).toBe('background-color:rgb(var(--arco-gray-2))')
    expect(darkDeclaration('bg', '212121')).toBeUndefined()
    expect(darkDeclaration('bg', 'e8f3ff')).toBeUndefined()
    expect(darkDeclaration('border', 'e5e6eb')).toBe('border-color:rgb(var(--border-base))')
    expect(darkDeclaration('border', '8d93a0')).toBe('border-color:rgb(var(--border-deep))')
    expect(darkDeclaration('bg', 'ffffff', '0.85')).toBe('background-color:rgb(var(--bg-page) / 0.85)')
    expect(darkDeclaration('from', 'ffffff')).toBe('--tw-gradient-from:rgb(var(--bg-page)) var(--tw-gradient-from-position);--tw-gradient-to:rgb(var(--bg-page) / 0) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)')
    expect(darkDeclaration('from', 'ffffff', '0')).toBe('--tw-gradient-from:rgb(var(--bg-page) / 0) var(--tw-gradient-from-position);--tw-gradient-to:rgb(var(--bg-page) / 0) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)')
    expect(darkDeclaration('via', 'ffffff', '0.85')).toBe('--tw-gradient-to:rgb(var(--bg-page) / 0) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),rgb(var(--bg-page) / 0.85) var(--tw-gradient-via-position),var(--tw-gradient-to)')
    expect(darkDeclaration('to', 'f9fafb')).toBe('--tw-gradient-to:rgb(var(--bg-page)) var(--tw-gradient-to-position)')
    expect(darkDeclaration('to', 'f7f8fa')).toBe('--tw-gradient-to:rgb(var(--arco-gray-1)) var(--tw-gradient-to-position)')
    expect(darkDeclaration('from', '1f2937')).toBeUndefined()
  })

  it('scopes fixed rules to module routes, utilities to every dark host route, and covers both hex spellings', () => {
    const chromeCss = MODULE_THEME_CSS.replaceAll(':not(:where([data-document-canvas], [data-document-canvas] *))', '')
    const rules = chromeCss.split('\n')
    expect(rules[0]).toBe('html.dsh-module-dark{color-scheme:dark}')
    expect(rules[2]).toBe('html.dsh-module-dark :is(thead,th,[role=columnheader]){background-color:rgb(var(--arco-gray-1))}')
    expect(rules[3]).toBe('html.dsh-module-dark[data-dsh-page="knowledge"] .aspect-\\[4\\/3\\] > svg[viewBox="0 0 120 90"]{filter:invert(1) hue-rotate(180deg)}')
    expect(rules[4]).toBe('html.dsh-host-dark [class*="bg-[linear-gradient("][class*="#FFF"],html.dsh-host-dark [class*="bg-[linear-gradient("][class*="#fff"]{background-image:linear-gradient(135deg,rgb(var(--brand-500) / 0.08),rgb(var(--arco-gray-1)) 50%,rgb(var(--brand-500) / 0.08))}')
    for (const rule of rules.slice(0, 4)) for (const selector of rule.slice(0, rule.indexOf('{')).replace(/:is\([^)]*\)/gu, '').split(',')) expect(selector.startsWith('html.dsh-module-dark')).toBe(true)
    // Selector lists are split on the scope prefix: :is() lists and inline-style selectors carry commas of their own.
    for (const rule of rules.slice(4)) for (const selector of rule.slice(0, rule.indexOf('{')).split(',html.')) expect(selector.startsWith('html.dsh-host-dark ') || selector.startsWith('dsh-host-dark ')).toBe(true)
    // A plain utility sits in the base :is() list of its declaration's rule, in both hex spellings.
    const base = (cls: string) => new RegExp(`html\\.dsh-host-dark :is\\([^)]*${cls.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}[,)]`, 'u')
    for (const cls of ['.bg-white', '.bg-\\[\\#fbfbfb\\]', '.bg-\\[\\#FBFBFB\\]', '.bg-\\[\\#f7f7f7\\]', '.text-\\[\\#1d2129\\]', '.text-\\[\\#1D2129\\]', '.text-black', '.text-gray-900', '.border-gray-200', '.bg-gray-50', '.border-white', '.from-white', '.to-white', '.from-white\\/0', '.to-white\\/0', '.via-white\\/85']) {
      expect(chromeCss).toMatch(base(cls))
    }
    for (const kept of [/\.text-\\\[\\#f53f3f\\\][,{)]/u, /\.bg-\\\[\\#212121\\\][,{)]/u, /\.text-white[,{)]/u, /\.bg-black[,{)]/u, /\.text-gray-50[,{)]/u, /\.from-gray-800[,{)]/u]) expect(chromeCss).not.toMatch(kept)
    expect(chromeCss).not.toMatch(/\.dark\b[^-]/u)
    expect(chromeCss.match(/\.text-\\\[\\#111\\\][,)]/gu)).toHaveLength(1)
    // Variant classes are separate utilities; each variant wraps its own :is() list.
    expect(chromeCss).toMatch(/html\.dsh-host-dark :is\([^)]*\.hover\\:bg-\\\[\\#f7f7f7\\\][,)][^)]*\):hover/u)
    expect(chromeCss).toMatch(/html\.dsh-host-dark :is\([^)]*\.fine-pointer\\:hover\\:bg-gray-50[,)][^)]*\):hover/u)
    expect(chromeCss).toMatch(/html\.dsh-host-dark \.group:hover :is\([^)]*\.group-hover\\:text-\\\[\\#333\\\][,)]/u)
    expect(chromeCss).toMatch(/html\.dsh-host-dark :is\([^)]*\.data-\\\[state\\=open\\\]\\:bg-gray-100[,)][^)]*\)\[data-state=open\]/u)
    expect(chromeCss).toMatch(/html\.dsh-host-dark :is\([^)]*\.has-\\\[\\\[data-state\\=open\\\]\\\]\\:bg-\\\[\\#f7f7f7\\\][,)][^)]*\):has\(\[data-state=open\]\)/u)
    expect(chromeCss).not.toContain('::placeholder:hover')
    // Interactive surfaces lift one step: hover on a gray-1 surface renders as gray-2.
    const hoverRule = chromeCss.split('\n').find((rule) => /\.hover\\:bg-\\\[\\#f7f7f7\\\][,)]/u.test(rule))
    expect(hoverRule?.endsWith('{background-color:rgb(var(--arco-gray-2))}')).toBe(true)
    const baseRule = chromeCss.split('\n').find((rule) => /:is\([^)]*\.bg-\\\[\\#f7f7f7\\\][,)]/u.test(rule))
    expect(baseRule?.endsWith('{background-color:rgb(var(--arco-gray-1))}')).toBe(true)
    const whiteHover = chromeCss.split('\n').find((rule) => /\.hover\\:bg-white[,)]/u.test(rule))
    expect(whiteHover?.endsWith('{background-color:rgb(var(--arco-gray-1))}')).toBe(true)
    // Linsight inline palette: matched on the serialized style attribute, overridden with !important.
    expect(chromeCss).toContain('html.dsh-host-dark [style^="color: rgb(29, 33, 41)"],html.dsh-host-dark [style*="; color: rgb(29, 33, 41)"]{color:rgb(var(--text-1)) !important}')
    expect(chromeCss).toContain('[style^="color: rgb(92, 92, 92)"]')
    expect(chromeCss).toContain('html.dsh-host-dark [style^="background-color: rgb(255, 255, 255)"],html.dsh-host-dark [style*="; background-color: rgb(255, 255, 255)"]{background-color:rgb(var(--bg-page)) !important}')
    expect(chromeCss).toContain(`html.dsh-host-dark [style*="%23EAEEFF"]{background-image:url("data:image/svg+xml,`)
    expect(chromeCss).toMatch(/fill='%232C2F36'[^\n]*!important\}/u)
    // highlight.js keeps its light palette; the host supplies the dark ink for every token group.
    expect(chromeCss).toContain('html.dsh-host-dark code.hljs,html.dsh-host-dark code[class*="language-"],html.dsh-host-dark pre[class*="language-"]{color:rgb(var(--text-1))}')
    expect(chromeCss).toContain('html.dsh-host-dark .hljs-comment,html.dsh-host-dark .hljs-meta{color:#8b949e}')
    expect(chromeCss).toContain('html.dsh-host-dark .hljs-keyword,')
    expect(chromeCss).toContain('html.dsh-host-dark .hljs-string{color:#a5d6ff}')
    expect(chromeCss).toContain('html.dsh-host-dark .hljs-attr,')
  })
})
