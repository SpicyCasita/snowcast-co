import { describe, expect, it } from 'vitest'
import { parsePutBody, type Favorite, type Thresholds } from '../src/alerts'
import { denverToday, evaluatePast, type PastLocation, type PastSnowfall } from '../src/past'

const fav = (id: string, name = id): Favorite => ({ id, name, lat: 39, lon: -106, elevationFt: 10000 })
const loc = (o: Partial<PastLocation>): PastLocation => ({
  name: 'x', station: { type: 'snotel', name: 'Test SNOTEL' }, estimate: false, last24In: 0, last48In: 0,
  days: [{ d: '2026-11-01', a: 2, p: 2 }], ...o,
})
const past = (locations: Record<string, PastLocation>): PastSnowfall => ({ version: 1, generated: '2026-11-02T12:00:00Z', locations })
const off: Thresholds = { h72In: null, d7In: null, freshIn: null, missIn: null, recapDay: null }
const friday = { date: '2026-11-06', weekday: 5 }

describe('fresh snow', () => {
  const p = past({ a: loc({ last24In: 8, last48In: 12 }), b: loc({ last24In: 2, last48In: 7 }) })

  it('alerts favorites at or over the threshold, biggest first', () => {
    const r = evaluatePast({ favorites: [fav('b'), fav('a')], thresholds: { ...off, freshIn: 6 } }, p, friday)
    expect(r.payloads).toHaveLength(1)
    expect(r.payloads[0].title).toContain('a 8"')
    expect(r.payloads[0].locId).toBe('a')
  })

  it('uses the 48-hour total when chosen', () => {
    const r = evaluatePast({ favorites: [fav('a'), fav('b')], thresholds: { ...off, freshIn: 6, freshHours: 48 } }, p, friday)
    expect(r.payloads[0].title).toContain('2 favorites')
  })

  it('fires once per location per day', () => {
    const rec = { favorites: [fav('a')], thresholds: { ...off, freshIn: 6 } }
    const first = evaluatePast(rec, p, friday)
    expect(evaluatePast({ ...rec, lastPast: first.lastPast }, p, friday).payloads).toHaveLength(0)
    expect(evaluatePast({ ...rec, lastPast: first.lastPast }, p, { date: '2026-11-07', weekday: 6 }).payloads).toHaveLength(1)
  })

  it('ignores favorites with no past data (map points)', () => {
    expect(evaluatePast({ favorites: [fav('nowhere')], thresholds: { ...off, freshIn: 1 } }, p, friday).payloads).toHaveLength(0)
  })
})

describe('forecast miss', () => {
  const p = past({ v: loc({ days: [{ d: '2026-10-31', a: 0, p: 9 }, { d: '2026-11-01', a: 1, p: 6 }, { d: '2026-11-02', a: null, p: 3 }] }) })

  it('scores the latest day with both values and says over or under', () => {
    const r = evaluatePast({ favorites: [fav('v', 'Vail')], thresholds: { ...off, missIn: 4 } }, p, friday)
    expect(r.payloads[0].title).toBe('📉 Forecast miss: Vail')
    expect(r.payloads[0].body).toContain('forecast 6", measured 1" (over by 5")')
    expect(r.lastPast['miss:v']).toBe('2026-11-01')
  })

  it('stays quiet when the error is under the threshold, and dedupes by scored day', () => {
    expect(evaluatePast({ favorites: [fav('v')], thresholds: { ...off, missIn: 6 } }, p, friday).payloads).toHaveLength(0)
    expect(evaluatePast({ favorites: [fav('v')], thresholds: { ...off, missIn: 4 }, lastPast: { 'miss:v': '2026-11-01' } }, p, friday).payloads).toHaveLength(0)
  })
})

describe('weekly recap', () => {
  const p = past({ a: loc({ days: [{ d: '2026-11-04', a: 3, p: 2 }, { d: '2026-11-05', a: 5, p: 4 }] }), b: loc({ days: [{ d: '2026-11-05', a: 1, p: null }] }) })

  it('sends on the chosen weekday only, once', () => {
    const rec = { favorites: [fav('b', 'B'), fav('a', 'A')], thresholds: { ...off, recapDay: 5 } }
    const r = evaluatePast(rec, p, friday)
    expect(r.payloads).toHaveLength(1)
    expect(r.payloads[0].body).toContain('A: 8" (forecast 6")')
    expect(r.payloads[0].body.indexOf('A:')).toBeLessThan(r.payloads[0].body.indexOf('B:'))
    expect(evaluatePast({ ...rec, lastPast: r.lastPast }, p, friday).payloads).toHaveLength(0)
    expect(evaluatePast(rec, p, { date: '2026-11-05', weekday: 4 }).payloads).toHaveLength(0)
  })
})

describe('denverToday', () => {
  it('uses Colorado time, not UTC', () => {
    // 2026-11-07 03:00 UTC is still Friday evening in Denver (MST).
    expect(denverToday(Date.UTC(2026, 10, 7, 3))).toEqual({ date: '2026-11-06', weekday: 5 })
  })
})

describe('parsePutBody past settings', () => {
  const base = { subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }, favorites: [] }

  it('defaults past alerts off for older clients', () => {
    const r = parsePutBody({ ...base, thresholds: { h72In: 6, d7In: 12 } })
    expect(typeof r).not.toBe('string')
    expect((r as Exclude<typeof r, string>).thresholds).toMatchObject({ freshIn: null, missIn: null, recapDay: null, freshHours: 24 })
  })

  it('accepts and validates the new settings', () => {
    const r = parsePutBody({ ...base, thresholds: { h72In: null, d7In: null, freshIn: 6, freshHours: 48, missIn: 4, recapDay: 5 } })
    expect((r as Exclude<typeof r, string>).thresholds).toMatchObject({ freshIn: 6, freshHours: 48, missIn: 4, recapDay: 5 })
    expect(parsePutBody({ ...base, thresholds: { h72In: null, d7In: null, recapDay: 9 } })).toBe('recapDay must be 0-6 or null')
  })
})
