/**
 * "Is snow coming anywhere in Colorado?" for LOOP's snow banner, at GET /colorado-snow.
 *
 * Forecasting every location on each request would be slow, so the 5-minute cron forecasts
 * one location per run (at its summit), rotating through them all every few hours, and keeps
 * each one's 48-hour total in KV. The endpoint just reads those saved totals.
 */
import { LOCATIONS, type SnowLocation } from '../../app/src/data/locations'
import { fetchWeights, snowNext48 } from './forecast'
import type { KVNamespace } from '@cloudflare/workers-types'

export const COLORADO_KEY = 'colorado-snow'
/** LOOP shows its banner at 1 inch or more in the next 48 hours, anywhere in the state. */
export const SNOW_THRESHOLD_IN = 1
/** Totals older than this are skipped, so a stalled sweep can't keep an old storm on screen. */
export const MAX_ENTRY_AGE_MS = 8 * 60 * 60 * 1000

export type ColoradoEntry = { name: string; in48: number; at: number }
export type ColoradoTotals = Record<string, ColoradoEntry>
export type ColoradoSummary = {
  snow: boolean
  thresholdInches: number
  maxInches: number
  where: string | null
  locationsChecked: number
  updated: string | null
}

const SWEEP: SnowLocation[] = LOCATIONS.filter(l => l.kind !== 'custom')

export function locationForSlot(slot: number, locations = SWEEP): SnowLocation {
  return locations[((slot % locations.length) + locations.length) % locations.length]
}

export function summarize(totals: ColoradoTotals, nowMs: number): ColoradoSummary {
  const fresh = Object.values(totals).filter(e => nowMs - e.at <= MAX_ENTRY_AGE_MS)
  const best = fresh.reduce<ColoradoEntry | null>((top, e) => (!top || e.in48 > top.in48 ? e : top), null)
  const newest = fresh.reduce((t, e) => Math.max(t, e.at), 0)
  const maxInches = best ? Math.round(best.in48 * 10) / 10 : 0
  return {
    snow: maxInches >= SNOW_THRESHOLD_IN,
    thresholdInches: SNOW_THRESHOLD_IN,
    maxInches,
    where: best && maxInches > 0 ? best.name : null,
    locationsChecked: fresh.length,
    updated: newest ? new Date(newest).toISOString() : null,
  }
}

export async function readColorado(kv: KVNamespace, nowMs = Date.now()): Promise<ColoradoSummary> {
  return summarize((await kv.get<ColoradoTotals>(COLORADO_KEY, 'json')) ?? {}, nowMs)
}

/** Forecasts the next location in the rotation and saves its 48-hour total. */
export async function sweepColorado(kv: KVNamespace, slot: number, nowMs = Date.now()) {
  const loc = locationForSlot(slot)
  try {
    const in48 = await snowNext48(loc.lat, loc.lon, loc.summitFt, await fetchWeights())
    const totals = (await kv.get<ColoradoTotals>(COLORADO_KEY, 'json')) ?? {}
    totals[loc.id] = { name: loc.name, in48, at: nowMs }
    await kv.put(COLORADO_KEY, JSON.stringify(totals))
  } catch (e) {
    console.warn(`colorado sweep failed for ${loc.id}: ${(e as Error).message}`)
  }
}
