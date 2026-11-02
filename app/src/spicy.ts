import { useCallback, useEffect, useState } from 'react'
import type { SnowLocation } from './data/locations'
import { loadPastSnowfall, type PastSnowfall } from './past'
import { getRecent } from './recent'
import { midElevation } from './storm'

/** More than this much measured in the past 24 h at a favorite earns a Spicy Casita Special. */
export const SPICY_MIN_IN = 12

export interface SpicyHit { id: string; name: string; inches: number }

/**
 * Favorites with more than SPICY_MIN_IN in the past 24 h, biggest first. Uses the larger of the
 * morning file's 24 h total and the live reading, since either can lag the other.
 */
export function spicyHits(favorites: SnowLocation[], past: PastSnowfall | null, live: Map<string, number | null>): SpicyHit[] {
  return favorites
    .map(f => {
      const vals = [past?.locations[f.id]?.last24In, live.get(f.id)].filter((v): v is number => v != null)
      return { id: f.id, name: f.name, inches: vals.length ? Math.max(...vals) : 0 }
    })
    .filter(h => h.inches > SPICY_MIN_IN)
    .sort((a, b) => b.inches - a.inches)
}

/** `?spicy=1` (or `#…?spicy=1`) forces the easter egg with a demo dump, for testing. */
export const spicyForced = (href = location.href) => /[?&]spicy=1\b/.test(href)

/** Checks once when the app opens. Returns the hits to celebrate and a way to dismiss. */
export function useSpicy(favorites: SnowLocation[]): [SpicyHit[], () => void] {
  const [hits, setHits] = useState<SpicyHit[]>([])
  useEffect(() => {
    let live = true
    if (spicyForced()) {
      const f = favorites[0]
      setHits([{ id: f?.id ?? 'wolf-creek', name: f?.name ?? 'Wolf Creek', inches: 14 }])
      return
    }
    ;(async () => {
      const past = await loadPastSnowfall()
      if (!past) return
      const recent = await Promise.all(favorites.map(async f => {
        const p = past.locations[f.id]
        if (p?.station?.type !== 'snotel') return [f.id, null] as const
        const r = await getRecent(f.id, p, { lat: f.lat, lon: f.lon, elevFt: midElevation(f) }).catch(() => null)
        return [f.id, r?.source === 'snotel' ? r.totals[24] : null] as const
      }))
      if (live) setHits(spicyHits(favorites, past, new Map(recent)))
    })()
    return () => { live = false }
    // Only on open: favorites changing later shouldn't pop it up mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const dismiss = useCallback(() => setHits([]), [])
  return [hits, dismiss]
}
