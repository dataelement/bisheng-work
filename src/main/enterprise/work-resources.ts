/** Fixed platform operations for locally executed Work tasks. */
export type WorkResourceRequest = {
  connectionKey: string
  operation: 'list' | 'retrieve'
  spaceIds?: number[]
  query?: string
}

export function parseWorkResourceRequest(input: unknown): WorkResourceRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid resource request.')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['connectionKey', 'operation', 'spaceIds', 'query'].includes(key)) ||
      typeof value.connectionKey !== 'string' || !value.connectionKey || value.connectionKey.length > 256) throw new Error('Invalid enterprise identity.')
  if (value.operation === 'list' && value.spaceIds === undefined && value.query === undefined) return { connectionKey: value.connectionKey, operation: 'list' }
  if (value.operation !== 'retrieve' || typeof value.query !== 'string' || !value.query.trim() || value.query.length > 4000 ||
      !Array.isArray(value.spaceIds) || value.spaceIds.length < 1 || value.spaceIds.length > 50 ||
      value.spaceIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Choose knowledge spaces and enter a search query.')
  return { connectionKey: value.connectionKey, operation: 'retrieve', spaceIds: [...new Set(value.spaceIds as number[])], query: value.query.trim() }
}

export async function readResourceJson(response: Response): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`Knowledge request failed (${response.status}).`), { status: response.status }) }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Knowledge response is empty.')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > 2 * 1024 * 1024) throw new Error('Knowledge response exceeds the allowed size.')
      chunks.push(next.value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (result?.status_code !== 200 || result.data === undefined) throw new Error('Knowledge service could not complete the request.')
  return result.data
}
