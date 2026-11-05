/**
 * Build public/data/past-snowfall.json: observed snowfall at each app location next to what we
 * predicted the day before, so the Past tab can show error in predicted vs actual.
 *
 *   npx tsx scripts/past-snowfall.ts [--obs ../pipeline/out/recent-obs.json]
 *
 * - Actual: from pipeline/recent_obs.py (nearest SNOTEL / CoCoRaHS station). A location with no
 *   station gets a model-analysis estimate instead, flagged `estimate: true`.
 * - Predicted: rebuilt from Open-Meteo's archive of day-before model runs (`previous_day1`) at the
 *   station's own point and elevation, blended exactly as the app does at a 24-hour lead (same
 *   snow-to-liquid ratio, same SNOTEL-tuned bias and weights). So the comparison is like for like.
 * - Days run 6am to 6am PST (7am MST), dated by the day they start: the window resort snow reports
 *   and CoCoRaHS observers use, and how pipeline/recent_obs.py dates SNOTEL.
 * - Predictions for days older than REFRESH_DAYS are kept from the previous file, so daily runs
 *   only download a few days per location.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { snowFraction, snowToLiquidRatio } from '../src/forecast/blend'
import { OPEN_METEO_MODELS } from '../src/forecast/openMeteo'
import { skillModel, type SkillWeights } from '../src/forecast/skill'
import { FT_PER_M, LOCATIONS } from '../src/data/locations'
import type { ModelId } from '../src/forecast/types'
import type { PastDay, PastLocation, PastSnowfall, PastStats, Station } from '../src/past'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(APP, 'public/data/past-snowfall.json')
const HISTORY_DAYS = 60
const REFRESH_DAYS = 4
const STATS_DAYS = 30
/** A day counts toward error stats if either actual or predicted reached this (inches). */
const SNOW_DAY_IN = 1
const LEAD_H = 24
const PACE_MS = 1500
const VERSION = 1
/** Hour (PST) each observation day starts, as in pipeline/recent_obs.py DAY_START_H. */
const DAY_START_H = 6

interface ObsLocation { name: string; kind: string; station: Station | null; days: Record<string, number>; last24In: number | null; last48In: number | null }
interface RecentObs { generated: string; seasonStart: string; locations: Record<string, ObsLocation> }

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Observation day of an hourly value stamped at the end of its hour: 6am PST belongs to the day before. */
const obsDay = (unixSec: number) => new Date((unixSec - (8 + DAY_START_H) * 3600 - 1) * 1000).toISOString().slice(0, 10)
const round1 = (x: number) => Math.round(x * 10) / 10

type Hourly = Record<string, (number | null)[]>

/** An Open-Meteo response's `hourly` block, or null after retries / at the daily limit. */
async function getHourly(url: string): Promise<Hourly | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url)
      if (res.ok) return ((await res.json()) as { hourly?: Hourly }).hourly ?? null
      if (res.status === 429 && /daily|hourly/i.test(await res.text())) return null
    } catch { /* retry */ }
    await sleep(5000 * (attempt + 1))
  }
  return null
}

/** Hourly snow from QPF + temperature with the app's snow fraction and SLR, times a bias factor. */
const snowFrom = (p: number | null, t: number | null, bias = 1) =>
  p == null || t == null ? null : p * bias * snowFraction(t) * snowToLiquidRatio(t)

/** Day-before blended forecast per observation day, rebuilt from archived `previous_day1` runs. */
export function blendPrevious(hourly: Hourly, weights: SkillWeights | null, lat: number, lon: number, elevFt: number): Record<string, number> {
  const skill = weights ? skillModel(weights, lat, lon, elevFt) : null
  const weight = (m: ModelId) => skill ? skill.weight(m, LEAD_H) : 1
  const bias = (m: ModelId) => skill ? skill.bias(m, LEAD_H) : 1
  const times = hourly.time as number[]
  const days: Record<string, { sum: number; hours: number }> = {}
  times.forEach((t, i) => {
    let num = 0
    let den = 0
    for (const m of OPEN_METEO_MODELS) {
      const w = weight(m)
      const s = snowFrom(hourly[`precipitation_previous_day1_${m}`]?.[i] ?? null, hourly[`temperature_2m_previous_day1_${m}`]?.[i] ?? null, bias(m))
      if (s == null || w <= 0) continue
      num += w * s
      den += w
    }
    if (den === 0) return
    const d = obsDay(t)
    days[d] ??= { sum: 0, hours: 0 }
    days[d].sum += num / den
    days[d].hours++
  })
  // Only complete days: a partial day would look like an under-forecast.
  return Object.fromEntries(Object.entries(days).filter(([, v]) => v.hours >= 22).map(([d, v]) => [d, round1(v.sum)]))
}

/** Model-analysis snowfall per observation day, for locations without a nearby station. */
function estimateDays(hourly: Hourly): Record<string, number> {
  const times = hourly.time as number[]
  const days: Record<string, number> = {}
  times.forEach((t, i) => {
    const s = snowFrom(hourly.precipitation?.[i] ?? null, hourly.temperature_2m?.[i] ?? null)
    if (s == null) return
    days[obsDay(t)] = (days[obsDay(t)] ?? 0) + s
  })
  return Object.fromEntries(Object.entries(days).map(([d, v]) => [d, round1(v)]))
}

/** Error of predicted vs actual over recent snow days (either side ≥ SNOW_DAY_IN). */
export function errorStats(days: PastDay[], sinceDay: string): PastStats | null {
  const scored = days.filter(x => x.d >= sinceDay && x.a != null && x.p != null && (x.a >= SNOW_DAY_IN || x.p >= SNOW_DAY_IN))
  if (!scored.length) return null
  const err = scored.map(x => x.p! - x.a!)
  const hits = scored.filter(x => x.a! >= SNOW_DAY_IN)
  return {
    n: scored.length,
    maeIn: round1(err.reduce((s, e) => s + Math.abs(e), 0) / err.length),
    biasIn: round1(err.reduce((s, e) => s + e, 0) / err.length),
    // Of days that actually snowed ≥1", how often we predicted ≥1" too.
    hitRate: hits.length ? Math.round((hits.filter(x => x.p! >= SNOW_DAY_IN).length / hits.length) * 100) / 100 : null,
  }
}

const previousRunsUrl = (lat: number, lon: number, elevFt: number, pastDays: number) =>
  'https://previous-runs-api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), elevation: (elevFt / FT_PER_M).toFixed(0),
    hourly: 'precipitation_previous_day1,temperature_2m_previous_day1',
    models: OPEN_METEO_MODELS.join(','), past_days: String(pastDays), forecast_days: '1',
    timezone: 'GMT', timeformat: 'unixtime', precipitation_unit: 'inch', temperature_unit: 'fahrenheit',
  })

const estimateUrl = (lat: number, lon: number, elevFt: number, pastDays: number) =>
  'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), elevation: (elevFt / FT_PER_M).toFixed(0),
    hourly: 'precipitation,temperature_2m', past_days: String(pastDays), forecast_days: '1',
    timezone: 'GMT', timeformat: 'unixtime', precipitation_unit: 'inch', temperature_unit: 'fahrenheit',
  })

async function main() {
  const obs: RecentObs = JSON.parse(readFileSync(resolve(APP, arg('--obs', '../pipeline/out/recent-obs.json')), 'utf8'))
  const weightsPath = resolve(APP, 'public/data/weights.json')
  const weights: SkillWeights | null = existsSync(weightsPath) ? JSON.parse(readFileSync(weightsPath, 'utf8')) : null
  const old: PastSnowfall | null = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
  // Predictions kept from a file with other day boundaries would be for different windows.
  const prev = old?.dayStartH === DAY_START_H ? old : null

  const today = obsDay(Date.now() / 1000)
  const dayList = Array.from({ length: HISTORY_DAYS }, (_, i) => obsDay(Date.now() / 1000 - (HISTORY_DAYS - i) * 86400))
  const refreshFrom = dayList[dayList.length - REFRESH_DAYS]
  const statsFrom = dayList[dayList.length - STATS_DAYS]

  const out: Record<string, PastLocation> = {}
  for (const loc of LOCATIONS) {
    const o = obs.locations[loc.id]
    const st = o?.station ?? null
    const lat = st?.lat ?? loc.lat
    const lon = st?.lon ?? loc.lon
    const elevFt = st?.elevFt ?? Math.round((loc.baseFt + loc.summitFt) / 2)

    // Reuse settled predictions; re-download only recent days (or everything the first time).
    const old = prev?.locations[loc.id]
    // Predictions depend only on the forecast point; a station's resort-check stats change daily.
    const pointKey = (s: Station | null) => (s ? `${s.lat},${s.lon},${s.elevFt}` : 'none')
    const samePoint = old && pointKey(old.station) === pointKey(st)
    const kept: Record<string, number> = {}
    if (samePoint) for (const x of old.days) if (x.p != null && x.d < refreshFrom) kept[x.d] = x.p
    const pastDays = Object.keys(kept).length ? REFRESH_DAYS + 1 : HISTORY_DAYS + 1
    const ph = await getHourly(previousRunsUrl(lat, lon, elevFt, pastDays))
    const predicted = { ...kept, ...(ph ? blendPrevious(ph, weights, lat, lon, elevFt) : {}) }

    let actual = o?.days ?? {}
    if (!st) {
      const eh = await getHourly(estimateUrl(lat, lon, elevFt, HISTORY_DAYS + 1))
      actual = eh ? estimateDays(eh) : {}
    }

    const days: PastDay[] = dayList.filter(d => d < today).map(d => ({ d, a: actual[d] ?? null, p: predicted[d] ?? null }))
    const season = Object.entries(actual).filter(([d]) => d >= obs.seasonStart)
    out[loc.id] = {
      name: loc.name,
      kind: loc.kind,
      station: st,
      estimate: !st,
      last24In: o?.last24In ?? null,
      last48In: o?.last48In ?? null,
      seasonIn: season.length ? round1(season.reduce((s, [, v]) => s + v, 0)) : null,
      days,
      stats: errorStats(days, statsFrom),
    }
    console.log(`${loc.id}: ${st ? st.name : 'estimate'} · ${days.filter(x => x.a != null).length} actual, ${days.filter(x => x.p != null).length} predicted days`)
    await sleep(PACE_MS)
  }

  const doc: PastSnowfall = { version: VERSION, generated: new Date().toISOString().slice(0, 19) + 'Z', obsGenerated: obs.generated, seasonStart: obs.seasonStart, dayStartH: DAY_START_H, locations: out }
  writeFileSync(OUT, JSON.stringify(doc))
  console.log(`wrote ${OUT} (${Math.round(JSON.stringify(doc).length / 1024)} KB)`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(e => { console.error(e); process.exit(1) })
