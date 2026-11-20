/**
 * Seth's Weather Report: a Colorado forecaster's snow calls from his Facebook posts, collected by
 * pipeline/fetch_seth.py into data/seth-forecasts.json. A call is a low–high total over some days for
 * a set of locations. It joins the blend as one more member, with the weight the pipeline learned
 * from how his past calls verified against station snow.
 */
import { localDate, type BlendedForecast, type Range } from './forecast/blend'
import { LOCATIONS } from './data/locations'

export interface SethCall {
  locations: string[]
  /** Inclusive local dates, YYYY-MM-DD. */
  start: string
  end: string
  lowIn: number
  highIn: number
}

export interface SethPost {
  id: string
  url: string
  published: string
  summary: string
  calls: SethCall[]
}

export interface SethSkill {
  /** Location-calls scored so far. */
  n: number
  sethMaeIn: number | null
  oursMaeIn: number | null
  /** Seth's share when combined with our blend, 0–1. */
  weight: number
  prior: number
}

export interface SethData {
  version: number
  generated: string
  source: string
  pageUrl: string
  skill: SethSkill
  posts: SethPost[]
}

/** One applied call, for display. Totals cover only the days still ahead. */
export interface SethApplied {
  post: SethPost
  call: SethCall
  /** Seth's range scaled to the days still ahead. */
  sethLowIn: number
  sethHighIn: number
  /** Our models-only total over those days, and the total after adding Seth. */
  modelsIn: number
  blendedIn: number
  /** Seth's share in the combination, 0–1. */
  weight: number
}

let pending: Promise<SethData | null> | null = null

export function loadSeth(): Promise<SethData | null> {
  pending ??= fetch(`${import.meta.env.BASE_URL}data/seth-forecasts.json`)
    .then(r => (r.ok ? r.json() : null))
    .then(j => (j?.version === 1 && Array.isArray(j.posts) ? (j as SethData) : null))
    .catch(() => null)
  return pending
}

const KM_PER_DEG = 111.2
/** A map point counts as a location if it's this close. Seth talks about places, not grid points. */
export const NEAR_KM = 15

export function nearestLocationId(lat: number, lon: number): string | null {
  let best: string | null = null
  let bestKm = NEAR_KM
  for (const l of LOCATIONS) {
    const km = Math.hypot((l.lat - lat) * KM_PER_DEG, (l.lon - lon) * KM_PER_DEG * Math.cos((lat * Math.PI) / 180))
    if (km <= bestKm) { best = l.id; bestKm = km }
  }
  return best
}

/**
 * Calls for `locId` that still have days ahead, from the newest post that mentions it:
 * a newer post about a storm replaces his earlier numbers for it.
 */
export function activeCalls(data: SethData, locId: string, today: string): { post: SethPost; call: SethCall }[] {
  const posts = [...data.posts].sort((a, b) => b.published.localeCompare(a.published))
  for (const post of posts) {
    const calls = post.calls.filter(c => c.locations.includes(locId) && c.end >= today)
    if (calls.length) return calls.map(call => ({ post, call }))
  }
  return []
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1

const scaleRange = (r: Range, f: number): Range => ({ ...r, expected: r.expected * f, low: r.low * f, high: r.high * f })

/**
 * Fold Seth's calls into the forecast. Over each call's remaining days, the total becomes
 * (1 − w) × models + w × Seth's midpoint, and the hourly series and daily bars are rescaled to match,
 * so every total in the app reflects it. Ensemble chances and confidence are left as computed.
 */
export function applySeth(forecast: BlendedForecast, calls: { post: SethPost; call: SethCall }[], weight: number): BlendedForecast {
  if (!calls.length || weight <= 0) return forecast
  const w = Math.min(1, weight)
  const hourly = [...forecast.hourlySnowIn]
  const days = forecast.days.map(d => ({ ...d }))
  const hourDates = forecast.times.map(localDate)
  const done = new Set<string>()
  const applied: SethApplied[] = []

  for (const { post, call } of calls) {
    const ahead = days.filter(d => d.date >= call.start && d.date <= call.end && !done.has(d.date))
    if (!ahead.length) continue
    const frac = ahead.length / daysBetween(call.start, call.end)
    const sethLow = call.lowIn * frac
    const sethHigh = call.highIn * frac
    const models = ahead.reduce((s, d) => s + d.snow.expected, 0)
    const target = (1 - w) * models + (w * (sethLow + sethHigh)) / 2
    const dates = new Set(ahead.map(d => d.date))
    const hours = hourDates.flatMap((d, i) => (dates.has(d) && i >= forecast.nowIndex ? [i] : []))

    if (models >= 0.1) {
      const f = target / models
      for (const d of ahead) d.snow = scaleRange(d.snow, f)
      for (const i of hours) hourly[i] *= f
    } else if (hours.length) {
      // The models are dry but Seth isn't: spread his share evenly.
      const perDay = target / ahead.length
      for (const d of ahead) d.snow = { ...d.snow, expected: d.snow.expected + perDay, high: Math.max(d.snow.high, d.snow.expected + perDay) }
      for (const i of hours) hourly[i] += target / hours.length
    }
    for (const d of dates) done.add(d)
    applied.push({ post, call, sethLowIn: sethLow, sethHighIn: sethHigh, modelsIn: models, blendedIn: target, weight: w })
  }
  if (!applied.length) return forecast

  const window = (r: Range, h: number): Range => {
    const b = Math.min(hourly.length, forecast.nowIndex + h)
    let before = 0
    let after = 0
    for (let i = forecast.nowIndex; i < b; i++) { before += forecast.hourlySnowIn[i]; after += hourly[i] }
    if (Math.abs(after - before) < 1e-9) return r
    if (before >= 0.05) return scaleRange(r, after / before)
    return { ...r, expected: after, high: Math.max(r.high, after) }
  }

  return {
    ...forecast,
    hourlySnowIn: hourly,
    days,
    next24: window(forecast.next24, 24),
    next48: window(forecast.next48, 48),
    next72: window(forecast.next72, 72),
    next7d: window(forecast.next7d, 168),
    calibration: `${forecast.calibration} · Seth's Weather Report at ${Math.round(w * 100)}%`,
    seth: applied,
  }
}
