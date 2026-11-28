/**
 * Build public/data/past-snowfall.json: observed snowfall at each app location next to what we
 * predicted the day before, so the Past tab can show error in predicted vs actual.
 *
 *   npx tsx scripts/past-snowfall.ts [--obs ../pipeline/out/recent-obs.json]
 *
 * - Actual: a resort's own morning report on days it posted one, from its opening day (resort-reports.json),
 *   else pipeline/recent_obs.py's station (SNOTEL depth rises / CoCoRaHS new snow). Each day records its
 *   source (`s`), and resort days keep the station's number (`st`). A location with no station gets a
 *   model-analysis estimate instead, flagged `estimate: true`, counted only up to now.
 * - Days older than FREEZE_DAYS are kept as published, so a station change, a data correction or a
 *   resort report dropping out of resort-reports.json's window never rewrites the season. A file built
 *   with another ACTUAL_VERSION is rebuilt from scratch instead.
 * - `days` holds finished days only; the day in progress is `today`, and `seasonIn` sums finished days,
 *   so the app can add its live readings without counting an hour twice.
 * - Predicted: rebuilt from Open-Meteo's archive of day-before model runs (`previous_day1`), blended
 *   exactly as the app does at a 24-hour lead (same snow-to-liquid ratio, same SNOTEL-tuned bias and
 *   weights): at a resort's mid-mountain, which its own report and the app's forecast describe, and
 *   elsewhere at the station's own point and elevation.
 * - Error stats are storm by storm (each storm's total with a day either side), so a storm two
 *   sources date a day apart isn't scored as two misses.
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
import type { DaySource, PastDay, PastLocation, PastSnowfall, PastStats, Station } from '../src/past'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(APP, 'public/data/past-snowfall.json')
const RESORT_REPORTS = resolve(APP, 'public/data/resort-reports.json')
const HISTORY_DAYS = 60
/** Measured days older than this are kept from the published file. */
const FREEZE_DAYS = 3
/**
 * How `a` is computed. 2: resort reports first; SNOTEL rises backed by the precip gauge count at 1";
 * the depth machine starts on a fixed date. A published file from another version is rebuilt.
 */
export const ACTUAL_VERSION = 2
const REFRESH_DAYS = 4
const STATS_DAYS = 30
/** A day counts toward error stats if either actual or predicted reached this (inches). */
const SNOW_DAY_IN = 1
const LEAD_H = 24
const PACE_MS = 1500
const VERSION = 1
/** Hour (PST) each observation day starts, as in pipeline/recent_obs.py DAY_START_H. */
const DAY_START_H = 6

interface ObsLocation {
  name: string; kind: string; station: Station | null; days: Record<string, number>; last24In: number | null; last48In: number | null
  asOf?: string | null
  /** A backed rise still settling in, and the day it began. */
  pending?: { d: string; in: number } | null
}
interface ResortReportsDoc { resorts: Record<string, { days?: Record<string, number | null>; openingDate?: string | null }> }
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

/** Model-analysis snowfall per observation day, for locations without a nearby station; hours after `nowSec` (forecast) never count. */
export function estimateDays(hourly: Hourly, nowSec = Date.now() / 1000): Record<string, number> {
  const times = hourly.time as number[]
  const days: Record<string, number> = {}
  times.forEach((t, i) => {
    if (t > nowSec) return
    const s = snowFrom(hourly.precipitation?.[i] ?? null, hourly.temperature_2m?.[i] ?? null)
    if (s == null) return
    days[obsDay(t)] = (days[obsDay(t)] ?? 0) + s
  })
  return Object.fromEntries(Object.entries(days).map(([d, v]) => [d, round1(v)]))
}

/**
 * Storms over `days` (sorted ISO dates): days where any series had SNOW_DAY_IN+, merged when at most
 * one day apart and padded a day each side, limited to `days`. Mirrors pipeline/recent_obs.storm_spans.
 */
export function stormSpans(days: string[], ...series: Record<string, number | null | undefined>[]): string[][] {
  const have = new Set(days)
  const DAY = 86_400_000
  const ms = (d: string) => Date.parse(`${d}T00:00:00Z`)
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
  const groups: [number, number][] = []
  for (const d of days) {
    if (!series.some(s => (s[d] ?? 0) >= SNOW_DAY_IN)) continue
    const t = ms(d)
    const last = groups[groups.length - 1]
    if (last && (t - last[1]) / DAY <= 2) last[1] = t
    else groups.push([t, t])
  }
  return groups.map(([lo, hi]) => {
    const span: string[] = []
    for (let t = lo - DAY; t <= hi + DAY; t += DAY) if (have.has(iso(t))) span.push(iso(t))
    return span
  })
}

/**
 * Error of predicted vs actual, storm by storm, over measured days from `sinceDay`: each storm's total
 * with a day either side, so a storm the forecast and the measurement date a day apart counts once.
 */
export function errorStats(days: PastDay[], sinceDay: string): PastStats | null {
  const scored = days.filter(x => x.d >= sinceDay && x.a != null && x.p != null && x.s !== 'estimate')
  const A = Object.fromEntries(scored.map(x => [x.d, x.a!]))
  const P = Object.fromEntries(scored.map(x => [x.d, x.p!]))
  const storms = stormSpans(scored.map(x => x.d), A, P)
  if (!storms.length) return null
  const sum = (m: Record<string, number>, span: string[]) => span.reduce((s, d) => s + m[d], 0)
  const err = storms.map(span => sum(P, span) - sum(A, span))
  const snowed = storms.filter(span => sum(A, span) >= SNOW_DAY_IN)
  return {
    n: storms.length,
    maeIn: round1(err.reduce((s, e) => s + Math.abs(e), 0) / err.length),
    biasIn: round1(err.reduce((s, e) => s + e, 0) / err.length),
    // Of storms that actually brought 1"+, how often we forecast 1"+ for them too.
    hitRate: snowed.length ? Math.round((snowed.filter(span => sum(P, span) >= SNOW_DAY_IN).length / snowed.length) * 100) / 100 : null,
    per: 'storm',
  }
}

/**
 * First day a resort's reports count as measurements: its opening day, or its first reported 1"+ if
 * that came earlier. Many resorts measure before they open; others post zeros until they do while the
 * snow falls, and those zeros aren't measurements. Mirrors pipeline/recent_obs.py measured_from.
 */
export function measuredFrom(r: { days?: Record<string, number | null>; openingDate?: string | null }): string | null {
  const first = Object.entries(r.days ?? {}).filter(([, v]) => v != null && v >= 1).map(([d]) => d).sort()[0]
  return [r.openingDate, first].filter((x): x is string => !!x).sort()[0] ?? null
}

/** Resort days that count as measured (from measuredFrom on). */
export function resortDays(doc: ResortReportsDoc | null, id: string): Record<string, number> {
  const r = doc?.resorts?.[id]
  const from = r ? measuredFrom(r) : null
  if (!r?.days || !from) return {}
  return Object.fromEntries(Object.entries(r.days).filter((e): e is [string, number] => e[1] != null && e[0] >= from))
}

/** One finished day: the resort's report where there is one, else the station (or estimate). */
export function measuredDay(d: string, p: number | null, station: number | null, source: DaySource, resort: Record<string, number>): PastDay {
  if (resort[d] != null) return { d, a: resort[d], p, s: 'resort', st: station }
  return { d, a: station, p, s: source }
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

export interface BuildInput {
  loc: { id: string; name: string; kind: string }
  /** recent_obs.py's entry: station, its days (the day in progress included), last 24/48 h. */
  obs: ObsLocation | undefined
  /** Model-analysis days, for a location without a station. */
  estimate: Record<string, number> | null
  predicted: Record<string, number>
  /** The resort's own reports that count as measured (resortDays). */
  resort: Record<string, number>
  /** The location in the published file, when it was built with the same ACTUAL_VERSION. */
  old: PastLocation | undefined
  /** The last HISTORY_DAYS observation days, oldest first; `today` is the one in progress. */
  dayList: string[]
  today: string
  /** Measured days before this are kept from `old`. */
  freezeFrom: string
  seasonStart: string
  statsFrom: string
  forecastAt: string
}

/** One location's entry in past-snowfall.json. */
export function buildLocation(i: BuildInput): PastLocation & { forecastAt: string } {
  const st = i.obs?.station ?? null
  const station = st ? i.obs!.days : i.estimate ?? {}
  const source: DaySource = st ? st.type : 'estimate'
  const frozen = new Map((i.old?.days ?? []).filter(x => x.d < i.freezeFrom && x.a != null).map(x => [x.d, x]))
  const days: PastDay[] = i.dayList.filter(d => d < i.today).map(d => {
    const p = i.predicted[d] ?? null
    const keep = frozen.get(d)
    return keep ? { ...keep, p } : measuredDay(d, p, station[d] ?? null, source, i.resort)
  })
  const season = days.filter(x => x.d >= i.seasonStart)
  const measured = season.filter(x => x.a != null)
  const resortDays = measured.filter(x => x.s === 'resort')
  const prevSt = i.old?.station
  const moved = !!(i.old && prevSt && st && prevSt.id !== st.id)
  return {
    name: i.loc.name,
    kind: i.loc.kind,
    station: st,
    estimate: !st,
    last24In: i.obs?.last24In ?? null,
    last48In: i.obs?.last48In ?? null,
    seasonIn: measured.length ? round1(measured.reduce((s, x) => s + x.a!, 0)) : null,
    days,
    stats: errorStats(days, i.statsFrom),
    missingDays: st ? season.length - measured.length : 0,
    // CoCoRaHS reports once a morning, so it has nothing for the day in progress.
    today: st?.type === 'cocorahs' ? null : { d: i.today, a: station[i.today] ?? null, provisional: i.obs?.pending?.d === i.today },
    asOf: i.obs?.asOf ?? null,
    ...(resortDays.length ? {
      seasonParts: {
        resortIn: round1(resortDays.reduce((s, x) => s + x.a!, 0)),
        stationIn: round1(measured.filter(x => x.s !== 'resort').reduce((s, x) => s + x.a!, 0)),
        resortFrom: resortDays[0].d,
      },
    } : {}),
    stationSince: moved ? i.today : i.old?.stationSince ?? null,
    previousStations: moved ? [...(i.old!.previousStations ?? []), { name: prevSt!.name, until: i.today }].slice(-3) : i.old?.previousStations ?? [],
    forecastAt: i.forecastAt,
  }
}

async function main() {
  const obs: RecentObs = JSON.parse(readFileSync(resolve(APP, arg('--obs', '../pipeline/out/recent-obs.json')), 'utf8'))
  const weightsPath = resolve(APP, 'public/data/weights.json')
  const weights: SkillWeights | null = existsSync(weightsPath) ? JSON.parse(readFileSync(weightsPath, 'utf8')) : null
  const reports: ResortReportsDoc | null = existsSync(RESORT_REPORTS) ? JSON.parse(readFileSync(RESORT_REPORTS, 'utf8')) : null
  const old: PastSnowfall | null = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
  // Predictions kept from a file with other day boundaries would be for different windows.
  const prev = old?.dayStartH === DAY_START_H ? old : null
  // Measured days are kept only from a file that computed them the same way.
  const prevActual = prev?.actualVersion === ACTUAL_VERSION ? prev : null
  if (prev && !prevActual) console.log(`published file is actualVersion ${prev.actualVersion ?? 1}: rebuilding every measured day`)

  const nowSec = Date.now() / 1000
  const today = obsDay(nowSec)
  const dayList = Array.from({ length: HISTORY_DAYS }, (_, i) => obsDay(nowSec - (HISTORY_DAYS - i) * 86400))
  const refreshFrom = dayList[dayList.length - REFRESH_DAYS]
  const statsFrom = dayList[dayList.length - STATS_DAYS]
  const freezeFrom = dayList[dayList.length - FREEZE_DAYS]

  const out: Record<string, PastLocation> = {}
  for (const loc of LOCATIONS) {
    const o = obs.locations[loc.id]
    const st = o?.station ?? null
    const mid = Math.round((loc.baseFt + loc.summitFt) / 2)
    // A resort's forecast is scored where its report and the app's forecast are: mid-mountain.
    const point = loc.kind === 'resort' ? { lat: loc.lat, lon: loc.lon, elevFt: mid } : { lat: st?.lat ?? loc.lat, lon: st?.lon ?? loc.lon, elevFt: st?.elevFt ?? mid }
    const forecastAt = `${point.lat},${point.lon},${point.elevFt}`

    // Reuse settled predictions; re-download only recent days (or everything the first time).
    const before = prev?.locations[loc.id] as (PastLocation & { forecastAt?: string }) | undefined
    const samePoint = before && (before.forecastAt ?? (before.station ? `${before.station.lat},${before.station.lon},${before.station.elevFt}` : 'none')) === forecastAt
    const kept: Record<string, number> = {}
    if (samePoint) for (const x of before.days) if (x.p != null && x.d < refreshFrom) kept[x.d] = x.p
    const pastDays = Object.keys(kept).length ? REFRESH_DAYS + 1 : HISTORY_DAYS + 1
    const ph = await getHourly(previousRunsUrl(point.lat, point.lon, point.elevFt, pastDays))
    const predicted = { ...kept, ...(ph ? blendPrevious(ph, weights, point.lat, point.lon, point.elevFt) : {}) }

    let estimate: Record<string, number> | null = null
    if (!st) {
      const eh = await getHourly(estimateUrl(point.lat, point.lon, point.elevFt, HISTORY_DAYS + 1))
      estimate = eh ? estimateDays(eh, nowSec) : {}
    }

    const entry = buildLocation({
      loc, obs: o, estimate, predicted, resort: loc.kind === 'resort' ? resortDays(reports, loc.id) : {},
      old: prevActual?.locations[loc.id], dayList, today, freezeFrom, seasonStart: obs.seasonStart, statsFrom, forecastAt,
    })
    out[loc.id] = entry
    const src = entry.seasonParts ? `resort reports from ${entry.seasonParts.resortFrom} + ${st?.name}` : st ? st.name : 'estimate'
    console.log(`${loc.id}: ${src} · season ${entry.seasonIn ?? '–'}" · ${entry.days.filter(x => x.a != null).length} measured, ${entry.days.filter(x => x.p != null).length} predicted days`)
    await sleep(PACE_MS)
  }

  const doc: PastSnowfall = {
    version: VERSION, generated: new Date().toISOString().slice(0, 19) + 'Z', obsGenerated: obs.generated, seasonStart: obs.seasonStart,
    dayStartH: DAY_START_H, actualVersion: ACTUAL_VERSION, freezeDays: FREEZE_DAYS, locations: out,
  }
  writeFileSync(OUT, JSON.stringify(doc))
  console.log(`wrote ${OUT} (${Math.round(JSON.stringify(doc).length / 1024)} KB)`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(e => { console.error(e); process.exit(1) })
