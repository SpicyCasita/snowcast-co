/**
 * Live short-window snowfall (3–48 h) for the Past tab and the easter egg. The daily
 * past-snowfall.json is only built a few times a day, so these come straight from the source:
 *   - SNOTEL stations: hourly snow depth, snow-water (pillow), precipitation and air temperature from
 *     the NRCS AWDB API (CORS-enabled). New snow is the depth rises that hold, as in
 *     pipeline/recent_obs.py: a rise the water gauges back up counts at 1" within two readings, and a
 *     backed rise still in progress shows straight away, marked provisional ("settling in"). Rises
 *     with no water behind them (sensor flicker, sunny-afternoon blips) still need 1.5" held 4 hours.
 *     Precip gauges alone aren't converted to snow: that tracked resort reports 2-4x too high in
 *     Nov 2026 (rain, melt on warm ground, graupel).
 *   - Everywhere else (CoCoRaHS reports once a day): Open-Meteo's recent hours, converted with the
 *     app's snow-to-liquid ratio, and labelled as an estimate.
 * Windows count back from now, not from the newest reading, and a window the readings no longer
 * cover well (the station stopped reporting) is null rather than 0.
 */
import { FT_PER_M } from './data/locations'
import { snowFraction, snowToLiquidRatio } from './forecast/blend'
import type { PastLocation } from './past'

export const WINDOWS = [3, 6, 12, 24, 48] as const
export type WindowH = (typeof WINDOWS)[number]

export interface Reading { t: number; v: number | null }

/** One station's hourly series (epoch ms). Only depth is required. */
export interface StationSeries { depth: Reading[]; prec?: Reading[]; swe?: Reading[]; temp?: Reading[] }

/** A new-snow amount and whether any of it is a rise still settling in. */
export interface Amount { inches: number; provisional: boolean }

export interface RecentSnow {
  source: 'snotel' | 'estimate'
  /** Inches per window back from `at`; null when the data doesn't cover it. */
  totals: Record<WindowH, number | null>
  /** Windows that include a rise still settling in (shown as ≈). */
  provisional: Record<WindowH, boolean>
  /** Time of the latest reading used, epoch ms. */
  asOf: number | null
  /** When the windows were computed, epoch ms. */
  at: number
  /** New snow after `t` (epoch ms), or null when the readings don't reach back to it. */
  since: (t: number) => Amount | null
}

/** Depth must move this far (in) from the running level to count as new snow or settling... */
export const STEP_IN = 1.5
/** ...and hold there this many hourly readings. Same as pipeline/recent_obs.py. */
export const HOLD_H = 4
/** With water behind it, a rise this size counts after this many readings. */
export const BACKED_STEP_IN = 1.0
export const BACKED_HOLD_H = 2
/** Water behind a rise: the precip gauge or snow pillow gained this much within the lookback... */
export const WATER_STEP_IN = 0.1
export const WATER_LOOKBACK_H = 6
/** ...while the air averaged this cold or colder (no thermometer: water alone will do). */
export const SNOW_MAX_TAVG_F = 34
const EPS = 1e-9
const H = 3600_000

const median3 = (xs: number[], i: number) => {
  const w = xs.slice(Math.max(0, i - 1), i + 2).sort((a, b) => a - b)
  return w.length % 2 ? w[(w.length - 1) / 2] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2
}

/** 3-reading centred median over the readings that exist (gaps skipped), like recent_obs.smooth. */
export function smooth(rs: Reading[] | undefined): { t: number; v: number }[] {
  const ok = (rs ?? []).filter((r): r is { t: number; v: number } => r.v != null).sort((a, b) => a.t - b.t)
  const raw = ok.map(r => r.v)
  return ok.map((r, i) => ({ t: r.t, v: median3(raw, i) }))
}

/** First index with t >= x (or with t > x when `after`). */
function bisect(ts: number[], x: number, after = false): number {
  let lo = 0
  let hi = ts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (after ? ts[mid] <= x : ts[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Which readings (at `times`) have water behind them: over the lookback hours up to the reading,
 * the precipitation gauge or the snow pillow gained a sensor step above its lowest smoothed value,
 * and the air averaged at or below SNOW_MAX_TAVG_F. Mirrors recent_obs.backed_hours.
 */
export function backedHours(times: number[], s: Omit<StationSeries, 'depth'>, lookbackH = WATER_LOOKBACK_H): boolean[] {
  const span = lookbackH * H
  const gain = (rs: Reading[] | undefined) => {
    const m = smooth(rs)
    const mt = m.map(x => x.t)
    return times.map(t => {
      const lo = bisect(mt, t - span)
      const hi = bisect(mt, t, true)
      if (hi <= lo) return 0
      let min = Infinity
      for (let k = lo; k < hi; k++) min = Math.min(min, m[k].v)
      return m[hi - 1].v - min
    })
  }
  const p = gain(s.prec)
  const w = gain(s.swe)
  const temp = (s.temp ?? []).filter((r): r is { t: number; v: number } => r.v != null).sort((a, b) => a.t - b.t)
  const tt = temp.map(x => x.t)
  return times.map((t, k) => {
    if (!(p[k] >= WATER_STEP_IN - EPS || w[k] >= WATER_STEP_IN - EPS)) return false
    const lo = bisect(tt, t - span)
    const hi = bisect(tt, t, true)
    if (hi <= lo) return true
    let sum = 0
    for (let j = lo; j < hi; j++) sum += temp[j].v
    return sum / (hi - lo) <= SNOW_MAX_TAVG_F + EPS
  })
}

export interface Rises {
  /** New snow (in), each credited to the hour its rise began. */
  increments: Reading[]
  /** A backed rise still in progress at the newest reading: shown, but still settling in. */
  pending: { t: number; v: number } | null
  /** Times of the depth readings used. */
  times: number[]
}

/**
 * New snow from a station's hourly series. Mirrors pipeline/recent_obs.py snow_rises: the 3-reading
 * median depth has to rise STEP_IN above a running level and stay there HOLD_H readings (or
 * BACKED_STEP_IN for BACKED_HOLD_H readings with water behind it), and then counts only as far as its
 * lowest point in that stretch. The level follows settling and melt down the same way, so snow that
 * falls and melts later still counts. pipeline/tests/fixtures/snow-rises.json holds cases both must pass.
 */
export function snowRises(s: StationSeries): Rises {
  const med = smooth(s.depth)
  const times = med.map(x => x.t)
  const v = med.map(x => x.v)
  const backed = s.prec || s.swe ? backedHours(times, s) : times.map(() => false)
  const increments: Reading[] = []
  if (!v.length) return { increments, pending: null, times }
  let level = v[0]
  let up: number | null = null
  let down: number | null = null
  for (let i = 1; i < v.length; i++) {
    const [step, hold] = backed[i] ? [BACKED_STEP_IN, BACKED_HOLD_H] : [STEP_IN, HOLD_H]
    if (v[i] >= level + step - EPS) {
      up ??= i
      down = null
      if (i - up + 1 >= hold) {
        const next = Math.min(...v.slice(up, i + 1))
        increments.push({ t: times[up], v: next - level })
        level = next
        up = null
      }
    } else if (v[i] <= level - STEP_IN + EPS) {
      down ??= i
      up = null
      if (i - down + 1 >= HOLD_H) {
        level = Math.max(...v.slice(down, i + 1))
        down = null
      }
    } else {
      up = down = null
    }
  }
  let pending: Rises['pending'] = null
  if (up != null && backed[v.length - 1]) {
    const amount = Math.min(...v.slice(up)) - level
    if (amount >= BACKED_STEP_IN - EPS) pending = { t: times[up], v: amount }
  }
  return { increments, pending, times }
}

/** Snow increments from depth alone (every rise needs STEP_IN held HOLD_H readings). */
export const stormIncrements = (depth: Reading[]): Reading[] => snowRises({ depth }).increments

const round1 = (x: number) => Math.round(x * 10) / 10

/** New snow after `t`, or null when the readings don't reach back that far. */
export function riseSince(r: Rises, t: number): Amount | null {
  if (!r.times.length || r.times[0] > t) return null
  let inches = 0
  for (const x of r.increments) if (x.t > t) inches += x.v!
  const provisional = r.pending != null && r.pending.t > t
  if (provisional) inches += r.pending!.v
  return { inches: round1(inches), provisional }
}

/**
 * New snow per window back from `now`, including a backed rise still in progress. Null where the
 * readings don't reach back to the window's start, or have stopped for more than half the window
 * (a 3-hour window with no reading in 2 hours says nothing).
 */
export function windowTotals(r: Rises, now: number): Pick<RecentSnow, 'totals' | 'provisional'> {
  const totals = {} as RecentSnow['totals']
  const provisional = {} as RecentSnow['provisional']
  const latest = r.times.length ? r.times[r.times.length - 1] : null
  for (const w of WINDOWS) {
    const start = now - w * H
    const a = latest != null && now - latest <= (w * H) / 2 ? riseSince(r, start) : null
    totals[w] = a ? a.inches : null
    provisional[w] = a?.provisional ?? false
  }
  return { totals, provisional }
}

/** AWDB reports every station in Pacific Standard Time (as pipeline/fetch_snotel.py assumes). */
const pst = (d: Date) => new Date(d.getTime() - 8 * H).toISOString().slice(0, 13).replace('T', ' ') + ':00'
const VALID: Record<string, [number, number]> = { SNWD: [0, 400], WTEQ: [0, 200], PREC: [0, 300], TOBS: [-60, 100] }

async function snotelSeries(triplet: string, now: Date): Promise<StationSeries | null> {
  const params = new URLSearchParams({
    stationTriplets: triplet, elements: 'SNWD,WTEQ,PREC,TOBS', duration: 'HOURLY',
    beginDate: pst(new Date(now.getTime() - 60 * H)), endDate: pst(new Date(now.getTime() + 24 * H)), periodRef: 'START',
  })
  const res = await fetch(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?${params}`)
  if (!res.ok) return null
  type El = { stationElement?: { elementCode?: string }; values?: { date: string; value: number | null }[] }
  const json = (await res.json()) as { data?: El[] }[]
  const out: Record<string, Reading[]> = {}
  for (const el of json[0]?.data ?? []) {
    const code = el.stationElement?.elementCode ?? 'SNWD'
    const [lo, hi] = VALID[code] ?? [-Infinity, Infinity]
    out[code] = (el.values ?? []).map(v => ({ t: Date.parse(v.date.replace(' ', 'T') + ':00-08:00'), v: v.value != null && v.value >= lo && v.value <= hi ? v.value : null }))
  }
  return out.SNWD ? { depth: out.SNWD, prec: out.PREC, swe: out.WTEQ, temp: out.TOBS } : null
}

/** Snow per window from Open-Meteo's recent hours (model analysis), summed back from now. */
async function estimateTotals(lat: number, lon: number, elevFt: number, now: number): Promise<RecentSnow | null> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), elevation: (elevFt / FT_PER_M).toFixed(0),
    hourly: 'precipitation,temperature_2m', past_hours: '48', forecast_hours: '1',
    timezone: 'GMT', timeformat: 'unixtime', precipitation_unit: 'inch', temperature_unit: 'fahrenheit',
  })
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`)
  if (!res.ok) return null
  const h = (await res.json()).hourly as { time: number[]; precipitation: (number | null)[]; temperature_2m: (number | null)[] }
  // Each value is the hour ending at its time.
  const hourly = h.time.map((t, i) => {
    const p = h.precipitation[i]
    const temp = h.temperature_2m[i]
    return { t: t * 1000, s: p == null || temp == null ? 0 : p * snowFraction(temp) * snowToLiquidRatio(temp) }
  }).filter(x => x.t <= now)
  const since = (t: number): Amount | null =>
    hourly.length && hourly[0].t - H <= t ? { inches: round1(hourly.filter(x => x.t > t).reduce((s, x) => s + x.s, 0)), provisional: false } : null
  const totals = {} as RecentSnow['totals']
  const provisional = {} as RecentSnow['provisional']
  for (const w of WINDOWS) {
    totals[w] = since(now - w * H)?.inches ?? null
    provisional[w] = false
  }
  return { source: 'estimate', totals, provisional, asOf: hourly.length ? hourly[hourly.length - 1].t : null, at: now, since }
}

/** Live numbers are refetched after this long, failures sooner. */
export const RECENT_TTL_MS = 10 * 60_000
const FAILED_TTL_MS = 60_000
const cache = new Map<string, { at: number; promise: Promise<RecentSnow | null> }>()

/** Live recent snowfall for a past-snowfall location (cached for RECENT_TTL_MS). */
export function getRecent(id: string, loc: PastLocation, fallback: { lat: number; lon: number; elevFt: number }): Promise<RecentSnow | null> {
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < RECENT_TTL_MS) return hit.promise
  const st = loc.station
  const now = Date.now()
  const promise = (async (): Promise<RecentSnow | null> => {
    if (st?.type === 'snotel') {
      const series = await snotelSeries(st.id, new Date(now)).catch(() => null)
      const rises = series ? snowRises(series) : null
      if (rises?.times.length) {
        return { source: 'snotel', ...windowTotals(rises, now), asOf: rises.times[rises.times.length - 1], at: now, since: t => riseSince(rises, t) }
      }
    }
    return estimateTotals(st?.lat ?? fallback.lat, st?.lon ?? fallback.lon, st?.elevFt ?? fallback.elevFt, now).catch(() => null)
  })()
  cache.set(id, { at: now, promise })
  promise.then(r => { if (!r) cache.set(id, { at: now - RECENT_TTL_MS + FAILED_TTL_MS, promise }) })
  return promise
}
