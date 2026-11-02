import { useEffect, useState } from 'react'
import type { SnowLocation } from './data/locations'
import { getForecast } from './forecast/useForecast'

/** Snow (inches, next 24 h) at a favorite that turns on the storm snowfall. */
export const STORM_MIN_IN = 1

export interface StormHit { id: string; name: string; inches: number }

export const midElevation = (l: SnowLocation) => Math.round((l.baseFt + l.summitFt) / 2)

/** Favorites expecting at least STORM_MIN_IN in the next 24 h, biggest first. */
export function stormHits(favorites: SnowLocation[], next24: Map<string, number>): StormHit[] {
  return favorites
    .map(f => ({ id: f.id, name: f.name, inches: next24.get(f.id) ?? 0 }))
    .filter(h => h.inches >= STORM_MIN_IN)
    .sort((a, b) => b.inches - a.inches)
}

/** Uses the same cached forecasts as the favorite cards, so it adds no network calls. */
export function useStorm(favorites: SnowLocation[]): StormHit[] {
  const [hits, setHits] = useState<StormHit[]>([])
  const key = favorites.map(f => f.id).join(',')
  useEffect(() => {
    let live = true
    Promise.allSettled(favorites.map(f => getForecast(f.lat, f.lon, midElevation(f)))).then(results => {
      const next24 = new Map<string, number>()
      results.forEach((r, i) => { if (r.status === 'fulfilled') next24.set(favorites[i].id, r.value.next24.expected) })
      if (live) setHits(stormHits(favorites, next24))
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return hits
}
