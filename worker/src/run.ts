import { buildPayload, evaluate, pointKey, type Favorite, type LocationTotals, type SubscriptionRecord } from './alerts'
import { fetchWeights, forecastTotals } from './forecast'
import { denverToday, evaluatePast, fetchPast, MAX_DATA_AGE_MS } from './past'
import { sendPush, type VapidKeys } from './webpush'
import type { KVNamespace } from '@cloudflare/workers-types'

/**
 * Free-plan Workers get 10 ms of CPU per invocation and one blend costs 2-4 ms, so the cron runs every
 * RUN_EVERY_MIN minutes and forecasts this many points each time, rotating through all favorites.
 * Up to 12 distinct points are each checked hourly; more than that and the cycle stretches.
 */
export const MAX_POINTS_PER_RUN = 1
/** Must match the cron in wrangler.toml. */
export const RUN_EVERY_MIN = 5
const FORECAST_CONCURRENCY = 4

export interface Env {
  SUBS: KVNamespace
  VAPID_PUBLIC_KEY: string
  /** Secret: `wrangler secret put VAPID_PRIVATE_KEY`. */
  VAPID_PRIVATE_KEY: string
  VAPID_SUBJECT: string
  /** Comma-separated origins allowed to call the API. */
  ALLOWED_ORIGINS: string
}

// Trim: a secret pasted or piped on Windows can pick up a trailing newline.
export const vapid = (env: Env): VapidKeys => ({ publicKey: env.VAPID_PUBLIC_KEY.trim(), privateKey: env.VAPID_PRIVATE_KEY.trim(), subject: env.VAPID_SUBJECT })

export async function subKey(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return 'sub:' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function loadSubscriptions(kv: KVNamespace): Promise<[string, SubscriptionRecord][]> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix: 'sub:', cursor })
    keys.push(...page.keys.map(k => k.name))
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  const recs = await Promise.all(keys.map(k => kv.get<SubscriptionRecord>(k, 'json')))
  return keys.map((k, i) => [k, recs[i]] as [string, SubscriptionRecord | null]).filter((e): e is [string, SubscriptionRecord] => e[1] != null)
}

/** This run's share of the points, rotating each run when there are more than fit in one. */
export function pointsForRun(keys: string[], slot: number, max = MAX_POINTS_PER_RUN): string[] {
  const sorted = [...keys].sort()
  const chunks = Math.ceil(sorted.length / max)
  if (chunks <= 1) return sorted
  const i = slot % chunks
  return sorted.slice(i * max, (i + 1) * max)
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function runAlerts(env: Env, nowMs = Date.now()) {
  const subs = await loadSubscriptions(env.SUBS)
  if (subs.length === 0) return { subscriptions: 0 }

  const points = new Map<string, Favorite>()
  for (const [, rec] of subs) for (const f of rec.favorites) points.set(pointKey(f), f)
  const batch = pointsForRun([...points.keys()], Math.floor(nowMs / (RUN_EVERY_MIN * 60_000)))

  const weights = await fetchWeights()
  // One forecast per point per run, however many subscribers share it.
  const totals = new Map<string, LocationTotals>()
  await mapLimit(batch, FORECAST_CONCURRENCY, async key => {
    try {
      totals.set(key, await forecastTotals(points.get(key)!, weights))
    } catch (e) {
      console.warn(`forecast failed for ${key}: ${(e as Error).message}`)
    }
  })

  let sent = 0
  let dropped = 0
  for (const [key, rec] of subs) {
    const { hits, lastAlerts } = evaluate(rec, f => totals.get(pointKey(f)), nowMs)
    const payload = buildPayload(hits)
    if (!payload) continue
    try {
      const res = await sendPush(rec.subscription, payload, vapid(env), { topic: payload.tag })
      if (res.gone) {
        await env.SUBS.delete(key)
        dropped++
      } else if (res.status < 300) {
        // Only record the alert once it was accepted, so a failed send retries next hour.
        await env.SUBS.put(key, JSON.stringify({ ...rec, lastAlerts }))
        sent++
      } else {
        console.warn(`push to ${key} failed: ${res.status}`)
      }
    } catch (e) {
      console.warn(`push to ${key} threw: ${(e as Error).message}`)
    }
  }
  const summary = { subscriptions: subs.length, points: points.size, forecast: totals.size, batch: batch.length, sent, dropped }
  console.log(JSON.stringify(summary))
  return summary
}

/**
 * Morning run: fresh-snow, forecast-miss and weekly-recap alerts from the published past-snowfall data,
 * which a GitHub Actions job refreshes shortly before this cron.
 */
export async function runMorning(env: Env, nowMs = Date.now()) {
  const past = await fetchPast()
  if (!past || nowMs - Date.parse(past.generated) > MAX_DATA_AGE_MS) {
    console.warn(`past-snowfall data missing or stale (${past?.generated ?? 'none'}); skipping morning alerts`)
    return { skipped: true }
  }
  const today = denverToday(nowMs)
  const subs = await loadSubscriptions(env.SUBS)
  let sent = 0
  let dropped = 0
  for (const [key, rec] of subs) {
    const { payloads, lastPast } = evaluatePast(rec, past, today)
    if (!payloads.length) continue
    let ok = true
    for (const payload of payloads) {
      try {
        const res = await sendPush(rec.subscription, payload, vapid(env), { topic: payload.tag })
        if (res.gone) {
          await env.SUBS.delete(key)
          dropped++
          ok = false
          break
        }
        if (res.status < 300) sent++
        else ok = false
      } catch (e) {
        console.warn(`morning push to ${key} threw: ${(e as Error).message}`)
        ok = false
      }
    }
    // Record what was sent only if every push went through, so a failed send retries next morning.
    if (ok) await env.SUBS.put(key, JSON.stringify({ ...rec, lastPast }))
  }
  const summary = { morning: true, subscriptions: subs.length, sent, dropped }
  console.log(JSON.stringify(summary))
  return summary
}
