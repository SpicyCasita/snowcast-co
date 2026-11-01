import type { PushSubscriptionJSON } from './webpush'

export interface Favorite {
  id: string
  name: string
  lat: number
  lon: number
  elevationFt: number
}

/** Inches; null turns that window off. */
export interface Thresholds {
  h72In: number | null
  d7In: number | null
}

export type AlertWindow = 'h72' | 'd7'

export interface LastAlert {
  /** Epoch ms. */
  at: number
  expected: number
}

export interface SubscriptionRecord {
  subscription: PushSubscriptionJSON
  favorites: Favorite[]
  thresholds: Thresholds
  createdAt: number
  updatedAt: number
  /** Keyed by `${locationId}:${window}`. */
  lastAlerts: Record<string, LastAlert>
}

/** Expected snow (inches) for one location. */
export interface LocationTotals {
  h72: number
  d7: number
}

export interface AlertHit {
  id: string
  name: string
  window: AlertWindow
  expected: number
  threshold: number
}

export interface PushPayload {
  title: string
  body: string
  tag: string
  /** Location to open on tap; null opens the home screen. */
  locId: string | null
}

export const REPEAT_AFTER_MS = 24 * 3600 * 1000
/** Re-alert inside the 24h window when the forecast has grown by this factor since the last alert. */
export const RISE_FACTOR = 1.5
const FORGET_AFTER_MS = 7 * 24 * 3600 * 1000
export const MAX_FAVORITES = 40

export const WINDOW_LABEL: Record<AlertWindow, string> = { h72: 'next 72h', d7: 'next 7 days' }

/** Cache key for a forecast point, so favorites shared by several subscribers are fetched once. */
export const pointKey = (f: Pick<Favorite, 'lat' | 'lon' | 'elevationFt'>) =>
  `${f.lat.toFixed(3)},${f.lon.toFixed(3)},${Math.round(f.elevationFt)}`

export function shouldAlert(expected: number, threshold: number | null, last: LastAlert | undefined, nowMs: number): boolean {
  if (threshold == null || !(expected >= threshold)) return false
  if (!last) return true
  if (nowMs - last.at >= REPEAT_AFTER_MS) return true
  return expected >= last.expected * RISE_FACTOR
}

/**
 * Which favorites cross a threshold this run, and the dedupe state to store afterwards.
 * Favorites with no forecast this run (fetch failed or not in this run's batch) are skipped.
 */
export function evaluate(
  rec: Pick<SubscriptionRecord, 'favorites' | 'thresholds' | 'lastAlerts'>,
  totals: (f: Favorite) => LocationTotals | undefined,
  nowMs: number,
): { hits: AlertHit[]; lastAlerts: Record<string, LastAlert> } {
  const hits: AlertHit[] = []
  const lastAlerts: Record<string, LastAlert> = {}
  const ids = new Set(rec.favorites.map(f => f.id))
  // Keep recent state for current favorites only, so the record doesn't grow without bound.
  for (const [k, v] of Object.entries(rec.lastAlerts ?? {})) {
    if (ids.has(k.slice(0, k.lastIndexOf(':'))) && nowMs - v.at < FORGET_AFTER_MS) lastAlerts[k] = v
  }
  for (const f of rec.favorites) {
    const t = totals(f)
    if (!t) continue
    for (const window of ['h72', 'd7'] as const) {
      const threshold = window === 'h72' ? rec.thresholds.h72In : rec.thresholds.d7In
      const expected = t[window]
      const key = `${f.id}:${window}`
      if (!shouldAlert(expected, threshold, lastAlerts[key], nowMs)) continue
      hits.push({ id: f.id, name: f.name, window, expected, threshold: threshold! })
      lastAlerts[key] = { at: nowMs, expected }
    }
  }
  return { hits, lastAlerts }
}

export const fmtIn = (x: number) => `${x >= 10 ? Math.round(x) : Math.round(x * 10) / 10}"`

/** One notification per subscription per run, strongest signal first. */
export function buildPayload(hits: AlertHit[]): PushPayload | null {
  if (hits.length === 0) return null
  const byLoc = new Map<string, AlertHit[]>()
  for (const h of hits) byLoc.set(h.id, [...(byLoc.get(h.id) ?? []), h])
  const strength = (hs: AlertHit[]) => Math.max(...hs.map(h => h.expected / h.threshold))
  const locs = [...byLoc.values()].sort((a, b) => strength(b) - strength(a))
  const line = (hs: AlertHit[]) =>
    [...hs].sort((a, b) => (a.window === b.window ? 0 : a.window === 'h72' ? -1 : 1))
      .map(h => `${fmtIn(h.expected)} ${WINDOW_LABEL[h.window]}`).join(', ')

  const top = locs[0]
  if (locs.length === 1) {
    return {
      title: `❄ ${top[0].name}: ${fmtIn(Math.max(...top.map(h => h.expected)))} of snow forecast`,
      body: `${line(top)} (alert at ${top.map(h => fmtIn(h.threshold)).join(' / ')}). Tap for the forecast.`,
      tag: `snow-${top[0].id}`,
      locId: top[0].id,
    }
  }
  return {
    title: `❄ Snow for ${locs.length} favorites`,
    body: locs.map(hs => `${hs[0].name}: ${line(hs)}`).join('\n'),
    tag: 'snow-multi',
    locId: top[0].id,
  }
}

export const testPayload = (): PushPayload => ({
  title: '❄ SnowCast test alert',
  body: 'Push alerts are working. You will get one when a favorite crosses your threshold.',
  tag: 'snow-test',
  locId: null,
})

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const threshold = (x: unknown) => (x == null ? null : isNum(x) && x > 0 && x <= 500 ? x : undefined)

export function parseSubscription(x: unknown): PushSubscriptionJSON | string {
  const s = x as PushSubscriptionJSON | undefined
  if (!s || typeof s.endpoint !== 'string' || !s.endpoint.startsWith('https://') || s.endpoint.length > 2048) return 'subscription.endpoint must be an https URL'
  if (typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') return 'subscription.keys missing'
  return { endpoint: s.endpoint, expirationTime: s.expirationTime ?? null, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }
}

/** Validate a PUT /subscription body. Returns an error message on bad input. */
export function parsePutBody(body: unknown): Pick<SubscriptionRecord, 'subscription' | 'favorites' | 'thresholds'> | string {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return 'body must be JSON'
  const subscription = parseSubscription(b.subscription)
  if (typeof subscription === 'string') return subscription
  if (!Array.isArray(b.favorites) || b.favorites.length > MAX_FAVORITES) return `favorites must be an array of at most ${MAX_FAVORITES}`
  const favorites: Favorite[] = []
  for (const f of b.favorites as Record<string, unknown>[]) {
    if (typeof f?.id !== 'string' || typeof f.name !== 'string' || !isNum(f.lat) || !isNum(f.lon) || !isNum(f.elevationFt)) return 'each favorite needs id, name, lat, lon, elevationFt'
    if (Math.abs(f.lat) > 90 || Math.abs(f.lon) > 180) return `favorite ${f.id} has bad coordinates`
    favorites.push({ id: f.id.slice(0, 80), name: f.name.slice(0, 80), lat: f.lat, lon: f.lon, elevationFt: f.elevationFt })
  }
  const t = (b.thresholds ?? {}) as Record<string, unknown>
  const h72In = threshold(t.h72In)
  const d7In = threshold(t.d7In)
  if (h72In === undefined || d7In === undefined) return 'thresholds must be positive numbers or null'
  return { subscription, favorites, thresholds: { h72In, d7In } }
}
