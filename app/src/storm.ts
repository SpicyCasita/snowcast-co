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

export interface StormState {
  hits: StormHit[]
  /** Biggest 72-hour forecast among favorites (inches); sizes the snow globe. */
  peak72: number
}

/** Uses the same cached forecasts as the favorite cards, so it adds no network calls. */
export function useStorm(favorites: SnowLocation[]): StormState {
  const [state, setState] = useState<StormState>({ hits: [], peak72: 0 })
  const key = favorites.map(f => f.id).join(',')
  useEffect(() => {
    let live = true
    Promise.allSettled(favorites.map(f => getForecast(f.lat, f.lon, midElevation(f)))).then(results => {
      const next24 = new Map<string, number>()
      let peak72 = 0
      results.forEach((r, i) => {
        if (r.status !== 'fulfilled') return
        next24.set(favorites[i].id, r.value.next24.expected)
        peak72 = Math.max(peak72, r.value.next72.expected)
      })
      if (live) setState({ hits: stormHits(favorites, next24), peak72 })
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
}
