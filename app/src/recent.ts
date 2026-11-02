/**
 * Live short-window snowfall (3–48 h) for the Past tab and the easter egg. The daily
 * past-snowfall.json is only refreshed at 5am, so these come straight from the source:
 *   - SNOTEL stations: hourly snow depth from the NRCS AWDB API (CORS-enabled).
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

/** Fewer hours of smoothing for short windows so a 3-hour total can still move. */
const smoothingFor = (hours: number) => (hours <= 3 ? 1 : hours <= 6 ? 2 : 3)

/**
 * New snow over the last `hours` from hourly depth: median of the latest readings minus the median
 * of readings `hours` earlier, clipped at 0 (settling isn't negative snowfall). Mirrors
 * pipeline/recent_obs.py depth_gain.
 */
export function depthGain(readings: Reading[], hours: number): number | null {
  const ok = readings.filter((r): r is { t: number; v: number } => r.v != null).sort((a, b) => a.t - b.t)
  if (!ok.length) return null
  const smooth = smoothingFor(hours)
  const end = ok[ok.length - 1].t
  const H = 3600_000
  const median = (xs: number[]) => {
    const s = xs.slice().sort((a, b) => a - b)
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  }
  const now = ok.filter(r => r.t > end - smooth * H).map(r => r.v)
  const before = ok.filter(r => r.t > end - (hours + smooth) * H && r.t <= end - hours * H).map(r => r.v)
  if (!before.length) return null
  return Math.round(Math.max(0, median(now) - median(before)) * 10) / 10
}

/** Gains below this in windows up to 12 h are within the depth sensor's ±1" jitter. */
export const NOISE_FLOOR_IN = 1.5

/**
 * Make per-window totals physically consistent: short-window gains under the noise floor count as 0,
 * and a longer window never reports less than a shorter one it contains.
 */
export function cleanWindows(raw: RecentSnow['totals']): RecentSnow['totals'] {
  const out = {} as RecentSnow['totals']
  let floor = 0
  for (const w of WINDOWS) {
    let v = raw[w]
    if (v != null && w <= 12 && v < NOISE_FLOOR_IN) v = 0
    if (v != null) floor = Math.max(floor, v)
    out[w] = v == null ? null : floor
  }
  return out
}

async function snotelReadings(triplet: string): Promise<Reading[] | null> {
  // AWDB reports every station in Pacific Standard Time (as pipeline/fetch_snotel.py assumes).
  const fmt = (d: Date) => new Date(d.getTime() - 8 * 3600_000).toISOString().slice(0, 13).replace('T', ' ') + ':00'
  const end = new Date()
  const begin = new Date(end.getTime() - 60 * 3600_000)
  const params = new URLSearchParams({ stationTriplets: triplet, elements: 'SNWD', duration: 'HOURLY', beginDate: fmt(begin), endDate: fmt(new Date(end.getTime() + 24 * 3600_000)), periodRef: 'START' })
  const res = await fetch(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?${params}`)
  if (!res.ok) return null
  const json = (await res.json()) as { data?: { values?: { date: string; value: number | null }[] }[] }[]
  const values = json[0]?.data?.[0]?.values ?? []
  return values.map(v => ({ t: Date.parse(v.date.replace(' ', 'T') + ':00-08:00'), v: v.value != null && v.value >= 0 && v.value < 400 ? v.value : null }))
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
        const r = await snotelReadings(st.id).catch(() => null)
        if (r?.some(x => x.v != null)) {
          const raw = {} as RecentSnow['totals']
          for (const w of WINDOWS) raw[w] = depthGain(r, w)
          const totals = cleanWindows(raw)
          const last = r.filter(x => x.v != null).at(-1)
          return { source: 'snotel' as const, totals, asOf: last?.t ?? null }
        }
      }
      return estimateTotals(st?.lat ?? fallback.lat, st?.lon ?? fallback.lon, st?.elevFt ?? fallback.elevFt).catch(() => null)
    })()
    cache.set(id, p)
  }
  return cache.get(id)!
}
