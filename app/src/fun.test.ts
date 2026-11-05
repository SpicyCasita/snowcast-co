import { describe, expect, it } from 'vitest'
import { LOCATIONS_BY_ID, type SnowLocation } from './data/locations'
import type { PastLocation, PastSnowfall } from './past'
import { cleanWindows, confirmedPrecip, depthGain, peakRise, precipSnow, precipTotal, type Reading } from './recent'
import { AGITATE_MIN, createMotionFilter, globeParams, STIR_MIN } from './globe'
import { spicyForced, spicyHits, tapCounter } from './spicy'
import { stormHits } from './storm'
import { nextTheme } from './theme'

const loc = (id: string) => LOCATIONS_BY_ID.get(id) as SnowLocation
const wolf = loc('wolf-creek')
const vail = loc('vail')
const denver = loc('denver')

const pastLoc = (last24In: number | null): PastLocation => ({
  name: 'x', kind: 'resort', station: null, estimate: false, last24In, last48In: null, seasonIn: null, days: [], stats: null,
})
const past = (m: Record<string, number | null>): PastSnowfall => ({
  version: 1, generated: '', obsGenerated: '', seasonStart: '2026-10-01',
  locations: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, pastLoc(v)])),
})

describe('Spicy Casita Special trigger', () => {
  it('fires at 12.0" or more, not just under', () => {
    expect(spicyHits([wolf, vail], past({ 'wolf-creek': 12, vail: 11.9 }), new Map())).toEqual([{ id: 'wolf-creek', name: 'Wolf Creek', inches: 12 }])
  })

  it('uses the live reading when it is higher than the morning file', () => {
    const hits = spicyHits([wolf], past({ 'wolf-creek': 4 }), new Map([['wolf-creek', 15]]))
    expect(hits[0].inches).toBe(15)
  })

  it('only counts favorites, biggest dump first', () => {
    const hits = spicyHits([vail, wolf], past({ 'wolf-creek': 14, vail: 20, telluride: 30 }), new Map())
    expect(hits.map(h => h.id)).toEqual(['vail', 'wolf-creek'])
  })

  it('stays quiet without data', () => {
    expect(spicyHits([wolf], null, new Map())).toEqual([])
  })

  it('can be forced for testing with ?spicy=1', () => {
    expect(spicyForced('https://x/snowcast-co/?spicy=1#/')).toBe(true)
    expect(spicyForced('https://x/snowcast-co/#/loc/vail?spicy=1')).toBe(true)
    expect(spicyForced('https://x/snowcast-co/?spicy=10')).toBe(false)
    expect(spicyForced('https://x/snowcast-co/#/')).toBe(false)
  })
})

describe('storm mode', () => {
  it('turns on for favorites expecting 1"+ in 24h, biggest first', () => {
    const hits = stormHits([denver, wolf, vail], new Map([['denver', 0.4], ['wolf-creek', 11], ['vail', 2]]))
    expect(hits.map(h => h.id)).toEqual(['wolf-creek', 'vail'])
  })
  it('is off when nothing is coming', () => {
    expect(stormHits([denver], new Map([['denver', 0.9]]))).toEqual([])
  })
})

describe('live short-window depth gain', () => {
  const H = 3600_000
  const series = (vals: number[]): Reading[] => vals.map((v, i) => ({ t: i * H, v }))

  it('catches a 3-hour burst without smoothing it away', () => {
    // flat at 20", then 4" in the last two hours
    expect(depthGain(series([20, 20, 20, 20, 20, 20, 22, 24]), 3)).toBe(4)
  })
  it('smooths a one-hour spike for longer windows', () => {
    expect(depthGain(series([...Array(20).fill(30), 30, 30, 60]), 12)).toBe(0)
  })
  it('never reports settling as negative snowfall, and needs enough history', () => {
    expect(depthGain(series([30, 29, 28, 27, 26, 25, 24, 23]), 6)).toBe(0)
    expect(depthGain(series([30, 31]), 6)).toBeNull()
  })
})

describe('precip-gauge snow', () => {
  const H = 3600_000
  const series = (vals: (number | null)[]) => vals.map((v, i) => ({ t: i * H, v }))
  it('turns gauge rises into snow by temperature, ignoring jitter dips and resets', () => {
    const prec = series([1.0, 1.0, 1.1, 1.2, 1.3, 1.4, 1.4, 1.3, 1.4, 1.4, 1.4, 1.4])
    const cold = series(Array(12).fill(20))
    expect(precipTotal(precipSnow(prec, cold), 48)).toBeCloseTo(0.4 * 17, 1)
    expect(precipTotal(precipSnow(prec, series(Array(12).fill(40))), 48)).toBe(0)
    const reset = series([12, 12, 0, 0, 0.1, 0.1])
    expect(precipTotal(precipSnow(reset, cold), 48)).toBeCloseTo(1.7, 1)
  })
  it('counts gauge snow only when depth confirms it, capped at twice the rise', () => {
    const snow = series(Array(24).fill(0.5)) // 12" of gauge snow over the day
    expect(confirmedPrecip(series(Array(24).fill(0)), snow, 24)).toBe(0) // melted on contact
    expect(confirmedPrecip(series(Array.from({ length: 24 }, (_, i) => i % 2)), snow, 24)).toBe(0) // 1" flicker
    const briefly = series([...Array(14).fill(0), ...Array(5).fill(3), ...Array(5).fill(0)])
    expect(peakRise(briefly, 24)).toBe(3)
    expect(confirmedPrecip(briefly, snow, 24)).toBe(6) // capped at 2 × 3"
    expect(confirmedPrecip(series([...Array(12).fill(0), ...Array(12).fill(8)]), snow, 24)).toBe(12)
  })
  it('only sums the window before the latest reading', () => {
    const snow = series([1, 1, 1, 1, 1, 1])
    expect(precipTotal(snow, 3)).toBe(3)
    expect(precipTotal([], 3)).toBeNull()
  })
})

describe('cleanWindows', () => {
  it('drops sub-1.5" jitter in short windows and keeps totals non-decreasing', () => {
    // Steamboat-style flicker from a ±1" sensor
    expect(cleanWindows({ 3: 1, 6: 0, 12: 1, 24: 0, 48: 1 })).toEqual({ 3: 0, 6: 0, 12: 0, 24: 0, 48: 1 })
    // a real burst carries forward into the longer windows
    expect(cleanWindows({ 3: 4, 6: 3, 12: 6, 24: 5, 48: 9 })).toEqual({ 3: 4, 6: 4, 12: 6, 24: 6, 48: 9 })
  })
  it('keeps unknown windows unknown', () => {
    expect(cleanWindows({ 3: null, 6: 2, 12: null, 24: 3, 48: null })).toEqual({ 3: null, 6: 2, 12: null, 24: 3, 48: null })
  })
})

describe('theme toggle', () => {
  it('cycles Auto → Light → Dark → Auto', () => {
    expect(nextTheme('system')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('system')
  })
})

describe('secret five-tap summon', () => {
  it('fires on the 5th tap within 2 seconds, then starts over', () => {
    const tap = tapCounter()
    expect([0, 300, 600, 900].map(tap)).toEqual([false, false, false, false])
    expect(tap(1200)).toBe(true)
    expect(tap(1300)).toBe(false)
  })
  it('ignores taps spread out over more than 2 seconds', () => {
    const tap = tapCounter()
    expect([0, 600, 1200, 1800, 2400].map(tap)).toEqual([false, false, false, false, false])
    expect(tap(2700)).toBe(false) // only 1200..2700 are inside the window
    expect(tap(2800)).toBe(true) // 1200, 1800, 2400, 2700, 2800
  })
})

describe('snow globe', () => {
  it('scales flakes and float time with the forecast, capped', () => {
    expect(globeParams(0)).toEqual({ count: 70, floatSeconds: 4 })
    const big = globeParams(24)
    expect(big.count).toBeGreaterThan(globeParams(6).count)
    expect(big.floatSeconds).toBeGreaterThan(globeParams(6).floatSeconds)
    expect(globeParams(100)).toEqual(globeParams(36))
  })

  it('reacts on the first sample, and a gentle 0.3 g shake is enough to stir the snow', () => {
    const filter = createMotionFilter()
    filter({ x: 0, y: 9.8, z: 0 }) // held upright, still
    const m = filter({ x: 3.2, y: 9.8, z: 0 }) // a light flick to the right
    expect(m.magnitude).toBeGreaterThan(AGITATE_MIN)
    expect(m.magnitude).toBeGreaterThanOrEqual(STIR_MIN * 0.9)
    expect(m.accel.x).toBeGreaterThan(0)
  })

  it('ignores the phone just sitting still', () => {
    const filter = createMotionFilter()
    let m = filter({ x: 0, y: 9.8, z: 0 })
    for (let i = 0; i < 5; i++) m = filter({ x: 0.05, y: 9.8, z: 0 })
    expect(m.magnitude).toBeLessThan(AGITATE_MIN)
  })

  it('uses gravity-free acceleration from the browser when it has one', () => {
    const m = createMotionFilter()({ x: 0, y: 9.8, z: 0 }, { x: 0, y: 2, z: 0 })
    expect(m.magnitude).toBe(2)
    expect(m.accel.y).toBe(-2) // device "up" is screen "up" (negative y)
  })

  it('finds "down" on screen whichever sign convention the browser uses, and follows tilt', () => {
    // Spec convention: +9.8 on y when upright. iOS Safari has reported -9.8.
    for (const g of [9.8, -9.8]) {
      const filter = createMotionFilter()
      const first = filter({ x: 0, y: g, z: 0 }).down
      expect(first.x).toBeCloseTo(0)
      expect(first.y).toBeCloseTo(1)
      // Tip the phone so its right side is lower: snow should drift right.
      let m = filter({ x: 0, y: g, z: 0 })
      for (let i = 0; i < 60; i++) m = filter({ x: -Math.sign(g) * 6.9, y: g * 0.7, z: 0 })
      expect(m.down.x).toBeGreaterThan(0.5)
    }
  })

  it('falls back to screen-down and low tilt when the phone lies flat', () => {
    const m = createMotionFilter()({ x: 0, y: 0, z: 9.8 })
    expect(m.down).toEqual({ x: 0, y: 1 })
    expect(m.tilt).toBeLessThan(0.1)
  })
})
