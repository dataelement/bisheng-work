import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

interface Registration {
  config: { name: string; id?: string; order?: number }
  component: (props: Record<string, unknown>) => unknown
}

describe('BISHENG client slot occupants', () => {
  it('keeps BISHENG artwork in mark seats while removing the wide sidebar wordmark', async () => {
    const source = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-client-ui', 'client.js'),
      'utf8'
    )
    let definition: {
      factory: (require: (id: string) => unknown) => {
        apply: (ctx: unknown) => void
        inject: string[]
      }
    } | undefined
    const appended: Array<{ textContent?: string }> = []
    const removeStyle = vi.fn()
    let disposeStyle: (() => void) | undefined
    const document = {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => ({ id: '', dataset: {}, textContent: '', remove: removeStyle })),
      head: { appendChild: (node: { textContent?: string }) => appended.push(node) }
    }
    const windowEvents = new EventTarget()
    vm.runInNewContext(source, {
      document,
      navigator: { language: 'en-US' },
      window: {
        addEventListener: windowEvents.addEventListener.bind(windowEvents),
        removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
        __ModuleLoader__: {
          load: (value: typeof definition) => {
            definition = value
          }
        }
      }
    })

    expect(definition).toBeDefined()
    const createElement = (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): { type: unknown; props: Record<string, unknown> } => ({
      type,
      props: { ...props, children }
    })
    const MenuItemButton = vi.fn()
    let menuOpen = false
    const setMenuOpen = vi.fn()
    const effectDisposers: Array<() => void> = []
    const plugin = definition!.factory((id) => {
      if (id === 'react') {
        return {
          createElement,
          useEffect: (effect: () => void | (() => void)) => {
            const dispose = effect()
            if (dispose) effectDisposers.push(dispose)
          },
          useState: (initial: unknown) => [typeof initial === 'boolean' ? menuOpen : initial, setMenuOpen],
          useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot()
        }
      }
      if (id === '@deepseek-ai/dsh-client-ui-primitives') {
        return { MenuItemButton }
      }
      throw new Error(`Unexpected client dependency: ${id}`)
    })

    const registrations: Registration[] = []
    const slots = {
      inject: (_name: string, callback: () => unknown): unknown => {
        const result = callback()
        if (result && typeof result === 'object' && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) void _entry
        }
        return result
      },
      register: (
        config: Registration['config'],
        component: Registration['component']
      ): (() => void) => {
        registrations.push({ config, component })
        return () => undefined
      }
    }
    plugin.apply({
      slots,
      locale: {
        register: () => () => undefined,
        bind: () => (key: string) => key
      },
      remote: { session: { openWorkspacePath: () => Promise.resolve({ ok: true, value: { opened: true } }) } },
      effect: (setup: () => (() => void) | undefined) => { disposeStyle = setup() }
    })

    expect(plugin.inject).toEqual(['slots', 'locale', 'remote', 'remote.session', 'sessions', 'uiWorkspace', 'layout'])
    expect(registrations.map(({ config }) => config.name)).toEqual([
      'shell.overlay',
      'sidebar.primaryNavigation',
      'sidebar.workspaces.title',
      'desktop.mode.content',
      'sidebar.workspaces.collection',
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark',
      'conversation.hero.brand.title',
      'sidebar.right.tab.document.unpreviewable',
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.menu.item'
    ])
    // Desktop toolbar styles have an owned lifetime; branding stays in currentColor.
    expect(appended).toHaveLength(2)
    // Match Harness panelList spacing without changing navigation's outer padding.
    expect(appended[0]?.textContent).toContain('.dshPrimaryNavigation{display:flex;flex-direction:column;flex:none;gap:4px;padding:0 0 12px}')
    expect(appended[0]?.textContent).toContain('.dshPrimaryNavigation[data-wide=false]{gap:12px}')
    // The in-place dropdown fills its trigger wrapper instead of shrink-wrapping its labels.
    expect(appended[0]?.textContent).toContain('.dshNavigationMenu .dshNavigationMenuList{width:100%;min-width:0;max-width:100%;box-sizing:border-box}')
    const primaryNavigation = registrations.find(({ config }) => config.name === 'sidebar.primaryNavigation')!.component
    for (const wide of [true, false]) {
      const nav = primaryNavigation({
        wide, panels: [], navigation: { subscribe: vi.fn(), snapshot: () => ({ mode: 'work' }) }, t: (key: string) => key
      }) as { props: Record<string, unknown> }
      expect(nav.props.className).toBe('dshPrimaryNavigation')
      expect(nav.props['data-wide']).toBe(wide)
    }
    // A native WebContentsView steals window focus without an iframe target.
    menuOpen = true
    primaryNavigation({
      wide: true, panels: [], navigation: { subscribe: vi.fn(), snapshot: () => ({ mode: 'chat' }) }, t: (key: string) => key
    })
    setMenuOpen.mockClear()
    windowEvents.dispatchEvent(new Event('blur'))
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    effectDisposers.forEach(dispose => dispose())
    setMenuOpen.mockClear()
    windowEvents.dispatchEvent(new Event('blur'))
    expect(setMenuOpen).not.toHaveBeenCalled()
    expect(appended[1]?.textContent).toContain("[data-dsh-preset-search]")
    disposeStyle?.()
    expect(removeStyle).toHaveBeenCalledOnce()

    const sidebarName = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.name'
    )!.component({})
    expect(sidebarName).toBeNull()

    const sidebarMark = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.mark'
    )!.component({ size: 24 }) as { type: unknown; props: Record<string, unknown> }
    expect(sidebarMark.type).toBe('svg')
    expect(sidebarMark.props.width).toBe(17)
    expect(sidebarMark.props.height).toBe(17)
    const [markField, ...markPaths] = sidebarMark.props.children as Array<{
      type: unknown
      props: Record<string, unknown>
    }>
    expect(markField?.type).toBe('rect')
    expect(markField?.props.fill).toBe('#000000')
    expect(markPaths).toHaveLength(8)
    expect(markPaths.every(({ type, props }) => type === 'path' && props.fill === 'white')).toBe(true)

    const heroMark = registrations.find(
      ({ config }) => config.name === 'conversation.hero.brand.mark'
    )!.component({ size: 48, className: 'hero-mark', navigation: { subscribe: vi.fn(), snapshot: () => ({}) } }) as {
      type: unknown
      props: Record<string, unknown>
    }
    expect(heroMark.type).toBe('svg')
    expect(heroMark.props.width).toBe(48)
    expect(heroMark.props.height).toBe(48)
    expect(heroMark.props.viewBox).toBe('0 0 2400 2400')
    expect(heroMark.props.fill).toBe('none')
    expect(heroMark.props.className).toBe('hero-mark')
    expect(heroMark.props.size).toBeUndefined()
    const heroChildren = heroMark.props.children as Array<{
      type: unknown
      props: Record<string, unknown>
    }>
    const [heroField, ...heroPaths] = heroChildren
    expect(heroField?.type).toBe('rect')
    expect(heroField?.props.fill).toBe('#000000')
    expect(heroPaths).toHaveLength(8)
    expect(heroPaths.every(({ type, props }) => type === 'path' && props.fill === 'white')).toBe(true)
    const branding = { welcomeMessage: 'Team workspace', assistantIcon: { enabled: true, image: 'https://enterprise.example/custom.svg' } }
    const navigation = { subscribe: vi.fn(), snapshot: () => ({ navigation: { branding } }) }
    const configuredMark = registrations.find(({ config }) => config.name === 'conversation.hero.brand.mark')!.component({ size: 34, navigation }) as { type: unknown; props: Record<string, unknown> }
    expect(configuredMark.type).toBe('img')
    expect(configuredMark.props.src).toBe(branding.assistantIcon.image)
    const configuredTitle = registrations.find(({ config }) => config.name === 'conversation.hero.brand.title')!.component({ navigation, t: (key: string) => key }) as { props: Record<string, unknown> }
    expect(configuredTitle.props.children).toEqual(['Team workspace'])
    branding.assistantIcon.enabled = false
    expect(registrations.find(({ config }) => config.name === 'conversation.hero.brand.mark')!.component({ size: 34, navigation })).toBeNull()

  })

  it('reuses the upstream preview-badge styling for the enterprise label', async () => {
    const source = await readFile(
      path.join(
        projectRoot,
        'node_modules',
        '@deepseek-ai',
        'dsh-client-ui-conversation',
        'lib',
        'client.js'
      ),
      'utf8'
    )

    expect(source).toContain('children: renderSlot("conversation.hero.brand.title", {}, { fallback: [(0, react_jsx_runtime.jsx)("span", { children: t("hero.headline") })')
    expect(source).toContain('className: HeroShell_module_css_default.previewBadge')
    expect(source).toContain('children: t("hero.preview")')
    expect(source).toContain('background:var(--dsw-alias-state-business-tertiary)')
    expect(source).toContain('color:var(--dsw-alias-label-primary-bluish)')
    expect(source).toContain('align-self:flex-start;margin-top:2px')
  })

  it('uses the new hero message in both Chinese and English', async () => {
    const source = await readFile(
      path.join(
        projectRoot,
        'node_modules',
        '@deepseek-ai',
        'dsh-client-ui-conversation',
        'lib',
        'client.js'
      ),
      'utf8'
    )
    const patch = await readFile(
      path.join(
        projectRoot,
        'patches',
        '@deepseek-ai+dsh-client-ui-conversation+0.2.1-rc.2.patch'
      ),
      'utf8'
    )

    expect(source).toContain('"hero.headline": "来一起创造"')
    expect(source).toContain('"hero.preview": "企业版"')
    expect(source).not.toContain('"hero.headline": "探索未至之境"')
    expect(source).toContain('"hero.headline": "Let\'s Create Together"')
    expect(source).toContain('"hero.preview": "Enterprise"')
    expect(patch).toContain('+\t\t\t"hero.headline": "来一起创造",')
    expect(patch).toContain('+\t\t\t"hero.preview": "企业版",')
    expect(patch).toContain('-\t\t\t"hero.headline": "探索未至之境",')
    expect(patch).toContain('+\t\t\t"hero.headline": "Let\'s Create Together",')
    expect(patch).toContain('+\t\t\t"hero.preview": "Enterprise",')
    expect(patch).toContain('-\t\t\t"hero.headline": "Into the Unknown",')
  })

  it('shows the brand mark only in the collapsed rail, not beside the wide brand name', async () => {
    const source = await readFile(
      path.join(
        projectRoot,
        'node_modules',
        '@deepseek-ai',
        'dsh-client-ui-sidebar',
        'lib',
        'client.js'
      ),
      'utf8'
    )

    const logoRowStart = source.indexOf('className: SidebarRoot_module_css_default.logoRow')
    expect(logoRowStart).toBeGreaterThan(-1)
    expect(source.slice(Math.max(0, logoRowStart - 220), logoRowStart)).toContain('!darwinDesktop && !windowsTitlebar &&')
    expect(source).toContain('className: SidebarRoot_module_css_default.topStrip')
    // Windows pins the toggle into the caption. Rendering it outside the logo
    // row lets that empty 40px band go away without losing the button.
    const windowsToggle = source.indexOf('windowsTitlebar && toggle')
    expect(windowsToggle).toBeGreaterThan(-1)
    expect(windowsToggle).toBeLessThan(logoRowStart)
    expect(source.slice(windowsToggle, logoRowStart)).not.toContain('logoRow')

    const wideBrandStart = source.indexOf('children: [wide &&')
    const wideBrandEnd = source.indexOf('})(), toggle]', wideBrandStart)
    const wideBrand = source.slice(wideBrandStart, wideBrandEnd)
    expect(wideBrandStart).toBeGreaterThan(-1)
    expect(wideBrandEnd).toBeGreaterThan(wideBrandStart)
    expect(wideBrand).toContain('renderSlot("sidebar.brand.name"')
    expect(wideBrand).not.toContain('renderSlot("sidebar.brand.mark"')
    expect(wideBrand).not.toContain('darwinDesktop ?')
    expect(wideBrand).toContain('"data-dsh-sidebar-brand-identity": true')
    const desktopClient = await readFile(path.join(projectRoot, 'packages/dsh-desktop-client-ui/client.js'), 'utf8')
    expect(desktopClient).toContain('[data-dsh-sidebar-brand-identity] { display:none !important; }')
    expect(desktopClient).not.toContain('div[data-window-drag]:has([data-dsh-sidebar-brand-identity])')

    const railMarkStart = source.indexOf(
      'className: SidebarRoot_module_css_default.railMark'
    )
    const railMarkEnd = source.indexOf(
      'className: SidebarRoot_module_css_default.panelIcon',
      railMarkStart
    )
    const railMark = source.slice(railMarkStart, railMarkEnd)
    expect(railMarkStart).toBeGreaterThan(-1)
    expect(railMarkEnd).toBeGreaterThan(railMarkStart)
    expect(railMark).toContain('renderSlot("sidebar.brand.mark", { size: 24 }')
  })
})
