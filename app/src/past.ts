/** Observed snowfall vs our day-before forecast, built a few times a day by scripts/past-snowfall.ts. */
import { freshLoader, fetchJson } from './refresh'
import type { Amount, RecentSnow } from './recent'

export interface Station {
  type: 'snotel' | 'cocorahs'; id: string; name: string; lat: number; lon: number; elevFt: number | null; km: number
  /** Picked over the nearest-fit station (`replaced`) because it matches the resort's own reports. */
  matchedBy?: 'resort-reports'
  replaced?: string
  /** Station vs the resort's own reports since it opened, storm by storm (errIn = summed miss). */
  resortCheck?: { reportedIn: number; stationIn: number; days: number; storms?: number; errIn?: number; candidates?: { id: string; name: string; stationIn: number; errIn: number }[] }
}

/** Where a day's measured snow came from. */
export type DaySource = 'resort' | 'snotel' | 'cocorahs' | 'estimate'

/**
 * One observation day, 7am to 7am Mountain Standard Time like resort snow reports and CoCoRaHS:
 * actual (a) and predicted (p) snowfall in inches; null when unknown.
 */
export interface PastDay {
  d: string
  /** The resort's own report on days it posted one (from its opening day), else the station. */
  a: number | null
  p: number | null
  /** Where `a` came from; files from before sources were recorded leave it out. */
  s?: DaySource
  /** The station's own number on days `a` is the resort's. */
  st?: number | null
}

/** Error of predicted vs actual, storm by storm (`per: 'storm'`) or, in older files, day by day. */
export interface PastStats {
  n: number
  /** Average size of the miss, inches. */
  maeIn: number
  /** Average signed error (predicted − actual): positive = we forecast too much. */
  biasIn: number
  /** Share of storms (days) that brought ≥1" which we also forecast at ≥1". */
  hitRate: number | null
  per?: 'storm' | 'day'
}

export interface PastLocation {
  name: string
  kind: string
  station: Station | null
  /** No station nearby: `a` is a model-analysis estimate, not a measurement. */
  estimate: boolean
  last24In: number | null
  last48In: number | null
  /** Finished days since the season start, summed. */
  seasonIn: number | null
  /** Finished days (all of them before the day in progress). */
  days: PastDay[]
  stats: PastStats | null
  /** Finished days since the season start with nothing measured (a gauge that didn't report). */
  missingDays?: number
  /** The day in progress when the file was built, from the station. */
  today?: { d: string; a: number | null; provisional: boolean } | null
  /** Newest reading the file used (ISO time for SNOTEL, the report date for CoCoRaHS). */
  asOf?: string | null
  /** For resorts: how the season splits between the resort's own reports and station days. */
  seasonParts?: { resortIn: number; stationIn: number; resortFrom: string | null }
  /** The station's first day, when it replaced another; earlier days keep the earlier station's numbers. */
  stationSince?: string | null
  previousStations?: { name: string; until: string }[]
}

export interface PastSnowfall {
  version: number
  generated: string
  obsGenerated: string
  seasonStart: string
  /** Hour (PST) observation days start; files from before days were aligned to 7am MST lack it. */
  dayStartH?: number
  /** How `a` is computed; a file from another version is rebuilt, not kept. */
  actualVersion?: number
  /** Days older than this are kept as published rather than recomputed. */
  freezeDays?: number
  locations: Record<string, PastLocation>
}

/** The file is rebuilt a few times a day; the app asks again after this long. */
export const PAST_TTL_MS = 15 * 60_000

export const loadPastSnowfall = freshLoader<PastSnowfall>(
  () => fetchJson(`${import.meta.env.BASE_URL}data/past-snowfall.json`)
    .then(j => ((j as PastSnowfall | null)?.version === 1 && (j as PastSnowfall).locations ? (j as PastSnowfall) : null)),
  PAST_TTL_MS,
)

const DAY_MS = 86_400_000

/** When observation day `d` ends (epoch ms): its next morning at `dayStartH` PST. */
export const dayEnd = (d: string, dayStartH = 6) => Date.parse(`${d}T00:00:00Z`) + DAY_MS + (8 + dayStartH) * 3_600_000

/** The observation day (starting `dayStartH` PST) that `t` falls in. */
export const obsDayAt = (t: number, dayStartH = 6) => new Date(t - (8 + dayStartH) * 3_600_000).toISOString().slice(0, 10)

export interface Composed {
  /** Last 7 observation days including today so far. */
  week: Amount | null
  season: Amount | null
  /** New snow since the file's last finished day ended, when known. */
  sinceFile: Amount | null
}

/**
 * "7 days" and "Since Oct 1": the file's finished days plus the snow since its last day ended, from
 * the live readings (or the file's own partial day when they're unavailable). Each hour counts once,
 * however late the file is.
 */
export function composeTotals(l: PastLocation, recent: RecentSnow | null, now: number, dayStartH = 6): Composed {
  const last = l.days.length ? l.days[l.days.length - 1].d : null
  let sinceFile: Amount | null = null
  if (last && recent?.source === 'snotel') sinceFile = recent.since(dayEnd(last, dayStartH))
  if (!sinceFile && last && l.today && l.today.a != null && l.today.d > last) sinceFile = { inches: l.today.a, provisional: l.today.provisional }
  const today = obsDayAt(now, dayStartH)
  const weekStart = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * DAY_MS).toISOString().slice(0, 10)
  const weekDays = l.days.filter(d => d.d >= weekStart && d.a != null)
  const add = (base: number | null): Amount | null => {
    if (base == null && !sinceFile) return null
    return { inches: Math.round(((base ?? 0) + (sinceFile?.inches ?? 0)) * 10) / 10, provisional: sinceFile?.provisional ?? false }
  }
  return {
    week: add(weekDays.length ? weekDays.reduce((s, d) => s + d.a!, 0) : null),
    season: add(l.seasonIn),
    sinceFile,
  }
}

export const stationLabel = (l: PastLocation) =>
  l.estimate || !l.station
    ? 'Model estimate (no station nearby)'
    : `${l.station.name}${l.station.type === 'cocorahs' ? ' (CoCoRaHS)' : ''} · ${l.station.km} km${l.station.elevFt ? ` · ${l.station.elevFt.toLocaleString()}′` : ''}`

/** Why a resort's station isn't the closest fit, e.g. "Chosen over Red Mountain Pass SNOTEL: ...". */
export function stationNote(l: PastLocation): string | null {
  const st = l.station
  const notes: string[] = []
  if (st?.matchedBy === 'resort-reports' && st.resortCheck) {
    const c = st.resortCheck
    notes.push(`Chosen over ${st.replaced ?? 'the closest-fit station'}: since ${l.name} opened, this station measured ${c.stationIn}" to the resort's own ${c.reportedIn}".`)
  }
  const prev = l.previousStations?.[l.previousStations.length - 1]
  if (prev && l.stationSince) notes.push(`Measured here since ${shortDay(l.stationSince)}; days before that keep ${prev.name}'s numbers.`)
  return notes.length ? notes.join(' ') : null
}

const shortDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** Where a resort's measured days come from, e.g. "Winter Park's own reports from Nov 2". */
export function sourceNote(l: PastLocation): string | null {
  const from = l.seasonParts?.resortFrom
  return from ? `${l.name}'s own reports from ${shortDay(from)}` : null
}

/** Plain-language summary of the bias, e.g. "forecasts ran 0.9" high". */
export function biasPhrase(biasIn: number): string {
  if (Math.abs(biasIn) < 0.3) return 'little systematic bias'
  return `forecasts ran ${Math.abs(biasIn).toFixed(1)}" ${biasIn > 0 ? 'high' : 'low'}`
}
