import { describe, expect, it } from 'vitest'
import { defaultWeight } from './blend'
import { bandOf, leadDayOf, MIN_CELL_N, regionOf, skillModel, type CellStats, type SkillWeights } from './skill'

const stats = (bias: number, weight: number, n = 200, mae = 4, maeRaw = 5): CellStats => ({ bias, weight, mae, maeRaw, n })

const leads = (cell: SkillWeights['weights'][string][string][string]) =>
  Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(d => [String(d), cell]))

const W: SkillWeights = {
  version: 1,
  generated: '2026-11-01T00:00:00Z',
  regions: {
    'Front Range foothills': { bbox: [-105.85, 38.6, -102.0, 41.01], order: 0 },
    'San Juans': { bbox: [-109.06, 36.99, -106.0, 38.5], order: 1 },
    'Central Mtns': { bbox: [-109.06, 36.99, -105.85, 41.01], order: 2 },
  },
  bands: { lt9k: [null, 9000], '9to11k': [9000, 11000], gt11k: [11000, null] },
  meta: { aliases: { gfs_seamless: { '1': 'ncep_hrrr_conus' } }, sites: 5, dateRange: ['2024-11-03', '2025-04-30'] },
  weights: {
    ALL: {
      ALL: leads({ ecmwf_ifs025: stats(1.2, 0.6), icon_seamless: stats(1.1, 0.4) }),
      gt11k: leads({ ecmwf_ifs025: stats(1.7, 0.7), icon_seamless: stats(1.3, 0.3, 200, 6, 5) }),
    },
    // Too little data: should be skipped in favour of the band cell.
    'San Juans': { gt11k: leads({ ecmwf_ifs025: stats(3, 0.9, MIN_CELL_N - 1), icon_seamless: stats(3, 0.1, MIN_CELL_N - 1) }) },
  },
}

describe('region and band lookup', () => {
  it('uses the first matching region by order', () => {
    expect(regionOf(W, 39.7, -105.2)).toBe('Front Range foothills')
    expect(regionOf(W, 37.47, -106.79)).toBe('San Juans')
    expect(regionOf(W, 39.5, -106.1)).toBe('Central Mtns')
    expect(regionOf(W, 45, -100)).toBeNull()
  })
  it('bands by elevation with open ends', () => {
    expect(bandOf(W, 5280)).toBe('lt9k')
    expect(bandOf(W, 9000)).toBe('9to11k')
    expect(bandOf(W, 12000)).toBe('gt11k')
  })
  it('maps lead hours to lead days', () => {
    expect(leadDayOf(-5)).toBe(1)
    expect(leadDayOf(1)).toBe(1)
    expect(leadDayOf(24)).toBe(1)
    expect(leadDayOf(25)).toBe(2)
  })
})

describe('skillModel', () => {
  const wolfCreekSummit = skillModel(W, 37.47, -106.79, 11900)

  it('falls back from a thin region cell to the band cell', () => {
    expect(wolfCreekSummit.bias('ecmwf_ifs025', 30)).toBe(1.7)
    expect(wolfCreekSummit.calibration).toContain('gt11k')
  })

  it('skips a bias that made verification worse', () => {
    expect(wolfCreekSummit.bias('icon_seamless', 30)).toBe(1)
  })

  it('rescales learned weights to the heuristic mass of the cell', () => {
    const h = 30
    const mass = defaultWeight('ecmwf_ifs025', h) + defaultWeight('icon_seamless', h)
    expect(wolfCreekSummit.weight('ecmwf_ifs025', h)).toBeCloseTo(0.7 * mass)
    expect(wolfCreekSummit.weight('icon_seamless', h)).toBeCloseTo(0.3 * mass)
  })

  it('keeps heuristic weights for models the cell does not cover', () => {
    expect(wolfCreekSummit.weight('ncep_nam_conus', 10)).toBe(defaultWeight('ncep_nam_conus', 10))
    expect(wolfCreekSummit.weight('nws', 10)).toBe(defaultWeight('nws', 10))
  })

  it('drops an aliased model at the aliased lead only', () => {
    expect(wolfCreekSummit.weight('gfs_seamless', 10)).toBe(0)
    expect(wolfCreekSummit.weight('gfs_seamless', 30)).toBe(defaultWeight('gfs_seamless', 30))
  })

  it('uses heuristics past day 7 but carries the bias forward', () => {
    expect(wolfCreekSummit.weight('ecmwf_ifs025', 200)).toBe(defaultWeight('ecmwf_ifs025', 200))
    expect(wolfCreekSummit.bias('ecmwf_ifs025', 200)).toBe(1.7)
  })

  it('credits CoCoRaHS gauges in the label when the weights include them', () => {
    const withGauges = { ...W, meta: { ...W.meta, sources: { observations: { snotel: { sites: 5 }, cocorahs: { sites: 10 } } } } }
    expect(skillModel(withGauges, 37.47, -106.79, 11900).calibration).toContain('5 SNOTEL sites + 10 CoCoRaHS gauges')
  })

  it('uses the statewide cell outside any band-specific data', () => {
    const denver = skillModel(W, 39.74, -104.99, 5280)
    expect(denver.bias('ecmwf_ifs025', 30)).toBe(1.2)
    expect(denver.calibration).toContain('statewide')
  })
})
