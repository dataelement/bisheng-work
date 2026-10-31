import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { expect, it, vi } from 'vitest'

function setup() {
  let plugin
  const fetch = vi.fn(async () => Response.json({ ok: true }))
  vm.runInNewContext(readFileSync(new URL('../packages/dsh-desktop-client-ui/client.js', import.meta.url), 'utf8'), {
    fetch, window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({})) } } }
  })
  return { source: plugin.toolReferenceSource, fetch }
}

it('serializes the actual selected tool identity after checking availability for its account', async () => {
  const { source, fetch } = setup()
  const ref = JSON.stringify({ name: 'mcp__bisheng__bisheng_tool_7', label: '当前时间', connectionKey: 'account-a' })
  expect(source.codec.clipboardText(ref)).toBe('/当前时间')
  expect(source.openReference()).toBe(false)
  expect(await source.codec.serialize(ref)).toBe(' [Selected tool: mcp__bisheng__bisheng_tool_7; label: "当前时间"] ')
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ operation: 'validate', names: ['mcp__bisheng__bisheng_tool_7'], connectionKey: 'account-a' })
  fetch.mockResolvedValueOnce(Response.json({ error: 'Tool disabled' }, { status: 400 }))
  await expect(source.codec.serialize(ref)).rejects.toThrow('Tool disabled')
})

it('rejects forged references and propagates cancellation instead of submitting', async () => {
  const { source, fetch } = setup()
  await expect(source.codec.serialize(JSON.stringify({ name: 'bash', label: 'Bash', connectionKey: 'a' }))).rejects.toThrow('Invalid tool')
  expect(fetch).not.toHaveBeenCalled()
  const signal = new AbortController().signal
  const error = new DOMException('Canceled', 'AbortError')
  fetch.mockRejectedValueOnce(error)
  await expect(source.codec.serialize(JSON.stringify({ name: 'mcp__bisheng__bisheng_tool_7', label: 'Time', connectionKey: 'a' }), signal)).rejects.toThrow('Canceled')
  expect(fetch.mock.calls[0][1].signal).toBe(signal)
})
