/**
 * Live short-window snowfall (3–48 h) for the Past tab and the easter egg. The daily
 * past-snowfall.json is only refreshed at 5am, so these come straight from the source:
 *   - SNOTEL stations: hourly snow depth from the NRCS AWDB API (CORS-enabled); new snow is the rises
 *     that hold, as in pipeline/recent_obs.py (precip gauges read 2-4x resort reports, so aren't used).
 *   - Everywhere else (CoCoRaHS reports once a day): Open-Meteo's recent hours, converted with the
 *     app's snow-to-liquid ratio, and labelled as an estimate.
 */
import { FT_PER_M } from './data/locations'
import { snowFraction, snowToLiquidRatio } from './forecast/blend'
import type { PastLocation } from './past'

export const WINDOWS = [3, 6, 12, 24, 48] as const
export type WindowH = (typeof WINDOWS)[number]

export interface RecentSnow {
  source: 'snotel' | 'estimate'
  /** Inches per window; null when the data doesn't cover it. */
  totals: Record<WindowH, number | null>
  /** Time of the latest reading used, epoch ms. */
  asOf: number | null
}

export interface Reading { t: number; v: number | null }

/** Depth must move this far (in) from the running level to count as new snow or settling... */
export const STEP_IN = 1.5
/** ...and hold there this many hourly readings. Same as pipeline/recent_obs.py. */
export const HOLD_H = 4

const median3 = (xs: number[], i: number) => {
  const w = xs.slice(Math.max(0, i - 1), i + 2).sort((a, b) => a - b)
  return w.length % 2 ? w[(w.length - 1) / 2] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2
}

/**
 * New snow (in) from hourly snow depth, one entry per rise, timed when the sensor confirmed it.
 * Mirrors pipeline/recent_obs.py storm_increments: 3-hour medians must move STEP_IN from a running
 * level and stay there HOLD_H readings, which ignores the sensors' flicker and their afternoon blips
 * over bare ground; the level follows settling and melt down the same way, so snow that falls and
 * melts later still counts. The pipeline dates a rise from when it began, for daily totals; live
 * windows use when it was confirmed, or a 3-hour window could never show anything.
 */
export function stormIncrements(depth: Reading[], step = STEP_IN, hold = HOLD_H): Reading[] {
  const ok = depth.filter((r): r is { t: number; v: number } => r.v != null).sort((a, b) => a.t - b.t)
  const raw = ok.map(r => r.v)
  const med = raw.map((_, i) => median3(raw, i))
  const out: Reading[] = []
  if (!med.length) return out
  let level = med[0]
  let up: number | null = null
  let down: number | null = null
  for (let i = 1; i < med.length; i++) {
    if (med[i] >= level + step) {
      up ??= i
      down = null
      if (i - up + 1 >= hold) {
        const next = Math.min(...med.slice(up, i + 1))
        out.push({ t: ok[i].t, v: next - level })
        level = next
        up = null
      }
    } else if (med[i] <= level - step) {
      down ??= i
      up = null
      if (i - down + 1 >= hold) {
        level = Math.max(...med.slice(down, i + 1))
        down = null
      }
    } else {
      up = down = null
    }
  }
  return out
}

/**
 * New snow per window back from the latest reading: the rises confirmed in it, so windows trail a
 * storm by about HOLD_H - 1 hours. Null where the readings don't reach back that far.
 */
export function windowTotals(depth: Reading[]): RecentSnow['totals'] {
  const times = depth.filter(r => r.v != null).map(r => r.t)
  const incs = stormIncrements(depth)
  const totals = {} as RecentSnow['totals']
  for (const w of WINDOWS) {
    const start = times.length ? Math.max(...times) - w * 3600_000 : NaN
    totals[w] = !times.length || Math.min(...times) > start ? null
      : Math.round(incs.filter(r => r.t > start).reduce((sum, r) => sum + r.v!, 0) * 10) / 10
  }
  return totals
}

async function snotelDepth(triplet: string): Promise<Reading[] | null> {
  // AWDB reports every station in Pacific Standard Time (as pipeline/fetch_snotel.py assumes).
  const fmt = (d: Date) => new Date(d.getTime() - 8 * 3600_000).toISOString().slice(0, 13).replace('T', ' ') + ':00'
  const end = new Date()
  const begin = new Date(end.getTime() - 60 * 3600_000)
  const params = new URLSearchParams({ stationTriplets: triplet, elements: 'SNWD', duration: 'HOURLY', beginDate: fmt(begin), endDate: fmt(new Date(end.getTime() + 24 * 3600_000)), periodRef: 'START' })
  const res = await fetch(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?${params}`)
  if (!res.ok) return null
  const json = (await res.json()) as { data?: { values?: { date: string; value: number | null }[] }[] }[]
  return (json[0]?.data?.[0]?.values ?? []).map(v => ({ t: Date.parse(v.date.replace(' ', 'T') + ':00-08:00'), v: v.value != null && v.value >= 0 && v.value <= 400 ? v.value : null }))
}

/** Snow per window from Open-Meteo's recent hours (model analysis), summed back from now. */
async function estimateTotals(lat: number, lon: number, elevFt: number): Promise<RecentSnow | null> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), elevation: (elevFt / FT_PER_M).toFixed(0),
    hourly: 'precipitation,temperature_2m', past_hours: '48', forecast_hours: '1',
    timezone: 'GMT', timeformat: 'unixtime', precipitation_unit: 'inch', temperature_unit: 'fahrenheit',
  })
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`)
  if (!res.ok) return null
  const h = (await res.json()).hourly as { time: number[]; precipitation: (number | null)[]; temperature_2m: (number | null)[] }
  const nowSec = Date.now() / 1000
  const hourly = h.time.map((t, i) => {
    const p = h.precipitation[i]
    const temp = h.temperature_2m[i]
    return { t, s: p == null || temp == null ? 0 : p * snowFraction(temp) * snowToLiquidRatio(temp) }
  }).filter(x => x.t <= nowSec)
  const totals = {} as RecentSnow['totals']
  for (const w of WINDOWS) {
    const win = hourly.filter(x => x.t > nowSec - w * 3600)
    totals[w] = win.length ? Math.round(win.reduce((s, x) => s + x.s, 0) * 10) / 10 : null
  }
  return { source: 'estimate', totals, asOf: hourly.length ? hourly[hourly.length - 1].t * 1000 : null }
}

const cache = new Map<string, Promise<RecentSnow | null>>()

/** Live recent snowfall for a past-snowfall location (cached for the session). */
export function getRecent(id: string, loc: PastLocation, fallback: { lat: number; lon: number; elevFt: number }): Promise<RecentSnow | null> {
  if (!cache.has(id)) {
    const st = loc.station
    const p = (async () => {
      if (st?.type === 'snotel') {
        const depth = await snotelDepth(st.id).catch(() => null)
        const times = (depth ?? []).filter(x => x.v != null).map(x => x.t)
        if (depth && times.length) return { source: 'snotel' as const, totals: windowTotals(depth), asOf: Math.max(...times) }
      }
      return estimateTotals(st?.lat ?? fallback.lat, st?.lon ?? fallback.lon, st?.elevFt ?? fallback.elevFt).catch(() => null)
    })()
    cache.set(id, p)
  }
  return cache.get(id)!
}
