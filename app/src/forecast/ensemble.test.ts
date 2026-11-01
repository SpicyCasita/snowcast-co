import { describe, expect, it } from 'vitest'
import { blend, bucketOf, cumulative, ensembleStats } from './blend'
import { parseEnsemble } from './ensemble'
import type { EnsembleSeries, ModelSeries, RawForecast } from './types'

const T0 = Date.UTC(2026, 11, 1, 7) / 1000
const hours = (n: number) => Array.from({ length: n }, (_, i) => T0 + i * 3600)

describe('cumulative', () => {
  it('keeps a running total', () => {
    expect(cumulative([1, 0, 2.5])).toEqual([1, 1, 3.5])
    expect(cumulative([])).toEqual([])
  })
})

describe('bucketOf', () => {
  it('uses half-open buckets with an open top', () => {
    expect(bucketOf(0)).toEqual([0, 1])
    expect(bucketOf(1)).toEqual([1, 3])
    expect(bucketOf(5.9)).toEqual([3, 6])
    expect(bucketOf(30)).toEqual([12, null])
  })
})

describe('ensembleStats', () => {
  const totals = Array.from({ length: 80 }, (_, i) => i / 10) // 0.0 … 7.9, median ≈ 3.95

  it('re-centres the ensemble on the blend and brackets it', () => {
    const s = ensembleStats(4, totals)
    expect(s.low).toBeLessThan(4)
    expect(s.high).toBeGreaterThan(4)
    expect(s.ensembleSize).toBe(80)
  })

  it('gives monotonically falling chances for bigger amounts', () => {
    const { chance } = ensembleStats(4, totals)
    expect(chance[1]).toBeGreaterThanOrEqual(chance[3])
    expect(chance[3]).toBeGreaterThanOrEqual(chance[6])
    expect(chance[6]).toBeGreaterThanOrEqual(chance[12])
  })

  it('reports the share of members in the forecast bucket as confidence', () => {
    const tight = ensembleStats(4, Array(50).fill(4))
    expect(tight.bucket).toEqual([3, 6])
    expect(tight.confidence).toBe(1)
    const wide = ensembleStats(4, totals)
    expect(wide.confidence).toBeGreaterThan(0)
    expect(wide.confidence).toBeLessThan(1)
  })

  it('shifts rather than scales when the ensemble is nearly dry', () => {
    const s = ensembleStats(2, Array(40).fill(0))
    expect(s.low).toBeCloseTo(2)
    expect(s.chance[1]).toBe(1)
  })
})

describe('parseEnsemble', () => {
  it('splits control and numbered members per family and aligns to times', () => {
    const t = hours(3)
    const hourly = {
      precipitation_ncep_gefs025: [0.1, 0.1, 0.1],
      temperature_2m_ncep_gefs025: [20, 20, 20],
      precipitation_member01_ncep_gefs025: [0.2, 0.2, 0.2],
      temperature_2m_member01_ncep_gefs025: [20, 20, 20],
      precipitation_member01_ecmwf_ifs025_ensemble: [0.3, 0.3, 0.3],
      temperature_2m_member01_ecmwf_ifs025_ensemble: [25, 25, 25],
    }
    const members = parseEnsemble(hourly, t, [t[1], t[2], t[2] + 3600])!
    expect(members.map(m => m.family)).toEqual(['gfs_seamless', 'gfs_seamless', 'ecmwf_ifs025'])
    expect(members[1].precipIn).toEqual([0.2, 0.2, null])
  })

  it('returns null with no members', () => {
    expect(parseEnsemble({}, [], [])).toBeNull()
  })
})

describe('blend with an ensemble', () => {
  const n = 48
  const det = (precip: number): ModelSeries => ({
    model: 'gem_seamless',
    precipIn: Array(n).fill(precip),
    tempF: Array(n).fill(20),
    rawSnowIn: Array(n).fill(null),
    freezingLevelFt: Array(n).fill(null),
  })
  const member = (precip: number): EnsembleSeries => ({ family: 'ecmwf_ifs025', precipIn: Array(n).fill(precip), tempF: Array(n).fill(20) })

  it('adds confidence and chances when at least 10 members cover the window', () => {
    const raw: RawForecast = { times: hours(n), nowIndex: 0, elevationFt: 10000, models: [det(0.01)], ensemble: Array.from({ length: 20 }, (_, i) => member(0.002 * (i + 1))) }
    const { next24 } = blend(raw)
    expect(next24.confidence).toBeDefined()
    expect(next24.chance?.[1]).toBeGreaterThan(0)
    expect(next24.expected).toBeCloseTo(24 * 0.01 * 17)
  })

  it('falls back to the model spread without enough members', () => {
    const raw: RawForecast = { times: hours(n), nowIndex: 0, elevationFt: 10000, models: [det(0.01)], ensemble: [member(0.01)] }
    expect(blend(raw).next24.confidence).toBeUndefined()
  })
})
