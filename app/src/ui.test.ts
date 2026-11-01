import { describe, expect, it } from 'vitest'
import { sixHourTicks, tickLabel } from './screens/HourlyChart'
import { moveItem } from './storage'

describe('moveItem', () => {
  it('moves up and down', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
  })
  it('ignores out-of-range moves', () => {
    const xs = ['a', 'b']
    expect(moveItem(xs, 0, -1)).toBe(xs)
    expect(moveItem(xs, 1, 2)).toBe(xs)
  })
})

describe('72h chart axis', () => {
  // 2026-12-01 00:00 MST = 07:00 UTC
  const midnight = Date.UTC(2026, 11, 1, 7) / 1000
  const hours = Array.from({ length: 24 }, (_, i) => midnight + i * 3600)

  it('ticks every 6 local hours', () => {
    expect(sixHourTicks(hours).map(tickLabel)).toEqual(['Tue', '6a', '12p', '6p'])
  })
})
