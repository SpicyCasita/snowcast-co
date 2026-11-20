import { describe, expect, it } from 'vitest'
import { blend } from './forecast/blend'
import type { ModelSeries, RawForecast } from './forecast/types'
import { activeCalls, applySeth, nearestLocationId, type SethData, type SethPost } from './seth'

const T0 = Date.UTC(2026, 11, 1, 7) / 1000 // 2026-12-01 00:00 MST
const N = 240
const times = Array.from({ length: N }, (_, i) => T0 + i * 3600)

/** 0.01" liquid/h at 20°F on 12-02 and 12-03 only, from two models. */
const series = (model: ModelSeries['model']): ModelSeries => ({
  model,
  precipIn: times.map((_, i) => (i >= 24 && i < 72 ? 0.01 : 0)),
  tempF: Array(N).fill(20),
  rawSnowIn: Array(N).fill(null),
  freezingLevelFt: Array(N).fill(null),
})
const raw: RawForecast = { times, nowIndex: 0, elevationFt: 10000, models: [series('ecmwf_ifs025'), series('gem_seamless')] }

const post = (published: string, calls: SethPost['calls']): SethPost => ({ id: published, url: 'https://fb/p', published, summary: 's', calls })
const data = (...posts: SethPost[]): SethData => ({
  version: 1, generated: '', source: '', pageUrl: '',
  skill: { n: 0, sethMaeIn: null, oursMaeIn: null, weight: 0.25, prior: 0.15 },
  posts,
})

describe('activeCalls', () => {
  const old = post('2026-11-29T15:00:00Z', [{ locations: ['vail'], start: '2026-12-02', end: '2026-12-03', lowIn: 1, highIn: 2 }])
  const fresh = post('2026-11-30T15:00:00Z', [{ locations: ['vail', 'copper'], start: '2026-12-02', end: '2026-12-03', lowIn: 10, highIn: 14 }])
  const past = post('2026-12-01T01:00:00Z', [{ locations: ['vail'], start: '2026-11-29', end: '2026-11-30', lowIn: 3, highIn: 5 }])

  it("takes the newest post's calls that still have days ahead", () => {
    const calls = activeCalls(data(old, fresh, past), 'vail', '2026-12-01')
    expect(calls.map(c => c.call.lowIn)).toEqual([10])
    expect(activeCalls(data(old, fresh), 'telluride', '2026-12-01')).toEqual([])
  })
})

describe('applySeth', () => {
  const base = blend(raw)
  const models = base.days.filter(d => d.date === '2026-12-02' || d.date === '2026-12-03').reduce((s, d) => s + d.snow.expected, 0)
  const call = { locations: ['vail'], start: '2026-12-02', end: '2026-12-03', lowIn: 20, highIn: 30 }

  it('moves the storm total toward his midpoint by his weight, everywhere', () => {
    const f = applySeth(base, [{ post: post('2026-11-30T15:00:00Z', [call]), call }], 0.25)
    const target = 0.75 * models + 0.25 * 25
    const days = f.days.filter(d => d.date === '2026-12-02' || d.date === '2026-12-03')
    expect(days.reduce((s, d) => s + d.snow.expected, 0)).toBeCloseTo(target, 6)
    expect(f.next72.expected).toBeCloseTo(target, 6)
    expect(f.hourlySnowIn.reduce((s, x) => s + x, 0)).toBeCloseTo(target, 6)
    expect(f.days[0].snow.expected).toBe(base.days[0].snow.expected)
    expect(f.seth?.[0]).toMatchObject({ sethLowIn: 20, sethHighIn: 30, weight: 0.25 })
    expect(f.calibration).toContain("Seth's Weather Report at 25%")
  })

  it('counts only the part of his call still ahead', () => {
    const started = { ...call, start: '2026-11-30', end: '2026-12-03' } // 4 days, 2 ahead (12-01 is dry)
    const f = applySeth(base, [{ post: post('2026-11-29T15:00:00Z', [started]), call: started }], 0.25)
    expect(f.seth?.[0].sethLowIn).toBeCloseTo(15)
  })

  it('adds snow when the models are dry', () => {
    const dry = { ...call, start: '2026-12-06', end: '2026-12-06', lowIn: 4, highIn: 4 }
    const f = applySeth(base, [{ post: post('2026-11-30T15:00:00Z', [dry]), call: dry }], 0.25)
    expect(f.days.find(d => d.date === '2026-12-06')!.snow.expected).toBeCloseTo(1)
    expect(f.next7d.expected).toBeCloseTo(base.next7d.expected + 1, 6)
  })

  it('leaves the forecast alone without calls', () => {
    expect(applySeth(base, [], 0.25)).toBe(base)
  })
})

describe('nearestLocationId', () => {
  it('matches only nearby points', () => {
    expect(nearestLocationId(39.61, -106.36)).toBe('vail')
    expect(nearestLocationId(38.0, -103.0)).toBeNull()
  })
})
