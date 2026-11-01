/**
 * Log today's live forecast so it can be verified once the days have passed (pipeline/verify.py).
 *
 *   npx tsx scripts/log-forecasts.ts [--stations ../pipeline/data/log-stations.json] [--limit N]
 *
 * For every location in src/data/locations.ts and every SNOTEL (or CoCoRaHS) station within
 * --radius-km of one, it runs the same fetch + blend the app does, with the SNOTEL-tuned weights from
 * public/data/weights.json, and appends one JSON line per point to public/data/forecast-log-YYYY-MM.jsonl:
 *
 *   w     next 24/48/72 h snow (in): expected, low, high and any confidence / chance fields on the Range
 *   d     per observation day (a PST day for SNOTEL; CoCoRaHS days start at the station's
 *         reading hour, dayStartH) for lead days 1-3: blended SWE (tuned and default weights),
 *         each model's raw QPF, and blended snow; stations only
 *
 * Run it near 00:00 PST (08:00 UTC) so the 24 h window lines up with the SNOTEL day.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blend, defaultWeight, type BiasFn, type Range, type WeightFn } from '../src/forecast/blend'
import { alignNwsSnow, fetchNwsSnow } from '../src/forecast/nws'
import { fetchOpenMeteo } from '../src/forecast/openMeteo'
import { skillModel, type SkillWeights } from '../src/forecast/skill'
import type { RawForecast } from '../src/forecast/types'
import { LOCATIONS } from '../src/data/locations'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOG_VERSION = 1
const LEAD_DAYS = 3
const PST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Etc/GMT+8', year: 'numeric', month: '2-digit', day: '2-digit' })

interface Point {
  id: string
  src: 'location' | 'snotel' | 'cocorahs'
  site?: string
  name: string
  lat: number
  lon: number
  ft: number
  /** Hour (PST) the station's observation day starts: 0 for SNOTEL, ~6 for CoCoRaHS. */
  dayStartH: number
}

interface Station { source?: string; site: string; name?: string; lat: number; lon: number; elevFt: number; dayStartH?: number }

function args() {
  const a = process.argv.slice(2)
  const get = (k: string, d: string) => {
    const i = a.indexOf(`--${k}`)
    return i >= 0 && a[i + 1] ? a[i + 1] : d
  }
  return {
    stations: resolve(APP, get('stations', '../pipeline/data/log-stations.json')),
    weights: resolve(APP, get('weights', 'public/data/weights.json')),
    outDir: resolve(APP, get('out-dir', 'public/data')),
    radiusKm: Number(get('radius-km', '20')),
    limit: Number(get('limit', '0')),
    concurrency: Number(get('concurrency', '3')),
    // Open-Meteo rate-limits per minute and an ensemble call counts many times over; without pacing
    // the later points silently lose their ensemble (and with it confidence and chances).
    paceMs: Number(get('pace-ms', '2500')),
  }
}

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(h))
}

function points(stationsPath: string, radiusKm: number): Point[] {
  const out: Point[] = LOCATIONS.map(l => ({
    id: `loc:${l.id}`,
    src: 'location',
    name: l.name,
    lat: l.lat,
    lon: l.lon,
    // The location view opens at mid-mountain for resorts.
    ft: Math.round((l.baseFt + l.summitFt) / 2),
    dayStartH: 0,
  }))
  if (!existsSync(stationsPath)) {
    console.warn(`no station list at ${stationsPath}; logging locations only (run: python verify.py --export-stations)`)
    return out
  }
  const stations = JSON.parse(readFileSync(stationsPath, 'utf8')) as Station[]
  for (const s of stations) {
    if (!LOCATIONS.some(l => km(l, s) <= radiusKm)) continue
    const src = s.source === 'cocorahs' ? 'cocorahs' : 'snotel'
    out.push({ id: `${src}:${s.site}`, src, site: s.site, name: s.name ?? s.site, lat: s.lat, lon: s.lon, ft: Math.round(s.elevFt), dayStartH: s.dayStartH ?? 0 })
  }
  return out
}

const r2 = (x: number) => Math.round(x * 100) / 100

/** Round every number in a Range (and nested chance/bucket) to 0.01; keeps fields added later. */
function compact(v: unknown): unknown {
  if (typeof v === 'number') return r2(v)
  if (Array.isArray(v)) return v.map(compact)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x)]))
  return v
}

/** The same forecast cut to `hours` past now, so blend's 72 h window becomes a shorter one. */
function truncate(raw: RawForecast, hours: number): RawForecast {
  const end = raw.nowIndex + hours
  return {
    ...raw,
    times: raw.times.slice(0, end),
    models: raw.models.map(m => ({
      ...m,
      precipIn: m.precipIn.slice(0, end),
      tempF: m.tempF.slice(0, end),
      rawSnowIn: m.rawSnowIn.slice(0, end),
      freezingLevelFt: m.freezingLevelFt.slice(0, end),
      windMph: m.windMph?.slice(0, end),
      gustMph: m.gustMph?.slice(0, end),
    })),
    ensemble: raw.ensemble?.map(e => ({ ...e, precipIn: e.precipIn.slice(0, end), tempF: e.tempF.slice(0, end) })) ?? null,
  }
}

/** Hour index → observation day. Open-Meteo precip at time t fell in the hour before t. */
const obsDay = (t: number, dayStartH: number) => PST.format(new Date((t - 3600 - dayStartH * 3600) * 1000))

/** Per PST day: blended liquid (in) with given weights/bias, and each model's raw QPF. */
function dailySwe(raw: RawForecast, hourlySnowIn: number[], weight: WeightFn, bias: BiasFn, defaultW: WeightFn, dayStartH: number) {
  const { times, nowIndex } = raw
  const today = obsDay(times[nowIndex], dayStartH)
  const days = new Map<string, number[]>()
  times.forEach((t, i) => {
    const d = obsDay(t, dayStartH)
    if (d < today) return
    if (!days.has(d)) days.set(d, [])
    days.get(d)!.push(i)
  })
  const blendHour = (i: number, w: WeightFn, b: BiasFn) => {
    let num = 0
    let den = 0
    for (const m of raw.models) {
      const p = m.precipIn[i]
      const wt = w(m.model, i - nowIndex)
      if (p == null || wt <= 0) continue
      num += wt * b(m.model, i - nowIndex) * p
      den += wt
    }
    return den > 0 ? num / den : null
  }
  const out = []
  let lead = 0
  for (const [date, idx] of days) {
    const ahead = idx.filter(i => i >= nowIndex)
    // A day mostly gone by run time isn't a forecast; lead 1 is the first day mostly ahead.
    if (ahead.length < 12) continue
    if (++lead > LEAD_DAYS) break
    if (idx.length < 20) continue
    const sum = (f: (i: number) => number | null) => {
      const vs = ahead.map(f).filter((v): v is number => v != null)
      return vs.length >= ahead.length * 0.9 && vs.length ? r2(vs.reduce((s, v) => s + v, 0)) : null
    }
    const models: Record<string, number | null> = {}
    for (const m of raw.models) if (m.model !== 'nws') models[m.model] = sum(i => m.precipIn[i])
    out.push({
      date,
      lead,
      // Share of the PST day still ahead when the forecast was made; verify.py skips partial days.
      cov: r2(ahead.length / 24),
      swe: { tuned: sum(i => blendHour(i, weight, bias)), default: sum(i => blendHour(i, defaultW, () => 1)), m: models },
      snow: r2(ahead.reduce((s, i) => s + (hourlySnowIn[i] ?? 0), 0)),
    })
  }
  return out
}

// The ensemble is optional: older checkouts don't have it, and it may fail on its own.
type EnsembleMod = typeof import('../src/forecast/ensemble')
const ensembleMod: EnsembleMod | null = await import('../src/forecast/ensemble').catch(() => null)

async function logPoint(p: Point, weights: SkillWeights | null) {
  const [raw, nws, ens] = await Promise.all([
    fetchOpenMeteo(p.lat, p.lon, p.ft),
    fetchNwsSnow(p.lat, p.lon),
    ensembleMod ? ensembleMod.fetchEnsemble(p.lat, p.lon, p.ft).catch(() => null) : null,
  ])
  if (nws) raw.models.push({ model: 'nws', ...alignNwsSnow(nws, raw.times) })
  if (ens && ensembleMod) raw.ensemble = ensembleMod.parseEnsemble(ens.hourly, ens.times, raw.times)
  const tuned = weights ? skillModel(weights, p.lat, p.lon, p.ft) : null
  const opts = tuned ?? {}
  const f = blend(raw, opts)
  const f48 = blend(truncate(raw, 48), opts)
  const w: Record<string, Range> = { 24: f.next24, 48: f48.next72, 72: f.next72 }
  return {
    v: LOG_VERSION,
    run: new Date().toISOString().slice(0, 16) + 'Z',
    id: p.id,
    src: p.src,
    ...(p.site ? { site: p.site } : {}),
    name: p.name,
    lat: p.lat,
    lon: p.lon,
    ft: p.ft,
    start: raw.times[raw.nowIndex],
    ...(p.dayStartH ? { dayStartH: p.dayStartH } : {}),
    tuned: !!tuned && !f.calibration.startsWith('Default'),
    w: compact(w),
    ...(p.src !== 'location' ? { d: dailySwe(raw, f.hourlySnowIn, tuned?.weight ?? defaultWeight, tuned?.bias ?? (() => 1), defaultWeight, p.dayStartH) } : {}),
  }
}

async function main() {
  const opt = args()
  // api.weather.gov rejects requests without a User-Agent naming the caller.
  const nativeFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes('api.weather.gov')) return nativeFetch(input, init)
    const headers = new Headers(init?.headers)
    headers.set('User-Agent', '(SnowCast CO forecast verification, https://github.com/SpicyCasita/snowcast-co)')
    return nativeFetch(input, { ...init, headers })
  }

  let weights: SkillWeights | null = null
  try {
    const j = JSON.parse(readFileSync(opt.weights, 'utf8'))
    if (j?.version === 1 && j.weights) weights = j
  } catch {
    console.warn(`no usable weights at ${opt.weights}; logging the default blend`)
  }

  let pts = points(opt.stations, opt.radiusKm)
  if (opt.limit > 0) pts = pts.slice(0, opt.limit)
  const lines: string[] = []
  let failed = 0
  let next = 0
  let gate = Date.now()
  await Promise.all(Array.from({ length: Math.max(1, opt.concurrency) }, async () => {
    while (next < pts.length) {
      const p = pts[next++]
      const at = gate
      gate = Math.max(Date.now(), gate) + opt.paceMs
      if (at > Date.now()) await new Promise(r => setTimeout(r, at - Date.now()))
      try {
        lines.push(JSON.stringify(await logPoint(p, weights)))
      } catch (e) {
        failed++
        console.warn(`${p.id}: ${(e as Error).message}`)
      }
    }
  }))
  if (!lines.length) throw new Error('every point failed')
  mkdirSync(opt.outDir, { recursive: true })
  const file = resolve(opt.outDir, `forecast-log-${new Date().toISOString().slice(0, 7)}.jsonl`)
  appendFileSync(file, lines.sort().join('\n') + '\n')
  const withEns = lines.filter(l => l.includes('"ensembleSize"')).length
  console.log(`logged ${lines.length} points (${failed} failed, ${withEns} with ensemble) to ${file}`)
}

await main()
