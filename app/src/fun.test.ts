import { describe, expect, it } from 'vitest'
import { LOCATIONS_BY_ID, type SnowLocation } from './data/locations'
import type { PastLocation, PastSnowfall } from './past'
import { cleanWindows, depthGain, type Reading } from './recent'
import { spicyForced, spicyHits } from './spicy'
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
  it('fires for more than 12" in 24h, not exactly 12"', () => {
    expect(spicyHits([wolf, vail], past({ 'wolf-creek': 12.5, vail: 12 }), new Map())).toEqual([{ id: 'wolf-creek', name: 'Wolf Creek', inches: 12.5 }])
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
