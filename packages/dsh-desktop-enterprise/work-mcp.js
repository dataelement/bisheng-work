import { Client } from '@modelcontextprotocol/client'

/** MCP SDK transport over the authenticated, fixed-operation Desktop broker. */
export class WorkBrokerTransport {
  constructor(request, connectionKey, signal) {
    this.request = request
    this.connectionKey = connectionKey
    this.controller = new AbortController()
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
  }
  async start() { this.signal.throwIfAborted() }
  setProtocolVersion(version) { this.protocolVersion = version }
  async send(message, options) {
    // The HTTP request is already cancelled through requestSignal. Stateless
    // calls have no server session in which to deliver a cancellation message.
    if (message.method === 'notifications/cancelled') return
    const signal = options?.requestSignal ? AbortSignal.any([this.signal, options.requestSignal]) : this.signal
    signal.throwIfAborted()
    const response = await this.request({ connectionKey: this.connectionKey, message,
      ...(this.protocolVersion ? { protocolVersion: this.protocolVersion } : {}) }, signal)
    signal.throwIfAborted()
    if (response) this.onmessage?.(response)
  }
  async close() { this.controller.abort(); this.onclose?.() }
}

export async function withWorkMcp(request, connectionKey, signal, use) {
  const client = new Client({ name: 'bisheng-desktop-work', version: '1.0.0' })
  const transport = new WorkBrokerTransport(request, connectionKey, signal)
  try {
    await client.connect(transport)
    return await use(client)
  } finally { await client.close() }
}

/** Complete pagination with cursor-cycle and catalog-size bounds. */
export async function readMcpPages(fetchPage, field) {
  const rows = [], cursors = new Set()
  let cursor
  do {
    const page = await fetchPage(cursor ? { cursor } : undefined)
    if (!Array.isArray(page[field])) throw new Error('Invalid enterprise capability catalog.')
    rows.push(...page[field])
    if (rows.length > 5000) throw new Error('Enterprise capability catalog exceeds the limit.')
    cursor = page.nextCursor
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw new Error('Invalid enterprise catalog cursor.')
    cursors.add(cursor)
  } while (cursor)
  return rows
}
