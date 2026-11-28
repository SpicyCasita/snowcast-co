import { describe, expect, it } from 'vitest'
import { blendPrevious, buildLocation, errorStats, estimateDays, measuredDay, resortDays, stormSpans, type BuildInput } from '../scripts/past-snowfall'
import { biasPhrase, composeTotals, dayEnd, stationLabel, stationNote, type PastDay, type PastLocation } from './past'
import type { RecentSnow } from './recent'

const day = (d: string, a: number | null, p: number | null): PastDay => ({ d, a, p })
const nov = (n: number) => `2026-11-${String(n).padStart(2, '0')}`

describe('errorStats', () => {
  it('scores storm by storm, a day either side', () => {
    // A 4" storm forecast a day early is one storm, scored on its total, not two misses.
    const days = [day(nov(1), 0, 0), day(nov(2), 0, 4), day(nov(3), 4, 0), day(nov(4), 0, 0), day(nov(5), 0, 0), day(nov(6), 0, 0), day(nov(7), 2, 0), day(nov(8), 0, 0)]
    const s = errorStats(days, nov(1))!
    expect(s).toEqual({ n: 2, maeIn: 1, biasIn: -1, hitRate: 0.5, per: 'storm' })
  })

  it('ignores days before the window, days missing either side, and estimates', () => {
    expect(errorStats([day('2026-09-01', 5, 1), day('2026-10-02', null, 4)], '2026-10-01')).toBeNull()
    expect(errorStats([{ ...day(nov(2), 5, 1), s: 'estimate' }], nov(1))).toBeNull()
  })

  it('finds storms like the pipeline does', () => {
    const days = Array.from({ length: 12 }, (_, i) => nov(i + 1))
    // Same case as pipeline/tests/test_recent_obs.py test_storm_spans_merge_pad_and_union_sources.
    expect(stormSpans(days, { [nov(3)]: 4, [nov(5)]: 2, [nov(10)]: 0.5 })).toEqual([[nov(2), nov(3), nov(4), nov(5), nov(6)]])
    expect(stormSpans(days, { [nov(3)]: 4, [nov(5)]: 2 }, { [nov(10)]: 3 })[1]).toEqual([nov(9), nov(10), nov(11)])
  })
})

describe('measured days', () => {
  it('takes the resort report from its first snow report or opening day, keeping the station alongside', () => {
    // Winter Park: zeros while closed, 4" on Nov 2 (measured before opening), open Nov 13.
    const doc = { resorts: { wp: { openingDate: nov(13), days: { [nov(1)]: 0, [nov(2)]: 4, [nov(14)]: 1, [nov(15)]: null } } } }
    const resort = resortDays(doc, 'wp')
    expect(resort).toEqual({ [nov(2)]: 4, [nov(14)]: 1 })
    expect(measuredDay(nov(14), 2.2, 0, 'snotel', resort)).toEqual({ d: nov(14), a: 1, p: 2.2, s: 'resort', st: 0 })
    expect(measuredDay(nov(1), 2, 0, 'snotel', resort)).toEqual({ d: nov(1), a: 0, p: 2, s: 'snotel' })
    // Copper: zeros until it opened while its station got snow; those zeros aren't measurements.
    expect(resortDays({ resorts: { c: { openingDate: nov(13), days: { [nov(2)]: 0, [nov(14)]: 3 } } } }, 'c')).toEqual({ [nov(14)]: 3 })
    expect(resortDays({ resorts: { z: { days: { [nov(2)]: 0 } } } }, 'z')).toEqual({})
  })

  it('never counts forecast hours as measured', () => {
    const t0 = Date.UTC(2026, 10, 27, 15) / 1000 // 7am PST: the Nov 27 observation day
    const hourly = { time: [t0, t0 + 3600, t0 + 7200], precipitation: [0.1, 0.1, 0.1], temperature_2m: [20, 20, 20] }
    const all = estimateDays(hourly, t0 + 7200)['2026-11-27']
    expect(estimateDays(hourly, t0 + 3600)['2026-11-27']).toBeCloseTo((all * 2) / 3, 1)
  })
})

describe('buildLocation', () => {
  const station = { type: 'snotel' as const, id: 'A', name: 'A SNOTEL', lat: 39.8, lon: -105.8, elevFt: 11000, km: 9 }
  const dayList = Array.from({ length: 10 }, (_, i) => nov(i + 18)) // Nov 18..27; 27 is in progress
  const base: BuildInput = {
    loc: { id: 'wp', name: 'Winter Park', kind: 'resort' },
    obs: { name: 'Winter Park', kind: 'resort', station, days: { [nov(20)]: 0, [nov(21)]: 3, [nov(25)]: 1, [nov(27)]: 2 }, last24In: 2, last48In: 2, pending: { d: nov(27), in: 1 } },
    estimate: null, predicted: { [nov(20)]: 1.1, [nov(21)]: 0.5 }, resort: { [nov(20)]: 4, [nov(21)]: 3 },
    old: undefined, dayList, today: nov(27), freezeFrom: nov(24), seasonStart: '2026-10-01', statsFrom: nov(18), forecastAt: 'x',
  }

  it('puts the resort first, sums finished days only and carries the day in progress', () => {
    const l = buildLocation(base)
    expect(l.days.map(d => d.d)).toEqual(dayList.slice(0, -1))
    expect(l.days.find(d => d.d === nov(20))).toEqual({ d: nov(20), a: 4, p: 1.1, s: 'resort', st: 0 })
    expect(l.seasonIn).toBe(8) // 4 + 3 (resort) + 1 (station); today's 2" isn't in it
    expect(l.today).toEqual({ d: nov(27), a: 2, provisional: true })
    expect(l.seasonParts).toEqual({ resortIn: 7, stationIn: 1, resortFrom: nov(20) })
    expect(l.missingDays).toBe(6) // Nov 18, 19, 22, 23, 24 and 26 had no reading
  })

  it('keeps published days before the freeze line, whatever the station says now', () => {
    const first = buildLocation(base)
    const moved = { ...station, id: 'B', name: 'B SNOTEL' }
    const again = buildLocation({ ...base, old: first, obs: { ...base.obs!, station: moved, days: { [nov(21)]: 9, [nov(25)]: 6 } }, resort: {} })
    expect(again.days.find(d => d.d === nov(21))?.a).toBe(3) // frozen
    expect(again.days.find(d => d.d === nov(25))?.a).toBe(6) // recent: recomputed
    expect(again.stationSince).toBe(nov(27))
    expect(again.previousStations).toEqual([{ name: 'A SNOTEL', until: nov(27) }])
  })
})

describe('composeTotals', () => {
  const l: PastLocation = {
    name: 'x', kind: 'resort', station: null, estimate: false, last24In: null, last48In: null, seasonIn: 20,
    days: [day(nov(20), 4, 0), day(nov(21), 3, 0), day(nov(26), 1, 0)], stats: null, today: { d: nov(27), a: 2, provisional: false },
  }
  const live = (since: (t: number) => { inches: number; provisional: boolean } | null) => ({ source: 'snotel', since } as unknown as RecentSnow)
  const now = Date.UTC(2026, 10, 27, 22) // 3pm MST Nov 27

  it('adds the live snow since the last finished day ended, once', () => {
    let asked = 0
    const c = composeTotals(l, live(t => { asked = t; return { inches: 3, provisional: true } }), now)
    expect(asked).toBe(dayEnd(nov(26)))
    expect(c.season).toEqual({ inches: 23, provisional: true })
    expect(c.week).toEqual({ inches: 7, provisional: true }) // Nov 21..26 finished (3 + 1) + 3 live
  })

  it("falls back to the file's own day in progress, and to nothing", () => {
    expect(composeTotals(l, null, now).season).toEqual({ inches: 22, provisional: false })
    expect(composeTotals({ ...l, today: null }, null, now).season).toEqual({ inches: 20, provisional: false })
    expect(composeTotals({ ...l, seasonIn: null, days: [], today: null }, null, now).season).toBeNull()
  })
})

describe('blendPrevious', () => {
  // 24 hours of one model at 0.05"/h and 20°F, stamped at the end of each hour: 7am PST Dec 1
  // (15:00 UTC) through 6am Dec 2, which is the whole Dec 1 observation day.
  const t0 = Date.UTC(2026, 11, 1, 15) / 1000
  const times = Array.from({ length: 24 }, (_, i) => t0 + i * 3600)
  const hourly = {
    time: times,
    precipitation_previous_day1_gem_seamless: times.map(() => 0.05),
    temperature_2m_previous_day1_gem_seamless: times.map(() => 20),
  }

  it('applies the app snow ratio and sums whole observation days (6am to 6am PST)', () => {
    expect(blendPrevious(hourly, null, 39, -106, 10000)).toEqual({ '2026-12-01': 20.4 })
  })

  it('drops partial days rather than under-counting them', () => {
    const half = { ...hourly, time: times.slice(0, 12) }
    expect(blendPrevious(half, null, 39, -106, 10000)).toEqual({})
  })
})

describe('past helpers', () => {
  it('describes bias in plain words', () => {
    expect(biasPhrase(0.1)).toBe('little systematic bias')
    expect(biasPhrase(0.9)).toBe('forecasts ran 0.9" high')
    expect(biasPhrase(-1.25)).toBe('forecasts ran 1.3" low')
  })

  it('explains a station picked to match the resort', () => {
    const st = { type: 'snotel' as const, id: '1344:CO:SNTL', name: 'Alta Lakes SNOTEL', lat: 0, lon: 0, elevFt: 11290, km: 5.3 }
    const l: PastLocation = { name: 'Telluride', kind: 'resort', station: st, estimate: false, last24In: null, last48In: null, seasonIn: null, days: [], stats: null }
    expect(stationNote(l)).toBeNull()
    expect(stationNote({ ...l, station: { ...st, matchedBy: 'resort-reports', replaced: 'Red Mountain Pass SNOTEL', resortCheck: { reportedIn: 6, stationIn: 7, days: 1 } } }))
      .toBe(`Chosen over Red Mountain Pass SNOTEL: since Telluride opened, this station measured 7" to the resort's own 6".`)
  })

  it('labels estimates and stations', () => {
    const base: PastLocation = { name: 'x', kind: 'town', station: null, estimate: true, last24In: null, last48In: null, seasonIn: null, days: [], stats: null }
    expect(stationLabel(base)).toBe('Model estimate (no station nearby)')
    expect(stationLabel({ ...base, estimate: false, station: { type: 'cocorahs', id: 'CO-1', name: 'Denver 1.3 NE', lat: 0, lon: 0, elevFt: 5243, km: 2.1 } }))
      .toBe('Denver 1.3 NE (CoCoRaHS) · 2.1 km · 5,243′')
  })
})
