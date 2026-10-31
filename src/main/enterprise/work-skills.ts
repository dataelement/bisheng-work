/** Allowlisted host-side skill transport. Enterprise cookies stay in the host. */
export function parseWorkSkillRequest(input: unknown): { connectionKey: string; operation: 'list' | 'bundle' | 'dependencies'; id?: number; version?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid skill request.')
  const v = input as Record<string, unknown>
  if (Object.keys(v).some(key => !['connectionKey', 'operation', 'id', 'version'].includes(key)) ||
      typeof v.connectionKey !== 'string' || !v.connectionKey || v.connectionKey.length > 256) throw new Error('Invalid enterprise identity.')
  if (v.operation === 'list' && v.id === undefined && v.version === undefined) return { connectionKey: v.connectionKey, operation: 'list' }
  if (!['bundle', 'dependencies'].includes(String(v.operation)) || !Number.isSafeInteger(v.id) || (v.id as number) <= 0 ||
      typeof v.version !== 'string' || !/^[a-f0-9]{64}$/.test(v.version)) throw new Error('Invalid skill identity or version.')
  return { connectionKey: v.connectionKey, operation: v.operation as 'bundle' | 'dependencies', id: v.id as number, version: v.version }
}

export async function readSkillBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`Skill request failed (${response.status}).`), { status: response.status }) }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Skill response is empty.')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > limit) throw new Error('Skill response exceeds the supported size.')
      chunks.push(next.value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  return Buffer.concat(chunks)
}
