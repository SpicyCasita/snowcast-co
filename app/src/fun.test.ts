import { describe, expect, it } from 'vitest'
import { LOCATIONS_BY_ID, type SnowLocation } from './data/locations'
import type { PastLocation, PastSnowfall } from './past'
import { stormIncrements, windowTotals, type Reading } from './recent'
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

describe('live snow from hourly depth', () => {
  const H = 3600_000
  const series = (vals: (number | null)[]): Reading[] => vals.map((v, i) => ({ t: i * H, v }))
  const total = (r: Reading[]) => r.reduce((s, x) => s + (x.v ?? 0), 0)

  it('ignores flicker, spikes and afternoon blips', () => {
    expect(total(stormIncrements(series(Array.from({ length: 48 }, (_, i) => i % 2))))).toBe(0) // ±1" flicker
    expect(total(stormIncrements(series([...Array(10).fill(30), 60, ...Array(10).fill(30)])))).toBe(0) // one-hour spike
    // Mineral Creek, Oct 22: two 3-hour blips to 2" over bare ground
    expect(total(stormIncrements(series([0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 2, 1, 0, 1, 2, 2, 2, 1, 0, 0, 0, 0])))).toBe(0)
  })
  it('counts snow that builds and stays, including snow that settles or melts before more falls', () => {
    // Wolf Creek Summit, Nov 2: 18" -> 22"
    expect(total(stormIncrements(series([18, 18, 19, 20, 21, 21, 22, 23, 22, 22, 22, 22, 22, 22])))).toBe(4)
    // 6", settles to 4", then 5" more: 11" of snowfall though the depth only reached 9"
    expect(total(stormIncrements(series([...Array(8).fill(0), ...Array(8).fill(6), ...Array(8).fill(4), ...Array(8).fill(9)])))).toBe(11)
    // melts back to bare ground, then snows again
    expect(total(stormIncrements(series([...Array(6).fill(0), ...Array(6).fill(3), ...Array(6).fill(0), ...Array(6).fill(3)])))).toBe(6)
  })
  it('times a rise when the sensor has held it, so a short window still shows a storm in progress', () => {
    const depth = series([...Array(20).fill(10), 16, 16, 16, 16]) // 6" from hour 20, held through hour 23
    expect(stormIncrements(depth)).toEqual([{ t: 23 * H, v: 6 }])
    expect(windowTotals(depth)).toEqual({ 3: 6, 6: 6, 12: 6, 24: null, 48: null })
  })
  it('needs readings back to the start of a window', () => {
    const none = { 3: null, 6: null, 12: null, 24: null, 48: null }
    expect(windowTotals(series([5, 5, 5]))).toEqual(none)
    expect(windowTotals([])).toEqual(none)
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
