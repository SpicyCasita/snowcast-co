import { describe, expect, it } from 'vitest'
import { blend, defaultWeight, snowFraction, snowToLiquidRatio, weightedQuantile } from './blend'
import { alignNwsSnow, durationHours } from './nws'
import type { ModelSeries, RawForecast } from './types'

const T0 = Date.UTC(2026, 11, 1, 7) / 1000 // midnight in Denver (MST)
const hours = (n: number) => Array.from({ length: n }, (_, i) => T0 + i * 3600)

const series = (model: ModelSeries['model'], n: number, precip: number | null, temp: number | null): ModelSeries => ({
  model,
  precipIn: Array(n).fill(precip),
  tempF: Array(n).fill(temp),
  rawSnowIn: Array(n).fill(null),
  freezingLevelFt: Array(n).fill(null),
})

describe('snow physics', () => {
  it('is all rain when warm and all snow when cold', () => {
    expect(snowFraction(40)).toBe(0)
    expect(snowFraction(32)).toBe(1)
    expect(snowFraction(34.5)).toBeCloseTo(0.5)
  })
  it('gives fluffier snow in the dendritic range than near freezing', () => {
    expect(snowToLiquidRatio(33)).toBeLessThan(10)
    expect(snowToLiquidRatio(12)).toBeGreaterThan(18)
    expect(snowToLiquidRatio(-30)).toBe(16)
    expect(snowToLiquidRatio(50)).toBe(8)
  })
})

describe('weightedQuantile', () => {
  it('returns the median of equal weights', () => {
    expect(weightedQuantile([1, 2, 3], [1, 1, 1], 0.5)).toBe(2)
  })
  it('clamps to extremes', () => {
    expect(weightedQuantile([5, 1, 3], [1, 1, 1], 0)).toBe(1)
    expect(weightedQuantile([5, 1, 3], [1, 1, 1], 1)).toBe(5)
  })
  it('handles empty input', () => {
    expect(weightedQuantile([], [], 0.5)).toBe(0)
  })
})

describe('blend', () => {
  it('converts QPF to snow with the SLR and sums 24h', () => {
    const n = 48
    const raw: RawForecast = { times: hours(n), nowIndex: 0, elevationFt: 10000, models: [series('gem_seamless', n, 0.05, 20)] }
    const out = blend(raw)
    expect(out.next24.expected).toBeCloseTo(24 * 0.05 * 17)
    expect(out.days[0].date).toBe('2026-12-01')
  })

  it('applies a QPF bias before converting to snow', () => {
    const n = 48
    const raw: RawForecast = { times: hours(n), nowIndex: 0, elevationFt: 10000, models: [series('gem_seamless', n, 0.05, 20)] }
    const out = blend(raw, { bias: () => 1.5 })
    expect(out.next24.expected).toBeCloseTo(24 * 0.05 * 1.5 * 17)
  })

  it('does not count GFS seamless on day 1, where it is a copy of HRRR', () => {
    expect(defaultWeight('gfs_seamless', 6)).toBe(0)
    expect(defaultWeight('gfs_seamless', 30)).toBeGreaterThan(0)
  })

  it('ignores a model outside its useful range (HRRR beyond 48h)', () => {
    const n = 96
    const raw: RawForecast = {
      times: hours(n), nowIndex: 0, elevationFt: 10000,
      models: [series('ncep_hrrr_conus', n, 0.1, 20), series('ecmwf_ifs025', n, 0, 20)],
    }
    const out = blend(raw)
    expect(out.hourlySnowIn[1]).toBeGreaterThan(0)
    expect(out.hourlySnowIn[60]).toBe(0)
    expect(defaultWeight('ncep_hrrr_conus', 60)).toBe(0)
  })

  it('brackets the expected value with low/high', () => {
    const n = 48
    const raw: RawForecast = {
      times: hours(n), nowIndex: 0, elevationFt: 10000,
      models: [series('gfs_seamless', n, 0.02, 25), series('ecmwf_ifs025', n, 0.06, 25), series('gem_seamless', n, 0.04, 25)],
    }
    const { next24 } = blend(raw)
    expect(next24.low).toBeLessThan(next24.expected)
    expect(next24.high).toBeGreaterThan(next24.expected)
  })

  it('skips null hours instead of treating them as zero', () => {
    const n = 24
    const gappy = series('gem_seamless', n, 0.1, 20)
    gappy.precipIn = gappy.precipIn.map((v, i) => (i % 2 ? null : v))
    const raw: RawForecast = { times: hours(n), nowIndex: 0, elevationFt: 10000, models: [gappy] }
    const out = blend(raw)
    expect(out.hourlySnowIn[1]).toBe(0)
    expect(out.hourlySnowIn[0]).toBeCloseTo(0.1 * 17)
  })
})

describe('NWS alignment', () => {
  it('parses durations', () => {
    expect(durationHours('PT6H')).toBe(6)
    expect(durationHours('P1DT6H')).toBe(30)
    expect(durationHours('P1D')).toBe(24)
  })
  it('spreads period totals across hours in inches', () => {
    const times = hours(12)
    const iso = new Date(T0 * 1000).toISOString().replace('.000Z', '+00:00')
    const out = alignNwsSnow([{ validTime: `${iso}/PT6H`, value: 152.4 }], times)
    expect(out.rawSnowIn.slice(0, 6).every(v => Math.abs(v! - 1) < 1e-9)).toBe(true)
    expect(out.rawSnowIn[6]).toBeNull()
  })
})
