import type { EnterpriseChatPresentation, EnterprisePalette } from '../../shared/enterprise-chat-view'

/**
 * Module pages (knowledge spaces, subscriptions) ship no dark theme of their own: the
 * BISHENG client pins `<html class="light">` even though `@bisheng/ui` tokens define a
 * complete `.dark` ramp. The host therefore owns the class on module routes only, so the
 * Chat routes keep their deployed `data-dsh-chat-theme` handling untouched.
 */
export const MODULE_ROUTE_PATTERN = '^/workspace/(capabilities|knowledge|channel|apps|skills|square|settings)(?:[/?#]|$)'

/**
 * The BISHENG ThemeProvider rewrites the html class to `light` when React mounts, which
 * happens after the document's load event. The guard therefore stays installed in the page
 * and re-asserts the host decision whenever the class attribute changes; the host re-runs
 * this script on theme changes and in-page route changes, where `apply` reads the latest
 * host theme from the dataset. `dsh-host-dark` marks every route whose host theme is dark
 * (utility overrides apply there too, Chat included); `dsh-module-dark` is the module-only
 * scope where the host owns `html.dark`.
 */
export function moduleThemeScript(theme: EnterpriseChatPresentation['theme'], palette?: EnterprisePalette): string {
  return `(() => {
    const root = document.documentElement;
    root.dataset.dshHostTheme = '${theme}';
    // The palette follows the host theme, so it is rewritten on every delivery rather than once.
    const paletteCss = ${JSON.stringify(palette ? moduleThemePaletteCss(palette) : '')};
    const paletteStyle = document.getElementById('dsh-host-palette');
    if (paletteCss) {
      const style = paletteStyle || document.createElement('style');
      style.id = 'dsh-host-palette';
      if (style.textContent !== paletteCss) style.textContent = paletteCss;
      if (!style.isConnected) (document.head || root).appendChild(style);
    } else if (paletteStyle) paletteStyle.remove();
    if (!window.__dshModuleTheme) {
      const pattern = new RegExp(${JSON.stringify(MODULE_ROUTE_PATTERN)}, 'u');
      const frameCss = ${JSON.stringify(FRAME_DARK_CSS)};
      // The page may manage html.dark itself on chat routes; the host only ever removes the
      // class it added, so the two never fight over the attribute (a tug of war hangs the page).
      let owned = false;
      // Article readers render fetched HTML in same-origin srcdoc frames that pin a white page;
      // the host styles each reachable frame document, and again whenever the frame reloads.
      const themeFrame = (frame) => {
        let doc = null;
        try { doc = frame.contentDocument; } catch (error) { doc = null; }
        if (!doc) return;
        const dark = root.classList.contains('dsh-module-dark') && !frame.closest('[data-document-canvas]');
        let style = doc.getElementById('dsh-host-frame-dark');
        if (dark && !style) { style = doc.createElement('style'); style.id = 'dsh-host-frame-dark'; style.textContent = frameCss; (doc.head || doc.documentElement).appendChild(style); }
        else if (!dark && style) style.remove();
      };
      const watched = new WeakSet();
      const themeFrames = () => {
        for (const frame of document.querySelectorAll('iframe[srcdoc]')) {
          if (!watched.has(frame)) { watched.add(frame); frame.addEventListener('load', () => themeFrame(frame)); }
          themeFrame(frame);
        }
      };
      const apply = () => {
        const page = (location.pathname.match(pattern) || [])[1] || '';
        if ((root.dataset.dshPage || '') !== page) { if (page) root.dataset.dshPage = page; else delete root.dataset.dshPage; }
        const hostDark = root.dataset.dshHostTheme === 'dark';
        const dark = hostDark && page !== '';
        if (root.classList.contains('dsh-host-dark') !== hostDark) root.classList.toggle('dsh-host-dark', hostDark);
        if (root.classList.contains('dsh-module-dark') !== dark) root.classList.toggle('dsh-module-dark', dark);
        // Flip the ownership flag before touching the class: the observer re-enters apply on the mutation.
        if (dark) { if (!root.classList.contains('dark')) { owned = true; root.classList.add('dark'); } }
        else if (owned) { owned = false; root.classList.remove('dark'); }
        themeFrames();
      };
      new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['class'] });
      new MutationObserver((records) => { if (records.some((record) => [...record.addedNodes].some((node) => node.nodeType === 1))) themeFrames(); }).observe(root, { childList: true, subtree: true });
      window.__dshModuleTheme = { apply };
    }
    window.__dshModuleTheme.apply();
    window.dispatchEvent(new CustomEvent('dsh:appearance', { detail: { theme: '${theme}' } }));
    // Report the resolved page surface so the host log shows whether its palette reached the page.
    try {
      const layout = document.querySelector('#root > *');
      return 'page=' + getComputedStyle(root).getPropertyValue('--bg-page').trim() + ' layout=' + (layout ? getComputedStyle(layout).backgroundColor : 'none');
    } catch (error) { return 'unreadable'; }
  })()`
}

/** Linear channel mix; both ends are already opaque sRGB. */
function mixChannels(from: readonly [number, number, number], to: readonly [number, number, number], ratio: number): string {
  return from.map((channel, index) => Math.round(channel + ((to[index] as number) - channel) * ratio)).join(' ')
}

/** `h s% l%` for the page's shadcn-style tokens, which are consumed through `hsl(var(--token))`. */
function hslTriple(channels: string): string {
  const [r = 0, g = 0, b = 0] = channels.split(' ').map((value) => Number(value) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  const lightness = (max + min) / 2
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  const hue = delta === 0 ? 0 : max === r ? 60 * (((g - b) / delta + 6) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4)
  const fixed = (value: number): string => (Math.round(value * 10) / 10).toString()
  return `${fixed(hue)} ${fixed(saturation * 100)}% ${fixed(lightness * 100)}%`
}

/**
 * The deployed shell declares its ramp twice: once on `.dark` at the root, and again on its layout
 * root (`.dsh-web-chat` and the dialogs beside it) under `body[data-dsh-chat-theme]`, which the shell
 * derives from the host theme itself. Embedded settings pages render inside that layout root, so a
 * root-only override is shadowed there; the same declarations are therefore emitted on both scopes.
 */
const CHAT_LAYOUT_SCOPES = '.dsh-web-chat,.dsh-chat-menu,.dsh-chat-preview-modal,.dsh-knowledge-dialog'

/**
 * The BISHENG client reads its surfaces and ink through `rgb(var(--token))` triples, so one
 * redefinition of those triples moves the whole embedded page onto the host's palette instead of
 * its own dark ramp — including every utility the overrides below already redirect at these tokens.
 * The host-dark root supplies tokens to Chat, module pages and portaled dialogs, while
 * a light host leaves the page's own light design alone. `:root` lifts the specificity above the
 * page's own `html.dark` ramp whatever order the two stylesheets land in. The brand ramp is not
 * touched; product color stays the page's own.
 */
export function moduleThemePaletteCss(palette: EnterprisePalette): string {
  const { surface, raised, strong, labelPrimary, labelSecondary, labelTertiary, borderBase, borderDeep } = palette
  const lifted = mixChannels(raised, strong, 1 / 3)
  const declarations = [
    ['--bg-page', surface.join(' ')],
    ['--arco-gray-1', raised.join(' ')],
    ['--arco-gray-2', lifted],
    ['--arco-gray-3', mixChannels(raised, strong, 2 / 3)],
    ['--arco-gray-4', strong.join(' ')],
    // The layout root's own card ramp: a subtle card one step up, a stronger one two steps up.
    ['--fill-1', raised.join(' ')],
    ['--fill-2', lifted],
    ['--fill-3', mixChannels(raised, strong, 2 / 3)],
    ['--fill-4', strong.join(' ')],
    ['--btn-gray-text', labelSecondary.join(' ')],
    ['--btn-gray-solid-bg', strong.join(' ')],
    ['--btn-gray-border', borderBase.join(' ')],
    ['--btn-fill-1', raised.join(' ')],
    ['--btn-fill-2', lifted],
    ['--btn-fill-3', mixChannels(raised, strong, 2 / 3)],
    ['--btn-fill-4', strong.join(' ')],
    ['--btn-disabled-bg', raised.join(' ')],
    ['--btn-disabled-text', labelTertiary.join(' ')],
    ['--btn-disabled-border', borderBase.join(' ')],
    ['--tooltip-bg', raised.join(' ')],
    ['--text-1', labelPrimary.join(' ')],
    ['--text-2', labelSecondary.join(' ')],
    ['--text-3', labelTertiary.join(' ')],
    // The page's faintest ink has no host token of its own; it is tertiary faded toward the surface.
    ['--text-4', mixChannels(labelTertiary, surface, 0.45)],
    ['--border-base', borderBase.join(' ')],
    ['--border-deep', borderDeep.join(' ')]
  ]
  // The embedded settings pages paint their container through the shadcn ramp (`bg-background`,
  // `bg-card`, `border-border`), a second family the `.dark` block defines in HSL; it follows the
  // same host anchors so a container and the page behind it never show two different darks.
  const hsl: Array<[string, string]> = [
    ['--background', hslTriple(surface.join(' '))],
    ['--card', hslTriple(raised.join(' '))],
    ['--popover', hslTriple(raised.join(' '))],
    ['--popover-foreground', hslTriple(labelPrimary.join(' '))],
    ['--secondary', hslTriple(lifted)],
    ['--muted', hslTriple(lifted)],
    ['--accent', hslTriple(lifted)],
    ['--border', hslTriple(borderBase.join(' '))],
    ['--input', hslTriple(borderDeep.join(' '))],
    ['--foreground', hslTriple(labelPrimary.join(' '))],
    ['--card-foreground', hslTriple(labelPrimary.join(' '))],
    ['--secondary-foreground', hslTriple(labelPrimary.join(' '))],
    ['--accent-foreground', hslTriple(labelPrimary.join(' '))],
    ['--muted-foreground', hslTriple(labelTertiary.join(' '))]
  ]
  const body = [...declarations, ...hsl].map(([name, value]) => `${name}:${value}`).join(';')
  // Chat owns its page/composer contrast. Module layouts use the panel palette;
  // root tokens also reach portaled controls outside either layout.
  return [
    `html.dsh-host-dark:root{${body}}`,
    `html.dsh-module-dark body[data-dsh-chat-theme] :is(${CHAT_LAYOUT_SCOPES}){${body}}`,
    ...(palette.composer ? [`html[data-dsh-host-theme=dark] body[data-dsh-chat-theme=dark] .dsh-web-chat{--dsh-composer-bg:${palette.composer.join(' ')}}`] : [])
  ].join('\n')
}

/**
 * Fetched article HTML carries its own colors (inline WeChat styles, `background:#fff
 * !important` from the reader shell), so token overrides cannot reach it. Inverting the frame
 * and re-inverting its media is the only treatment that keeps arbitrary content legible; the
 * html background is chosen so the inversion lands on the dark page color.
 */
export const FRAME_DARK_CSS = [
  'html{filter:invert(1) hue-rotate(180deg);background:#ebebe9 !important;color-scheme:dark}',
  'body{background:transparent !important}',
  'img,video,canvas,picture,svg,iframe,[style*="background-image"],[style*="background:url"],[style*="background: url"]{filter:invert(1) hue-rotate(180deg)}'
].join('\n')

function escapeUtility(name: string): string {
  return name.replace(/[[\]#/.%:=]/gu, (char) => `\\${char}`)
}

/**
 * Tailwind variants the client combines with the hardcoded colors (`hover:bg-[#f7f7f7]`,
 * `has-[[data-state=open]]:bg-[#f7f7f7]`): each is a distinct class, so the override is
 * emitted once per variant with the variant's own selector shape.
 */
const VARIANTS: ReadonlyArray<{ prefix: string; wrap: (list: string) => string }> = [
  { prefix: 'hover:', wrap: (list) => `:is(${list}):hover` },
  { prefix: 'focus:', wrap: (list) => `:is(${list}):focus` },
  { prefix: 'active:', wrap: (list) => `:is(${list}):active` },
  { prefix: 'fine-pointer:hover:', wrap: (list) => `:is(${list}):hover` },
  { prefix: 'group-hover:', wrap: (list) => `.group:hover :is(${list})` },
  { prefix: 'data-[state=open]:', wrap: (list) => `:is(${list})[data-state=open]` },
  { prefix: 'has-[[data-state=open]]:', wrap: (list) => `:is(${list}):has([data-state=open])` }
]

/**
 * Hardcoded color utilities seen in the BISHENG client (deployed 3006 bundle plus the
 * `pages/knowledge` and `pages/Subscription` sources). Only the class names are listed; the
 * dark replacement is derived from each color's lightness below, so new entries need no
 * hand-picked target. Hex values are lowercase here; both spellings are emitted.
 */
const HARDCODED_UTILITIES: readonly string[] = [
  'bg-[#00b42a]', 'bg-[#0285ff]', 'bg-[#06b84c]', 'bg-[#1d2129]', 'bg-[#212121]', 'bg-[#25c298]', 'bg-[#282c34]',
  'bg-[#303134]', 'bg-[#4e5969]', 'bg-[#86909c]', 'bg-[#999999]', 'bg-[#c9cdd4]', 'bg-[#d9d9d9]', 'bg-[#e0e0e0]',
  'bg-[#e4e4e4]', 'bg-[#e5e6eb]', 'bg-[#e8ebf2]', 'bg-[#e8f3ff]', 'bg-[#e8ffea]', 'bg-[#ebebeb]', 'bg-[#ebecf0]',
  'bg-[#ebeff8]', 'bg-[#ebf0ff]', 'bg-[#ececec]', 'bg-[#ede4ff]', 'bg-[#ededed]', 'bg-[#eee]', 'bg-[#eeeeee]',
  'bg-[#eeeff1]', 'bg-[#eef0f4]', 'bg-[#f0f0f0]', 'bg-[#f0f1f3]', 'bg-[#f0f5ff]', 'bg-[#f1f1f1]', 'bg-[#f2f3f5]',
  'bg-[#f2f8ec]', 'bg-[#f4f4f4]', 'bg-[#f4f5f8]', 'bg-[#f4f8ff]', 'bg-[#f53f3f]', 'bg-[#f5f5f5]', 'bg-[#f5f7fa]',
  'bg-[#f5f7fb]', 'bg-[#f6f8fa]', 'bg-[#f7f3ff]', 'bg-[#f7f7f7]', 'bg-[#f7f8fa]', 'bg-[#f8f8f8]', 'bg-[#f9f9f9]',
  'bg-[#fa423e]', 'bg-[#fafafa]', 'bg-[#fafbfc]', 'bg-[#fbfbfb]', 'bg-[#ff7d00]', 'bg-[#ff9800]', 'bg-[#ffbf00]',
  'bg-[#ffe6d2]', 'bg-[#fff2f0]', 'bg-[#fff3e8]', 'bg-[#fff7e8]', 'bg-[#fff]', 'bg-gray-100', 'bg-gray-20',
  'bg-gray-200', 'bg-gray-300', 'bg-gray-400', 'bg-gray-50', 'bg-gray-500', 'bg-gray-600', 'bg-gray-700',
  'bg-gray-800', 'bg-gray-850', 'bg-gray-900', 'bg-gray-950', 'bg-neutral-800', 'bg-neutral-900', 'bg-slate-100',
  'bg-slate-200', 'bg-slate-50', 'bg-white', 'border-[#212121]', 'border-[#8d93a0]', 'border-[#c9cdd4]',
  'border-[#ced4e0]', 'border-[#d9d9d9]', 'border-[#d9dde7]', 'border-[#ddd]', 'border-[#dddddd]',
  'border-[#e0e0e0]', 'border-[#e3e3e3]', 'border-[#e5e6eb]', 'border-[#e8e9ed]', 'border-[#ebebeb]',
  'border-[#ebecf0]', 'border-[#ececec]', 'border-[#eef2f6]', 'border-[#f0f0f0]', 'border-[#f0f1f5]',
  'border-[#f2f3f5]', 'border-[#f53f3f]', 'border-[#ff7d00]', 'border-gray-100', 'border-gray-200',
  'border-gray-300', 'border-gray-400', 'border-gray-50', 'border-gray-500', 'border-gray-600', 'border-gray-700',
  'border-gray-800', 'border-gray-900', 'border-slate-100', 'border-slate-300', 'divide-[#ececec]',
  'divide-gray-200', 'divide-gray-600', 'text-[#000d4d]', 'text-[#007d1a]', 'text-[#00b42a]', 'text-[#024de3]',
  'text-[#070038]', 'text-[#111]', 'text-[#161616]', 'text-[#165dff]', 'text-[#1a1a1a]', 'text-[#1b61e6]',
  'text-[#1d2129]', 'text-[#212121]', 'text-[#24292e]', 'text-[#25c298]', 'text-[#333]', 'text-[#335cff]',
  'text-[#374151]', 'text-[#3a3a3a]', 'text-[#4e5969]', 'text-[#57606a]', 'text-[#5c6680]', 'text-[#61646d]',
  'text-[#64698b]', 'text-[#666666]', 'text-[#666]', 'text-[#6b7785]', 'text-[#6b778d]', 'text-[#7224d9]',
  'text-[#7c3aed]', 'text-[#808080]', 'text-[#818181]', 'text-[#86909c]', 'text-[#8a94a6]', 'text-[#8b8fa8]',
  'text-[#8c8c8c]', 'text-[#8d93a0]', 'text-[#91c561]', 'text-[#979797]', 'text-[#989898]', 'text-[#999999]',
  'text-[#999]', 'text-[#a9aeb8]', 'text-[#b6bbc5]', 'text-[#c0c4cc]', 'text-[#c9cdd4]', 'text-[#e5e6eb]',
  'text-[#e84b3c]', 'text-[#f53f3f]', 'text-[#f58a1f]', 'text-[#f76f44]', 'text-[#ff7d00]', 'text-[#fff]',
  'text-black', 'text-gray-100', 'text-gray-20', 'text-gray-200', 'text-gray-300', 'text-gray-400', 'text-gray-50',
  'text-gray-500', 'text-gray-600', 'text-gray-70', 'text-gray-700', 'text-gray-800', 'text-gray-900',
  'text-gray-950', 'text-neutral-800', 'text-slate-300', 'text-slate-400', 'text-slate-50', 'text-slate-500',
  'text-slate-600', 'text-slate-700', 'text-slate-800',
  'bg-white/10', 'bg-white/20', 'bg-white/30', 'bg-white/40', 'bg-white/50', 'bg-white/60', 'bg-white/70', 'bg-white/80', 'bg-white/85', 'bg-white/90', 'bg-white/95',
  'bg-gray-50/80', 'bg-gray-50/90', 'bg-gray-100/50', 'bg-gray-100/80', 'border-gray-100/40', 'text-black/40',
  'border-white',
  // Gradient stops: the masks behind ask bars and docks fade list content into a white page.
  'from-white', 'from-white/0', 'from-white/20', 'via-white/85', 'to-white', 'to-white/0', 'to-white/20',
  'from-gray-50', 'from-gray-200', 'from-gray-500', 'from-gray-700', 'from-gray-800', 'from-gray-850', 'from-gray-900',
  'to-gray-500', 'to-gray-900'
]

/**
 * Colors the client writes as inline `style` (the Linsight execution palette in
 * `execTokens.ts` and its result cards). Inline declarations outrank any class rule, so
 * these are matched on the serialized attribute and overridden with `!important`.
 */
const INLINE_STYLE_COLORS: ReadonlyArray<{ kind: 'text' | 'bg'; hex: string }> = [
  { kind: 'text', hex: '1d2129' }, { kind: 'text', hex: '5c5c5c' }, { kind: 'text', hex: '8a8a8a' },
  { kind: 'text', hex: '999999' }, { kind: 'text', hex: 'bfbfbf' },
  { kind: 'bg', hex: 'ffffff' }, { kind: 'bg', hex: 'fafbfc' }, { kind: 'bg', hex: 'e8eaed' }
]

/** Dot texture behind Linsight result / clarify cards: light-blue dots meant for a white card. */
const DOT_TEXTURE_LIGHT = '%23EAEEFF'
const DOT_TEXTURE_DARK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='5' height='5'%3E%3Ccircle cx='0.5' cy='0.5' r='0.5' fill='%232C2F36'/%3E%3C/svg%3E")`

/**
 * The client ships only highlight.js's GitHub light palette (style.css `.hljs-*`), so code
 * blocks keep light-theme ink once their surface turns dark. GitHub Dark colours, scoped to
 * the host-dark root; the token groups mirror the light palette's grouping exactly.
 */
const HLJS_DARK: ReadonlyArray<[string, string]> = [
  ['code.hljs,code[class*="language-"],pre[class*="language-"]', 'rgb(var(--text-1))'],
  ['.hljs-comment,.hljs-meta', '#8b949e'],
  ['.hljs-built_in,.hljs-class .hljs-title,.hljs-bullet,.hljs-link,.hljs-selector-id,.hljs-symbol,.hljs-title', '#d2a8ff'],
  ['.hljs-doctag,.hljs-formula,.hljs-keyword,.hljs-literal', '#ff7b72'],
  ['.hljs-addition,.hljs-attribute,.hljs-meta-string,.hljs-regexp,.hljs-string', '#a5d6ff'],
  ['.hljs-attr,.hljs-number,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-pseudo,.hljs-template-variable,.hljs-type,.hljs-variable', '#79c0ff']
]

/** Tailwind's default gray ramp; slate / zinc / neutral / stone share its lightness steps. */
const GRAY_RAMP: Readonly<Record<string, string>> = {
  20: '#ececf1', 50: '#f9fafb', 70: '#f3f4f6', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af',
  500: '#6b7280', 600: '#4b5563', 700: '#374151', 800: '#1f2937', 850: '#171717', 900: '#111827', 950: '#030712'
}

interface Utility { kind: 'bg' | 'text' | 'border' | 'divide' | 'placeholder' | 'from' | 'via' | 'to'; hex: string; names: string[]; alpha?: string }

/** Tailwind opacity modifiers (`bg-white/85`) keep their alpha on the replacement token. */
function parseUtility(name: string): Utility | undefined {
  const modifier = name.match(/^(.*)\/(\d{1,3})$/u)
  if (modifier) {
    const base = parseUtility(modifier[1] as string)
    if (!base) return undefined
    const alpha = (Number(modifier[2]) / 100).toString()
    return { ...base, alpha, names: base.names.map((alias) => `${alias}/${modifier[2]}`) }
  }
  const hex = name.match(/^(bg|text|border|divide|placeholder|from|via|to)-\[#([0-9a-f]{3}|[0-9a-f]{6})\]$/u)
  if (hex) {
    const kind = hex[1] as Utility['kind']
    const value = hex[2] as string
    const upper = `${kind}-[#${value.toUpperCase()}]`
    return { kind, hex: value.length === 3 ? [...value].map((c) => c + c).join('') : value, names: [...new Set([name, upper])] }
  }
  const named = name.match(/^(bg|text|border|divide|from|via|to)-(?:gray|slate|zinc|neutral|stone)-(\d{2,3})$/u)
  if (named) {
    const step = GRAY_RAMP[named[2] as string]
    return step ? { kind: named[1] as Utility['kind'], hex: step.slice(1), names: [name] } : undefined
  }
  if (name === 'text-black') return { kind: 'text', hex: '000000', names: [name] }
  if (name === 'border-white') return { kind: 'border', hex: 'ffffff', names: [name] }
  const stop = name.match(/^(from|via|to)-white$/u)
  if (stop) return { kind: stop[1] as Utility['kind'], hex: 'ffffff', names: [name] }
  if (name === 'bg-white' || name === 'bg-[#fff]') return { kind: 'bg', hex: 'ffffff', names: name === 'bg-white' ? [name] : [name, 'bg-[#FFF]', 'bg-[#ffffff]', 'bg-[#FFFFFF]'] }
  return undefined
}

/** HSL lightness, saturation and chroma (max − min channel) of a six-digit hex color, all in [0, 1]. */
function tone(hex: string): { lightness: number; saturation: number; chroma: number } {
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 2
  const chroma = max - min
  const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1))
  return { lightness, saturation, chroma }
}

/**
 * Dark replacement for a light-mode utility, or undefined to leave it alone. Chromatic
 * colors (brand, status, tinted surfaces) stay; so do already-dark backgrounds and
 * already-light text. Dark grays such as Tailwind's blue-tinted gray-900 read as saturated
 * in HSL, so near-black colors are judged by chroma instead.
 */
export function darkDeclaration(kind: Utility['kind'], hex: string, alpha?: string): string | undefined {
  const { lightness, saturation, chroma } = tone(hex)
  // HSL saturation explodes next to white (#fafbfc reads as 25% saturated), so near-whites
  // and near-blacks are judged by chroma instead.
  const neutral = saturation <= 0.25 || chroma < 0.03 || (lightness < 0.5 && chroma < 0.12)
  if (!neutral) return undefined
  const token = (name: string, opacity = alpha): string => `rgb(var(--${name})${opacity === undefined ? '' : ` / ${opacity}`})`
  const surface = (): string | undefined => {
    if (lightness >= 0.98) return 'bg-page'
    if (lightness >= 0.95) return 'arco-gray-1'
    if (lightness >= 0.9) return 'arco-gray-2'
    if (lightness >= 0.78) return 'arco-gray-3'
    if (lightness >= 0.5) return 'arco-gray-4'
    return undefined
  }
  if (kind === 'bg') {
    const name = surface()
    return name && `background-color:${token(name)}`
  }
  // Tailwind 3 gradient stops are custom properties; the replacement mirrors what the
  // light utility set, so `from-*` still seeds a transparent `to` and `via` keeps both ends.
  if (kind === 'from' || kind === 'via' || kind === 'to') {
    const name = surface()
    if (!name) return undefined
    if (kind === 'from') return `--tw-gradient-from:${token(name)} var(--tw-gradient-from-position);--tw-gradient-to:${token(name, '0')} var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)`
    if (kind === 'via') return `--tw-gradient-to:${token(name, '0')} var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),${token(name)} var(--tw-gradient-via-position),var(--tw-gradient-to)`
    return `--tw-gradient-to:${token(name)} var(--tw-gradient-to-position)`
  }
  if (kind === 'text' || kind === 'placeholder') {
    if (lightness < 0.3) return `color:${token('text-1')}`
    if (lightness < 0.48) return `color:${token('text-2')}`
    if (lightness < 0.75) return `color:${token('text-3')}`
    if (lightness < 0.9) return `color:${token('text-4')}`
    return undefined
  }
  if (lightness >= 0.78) return `border-color:${token('border-base')}`
  if (lightness >= 0.5) return `border-color:${token('border-deep')}`
  return undefined
}

const SURFACE_LIFT: Readonly<Record<string, string>> = { 'bg-page': 'arco-gray-1', 'arco-gray-1': 'arco-gray-2', 'arco-gray-2': 'arco-gray-3', 'arco-gray-3': 'arco-gray-4' }

/** The next surface token up the ramp for hover / active / open states; the top step stays. */
function liftSurface(declaration: string): string {
  return declaration.replace(/--(bg-page|arco-gray-[1-3])\b/u, (_match, name: string) => `--${SURFACE_LIFT[name] ?? name}`)
}

/** File content owns its palette; host overrides apply to application chrome. */
const APP_SURFACE = ':not(:where([data-document-canvas], [data-document-canvas] *))'

function buildModuleThemeCss(): string {
  // declaration → variant prefix ('' for the plain utility) → escaped class names
  const groups = new Map<string, Map<string, string[]>>()
  for (const name of HARDCODED_UTILITIES) {
    const utility = parseUtility(name)
    if (!utility) throw new Error(`Unrecognised module theme utility: ${name}`)
    const declaration = darkDeclaration(utility.kind, utility.hex, utility.alpha)
    if (!declaration) continue
    // Placeholder utilities share text declarations but need the pseudo-element on every selector.
    const key = utility.kind === 'placeholder' ? `${declaration}::placeholder` : declaration
    const variants = groups.get(key) ?? new Map<string, string[]>()
    groups.set(key, variants)
    const push = (group: Map<string, string[]>, prefix: string, alias: string) => {
      const list = group.get(prefix) ?? []
      const escaped = `.${escapeUtility(prefix + alias)}`
      if (!list.includes(escaped)) list.push(escaped)
      group.set(prefix, list)
    }
    // Interactive surfaces sit one step above their resting replacement: in the dark ramp the
    // page and arco-gray-1 are only a few values apart, so a hover mapped 1:1 would not read.
    const lifted = utility.kind === 'bg' ? liftSurface(declaration) : declaration
    const liftedGroup = groups.get(lifted) ?? new Map<string, string[]>()
    if (lifted !== declaration) groups.set(lifted, liftedGroup)
    for (const alias of utility.names) {
      push(variants, '', alias)
      if (utility.kind !== 'placeholder') for (const variant of VARIANTS) push(lifted === declaration ? variants : liftedGroup, variant.prefix, alias)
    }
  }
  // One rule per declaration: the plain utilities in an :is() list, then each variant wrapped
  // in that variant's own selector shape (`:is()` keeps the class specificity, so the rule
  // still outranks Tailwind's `.hover\:x:hover`).
  const rules = [...groups].map(([key, variants]) => {
    const placeholder = key.endsWith('::placeholder')
    const declaration = placeholder ? key.slice(0, -'::placeholder'.length) : key
    const selectors = [...variants].map(([prefix, list]) => {
      const variant = VARIANTS.find((candidate) => candidate.prefix === prefix)
      return `html.dsh-host-dark ${variant ? variant.wrap(list.join(',')) : `:is(${list.join(',')})`}${APP_SURFACE}${placeholder ? '::placeholder' : ''}`
    })
    return `${selectors.join(',')}{${declaration}}`
  })
  // Inline styles serialize as `prop: rgb(r, g, b)`; the two forms cover the first and any
  // later declaration without letting `color:` match `background-color:`.
  const inline: string[] = []
  for (const { kind, hex } of INLINE_STYLE_COLORS) {
    const declaration = darkDeclaration(kind, hex)
    if (!declaration) throw new Error(`Inline style color has no dark replacement: ${hex}`)
    const property = kind === 'text' ? 'color' : 'background-color'
    const serial = `rgb(${[0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`
    inline.push(`html.dsh-host-dark [style^="${property}: ${serial}"]${APP_SURFACE},html.dsh-host-dark [style*="; ${property}: ${serial}"]${APP_SURFACE}{${declaration} !important}`)
  }
  inline.push(`html.dsh-host-dark [style*="${DOT_TEXTURE_LIGHT}"]${APP_SURFACE}{background-image:${DOT_TEXTURE_DARK} !important}`)
  // Arbitrary gradient utilities (`bg-[linear-gradient(...,#FFF_50%,...)]`) are matched by
  // substring: the class attribute names the white stop, whatever the surrounding stops are.
  const whiteGradient = ['#FFF', '#fff'].map((stop) => `html.dsh-host-dark [class*="bg-[linear-gradient("][class*="${stop}"]${APP_SURFACE}`).join(',')
  return [
    'html.dsh-module-dark{color-scheme:dark}',
    'html.dsh-module-dark body,html.dsh-module-dark #root{background-color:rgb(var(--bg-page));color:rgb(var(--text-1))}',
    // Table headers carry their light surface through component styles rather than utilities.
    `html.dsh-module-dark :is(thead,th,[role=columnheader])${APP_SURFACE}{background-color:rgb(var(--arco-gray-1))}`,
    // Knowledge home folder tiles are inline SVG art with fixed pastel fills under a token-colored
    // name; inverting the art keeps the white name legible without touching the text tokens.
    'html.dsh-module-dark[data-dsh-page="knowledge"] .aspect-\\[4\\/3\\] > svg[viewBox="0 0 120 90"]{filter:invert(1) hue-rotate(180deg)}',
    `${whiteGradient}{background-image:linear-gradient(135deg,rgb(var(--brand-500) / 0.08),rgb(var(--arco-gray-1)) 50%,rgb(var(--brand-500) / 0.08))}`,
    ...rules,
    ...inline,
    ...HLJS_DARK.map(([selectors, color]) => `${selectors.split(',').map((selector) => `html.dsh-host-dark ${selector}${APP_SURFACE}`).join(',')}{color:${color}}`)
  ].join('\n')
}

export const MODULE_THEME_CSS = buildModuleThemeCss()
