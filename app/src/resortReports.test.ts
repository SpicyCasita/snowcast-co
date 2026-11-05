import { describe, expect, it } from 'vitest'
import type { PastDay } from './past'
import { compareToResort, isCurrent } from './resortReports'

describe('resort report comparison', () => {
  const days: PastDay[] = [
    { d: '2026-11-01', a: 1, p: 2 },
    { d: '2026-11-02', a: 2, p: 6 },
    { d: '2026-11-03', a: 0, p: 0.2 },
    { d: '2026-11-04', a: 3, p: 4 },
    { d: '2026-11-05', a: 0, p: 0 },
  ]
  it('scores the forecast against resort-reported snow days', () => {
    const c = compareToResort(days, { '2026-11-01': 2, '2026-11-02': 5, '2026-11-03': 0, '2026-11-04': 5, '2026-11-05': 0 })!
    expect(c.n).toBe(3)
    expect(c.maeIn).toBeCloseTo((0 + 1 + 1) / 3, 1)
    expect(c.biasIn).toBeCloseTo(0, 1)
    expect(c.stationGapIn).toBeCloseTo(((1 - 2) + (2 - 5) + (3 - 5)) / 3, 1)
  })
  it('needs at least three scored days', () => {
    expect(compareToResort(days, { '2026-11-02': 5 })).toBeNull()
  })
  it('treats reports older than 30 hours as stale', () => {
    const now = Date.parse('2026-11-05T15:00:00Z')
    expect(isCurrent({ updatedAt: '2026-11-05T13:00:00+00:00', new24In: 1, new48In: 1, new72In: 1, depthIn: 18 }, now)).toBe(true)
    expect(isCurrent({ updatedAt: '2026-11-03T13:00:00+00:00', new24In: 1, new48In: 1, new72In: 1, depthIn: 18 }, now)).toBe(false)
    expect(isCurrent(null, now)).toBe(false)
  })
})
