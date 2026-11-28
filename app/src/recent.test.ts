import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { backedHours, riseSince, snowRises, windowTotals, type Reading, type StationSeries } from './recent'

const H = 3600_000

interface GoldenCase { name: string; depth: (number | null)[]; prec?: (number | null)[] | null; swe?: (number | null)[] | null; temp?: (number | null)[] | null; increments: [number, number][]; pending: [number, number] | null }
const golden = JSON.parse(readFileSync(new URL('../../pipeline/tests/fixtures/snow-rises.json', import.meta.url), 'utf8')) as { start: string; cases: GoldenCase[] }
const t0 = Date.parse(golden.start.replace(' ', 'T') + ':00-08:00')
const series = (vals: (number | null)[] | null | undefined): Reading[] | undefined => vals?.map((v, i) => ({ t: t0 + i * H, v }))

describe('snow rises match the pipeline', () => {
  // pipeline/tests/test_recent_obs.py runs the same cases, so live windows and the daily file agree.
  for (const c of golden.cases) {
    it(c.name, () => {
      const r = snowRises({ depth: series(c.depth)!, prec: series(c.prec), swe: series(c.swe), temp: series(c.temp) })
      const round2 = (x: number) => Math.round(x * 100) / 100
      expect(r.increments.filter(x => x.v !== 0).map(x => [(x.t - t0) / H, round2(x.v!)])).toEqual(c.increments)
      expect(r.pending ? [(r.pending.t - t0) / H, round2(r.pending.v)] : null).toEqual(c.pending)
    })
  }
})

describe('live windows', () => {
  const at = (h: number) => t0 + h * H
  // 1"/h for the last 3 hours, precip gauge ticking, 26°F: the old rule showed 0 in every window.
  const storm: StationSeries = {
    depth: series([...Array(27).fill(10), 11, 12, 13])!,
    prec: series([...Array(27).fill(2.0), 2.1, 2.2, 2.3])!,
    temp: series(Array(30).fill(26))!,
  }

  it('shows snow that is still falling, marked as settling in', () => {
    const r = snowRises(storm)
    const w = windowTotals(r, at(29))
    expect(w.totals[3]).toBeGreaterThanOrEqual(2)
    expect(w.provisional[3]).toBe(true)
    expect(w.totals[24]).toBe(w.totals[3])
  })

  it('counts back from now, and goes blank when the station stops reporting', () => {
    const r = snowRises(storm)
    expect(windowTotals(r, at(29)).totals[6]).not.toBeNull()
    // Newest reading 3.5 hours old: the 3- and 6-hour windows can't say anything.
    const stale = windowTotals(r, at(32.5))
    expect(stale.totals[3]).toBeNull()
    expect(stale.totals[6]).toBeNull()
    expect(stale.totals[12]).toBe(windowTotals(r, at(29)).totals[12])
  })

  it('needs readings back to the start of a window', () => {
    const r = snowRises({ depth: series([5, 5, 5])! })
    expect(windowTotals(r, at(2)).totals).toEqual({ 3: null, 6: null, 12: null, 24: null, 48: null })
    expect(windowTotals(snowRises({ depth: [] }), at(2)).totals[3]).toBeNull()
  })

  it('gives new snow since a time, for adding today to the daily totals', () => {
    const r = snowRises(storm)
    expect(riseSince(r, at(-1))).toBeNull() // before the first reading
    expect(riseSince(r, at(0))?.inches).toBe(windowTotals(r, at(29)).totals[12])
    expect(riseSince(r, at(29))).toEqual({ inches: 0, provisional: false })
  })
})

describe('water behind a rise', () => {
  it('needs the gauge to gain a step while it is cold', () => {
    const times = Array.from({ length: 8 }, (_, i) => t0 + i * H)
    const prec = series([2.0, 2.0, 2.0, 2.1, 2.1, 2.1, 2.1, 2.1])
    expect(backedHours(times, { prec, temp: series(Array(8).fill(28)) })).toEqual([false, false, false, true, true, true, true, true])
    expect(backedHours(times, { prec, temp: series(Array(8).fill(39)) }).some(Boolean)).toBe(false)
    expect(backedHours([t0 + 12 * H], { prec, temp: series(Array(8).fill(28)) })).toEqual([false])
  })
})
