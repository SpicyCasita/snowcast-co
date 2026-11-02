/** Observed snowfall vs our day-before forecast, built daily by scripts/past-snowfall.ts. */

export interface Station { type: 'snotel' | 'cocorahs'; id: string; name: string; lat: number; lon: number; elevFt: number | null; km: number }

/** One PST day: actual (a) and predicted (p) snowfall in inches; null when unknown. */
export interface PastDay { d: string; a: number | null; p: number | null }

/** Error of predicted vs actual over recent snow days. */
export interface PastStats {
  n: number
  /** Average size of the miss, inches. */
  maeIn: number
  /** Average signed error (predicted − actual): positive = we forecast too much. */
  biasIn: number
  /** Share of days that snowed ≥1" which we also forecast ≥1". */
  hitRate: number | null
}

export interface PastLocation {
  name: string
  kind: string
  station: Station | null
  /** No station nearby: `a` is a model-analysis estimate, not a measurement. */
  estimate: boolean
  last24In: number | null
  last48In: number | null
  seasonIn: number | null
  days: PastDay[]
  stats: PastStats | null
}

export interface PastSnowfall {
  version: number
  generated: string
  obsGenerated: string
  seasonStart: string
  locations: Record<string, PastLocation>
}

let pending: Promise<PastSnowfall | null> | null = null

export function loadPastSnowfall(): Promise<PastSnowfall | null> {
  pending ??= fetch(`${import.meta.env.BASE_URL}data/past-snowfall.json`)
    .then(r => (r.ok ? r.json() : null))
    .then(j => (j?.version === 1 && j.locations ? (j as PastSnowfall) : null))
    .catch(() => null)
  return pending
}

/** Total actual snow over the last `n` days; null when no day in the window was measured. */
export function lastDaysTotal(days: PastDay[], n: number): number | null {
  const window = days.slice(-n).filter(d => d.a != null)
  return window.length ? window.reduce((s, d) => s + d.a!, 0) : null
}

export const stationLabel = (l: PastLocation) =>
  l.estimate || !l.station
    ? 'Model estimate (no station nearby)'
    : `${l.station.name}${l.station.type === 'cocorahs' ? ' (CoCoRaHS)' : ''} · ${l.station.km} km${l.station.elevFt ? ` · ${l.station.elevFt.toLocaleString()}′` : ''}`

/** Plain-language summary of the bias, e.g. "forecasts ran 0.9" high". */
export function biasPhrase(biasIn: number): string {
  if (Math.abs(biasIn) < 0.3) return 'little systematic bias'
  return `forecasts ran ${Math.abs(biasIn).toFixed(1)}" ${biasIn > 0 ? 'high' : 'low'}`
}
