import { fmtIn, type Favorite, type PushPayload, type Thresholds } from './alerts'

/** What the Worker needs from the app's data/past-snowfall.json (app/scripts/past-snowfall.ts). */
export interface PastDay { d: string; a: number | null; p: number | null }
export interface PastLocation {
  name: string
  station: { type: 'snotel' | 'cocorahs'; name: string } | null
  estimate: boolean
  last24In: number | null
  last48In: number | null
  days: PastDay[]
}
export interface PastSnowfall { version: number; generated: string; locations: Record<string, PastLocation> }

export const PAST_URL = 'https://spicycasita.github.io/snowcast-co/data/past-snowfall.json'
/** Skip the morning run if the data wasn't refreshed recently (the build failed or ran late). */
export const MAX_DATA_AGE_MS = 12 * 3600 * 1000
const RECAP_DAYS = 7

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Today's Colorado date and weekday (0 = Sunday). */
export function denverToday(nowMs: number): { date: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(nowMs))
  const get = (t: string) => parts.find(p => p.type === t)!.value
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')) }
}

const source = (l: PastLocation) => (l.estimate || !l.station ? 'model estimate' : l.station.name)
const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' })

export interface PastResult {
  payloads: PushPayload[]
  /** Dedupe state to store: `${kind}:${locationId}` (or `recap`) -> the date it was sent for. */
  lastPast: Record<string, string>
}

/**
 * The morning's past-snowfall notifications for one subscriber: fresh snow, forecast misses and the
 * weekly recap. Each kind fires at most once per location per day.
 */
export function evaluatePast(
  rec: { favorites: Favorite[]; thresholds: Thresholds; lastPast?: Record<string, string> },
  past: PastSnowfall,
  today: { date: string; weekday: number },
): PastResult {
  const t = rec.thresholds
  const lastPast = { ...(rec.lastPast ?? {}) }
  const favs = rec.favorites.map(f => [f, past.locations[f.id]] as const).filter((x): x is [Favorite, PastLocation] => !!x[1])
  const payloads: PushPayload[] = []

  if (t.freshIn != null) {
    const hours = t.freshHours === 48 ? 48 : 24
    const hits = favs
      .map(([f, l]) => ({ f, l, v: hours === 48 ? l.last48In : l.last24In }))
      .filter(h => h.v != null && h.v >= t.freshIn! && lastPast[`fresh:${h.f.id}`] !== today.date)
      .sort((a, b) => b.v! - a.v!)
    if (hits.length) {
      for (const h of hits) lastPast[`fresh:${h.f.id}`] = today.date
      const top = hits[0]
      payloads.push(hits.length === 1
        ? { title: `❄ Fresh snow: ${top.f.name} ${fmtIn(top.v!)}`, body: `${fmtIn(top.v!)} in the last ${hours}h at ${source(top.l)} (alert at ${fmtIn(t.freshIn)}).`, tag: `fresh-${top.f.id}`, locId: top.f.id }
        : { title: `❄ Fresh snow at ${hits.length} favorites`, body: hits.map(h => `${h.f.name}: ${fmtIn(h.v!)} in ${hours}h`).join('\n'), tag: 'fresh-multi', locId: top.f.id })
    }
  }

  if (t.missIn != null) {
    const hits = favs.flatMap(([f, l]) => {
      // The most recent day with both a measurement and a prediction (normally yesterday).
      const day = [...l.days].reverse().find(x => x.a != null && x.p != null)
      if (!day || Math.abs(day.p! - day.a!) < t.missIn! || lastPast[`miss:${f.id}`] === day.d) return []
      return [{ f, day, err: day.p! - day.a! }]
    }).sort((a, b) => Math.abs(b.err) - Math.abs(a.err))
    if (hits.length) {
      for (const h of hits) lastPast[`miss:${h.f.id}`] = h.day.d
      const line = (h: (typeof hits)[number]) =>
        `${shortDay(h.day.d)}: forecast ${fmtIn(h.day.p!)}, measured ${fmtIn(h.day.a!)} (${h.err > 0 ? 'over' : 'under'} by ${fmtIn(Math.abs(h.err))})`
      const top = hits[0]
      payloads.push(hits.length === 1
        ? { title: `📉 Forecast miss: ${top.f.name}`, body: line(top), tag: `miss-${top.f.id}`, locId: top.f.id }
        : { title: `📉 Forecast misses at ${hits.length} favorites`, body: hits.map(h => `${h.f.name} ${line(h)}`).join('\n'), tag: 'miss-multi', locId: top.f.id })
    }
  }

  if (t.recapDay != null && today.weekday === t.recapDay && lastPast.recap !== today.date && favs.length) {
    lastPast.recap = today.date
    const lines = favs.map(([f, l]) => {
      const week = l.days.slice(-RECAP_DAYS)
      const actual = week.reduce((s, x) => s + (x.a ?? 0), 0)
      const both = week.filter(x => x.a != null && x.p != null)
      const predicted = both.reduce((s, x) => s + x.p!, 0)
      return { f, actual, text: `${f.name}: ${fmtIn(actual)}${both.length ? ` (forecast ${fmtIn(predicted)})` : ''}` }
    }).sort((a, b) => b.actual - a.actual)
    payloads.push({ title: '📊 Your weekly snow recap', body: `Last 7 days, measured:\n${lines.map(l => l.text).join('\n')}`, tag: 'recap', locId: null })
  }

  return { payloads, lastPast }
}

export async function fetchPast(url = PAST_URL): Promise<PastSnowfall | null> {
  try {
    const res = await fetch(url, { cf: { cacheTtl: 300 } } as RequestInit)
    if (!res.ok) return null
    const j = (await res.json()) as PastSnowfall
    return j?.version === 1 && j.locations ? j : null
  } catch {
    return null
  }
}
