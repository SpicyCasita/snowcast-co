import { describe, expect, it } from 'vitest'
import { buildPayload, evaluate, parsePutBody, pointKey, REPEAT_AFTER_MS, shouldAlert, type Favorite, type LocationTotals } from '../src/alerts'
import { pointsForRun } from '../src/run'

const HOUR = 3600_000
const NOW = Date.UTC(2026, 11, 1, 12)
const vail: Favorite = { id: 'vail', name: 'Vail', lat: 39.606, lon: -106.355, elevationFt: 9845 }
const wolf: Favorite = { id: 'wolf-creek', name: 'Wolf Creek', lat: 37.472, lon: -106.793, elevationFt: 11102 }

describe('shouldAlert', () => {
  it('fires at or above the threshold and not below', () => {
    expect(shouldAlert(6, 6, undefined, NOW)).toBe(true)
    expect(shouldAlert(5.9, 6, undefined, NOW)).toBe(false)
  })
  it('never fires for a disabled window', () => {
    expect(shouldAlert(40, null, undefined, NOW)).toBe(false)
  })
  it('stays quiet within 24h of the last alert', () => {
    expect(shouldAlert(8, 6, { at: NOW - 23 * HOUR, expected: 7 }, NOW)).toBe(false)
  })
  it('repeats once 24h have passed', () => {
    expect(shouldAlert(7, 6, { at: NOW - REPEAT_AFTER_MS, expected: 7 }, NOW)).toBe(true)
  })
  it('repeats early when the forecast rose 50% or more', () => {
    expect(shouldAlert(10.5, 6, { at: NOW - HOUR, expected: 7 }, NOW)).toBe(true)
    expect(shouldAlert(10.4, 6, { at: NOW - HOUR, expected: 7 }, NOW)).toBe(false)
  })
  it('ignores NaN forecasts', () => {
    expect(shouldAlert(NaN, 6, undefined, NOW)).toBe(false)
  })
})

describe('evaluate', () => {
  const totals = (m: Record<string, LocationTotals>) => (f: Favorite) => m[f.id]

  it('checks each window against its own threshold', () => {
    const { hits, lastAlerts } = evaluate(
      { favorites: [vail, wolf], thresholds: { h72In: 6, d7In: 18 }, lastAlerts: {} },
      totals({ vail: { h72: 4, d7: 20 }, 'wolf-creek': { h72: 9, d7: 12 } }),
      NOW,
    )
    expect(hits.map(h => `${h.id}:${h.window}`)).toEqual(['vail:d7', 'wolf-creek:h72'])
    expect(lastAlerts).toEqual({ 'vail:d7': { at: NOW, expected: 20 }, 'wolf-creek:h72': { at: NOW, expected: 9 } })
  })

  it('dedupes per location and window independently', () => {
    const { hits } = evaluate(
      { favorites: [vail], thresholds: { h72In: 6, d7In: 10 }, lastAlerts: { 'vail:h72': { at: NOW - 2 * HOUR, expected: 7 } } },
      totals({ vail: { h72: 8, d7: 12 } }),
      NOW,
    )
    expect(hits.map(h => h.window)).toEqual(['d7'])
  })

  it('skips favorites without a forecast this run and keeps their state', () => {
    const last = { 'wolf-creek:h72': { at: NOW - HOUR, expected: 9 } }
    const { hits, lastAlerts } = evaluate({ favorites: [vail, wolf], thresholds: { h72In: 6, d7In: null }, lastAlerts: last }, totals({}), NOW)
    expect(hits).toEqual([])
    expect(lastAlerts).toEqual(last)
  })

  it('forgets state for removed favorites and old alerts', () => {
    const { lastAlerts } = evaluate(
      {
        favorites: [vail],
        thresholds: { h72In: 6, d7In: null },
        lastAlerts: { 'wolf-creek:h72': { at: NOW - HOUR, expected: 9 }, 'vail:d7': { at: NOW - 8 * 24 * HOUR, expected: 30 } },
      },
      totals({}),
      NOW,
    )
    expect(lastAlerts).toEqual({})
  })
})

describe('buildPayload', () => {
  it('returns null with nothing to say', () => {
    expect(buildPayload([])).toBeNull()
  })

  it('names the location for a single hit', () => {
    const p = buildPayload([{ id: 'vail', name: 'Vail', window: 'h72', expected: 8.26, threshold: 6 }])!
    expect(p).toEqual({
      title: '❄ Vail: 8.3" of snow forecast',
      body: '8.3" next 72h (alert at 6"). Tap for the forecast.',
      tag: 'snow-vail',
      locId: 'vail',
    })
  })

  it('combines both windows for one location, 72h first', () => {
    const p = buildPayload([
      { id: 'vail', name: 'Vail', window: 'd7', expected: 14.4, threshold: 12 },
      { id: 'vail', name: 'Vail', window: 'h72', expected: 9, threshold: 6 },
    ])!
    expect(p.title).toBe('❄ Vail: 14" of snow forecast')
    expect(p.body).toBe('9" next 72h, 14" next 7 days (alert at 12" / 6"). Tap for the forecast.')
  })

  it('summarises several locations, strongest first', () => {
    const p = buildPayload([
      { id: 'vail', name: 'Vail', window: 'h72', expected: 7, threshold: 6 },
      { id: 'wolf-creek', name: 'Wolf Creek', window: 'h72', expected: 18, threshold: 6 },
    ])!
    expect(p.title).toBe('❄ Snow for 2 favorites')
    expect(p.body).toBe('Wolf Creek: 18" next 72h\nVail: 7" next 72h')
    expect(p.locId).toBe('wolf-creek')
    expect(p.tag).toBe('snow-multi')
  })
})

describe('parsePutBody', () => {
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } }

  it('accepts a valid body', () => {
    const r = parsePutBody({ subscription, favorites: [vail], thresholds: { h72In: 6, d7In: null } })
    expect(r).toEqual({
      subscription: { ...subscription, expirationTime: null },
      favorites: [vail],
      // Past-snowfall alerts default to off when an older app omits them.
      thresholds: { h72In: 6, d7In: null, freshIn: null, freshHours: 24, missIn: null, recapDay: null },
    })
  })

  it('rejects bad input', () => {
    expect(parsePutBody(null)).toBeTypeOf('string')
    expect(parsePutBody({ subscription: { ...subscription, endpoint: 'http://x' }, favorites: [], thresholds: {} })).toBeTypeOf('string')
    expect(parsePutBody({ subscription, favorites: [{ id: 'x' }], thresholds: {} })).toBeTypeOf('string')
    expect(parsePutBody({ subscription, favorites: [], thresholds: { h72In: -1 } })).toBeTypeOf('string')
    expect(parsePutBody({ subscription, favorites: [], thresholds: { h72In: '6' } })).toBeTypeOf('string')
  })
})

describe('pointsForRun', () => {
  it('rotates through points when there are more than fit in one run', () => {
    const keys = Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(2, '0')}`)
    const seen = new Set([0, 1, 2].flatMap(h => pointsForRun(keys, h, 10)))
    expect(seen.size).toBe(25)
    expect(pointsForRun(keys, 0, 10)).toHaveLength(10)
    expect(pointsForRun(keys.slice(0, 5), 7, 10)).toHaveLength(5)
  })

  it('treats nearby favorites at the same elevation as one point', () => {
    expect(pointKey(vail)).toBe(pointKey({ ...vail, lat: vail.lat + 0.0001 }))
  })
})
