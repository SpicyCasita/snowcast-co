import type { EnsembleSeries, ModelId, ModelSeries, RawForecast } from './types'

/** Calendar days of daily summaries returned (today + 9). */
export const MAX_DAYS = 10

/** Snow amounts (inches) whose chance of being reached is reported. */
export const CHANCE_THRESHOLDS = [1, 3, 6, 12] as const

/** Buckets for the headline confidence: the chance the total lands in the same bucket as the forecast. */
export const BUCKETS: [number, number | null][] = [[0, 1], [1, 3], [3, 6], [6, 12], [12, null]]

export interface Range {
  expected: number
  low: number
  high: number
  /** Ensemble-based extras; absent when the ensemble couldn't be loaded. */
  confidence?: number
  bucket?: [number, number | null]
  /** Chance (0–1) of at least N inches, keyed by threshold. */
  chance?: Record<number, number>
  ensembleSize?: number
}

export interface DaySummary {
  /** Local Colorado date, YYYY-MM-DD. */
  date: string
  snow: Range
  perModel: Partial<Record<ModelId, number | null>>
  /** Lowest snow level (ft) during hours with precip, or null if dry. */
  snowLevelFt: number | null
  hiF: number | null
  loF: number | null
  maxWindMph: number | null
  maxGustMph: number | null
}

export interface BlendedForecast {
  times: number[]
  nowIndex: number
  elevationFt: number
  members: ModelId[]
  hourlySnowIn: number[]
  hourlyTempF: (number | null)[]
  hourlyWindMph: (number | null)[]
  hourlyGustMph: (number | null)[]
  days: DaySummary[]
  next24: Range
  /** Used by LOOP's "snow is coming" banner (via the alerts worker). */
  next48: Range
  next72: Range
  next7d: Range
  /** Where the weights came from, for display. */
  calibration: string
}

/** Returns the relative weight of `model` at `leadH` hours ahead (0 = exclude). */
export type WeightFn = (model: ModelId, leadH: number) => number

/** Returns the multiplicative QPF correction for `model` at `leadH` hours ahead. */
export type BiasFn = (model: ModelId, leadH: number) => number

export interface BlendOptions {
  weight?: WeightFn
  bias?: BiasFn
  calibration?: string
}

/**
 * Default skill weights from published CONUS verification: convection-allowing models (HRRR, NAM 3km)
 * lead the first two days, ECMWF leads after that. weights.json from the SNOTEL pipeline refines these.
 */
export const defaultWeight: WeightFn = (model, leadH) => {
  const h = Math.max(0, leadH)
  switch (model) {
    case 'ncep_hrrr_conus': return h <= 18 ? 3 : h <= 48 ? 2 : 0
    case 'ncep_nam_conus': return h <= 36 ? 1.5 : h <= 60 ? 1 : 0
    case 'ecmwf_ifs025': return h <= 72 ? 2 : 2.5
    // Open-Meteo's GFS "seamless" is HRRR over CONUS for the first day; counting it would double HRRR.
    case 'gfs_seamless': return h <= 24 ? 0 : 1.2
    case 'gem_seamless': return 1
    case 'icon_seamless': return 1
    case 'nws': return h <= 168 ? 1.5 : 0
  }
}

const lerpTable = (table: [number, number][], x: number): number => {
  if (x >= table[0][0]) return table[0][1]
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i]
    if (x >= x1) {
      const [x0, y0] = table[i - 1]
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)
    }
  }
  return table[table.length - 1][1]
}

/** Fraction of precip falling as snow at a surface temperature (°F). */
export const snowFraction = (tempF: number): number => Math.min(1, Math.max(0, (37 - tempF) / 5))

/**
 * Snow-to-liquid ratio by surface temperature (°F). Colorado's dry continental snowpack runs well above
 * the 10:1 rule of thumb, peaking in the dendritic-growth range around 10–15°F. Open-Meteo's own
 * snowfall field uses a fixed ratio, which badly undercounts cold mountain storms.
 */
export const snowToLiquidRatio = (tempF: number): number =>
  lerpTable([[34, 8], [30, 11], [25, 14], [20, 17], [15, 19], [10, 20], [0, 18], [-10, 16]], tempF)

/** Weighted quantile with linear interpolation between member midpoints. */
export function weightedQuantile(values: number[], weights: number[], q: number): number {
  const pairs = values.map((v, i) => [v, weights[i]] as const).filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0])
  if (pairs.length === 0) return 0
  if (pairs.length === 1) return pairs[0][0]
  const total = pairs.reduce((s, [, w]) => s + w, 0)
  let cum = 0
  const mids = pairs.map(([v, w]) => {
    const mid = (cum + w / 2) / total
    cum += w
    return [mid, v] as const
  })
  if (q <= mids[0][0]) return mids[0][1]
  for (let i = 1; i < mids.length; i++) {
    if (q <= mids[i][0]) {
      const [q0, v0] = mids[i - 1]
      const [q1, v1] = mids[i]
      return v0 + ((q - q0) / (q1 - q0)) * (v1 - v0)
    }
  }
  return mids[mids.length - 1][1]
}

/** Running total of an hourly series. */
export function cumulative(xs: number[]): number[] {
  let s = 0
  return xs.map(x => (s += x))
}

export const bucketOf = (x: number): [number, number | null] =>
  BUCKETS.find(([lo, hi]) => x >= lo && (hi == null || x < hi)) ?? BUCKETS[BUCKETS.length - 1]

/**
 * Spread, chance of each amount and confidence from ensemble member totals for one window.
 * The deterministic blend sets the amount (`expected`); the ensemble supplies the shape of the
 * uncertainty, re-centred so its median sits on `expected`.
 */
export function ensembleStats(expected: number, totals: number[]): Required<Pick<Range, 'low' | 'high' | 'confidence' | 'bucket' | 'chance' | 'ensembleSize'>> {
  const sorted = totals.slice().sort((x, y) => x - y)
  const ones = sorted.map(() => 1)
  const median = weightedQuantile(sorted, ones, 0.5)
  // Scale when the ensemble has a real signal; otherwise shift (scaling ~0 would explode).
  const adjusted = median >= 0.1
    ? sorted.map(v => v * (expected / median))
    : sorted.map(v => Math.max(0, v + expected - median))
  const low = Math.min(expected, weightedQuantile(adjusted, ones, 0.1))
  const high = Math.max(expected, weightedQuantile(adjusted, ones, 0.9))
  const share = (pred: (v: number) => boolean) => adjusted.filter(pred).length / adjusted.length
  const chance: Record<number, number> = {}
  for (const t of CHANCE_THRESHOLDS) chance[t] = share(v => v >= t)
  const bucket = bucketOf(expected)
  const [lo, hi] = bucket
  return { low: Math.max(0, low), high, confidence: share(v => v >= lo && (hi == null || v < hi)), bucket, chance, ensembleSize: adjusted.length }
}

const denverDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' })
export const localDate = (unixSec: number) => denverDate.format(new Date(unixSec * 1000))

/**
 * Hourly snow (inches) per model, computed from bias-corrected QPF × snow fraction × SLR rather than
 * each model's fixed-ratio snowfall. NWS is already a snowfall forecast and is used as is.
 */
export function memberSnow(raw: RawForecast, bias: BiasFn = () => 1): Map<ModelId, (number | null)[]> {
  const out = new Map<ModelId, (number | null)[]>()
  for (const m of raw.models) {
    if (m.model === 'nws') {
      out.set(m.model, m.rawSnowIn)
      continue
    }
    out.set(m.model, toSnow(m, raw.nowIndex, bias))
  }
  return out
}

function toSnow(s: Pick<ModelSeries, 'precipIn' | 'tempF'>, nowIndex: number, bias: BiasFn, model?: ModelId): (number | null)[] {
  const id = model ?? (s as ModelSeries).model
  return s.precipIn.map((p, i) => {
    const t = s.tempF[i]
    if (p == null || t == null) return null
    return p * bias(id, i - nowIndex) * snowFraction(t) * snowToLiquidRatio(t)
  })
}

/** Hourly snow per ensemble member, with the bias of its parent deterministic model. */
export function ensembleSnow(members: EnsembleSeries[], nowIndex: number, bias: BiasFn = () => 1): (number | null)[][] {
  return members.map(m => toSnow(m, nowIndex, bias, m.family))
}

export function blend(raw: RawForecast, { weight = defaultWeight, bias, calibration = 'Default weights' }: BlendOptions = {}): BlendedForecast {
  const { times, nowIndex } = raw
  const snow = memberSnow(raw, bias)
  const members = [...snow.keys()]
  const leadH = (i: number) => i - nowIndex

  const hourlySnowIn = times.map((_, i) => {
    let num = 0
    let den = 0
    for (const [model, series] of snow) {
      const v = series[i]
      const w = weight(model, leadH(i))
      if (v == null || w <= 0) continue
      num += w * v
      den += w
    }
    return den > 0 ? num / den : 0
  })

  /** Skill-weighted hourly average of a weather field across the deterministic models. */
  const weighted = (field: (m: ModelSeries) => (number | null)[] | undefined) => times.map((_, i) => {
    let num = 0
    let den = 0
    for (const m of raw.models) {
      const v = field(m)?.[i]
      const w = weight(m.model, leadH(i))
      if (v == null || w <= 0) continue
      num += w * v
      den += w
    }
    return den > 0 ? num / den : null
  })
  const hourlyTempF = weighted(m => m.tempF)
  const hourlyWindMph = weighted(m => m.windMph)
  const hourlyGustMph = weighted(m => m.gustMph)

  const ens = raw.ensemble?.length ? ensembleSnow(raw.ensemble, nowIndex, bias) : null

  /** Expected total plus a spread: from the ensemble when available, else from the models' totals. */
  const windowRange = (a: number, b: number): Range => {
    const expected = sum(hourlySnowIn, a, b)
    if (ens) {
      // Only members that cover the whole window, so short-range gaps don't bias totals low.
      const totals: number[] = []
      for (const series of ens) {
        let total = 0
        let ok = true
        for (let i = a; i < b && ok; i++) {
          const v = series[i]
          if (v == null) ok = false
          else total += v
        }
        if (ok) totals.push(total)
      }
      if (totals.length >= 10) return { expected, ...ensembleStats(expected, totals) }
    }
    const vals: number[] = []
    const ws: number[] = []
    for (const [model, series] of snow) {
      let total = 0
      let wSum = 0
      let covered = 0
      for (let i = a; i < b; i++) {
        const w = weight(model, leadH(i))
        const v = series[i]
        if (v != null && w > 0) {
          total += v
          wSum += w
          covered++
        } else {
          total += hourlySnowIn[i]
        }
      }
      if (covered === 0) continue
      vals.push(total)
      ws.push(wSum / covered)
    }
    // Six-ish members understate true uncertainty, so widen the band with lead time.
    const leadDays = Math.max(0, (a + b) / 2 - nowIndex) / 24
    const u = 0.2 + 0.05 * leadDays
    const low = Math.max(0, Math.min(weightedQuantile(vals, ws, 0.1), expected * (1 - u)))
    const high = Math.max(weightedQuantile(vals, ws, 0.9), expected * (1 + u))
    return { expected, low, high }
  }

  const dayIdx = new Map<string, number[]>()
  times.forEach((t, i) => {
    const d = localDate(t)
    if (!dayIdx.has(d)) dayIdx.set(d, [])
    dayIdx.get(d)!.push(i)
  })
  const today = localDate(times[nowIndex])
  const days: DaySummary[] = []
  for (const [date, idx] of dayIdx) {
    if (date < today || idx.length < 12) continue
    const a = idx[0]
    const b = idx[idx.length - 1] + 1
    const perModel: DaySummary['perModel'] = {}
    for (const [model, series] of snow) {
      const vs = series.slice(a, b)
      const n = vs.filter(v => v != null).length
      perModel[model] = n >= vs.length / 2 ? vs.reduce<number>((s, v) => s + (v ?? 0), 0) : null
    }
    let snowLevelFt: number | null = null
    for (const i of idx) {
      for (const m of raw.models) {
        const fl = m.freezingLevelFt[i]
        const p = m.precipIn[i]
        if (fl == null || p == null || p < 0.005) continue
        // Snow typically reaches ~1000 ft below the freezing level.
        const sl = Math.max(0, fl - 1000)
        snowLevelFt = snowLevelFt == null ? sl : Math.min(snowLevelFt, sl)
      }
    }
    const pick = (xs: (number | null)[]) => idx.map(i => xs[i]).filter((t): t is number => t != null)
    const temps = pick(hourlyTempF)
    const winds = pick(hourlyWindMph)
    const gusts = pick(hourlyGustMph)
    days.push({
      date,
      snow: windowRange(a, b),
      perModel,
      snowLevelFt,
      hiF: temps.length ? Math.max(...temps) : null,
      loF: temps.length ? Math.min(...temps) : null,
      maxWindMph: winds.length ? Math.max(...winds) : null,
      maxGustMph: gusts.length ? Math.max(...gusts) : null,
    })
  }

  const end = (h: number) => Math.min(times.length, nowIndex + h)
  return {
    times,
    nowIndex,
    elevationFt: raw.elevationFt,
    members,
    hourlySnowIn,
    hourlyTempF,
    hourlyWindMph,
    hourlyGustMph,
    // Late in the day the 240-hour window touches 11 calendar days; the UI shows 10.
    days: days.slice(0, MAX_DAYS),
    next24: windowRange(nowIndex, end(24)),
    next48: windowRange(nowIndex, end(48)),
    next72: windowRange(nowIndex, end(72)),
    next7d: windowRange(nowIndex, end(168)),
    calibration,
  }
}

function sum(xs: number[], a: number, b: number) {
  let s = 0
  for (let i = a; i < b; i++) s += xs[i]
  return s
}
