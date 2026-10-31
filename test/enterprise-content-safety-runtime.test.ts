import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { AgentRegistry, type AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { SessionStore, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { LlmRuntime, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { EnterpriseLlmAdapter } from '../packages/dsh-desktop-enterprise/openai.js'

// Coverage AC: AC-23, AC-24, AC-29, AC-30, AC-31.
// Use public AgentRegistry/AgentLoop and the real ToolRuntime pipeline. The only
// synthetic production dependency is the model transport, never the tool runner.
type Protocol = 'CHAT' | 'RESPONSES'
type Terminal = 'normal' | 'content_blocked' | 'check_unavailable' | 'content_filter'
const argumentsText = '{"value":"complete"}'
const tenantReply = 'Synthetic tenant safety reply Ω.'
const safeText = 'Checked text after complete tool arguments.'
const chatDelta = (delta: object, finish: string | null = null) => 'data: ' + JSON.stringify({
  choices: [{ index: 0, delta, finish_reason: finish }]
}) + '\n\n'
const responseEvent = (event: object, sequence_number: number) => 'event: ' + Reflect.get(event, 'type')
  + '\ndata: ' + JSON.stringify({ ...event, sequence_number }) + '\n\n'
const completedTool = { id: 'fc_safety', type: 'function_call', call_id: 'call_safety', name: 'increment', arguments: argumentsText, status: 'completed' }
const completedMessage = { id: 'msg_safe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: safeText, annotations: [] }] }

function wire(protocol: Protocol, terminal: Terminal) {
  if (protocol === 'CHAT') {
    const prefix = chatDelta({ tool_calls: [{ index: 0, id: 'call_safety', type: 'function', function: { name: 'increment', arguments: argumentsText } }] })
      + chatDelta({ content: safeText })
    if (terminal === 'normal') return { prefix, tail: chatDelta({}, 'tool_calls') + 'data: [DONE]\n\n' }
    if (terminal === 'content_filter') return { prefix, tail: 'data: ' + JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }],
      content_safety: { code: 'content_blocked', message: tenantReply }, request_id: 'synthetic-gateway-id'
    }) + '\n\ndata: [DONE]\n\n' }
    return { prefix, tail: 'event: error\ndata: ' + JSON.stringify({
      error: { type: 'content_safety', code: terminal, message: tenantReply }, request_id: 'synthetic-gateway-id'
    }) + '\n\n' }
  }
  const response = { id: 'resp_safety', object: 'response', model: 'bisheng:43', status: 'in_progress', output: [], usage: null }
  const prefix = [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item: { ...completedTool, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: completedTool.id, delta: argumentsText },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: completedTool.id, arguments: argumentsText },
    { type: 'response.output_item.done', output_index: 0, item: completedTool },
    { type: 'response.output_item.added', output_index: 1, item: { ...completedMessage, content: [], status: 'in_progress' } },
    { type: 'response.output_text.delta', output_index: 1, item_id: completedMessage.id, content_index: 0, delta: safeText },
    { type: 'response.output_item.done', output_index: 1, item: completedMessage }
  ].map(responseEvent).join('')
  if (terminal === 'normal') return { prefix, tail: responseEvent({
    type: 'response.completed', response: { ...response, status: 'completed', output: [completedTool, completedMessage], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } }
  }, 8) }
  return { prefix, tail: 'event: error\ndata: ' + JSON.stringify({
    type: 'error', error: { type: 'content_safety', code: terminal, message: tenantReply }, request_id: 'synthetic-gateway-id'
  }) + '\n\n' }
}

async function runAgent(protocol: Protocol, terminal: Terminal) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-safety-runtime-'))
  const context = new Context()
  const events: SessionEvent[] = [], frames: AssistantStreamFrame[] = [], toolArguments: unknown[] = []
  let calls = 0, requests = 0, preExecute = 0, returnedResults = 0, wrongTransport = 0
  let accumulatedArguments = '', observedBeforeTerminal = false, terminalReleased = false
  let releaseTail: () => void = () => {}
  const gate = new Promise<void>(resolve => { releaseTail = resolve })
  try {
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(AgentRegistry)
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    await context.plugin(LlmRuntime)
    await context.plugin(AgentLoop)
    context.on('session/event', (_session, event) => { events.push(event) })
    context.on('agent/assistant-stream', ({ frame }) => {
      frames.push(frame)
      if (frame.type === 'chunk' && frame.chunk.type === 'tool-call-delta') {
        accumulatedArguments += frame.chunk.argumentsDelta
        if (accumulatedArguments === argumentsText && !terminalReleased) {
          observedBeforeTerminal = calls === 0 && preExecute === 0
          releaseTail()
        }
      }
    })
    context.on('tools/pre-execute', async (_execution, next) => { preExecute += 1; return next() })
    context.on('tools/result', () => { returnedResults += 1 })
    context.tools.register(defineTool({
      name: 'increment', description: 'Synthetic side effect counter',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'integer' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, execution) {
        toolArguments.push(args)
        calls += 1
        execution.concludeTurn()
        return calls
      }
    }))
    const { prefix, tail } = wire(protocol, terminal)
    const request = async () => {
      requests += 1
      const encoder = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(prefix))
          // The actual Agent stream observer releases the final wire segment only
          // after the complete arguments have traversed the adapter and runtime.
          await gate
          terminalReleased = true
          controller.enqueue(encoder.encode(tail))
          controller.close()
        },
        cancel() { releaseTail() }
      }), { headers: { 'content-type': 'text/event-stream' } })
    }
    const wrong = async () => { wrongTransport += 1; throw new Error('Unexpected protocol fallback') }
    context.llm.registerAdapter(['enterprise'], new EnterpriseLlmAdapter({
      providerName: () => 'Synthetic enterprise', connectionKey: () => '1234567890abcdef',
      models: () => [{
        id: protocol === 'CHAT' ? 'bisheng:42' : 'bisheng:43', display_name: 'Synthetic safety runtime',
        capabilities: { streaming: true, tools: true, reasoning_content: false, ...(protocol === 'RESPONSES' ? { responses: true } : {}) },
        reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }
      }],
      request: protocol === 'CHAT' ? request : wrong,
      requestResponses: protocol === 'RESPONSES' ? request : wrong
    }))
    const handle = await context.agents.create({
      sessionId: SessionId('synthetic-safety-agent'), meta: { cwd: home },
      agentOptions: { provider: 'enterprise', model: protocol === 'CHAT' ? 'bisheng:42' : 'bisheng:43' }
    })
    try {
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic tool request' }] }))
      await handle.agent.whenIdle()
      expect(handle.agent.status).toBe('idle')
      const chunks: StreamChunk[] = frames.flatMap(frame => frame.type === 'chunk' ? [frame.chunk] : [])
      return { calls, requests, preExecute, returnedResults, wrongTransport, events, chunks, toolArguments, observedBeforeTerminal, terminalReleased }
    } finally {
      releaseTail()
      await handle.dispose()
    }
  } finally {
    releaseTail()
    await context.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
}

describe('enterprise content safety at the actual Harness tool execution boundary', () => {
  it.each([
    ['CHAT', 'content_filter', 'CONTENT_FILTERED'],
    ['CHAT', 'content_blocked', 'CONTENT_FILTERED'],
    ['CHAT', 'check_unavailable', 'CONTENT_CHECK_UNAVAILABLE'],
    ['RESPONSES', 'content_blocked', 'CONTENT_FILTERED'],
    ['RESPONSES', 'check_unavailable', 'CONTENT_CHECK_UNAVAILABLE']
  ] as const)('%s late %s never reaches a tool body or its execution pipeline', async (protocol, terminal, code) => {
    const result = await runAgent(protocol, terminal)
    expect(result.observedBeforeTerminal).toBe(true)
    expect(result.terminalReleased).toBe(true)
    expect(result.requests).toBe(1)
    expect(result.wrongTransport).toBe(0)
    expect(result.calls).toBe(0)
    expect(result.preExecute).toBe(0)
    expect(result.returnedResults).toBe(0)
    expect(result.chunks).toContainEqual(expect.objectContaining({ type: 'tool-call-delta', argumentsDelta: argumentsText }))
    expect(result.chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: safeText }))
    expect(result.chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toEqual([])
    expect(result.chunks.filter(chunk => chunk.type === 'finish')).toEqual([expect.objectContaining({
      reason: expect.objectContaining({ kind: 'error', failure: expect.objectContaining({ code, message: tenantReply, requestId: 'synthetic-gateway-id' }) })
    })])
    expect(result.events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')).toEqual([])
    expect(result.events.filter(event => event.type === 'assistant/message')).toEqual([])
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'assistant/attempt' }))
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'turn/end', data: expect.objectContaining({ reason: { kind: 'error', error: expect.objectContaining({ code, message: tenantReply }) } })
    }))
  })

  it.each(['CHAT', 'RESPONSES'] as const)('%s normally completed tool reaches the real scheduler and body exactly once', async protocol => {
    const result = await runAgent(protocol, 'normal')
    expect(result.observedBeforeTerminal).toBe(true)
    expect(result.terminalReleased).toBe(true)
    expect(result.requests).toBe(1)
    expect(result.wrongTransport).toBe(0)
    expect(result.calls).toBe(1)
    expect(result.preExecute).toBe(1)
    expect(result.returnedResults).toBe(1)
    expect(result.toolArguments).toEqual([{ value: 'complete' }])
    expect(result.chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toHaveLength(1)
    expect(result.events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(result.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'turn/end', data: expect.objectContaining({ reason: { kind: 'completed' } }) }))
  })
})
