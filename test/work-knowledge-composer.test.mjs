import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

let plugin
vm.runInNewContext(readFileSync(new URL('../packages/dsh-desktop-client-ui/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({})) } } }
})

function setup() {
  // Detect coordinates count each native reference as one editor node.
  let nodes = ['hello '], rev = 0, phase = 'plain'
  const snapshot = () => {
    let offset = 0
    const occurrences = []
    const draft = nodes.map(node => {
      if (typeof node === 'string') { offset += node.length; return node }
      const text = node.clipboardText
      occurrences.push({ ...node, offset, length: text.length })
      offset += text.length
      return text
    }).join('')
    return { draft, occurrences, draftRev: rev, phase }
  }
  const input = {
    state: { getSnapshot: snapshot },
    insertReference: (reference, span) => {
      if (span.draftRev !== rev) return false
      nodes.push(reference, ' '); rev++; return true
    }
  }
  const scope = { bail: (_scope, _event, { span }) => {
    let offset = 0
    const index = nodes.findIndex(node => {
      const start = offset
      offset += typeof node === 'string' ? node.length : 1
      return start === span.start && typeof node !== 'string'
    })
    if (index < 0 || span.draftRev !== rev) return false
    nodes.splice(index, 1); rev++; return true
  } }
  const request = vi.fn(async () => ({ spaces: [] }))
  const ensureSession = vi.fn(async () => {})
  const composer = plugin.createWorkKnowledgeComposer({ inputFor: () => ({ input, scope }), request, ensureSession })
  const capture = () => ({ start: 0, end: 0, draftRev: rev })
  const update = spaces => composer.update('one', spaces, capture)
  const enter = command => composer.prepare({ sessionId: 'one', references: snapshot().occurrences, signal: new AbortController().signal, command })
  return { composer, request, update, enter, input, setNodes: value => { nodes = value; rev++ }, setPhase: value => { phase = value } }
}
const a = { id: 7, name: '研发知识库' }
const b = { id: 9, name: '团队资料' }

describe('Work inline knowledge references', () => {
  it('inserts native blue-reference data with a stable ID and no preview action', async () => {
    const { composer, update, input } = setup()
    update([a])
    const [ref] = input.state.getSnapshot().occurrences
    expect(ref).toMatchObject({ source: 'desktop-knowledge', label: a.name, clipboardText: `@${a.name}` })
    expect(ref.appearance).toBe('folder')
    expect(composer.source.openReference()).toBe(false)
    expect(await composer.source.codec.serialize(ref.ref)).toBe(`@${a.name}`)
    expect(composer.read('one')).toEqual([a])
  })
  it('removes references by editor coordinates while retaining prose and other source references', () => {
    const { composer, update, input, setNodes } = setup()
    update([a, b])
    const [ra, rb] = input.state.getSnapshot().occurrences
    setNodes(['before ', { source: 'files', ref: 'long-file', clipboardText: '@very-long-file.pdf' }, ' ', ra, ' middle ', rb, ' after'])
    update([b])
    expect(composer.read('one')).toEqual([b])
    expect(input.state.getSnapshot().draft).toBe('before @very-long-file.pdf  middle @团队资料 after')
    update([])
    expect(input.state.getSnapshot().occurrences.map(ref => ref.source)).toEqual(['files'])
  })
  it('deduplicates IDs, keeps same-name spaces distinct and commits exactly the draft selection', async () => {
    const { update, enter, request } = setup()
    update([a, a, { ...b, name: a.name }])
    await enter()
    expect(request).toHaveBeenLastCalledWith('select', 'one', [7, 9], expect.any(AbortSignal))
  })
  it('keyboard deletion/undo follows native document occurrences', async () => {
    const { update, input, setNodes, composer, enter, request } = setup()
    update([a, b])
    const [ra, rb] = input.state.getSnapshot().occurrences
    setNodes(['question ', rb])
    expect(composer.read('one')).toEqual([b])
    await enter()
    expect(request.mock.calls.at(-1)[2]).toEqual([9])
    setNodes(['question ', ra, rb])
    await enter()
    expect(request.mock.calls.at(-1)[2]).toEqual([7, 9])
  })
  it('keeps the running task scope on sent-draft cleanup and clears it on the next send without references', async () => {
    const { update, enter, request, setNodes } = setup()
    update([a]); await enter()
    setNodes([])
    expect(request).toHaveBeenCalledTimes(1)
    setNodes(['next question']); await enter()
    expect(request.mock.calls.at(-1)[2]).toEqual([])
  })
  it('leaves ordinary local Work submissions independent of enterprise login', async () => {
    const { enter, request } = setup()
    await enter()
    expect(request).not.toHaveBeenCalled()
  })
  it('surfaces revoked access before sending and retains the draft', async () => {
    const { update, enter, request, composer } = setup()
    update([a]); request.mockRejectedValueOnce(new Error('Forbidden'))
    await expect(enter()).rejects.toThrow('Forbidden')
    expect(composer.read('one')).toEqual([a])
  })
  it('edits knowledge references alongside a claimed goal and commits its scope before create or edit', async () => {
    const { update, setPhase, composer, enter, request } = setup()
    setPhase('claimed')
    update([a, b]); update([b])
    expect(composer.read('one')).toEqual([b])
    for (const args of ['Summarize the reports', 'edit Summarize updated reports']) {
      await enter({ name: 'goal', args })
      expect(request.mock.calls.at(-1)[2]).toEqual([9])
    }
    update([])
    await enter({ name: 'goal', args: 'A new objective without knowledge' })
    expect(request.mock.calls.at(-1)[2]).toEqual([])
  })
  it.each(['adjudicating', 'submitting'])('retains the draft during %s admission', phase => {
    const { update, setPhase, composer } = setup()
    setPhase(phase)
    expect(() => update([a])).toThrow('Wait for the current submission')
    expect(composer.read('one')).toEqual([])
  })
  it('keeps an active objective scope through goal controls and unrelated commands', async () => {
    const { update, enter, request, setNodes } = setup()
    update([a]); await enter({ name: 'goal', args: 'Read the policy' })
    request.mockClear(); setNodes([])
    for (const args of ['', 'pause', 'resume', 'clear', 'edit', ' PAUSE ']) await enter({ name: 'goal', args })
    await enter({ name: 'model', args: 'provider/model' })
    expect(request).not.toHaveBeenCalled()
  })
})

const native = readFileSync(new URL('../node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', import.meta.url), 'utf8')
const sinkFactory = new Function('actx', 'session', `return ${native.match(/defaultSink: (async \(text, attachmentIds, mode, signal, references = \[\]\) => \{[\s\S]*?\n\s*\}),/)[1]}`)

it('native send waits for the submitted reference snapshot for prose, slash prompts and attachment-only messages', async () => {
  const trace = [], session = { sessionId: 'one' }
  const sink = vi.fn(async () => { trace.push('sent'); return { kind: 'success' } })
  const actx = { serial: vi.fn(async (_scope, event, payload) => { trace.push('scope'); expect(event).toBe('conversation/input-before-submit'); expect(payload.sessionId).toBe('one') }) }
  const submit = sinkFactory.call({ sink }, actx, session)
  const refs = [{ source: 'desktop-knowledge', ref: JSON.stringify(a) }]
  for (const text of ['question @研发知识库', '/skill question', '']) {
    trace.length = 0
    await submit(text, ['attachment'], 'next-turn', new AbortController().signal, text ? refs : undefined)
    expect(trace).toEqual(['scope', 'sent'])
    expect(actx.serial.mock.calls.at(-1)[2].references).toEqual(text ? refs : [])
  }
  expect(native).toContain('defaultSink(out.trim(), attachmentIds, mode, attempt.signal, occurrences)')
})

it('native send blocks on revoked permission or cancellation instead of dispatching', async () => {
  const sink = vi.fn()
  const actx = { serial: vi.fn(async () => { throw new Error('Forbidden') }) }
  const submit = sinkFactory.call({ sink }, actx, { sessionId: 'one' })
  await expect(submit('question', [], 'next-turn', new AbortController().signal, [])).rejects.toThrow('Forbidden')
  const abort = new AbortController(); abort.abort()
  await expect(submit('question', [], 'next-turn', abort.signal, [])).rejects.toThrow()
  expect(sink).not.toHaveBeenCalled()
})

const commandHookFactory = new Function('actx', 'session', `return ${native.match(/beforeCommandSubmit: (async \(command, references, signal\) => \{[\s\S]*?\n\s*\}),/)[1]}`)
const commandSubmitFactory = new Function(`return function ${native.slice(native.indexOf('beginSubmit(attempt, claim, args) {'), native.indexOf('\n\t\t\t/** Late-settlement guard:', native.indexOf('beginSubmit(attempt, claim, args) {')))}`)

function commandFixture(prepare, occurrences) {
  let finish
  const completed = new Promise(resolve => { finish = resolve })
  const controller = new AbortController()
  const actx = { serial: async (_scope, event, payload) => {
    expect(event).toBe('conversation/input-before-submit')
    await prepare(payload)
  } }
  const shell = {
    projection: { occurrences }, attachmentIds: [],
    deps: {
      actx,
      beforeCommandSubmit: commandHookFactory(actx, { sessionId: 'one' }),
      commandAttachments: { serialize: vi.fn(async () => []), release: vi.fn() }
    },
    dead: attempt => attempt.signal.aborted,
    dispatchRun: vi.fn(finish)
  }
  const submit = vi.fn(async () => ({ kind: 'success' }))
  return { shell, submit, controller, completed, begin: args => commandSubmitFactory().call(shell, { signal: controller.signal }, { name: 'goal', submit }, args) }
}

it('native claimed-goal submit saves the immutable reference scope before dispatch and preserves it after draft cleanup', async () => {
  const { composer, update, input, request, setNodes } = setup()
  update([a])
  const fixture = commandFixture(composer.prepare, input.state.getSnapshot().occurrences)
  fixture.begin('Find the policy')
  // A later editor snapshot must not replace the submitted selection.
  fixture.shell.projection = { occurrences: [] }
  await fixture.completed
  expect(request).toHaveBeenCalledWith('select', 'one', [7], expect.any(AbortSignal))
  expect(fixture.submit).toHaveBeenCalledWith('Find the policy', fixture.shell.deps.actx, [])
  expect(request.mock.invocationCallOrder[0]).toBeLessThan(fixture.submit.mock.invocationCallOrder[0])
  setNodes([])
  expect(request).toHaveBeenCalledTimes(1)
})

it('native claimed-goal submit stops on revoked knowledge access and retains editor references', async () => {
  const { composer, update, input, request } = setup()
  update([a]); request.mockRejectedValueOnce(new Error('Forbidden'))
  const fixture = commandFixture(composer.prepare, input.state.getSnapshot().occurrences)
  fixture.begin('Read the policy')
  await fixture.completed
  expect(fixture.submit).not.toHaveBeenCalled()
  expect(fixture.shell.dispatchRun).toHaveBeenCalledWith(expect.objectContaining({ ok: false, message: 'Forbidden' }))
  expect(composer.read('one')).toEqual([a])
})

it('native claimed-goal submit aborts while scope admission is pending', async () => {
  let release
  const admission = new Promise(resolve => { release = resolve })
  const fixture = commandFixture(() => admission, [])
  fixture.begin('Read the policy')
  await Promise.resolve()
  fixture.controller.abort(); release()
  await vi.waitFor(() => expect(fixture.controller.signal.aborted).toBe(true))
  await new Promise(resolve => setImmediate(resolve))
  expect(fixture.submit).not.toHaveBeenCalled()
  expect(fixture.shell.dispatchRun).not.toHaveBeenCalled()
})

it('makes the submitted goal scope available to the registered retrieval tool and system prompt', async () => {
  const { applyWorkResources } = await import('../packages/dsh-desktop-enterprise/work-resources.js')
  let tool, context
  const session = { id: 'one', header: {} }
  const retrieve = vi.fn(async body => body.operation === 'list' ? { spaces: [a, b] } : { chunks: [{ space_id: body.spaceIds[0], document_name: 'Policy.pdf', content: 'Annual leave policy' }] })
  const resources = applyWorkResources({
    sessions: { get: id => id === 'one' ? session : undefined }, on() {}, effect() {},
    connection: { fetch: { register() {} } },
    tools: { register: value => { tool = value } },
    systemPrompt: { context: value => { context = value } }
  }, { request: retrieve, state: () => ({ connected: true, connectionKey: 'account-a' }), refreshState: async () => {} })
  const { composer: editor, update, input } = setup()
  update([a])
  const composer = plugin.createWorkKnowledgeComposer({
    inputFor: () => ({ input }), ensureSession: async () => {},
    request: async (operation, id, ids) => { expect(operation).toBe('select'); await resources.select(id, ids) }
  })
  const fixture = commandFixture(composer.prepare, input.state.getSnapshot().occurrences)
  fixture.submit.mockImplementation(async () => {
    expect(context.text({ scope: { session } })).toContain(a.name)
    const result = await tool.execute({ query: 'annual leave' }, { agent: { session }, signal: fixture.controller.signal })
    expect(result.chunks[0].document_name).toBe('Policy.pdf')
    return { kind: 'success' }
  })
  fixture.begin('Summarize the annual leave policy')
  await fixture.completed
  expect(fixture.shell.dispatchRun).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  expect(retrieve).toHaveBeenLastCalledWith({ operation: 'retrieve', connectionKey: 'account-a', spaceIds: [7], query: 'annual leave' }, expect.any(AbortSignal))
  expect(editor.read('one')).toEqual([a])
})
