/** Public, read-only projection of enterprise statistics. No credentials cross IPC. */
export interface UsageMetrics {
  message_count: number
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  missing_usage_count: number
}
export interface UsagePoint extends UsageMetrics { start_at: string; end_at: string }
export interface UsageSummary {
  start_at: string
  end_at: string
  totals: UsageMetrics
  points: UsagePoint[]
}
export type UsageStorage = { used: number; limit: number } | null
export type UsageSection<T> = { status: 'ready'; data: T } | { status: 'error' }
export interface EnterpriseUsage {
  summary: UsageSection<UsageSummary>
  storage: UsageSection<UsageStorage>
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid usage response.')
  return value as Record<string, unknown>
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid usage count.')
  return value
}
function metrics(value: unknown): UsageMetrics {
  const row = object(value)
  const token = (key: string): number | null => row[key] === null ? null : count(row[key])
  return { message_count: count(row.message_count), missing_usage_count: count(row.missing_usage_count), input_tokens: token('input_tokens'), output_tokens: token('output_tokens'), total_tokens: token('total_tokens') }
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new Error('Invalid usage timestamp.')
  return value
}
export function parseUsageSummary(value: unknown): UsageSummary {
  const row = object(value)
  if (row.timezone !== 'Asia/Shanghai' || row.granularity !== 'day' || !Array.isArray(row.points) || row.points.length > 366) throw new Error('Invalid daily usage summary.')
  const start_at = timestamp(row.start_at), end_at = timestamp(row.end_at)
  if (Date.parse(end_at) < Date.parse(start_at)) throw new Error('Invalid usage range.')
  let previous = -Infinity
  const points = row.points.map(value => {
    const point = object(value), start = timestamp(point.start_at), end = timestamp(point.end_at)
    const time = Date.parse(start)
    if (time <= previous || Date.parse(end) <= time || time < Date.parse(start_at) || time > Date.parse(end_at)) throw new Error('Invalid usage bucket.')
    previous = time
    return { ...metrics(point), start_at: start, end_at: end }
  })
  return { start_at, end_at, totals: metrics(row.totals), points }
}
export function parseUsageStorage(value: unknown): UsageStorage {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid storage quota.')
  const item = value.map(object).find(row => row.resource_type === 'knowledge_space_file')
  if (!item) return null
  const used = item.user_used, limit = item.effective
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || typeof limit !== 'number' || !Number.isFinite(limit) || (limit < 0 && limit !== -1)) throw new Error('Invalid storage quota.')
  return { used, limit }
}
