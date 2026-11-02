import { describe, expect, it } from 'vitest'
import { blendPrevious, errorStats } from '../scripts/past-snowfall'
import { biasPhrase, lastDaysTotal, stationLabel, type PastDay, type PastLocation } from './past'

const day = (d: string, a: number | null, p: number | null): PastDay => ({ d, a, p })

describe('errorStats', () => {
  it('scores only days where we forecast or measured 1"+', () => {
    const s = errorStats([day('2026-10-01', 0, 0.2), day('2026-10-02', 4, 6), day('2026-10-03', 2, 0), day('2026-10-04', 0, 3)], '2026-10-01')!
    expect(s.n).toBe(3)
    expect(s.maeIn).toBeCloseTo((2 + 2 + 3) / 3, 1)
    expect(s.biasIn).toBeCloseTo((2 - 2 + 3) / 3, 1)
    // Two days actually snowed 1"+, and we forecast 1"+ on one of them.
    expect(s.hitRate).toBe(0.5)
  })

  it('ignores days before the window and days missing either side', () => {
    expect(errorStats([day('2026-09-01', 5, 1), day('2026-10-02', null, 4)], '2026-10-01')).toBeNull()
  })
})

describe('blendPrevious', () => {
  // 2026-12-01 08:00 UTC = midnight PST: 24 hours of one model at 0.05"/h and 20°F.
  const t0 = Date.UTC(2026, 11, 1, 8) / 1000
  const times = Array.from({ length: 24 }, (_, i) => t0 + i * 3600)
  const hourly = {
    time: times,
    precipitation_previous_day1_gem_seamless: times.map(() => 0.05),
    temperature_2m_previous_day1_gem_seamless: times.map(() => 20),
  }

  it('applies the app snow ratio and sums whole PST days', () => {
    expect(blendPrevious(hourly, null, 39, -106, 10000)).toEqual({ '2026-12-01': 20.4 })
  })

  it('drops partial days rather than under-counting them', () => {
    const half = { ...hourly, time: times.slice(0, 12) }
    expect(blendPrevious(half, null, 39, -106, 10000)).toEqual({})
  })
})

describe('past helpers', () => {
  it('totals the last n measured days', () => {
    const days = [day('a', 1, null), day('b', null, 2), day('c', 3, 1)]
    expect(lastDaysTotal(days, 2)).toBe(3)
    expect(lastDaysTotal([day('a', null, 1)], 7)).toBeNull()
  })

  it('describes bias in plain words', () => {
    expect(biasPhrase(0.1)).toBe('little systematic bias')
    expect(biasPhrase(0.9)).toBe('forecasts ran 0.9" high')
    expect(biasPhrase(-1.25)).toBe('forecasts ran 1.3" low')
  })

  it('labels estimates and stations', () => {
    const base: PastLocation = { name: 'x', kind: 'town', station: null, estimate: true, last24In: null, last48In: null, seasonIn: null, days: [], stats: null }
    expect(stationLabel(base)).toBe('Model estimate (no station nearby)')
    expect(stationLabel({ ...base, estimate: false, station: { type: 'cocorahs', id: 'CO-1', name: 'Denver 1.3 NE', lat: 0, lon: 0, elevFt: 5243, km: 2.1 } }))
      .toBe('Denver 1.3 NE (CoCoRaHS) · 2.1 km · 5,243′')
  })
})
