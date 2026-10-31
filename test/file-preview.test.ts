import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

async function packageClient(name: string, file = 'lib/client.js'): Promise<string> {
  return readFile(path.join(projectRoot, 'node_modules', '@deepseek-ai', name, file), 'utf8')
}

describe('uploaded file preview', () => {
  it('propagates native opener failures and preserves preview line options', async () => {
    const chat = await packageClient('dsh-client-ui-chat')
    const start = chat.indexOf('async function openResolvedHostFile(')
    const end = chat.indexOf('\n\t\t//#endregion', start)
    const open = new Function('fileAddressFor', `${chat.slice(start, end)}; return openResolvedHostFile`)(
      () => 'authorized-file-address'
    ) as (ctx: unknown, sessionId: string, cwd: string, path: string, options?: { line: number }) => Promise<void>
    const opened: unknown[] = []
    const nativeError = { code: 'open-failed', message: 'native opener failed' }
    const ctx = {
      sidebarRightTabs: { candidates: () => [] as string[] },
      sidebarRight: { openResource: (...args: unknown[]) => opened.push(args) },
      remote: { session: { openWorkspacePath: async () => ({ ok: false, error: nativeError }) } }
    }
    await expect(open(ctx, 'session', '/workspace', '/workspace/file')).rejects.toEqual(nativeError)
    expect(opened).toEqual([])
    ctx.sidebarRightTabs.candidates = () => ['preview']
    await open(ctx, 'session', '/workspace', '/workspace/file', { line: 17 })
    expect(opened).toEqual([['authorized-file-address', { params: { line: 17 } }]])
  })

  it('exposes a session-authorized host path instead of file bytes', async () => {
    const host = await packageClient('dsh-api-session-controller', 'lib/index.js')
    const client = await packageClient('dsh-api-session-controller')
    const uploads = await readFile(
      path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh-client-file-upload', 'lib', 'index.js'),
      'utf8'
    )

    expect(host).toContain('function referencedFile')
    expect(host).toContain('collectReferencedFilesByName')
    expect(host).toContain('collectReferencedImagesByName')
    expect(host).toContain('resolveAuthorizedFileRefByName')
    expect(host).toContain('ensureImagePreviewPath')
    expect(host).toContain('imageHostPath(match.ref)')
    expect(host).toContain('path: FILE_HOST_PATH')
    expect(host).toContain('/api/session/fileHostPath')
    expect(host).toContain('ctx.attachments.fileHostPath(ref)')
    expect(host).toContain('findStagedFile')
    expect(host).not.toContain('findStagedFilesByName')
    expect(host).toContain('attachmentId or name is required')
    expect(uploads).toContain('findStagedFile(agent, attachmentId)')
    expect(uploads).not.toContain('findStagedFilesByName')
    expect(client).toContain('async readFileHostPath(attachmentIdOrName)')
    expect(client).toContain('query.set("name", attachmentIdOrName.name)')
    expect(client).toContain('/api/session/fileHostPath')
  })

  it('opens uploaded files through one shared opener', async () => {
    const chat = await packageClient('dsh-client-ui-chat')
    const conversation = await packageClient('dsh-client-ui-conversation')
    const attachment = await packageClient('dsh-client-ui-attachment')

    expect(chat).toContain('ctx.provide("openUploadedAttachment"')
    expect(chat).toContain('binding.session.readFileHostPath(attachmentId)')
    expect(chat).toContain('openResolvedHostFile(ctx, sessionId, cwd, result.value.path)')
    expect(chat).toContain('sidebarRightTabs.candidates(address)')
    expect(chat).toContain('ctx.remote.session.openWorkspacePath({ path: hostPath })')
    expect(chat).toContain('ctx.sidebarRight.openResource')
    expect(chat).toContain('"sidebarRightTabs"')
    expect(chat).toContain('opener.open(sessionId, attachmentId)')
    expect(chat).toContain('onOpenUploadedFile(attachment.file.attachmentId)')
    expect(chat).not.toContain('openFile(attachment.file.name)')
    expect(chat).not.toContain('openFile(attachment.name)')

    expect(conversation).toContain('ctx.get("openUploadedAttachment")')
    expect(conversation).toContain('opener.open(sessionId, attachmentId)')
    expect(conversation).toContain('onOpenUploadedFile: openUploadedFile')
    expect(conversation).not.toContain('binding.session.readFileHostPath(attachmentId)')
    expect(conversation).not.toContain('dsh-resource://file/session/')

    expect(attachment).toContain('onOpen: upload?.status === "ready"')
    expect(attachment).toContain('onOpenUploadedFile(upload.file.attachmentId)')
  })

  it('resolves assistant file mentions via unique attachment name before workspace path', async () => {
    const chat = await packageClient('dsh-client-ui-chat')

    expect(chat).toContain('session.readFileHostPath({ name: path })')
    expect(chat).toContain('openResolvedHostFile(ctx, sessionId, cwd, byName.value.path)')
    expect(chat).not.toContain('openResolvedHostFile(ctx, sessionId, cwd, byName.value.path, options)')
    expect(chat).toContain('hostPathForOpen(cwd, path)')
    expect(chat).not.toContain('openFile(attachment.file.name)')
  })

  it('matches attachment names case-insensitively on Windows only', async () => {
    const host = await packageClient('dsh-api-session-controller', 'lib/index.js')
    const source = host.match(
      /function basenameLeaf\(value\) \{[\s\S]*?\nfunction fileNameMatches\(refName, needle\) \{[\s\S]*?\n\}/
    )?.[0]
    expect(source).toBeDefined()
    expect(source).toContain('process.platform === "win32"')
    expect(source).toContain('left.toLowerCase() === right.toLowerCase()')

    const load = (platform: string) =>
      new Function(
        'process',
        `${source}; return fileNameMatches`
      )({ platform }) as (refName: string, needle: string) => boolean

    const onWindows = load('win32')
    const onPosix = load('darwin')
    expect(onWindows('周报.docx', '周报.DOCX')).toBe(true)
    expect(onWindows('README.md', 'readme.md')).toBe(true)
    expect(onWindows('src/Main.ts', 'main.ts')).toBe(true)
    expect(onPosix('README.md', 'readme.md')).toBe(false)
    expect(onPosix('周报.docx', '周报.docx')).toBe(true)
  })

  it('keeps the original image path when the preview alias cannot be created', async () => {
    const host = await packageClient('dsh-api-session-controller', 'lib/index.js')
    expect(host).toContain('session-controller: image preview alias failed:')
    expect(host).toContain('return hostPath')
    expect(host).not.toContain('if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return aliased;\n\t\tthrow error;')
  })

  it('records the preview patches', async () => {
    const sessionPatch = await readFile(patchPath('@deepseek-ai/dsh-api-session-controller'), 'utf8')
    const chatPatch = await readFile(patchPath('@deepseek-ai/dsh-client-ui-chat'), 'utf8')
    const conversationPatch = await readFile(patchPath('@deepseek-ai/dsh-client-ui-conversation'), 'utf8')
    const attachmentPatch = await readFile(patchPath('@deepseek-ai/dsh-client-ui-attachment'), 'utf8')
    const uploadPatch = await readFile(patchPath('@deepseek-ai/dsh-client-file-upload'), 'utf8')
    const deliverablesPatch = await readFile(
      patchPath('@deepseek-ai/dsh-client-ui-deliverables'),
      'utf8'
    )

    expect(sessionPatch).toContain('/api/session/fileHostPath')
    expect(sessionPatch).toContain('resolveAuthorizedFileRefByName')
    expect(sessionPatch).toContain('collectReferencedImagesByName')
    expect(sessionPatch).toContain('ensureImagePreviewPath')
    expect(sessionPatch).toContain('function fileNameEquals')
    expect(sessionPatch).toContain('image preview alias failed')
    expect(sessionPatch).not.toContain('findStagedFilesByName')
    expect(chatPatch).toContain('openUploadedAttachment')
    expect(chatPatch).toContain('readFileHostPath({ name: path })')
    expect(chatPatch).toContain('openResolvedHostFile(ctx, sessionId, cwd, byName.value.path)')
    expect(chatPatch).not.toContain('openResolvedHostFile(ctx, sessionId, cwd, byName.value.path, options)')
    expect(chatPatch).toContain('openResolvedHostFile')
    expect(chatPatch).toContain('openWorkspacePath')
    expect(conversationPatch).toContain('openUploadedAttachment')
    expect(conversationPatch).not.toContain('binding.session.readFileHostPath')
    expect(attachmentPatch).toContain('onOpenUploadedFile')
    expect(uploadPatch).toContain('findStagedFile')
    expect(uploadPatch).not.toContain('findStagedFilesByName')
    expect(deliverablesPatch).toContain('v?\\d+(?:\\.\\d+){1,4}')
    expect(deliverablesPatch).toContain('@[^\\\\/@\\s]+\\/[^\\\\/@\\s]+(?:@[^\\\\/\\s]+)?')
  })

  it('offers a local-open action when sidebar preview cannot render the file', async () => {
    const preview = await packageClient('dsh-client-ui-sidebar-documentpreview')
    const desktop = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-client-ui', 'client.js'),
      'utf8'
    )

    expect(preview).toContain('renderSlot("sidebar.right.tab.document.unpreviewable", fileOwner)')
    expect(desktop).toContain("ctx.slots.inject('sidebar.right.tab.document.unpreviewable'")
    expect(desktop).toContain("'data-textpreview-open-local': true")
    expect(desktop).toContain("const remote = ctx.remote")
    expect(desktop).toContain('openWorkspacePath: (request) => remote.session.openWorkspacePath(request)')
    expect(desktop).toContain('locale: LOCAL_OPEN_NS')
    expect(desktop).toContain("action: 'reveal'")
    expect(desktop).toContain('Open with local app')
    expect(desktop).toContain('用本地应用打开')
    expect(desktop).toContain('已在访达中显示')
    expect(desktop).toContain('已在文件资源管理器中显示')
    expect(desktop).toContain('已在文件管理器中显示')
    expect(desktop).toContain('Shown in Finder')
    expect(desktop).toContain('Shown in File Explorer')
    expect(desktop).toContain('Shown in the file manager')
    expect(desktop).toContain('无法用本地应用打开')
    expect(desktop).toContain('Could not open with a local app')
    expect(desktop).toContain('background:var(--dsw-alias-bg-base)')
    expect(desktop).toContain('border:.5px solid var(--dsw-alias-border-l2)')
    expect(desktop).toContain('border-radius:var(--dsw-radius-md)')
    expect(desktop).toContain('height:36px')
    expect(desktop).toContain('padding:6px 14px')
    expect(desktop).toContain('font-size:14px')
    expect(desktop).toContain('background:var(--dsw-alias-interactive-bg-hover)')
    expect(desktop).toContain('[data-textpreview-open-local]:focus-visible')
    expect(desktop).toContain('align-items:center')
    expect(desktop).toContain('[data-textpreview-open-local-sizer] { visibility:hidden; }')
    expect(desktop).toContain('[data-textpreview-open-local]:disabled { cursor:default; }')
    expect(desktop).toContain('color:var(--dsw-alias-state-error-primary)')
  })

  it('reveals archives, opens other files in the default app, and reports failures', async () => {
    const copy = {
      zh: {
        label: '用本地应用打开',
        pending: '正在打开…',
        revealedDarwin: '已在访达中显示',
        revealedWindows: '已在文件资源管理器中显示',
        revealedOther: '已在文件管理器中显示',
        failed: '无法用本地应用打开'
      },
      en: {
        label: 'Open with local app',
        pending: 'Opening…',
        revealedDarwin: 'Shown in Finder',
        revealedWindows: 'Shown in File Explorer',
        revealedOther: 'Shown in the file manager',
        failed: 'Could not open with a local app'
      }
    }
    const opened = vi.fn(async (request: { path: string; action?: string }) => {
      if (request.path.endsWith('missing.zip')) return { ok: false, error: { message: 'Path does not exist: missing.zip' } }
      if (request.path.endsWith('denied.pptx')) return Promise.reject(new Error('permission denied'))
      if (request.path.endsWith('blank.zip')) return { ok: false, error: { message: '   ' } }
      return { ok: true, value: { opened: true } }
    })
    const mounted = await mountLocalOpen({
      absolutePath: '/workspace/notes.zip',
      openWorkspacePath: opened,
      copy
    })

    expect(mounted.label()).toBe('用本地应用打开')

    const zipButton = mounted.button()
    expect(zipButton?.props.disabled).toBe(false)
    mounted.click()
    expect(opened).toHaveBeenCalledWith({ path: '/workspace/notes.zip', action: 'reveal' })
    expect(mounted.button()?.props.disabled).toBe(true)
    expect(mounted.label()).toBe('正在打开…')
    expect(mounted.sizer()).toBe('用本地应用打开')
    await flushMicrotasks()
    expect(mounted.button()?.props.disabled).toBe(false)
    expect(mounted.label()).toBe('用本地应用打开')
    expect(mounted.feedback()?.props.children).toContain('已在访达中显示')
    expect(mounted.feedback()?.props.role).toBe('status')
    mounted.runTimers()
    expect(mounted.feedback()).toBeUndefined()

    mounted.setPath('/workspace/notes.tar.gz')
    mounted.click()
    await flushMicrotasks()
    expect(opened).toHaveBeenCalledWith({ path: '/workspace/notes.tar.gz', action: 'reveal' })

    mounted.setPath('/workspace/Deck.PPTX')
    mounted.click()
    await flushMicrotasks()
    expect(opened).toHaveBeenLastCalledWith({ path: '/workspace/Deck.PPTX' })
    expect(opened.mock.lastCall?.[0]).not.toHaveProperty('action')
    expect(mounted.feedback()).toBeUndefined()
    expect(mounted.label()).toBe('用本地应用打开')

    mounted.setPath('/workspace/missing.zip')
    mounted.click()
    await flushMicrotasks()
    expect(mounted.feedback()?.props['data-kind']).toBe('error')
    expect(mounted.feedback()?.props.role).toBe('alert')
    expect(mounted.feedback()?.props.children).toContain('Path does not exist: missing.zip')

    mounted.setPath('/workspace/denied.pptx')
    mounted.click()
    await flushMicrotasks()
    expect(mounted.feedback()?.props.children).toContain('permission denied')

    mounted.setPath('/workspace/blank.zip')
    mounted.click()
    await flushMicrotasks()
    expect(mounted.feedback()?.props.children).toContain('无法用本地应用打开')

    let finishLate: ((result: { ok: boolean; error: { message: string } }) => void) | undefined
    mounted.setPath('/workspace/late.zip')
    opened.mockImplementationOnce(() => new Promise((resolve) => { finishLate = resolve }))
    mounted.click()
    mounted.unmount()
    finishLate?.({ ok: false, error: { message: 'late failure' } })
    await flushMicrotasks()
    expect(mounted.feedback()?.props.children ?? []).not.toContain('late failure')
    mounted.dispose()
  })
})

interface PreviewNode {
  type: unknown
  props: Record<string, unknown> & { children: unknown[] }
}

function findPreviewNodes(
  node: unknown,
  predicate: (node: PreviewNode) => boolean,
  found: PreviewNode[] = []
): PreviewNode[] {
  if (!node || typeof node !== 'object') return found
  const element = node as PreviewNode
  if (typeof element.type === 'string' && element.props && predicate(element)) found.push(element)
  const children = element.props?.children
  if (Array.isArray(children)) {
    for (const child of children) findPreviewNodes(child, predicate, found)
  }
  return found
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function markedText(node: PreviewNode | undefined, marker: string): unknown {
  const children = node?.props.children
  if (!Array.isArray(children)) return undefined
  const match = children.find((child) => {
    return !!child && typeof child === 'object' && (child as PreviewNode).props[marker] === true
  }) as PreviewNode | undefined
  const text = match?.props.children
  return Array.isArray(text) ? text[0] : text
}

async function mountLocalOpen(initial: {
  absolutePath: string
  openWorkspacePath: (request: { path: string; action?: string }) => Promise<unknown>
  copy: { zh: Record<string, string>; en: Record<string, string> }
}) {
  const source = await readFile(
    path.join(projectRoot, 'packages', 'dsh-desktop-client-ui', 'client.js'),
    'utf8'
  )
  let definition: {
    factory: (require: (id: string) => unknown) => {
      apply: (ctx: unknown) => void
    }
  } | undefined
  const timers = new Map<number, () => void>()
  let timerId = 0
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load: (value: typeof definition) => {
          definition = value
        }
      },
      setTimeout: (callback: () => void) => {
        timerId += 1
        timers.set(timerId, callback)
        return timerId
      },
      clearTimeout: (id: number) => {
        timers.delete(id)
      }
    },
    document: {
      documentElement: { lang: 'zh-CN', dataset: { platform: 'darwin' } },
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '', dataset: {}, remove() {} }),
      head: { appendChild() {} }
    }
  })

  const hook = {
    states: [] as unknown[],
    cursor: 0,
    effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void } | undefined>,
    effectCursor: 0,
    pending: [] as Array<() => void>
  }
  let view: PreviewNode | undefined
  let activeLocale: 'zh' | 'en' = 'zh'
  let localeSnapshot: { active: 'zh' | 'en'; revision: number } = { active: activeLocale, revision: 0 }
  const localeListeners = new Set<() => void>()
  const translate = (key: string) => initial.copy[activeLocale][key] ?? key
  let currentProps: Record<string, unknown> = {
    absolutePath: initial.absolutePath,
    openWorkspacePath: initial.openWorkspacePath,
    t: translate,
    subscribeLocale: (listener: () => void) => {
      localeListeners.add(listener)
      return () => {
        localeListeners.delete(listener)
      }
    },
    getLocaleSnapshot: () => localeSnapshot
  }
  let component: (props: Record<string, unknown>) => PreviewNode = () => {
    throw new Error('Local open component is not registered')
  }
  let rendering = false

  function rerender(): void {
    hook.cursor = 0
    hook.effectCursor = 0
    hook.pending = []
    rendering = true
    view = component(currentProps)
    rendering = false
    const runs = hook.pending.splice(0)
    for (const run of runs) run()
  }

  const React = {
    Fragment: Symbol.for('react.fragment'),
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
      return { type, props: { ...(props ?? {}), children } }
    },
    useState(initialState: unknown) {
      const index = hook.cursor++
      if (hook.states.length <= index) {
        hook.states.push(typeof initialState === 'function' ? (initialState as () => unknown)() : initialState)
      }
      const setState = (value: unknown) => {
        const next = typeof value === 'function'
          ? (value as (previous: unknown) => unknown)(hook.states[index])
          : value
        if (Object.is(next, hook.states[index])) return
        hook.states[index] = next
        if (!rendering) rerender()
      }
      return [hook.states[index], setState] as const
    },
    useRef(initialValue: unknown) {
      const index = hook.cursor++
      if (hook.states.length <= index) hook.states.push({ current: initialValue })
      return hook.states[index] as { current: unknown }
    },
    useSyncExternalStore(subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) {
      const index = hook.cursor++
      if (hook.states.length <= index) {
        hook.states.push(getSnapshot())
        const stateIndex = index
        subscribe(() => {
          const next = getSnapshot()
          if (Object.is(next, hook.states[stateIndex])) return
          hook.states[stateIndex] = next
          if (!rendering) rerender()
        })
      }
      return hook.states[index]
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
      const index = hook.effectCursor++
      const previous = hook.effects[index]
      const changed = !previous
        || deps === undefined
        || (previous.deps?.length ?? -1) !== (deps?.length ?? -1)
        || (deps?.some((dep, depIndex) => !Object.is(dep, previous.deps?.[depIndex])) ?? false)
      if (!changed) return
      hook.pending.push(() => {
        previous?.cleanup?.()
        const cleanup = effect()
        hook.effects[index] = {
          deps,
          cleanup: typeof cleanup === 'function' ? cleanup : undefined
        }
      })
    }
  }

  const plugin = definition!.factory((id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MenuItemButton() { return null } }
    throw new Error(`Unexpected client dependency: ${id}`)
  })
  const disposers: Array<() => void> = []
  const registrations: Array<{
    config: { id?: string; inject?: () => Record<string, unknown> }
    component: (props: Record<string, unknown>) => PreviewNode
  }> = []
  plugin.apply({
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (
        config: (typeof registrations)[number]['config'],
        registered: (typeof registrations)[number]['component']
      ) => {
        registrations.push({ config, component: registered })
        return () => undefined
      }
    },
    locale: {
      register: () => () => undefined,
      bind: () => translate,
      subscribe: (listener: () => void) => {
        localeListeners.add(listener)
        return () => {
          localeListeners.delete(listener)
        }
      },
      getSnapshot: () => localeSnapshot
    },
    effect: (setup: () => (() => void) | undefined) => {
      const dispose = setup()
      if (dispose) disposers.push(dispose)
    },
    remote: {
      session: {
        openWorkspacePath: initial.openWorkspacePath
      }
    },
    get: () => undefined
  })
  const registration = registrations.find(({ config }) => config.id === 'desktop-open-local')
  if (!registration) throw new Error('desktop-open-local slot is missing')
  component = registration.component
  rerender()

  return {
    wrap: () => findPreviewNodes(view, (node) => node.props['data-textpreview-open-local-wrap'] === true)[0],
    button: () => findPreviewNodes(view, (node) => node.props['data-textpreview-open-local'] === true)[0],
    label: () => markedText(
      findPreviewNodes(view, (node) => node.props['data-textpreview-open-local'] === true)[0],
      'data-textpreview-open-local-label'
    ),
    sizer: () => markedText(
      findPreviewNodes(view, (node) => node.props['data-textpreview-open-local'] === true)[0],
      'data-textpreview-open-local-sizer'
    ),
    selectLocale: (next: 'zh' | 'en') => {
      activeLocale = next
      localeSnapshot = { active: next, revision: localeSnapshot.revision + 1 }
      for (const listener of localeListeners) listener()
    },
    feedback: () => findPreviewNodes(
      view,
      (node) => node.props['data-textpreview-open-local-feedback'] === true
    )[0],
    click: () => {
      const onClick = view?.props
        ? findPreviewNodes(view, (node) => node.props['data-textpreview-open-local'] === true)[0]?.props.onClick
        : undefined
      if (typeof onClick !== 'function') throw new Error('local open button has no click handler')
      onClick()
    },
    setPath: (absolutePath: string) => {
      currentProps = { ...currentProps, absolutePath }
      rerender()
    },
    runTimers: () => {
      const callbacks = [...timers.values()]
      timers.clear()
      for (const callback of callbacks) callback()
    },
    unmount: () => {
      for (const effect of hook.effects) effect?.cleanup?.()
      hook.effects = []
    },
    dispose: () => {
      for (const dispose of disposers) dispose()
    }
  }
}
