/**
 * What the resorts themselves report, collected each morning by pipeline/fetch_resort_reports.py
 * (resort snow reports as republished by OnTheSnow). Dated by the day the snow fell: a 6am report
 * counts as the previous day, so it lines up with the station's day (both cover roughly a day,
 * but resorts measure on their own schedule and stake, so expect some straddling).
 */
import type { PastDay } from './past'
import { freshLoader, fetchJson } from './refresh'

export interface ResortLatest {
  updatedAt: string
  new24In: number | null
  new48In: number | null
  new72In: number | null
  /** Base-area depth, else mid-mountain. */
  depthIn: number | null
}

export interface ResortReport {
  slug: string
  open: boolean
  openingDate: string | null
  latest: ResortLatest | null
  /** Day the snow fell → resort-reported 24 h new snow, inches. */
  days: Record<string, number>
}

export interface ResortReports {
  version: number
  generated: string
  source: string
  resorts: Record<string, ResortReport>
}

/** Resort reports update twice a morning; the app asks again after this long. */
export const RESORT_TTL_MS = 30 * 60_000

export const loadResortReports = freshLoader<ResortReports>(
  () => fetchJson(`${import.meta.env.BASE_URL}data/resort-reports.json`)
    .then(j => ((j as ResortReports | null)?.version === 1 && (j as ResortReports).resorts ? (j as ResortReports) : null)),
  RESORT_TTL_MS,
)

/** A report counts as current for 30 h, like the pipeline's freshness rule. */
export const isCurrent = (latest: ResortLatest | null, now = Date.now()) =>
  latest != null && now - Date.parse(latest.updatedAt) <= 30 * 3600_000

export interface ResortCompare {
  /** Days scored: resort reported, and resort or forecast ≥1". */
  n: number
  /** Our day-before forecast vs the resort's number. */
  maeIn: number
  biasIn: number
  /** Station measured − resort reported, on days both exist: negative = station reads lower. */
  stationGapIn: number | null
}

/** Score our forecast (and the station) against resort-reported days. Null with fewer than 3 days. */
export function compareToResort(days: PastDay[], resortDays: Record<string, number>): ResortCompare | null {
  const scored = days.filter(d => resortDays[d.d] != null && d.p != null && Math.max(resortDays[d.d], d.p) >= 1)
  if (scored.length < 3) return null
  const errs = scored.map(d => d.p! - resortDays[d.d])
  const both = days.filter(d => resortDays[d.d] != null && d.a != null && Math.max(resortDays[d.d], d.a) >= 1)
  const round = (x: number) => Math.round(x * 10) / 10
  return {
    n: scored.length,
    maeIn: round(errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length),
    biasIn: round(errs.reduce((s, e) => s + e, 0) / errs.length),
    stationGapIn: both.length ? round(both.reduce((s, d) => s + d.a! - resortDays[d.d], 0) / both.length) : null,
  }
}
