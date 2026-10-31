import { describe, expect, it } from 'vitest'
import { parseUsageStorage, parseUsageSummary } from '../src/shared/enterprise-usage'

const totals = { message_count: 12, input_tokens: 100, output_tokens: 20, total_tokens: 120, missing_usage_count: 0 }
const point = { ...totals, start_at: '2026-10-22T00:00:00+08:00', end_at: '2026-10-23T00:00:00+08:00' }
const summary = { start_at: point.start_at, end_at: '2026-10-22T14:00:00+08:00', timezone: 'Asia/Shanghai', granularity: 'day', totals, points: [point] }
describe('enterprise usage IPC projection', () => {
  it('preserves enterprise totals and missing tokens without converting null to zero', () => {
    expect(parseUsageSummary(summary)).toMatchObject({ totals, points: [point] })
    expect(parseUsageSummary({ ...summary, totals: { ...totals, total_tokens: null } }).totals.total_tokens).toBeNull()
  })
  it('rejects malformed, duplicate and unbounded buckets', () => {
    expect(() => parseUsageSummary({ ...summary, points: [point, point] })).toThrow()
    expect(() => parseUsageSummary({ ...summary, points: Array(367).fill(point) })).toThrow()
    expect(() => parseUsageSummary({ ...summary, totals: { ...totals, message_count: -1 } })).toThrow()
    expect(() => parseUsageSummary({ ...summary, timezone: 'UTC' })).toThrow()
    expect(() => parseUsageSummary({ ...summary, points: [{ ...point, start_at: 'invalid' }] })).toThrow()
  })
  it('reads only personal storage in GB and preserves unlimited and zero quotas', () => {
    expect(parseUsageStorage([{ resource_type: 'knowledge_space_file', user_used: 0.05, effective: -1, secret: 'ignored' }])).toEqual({ used: 0.05, limit: -1 })
    expect(parseUsageStorage([{ resource_type: 'knowledge_space_file', user_used: 0, effective: 0 }])).toEqual({ used: 0, limit: 0 })
    expect(parseUsageStorage([])).toBeNull()
    expect(() => parseUsageStorage([{ resource_type: 'knowledge_space_file', user_used: -1, effective: 2 }])).toThrow()
  })
})
