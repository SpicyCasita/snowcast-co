import { useCallback, useEffect, useRef, useState } from 'react'
import type { SnowLocation } from './data/locations'
import { loadPastSnowfall, type PastSnowfall } from './past'
import { getRecent } from './recent'
import { midElevation } from './storm'

/** This much (or more) measured in the past 24 h at a favorite earns a Spicy Casita Special. */
export const SPICY_MIN_IN = 12
/** Secret summon: this many taps anywhere within SECRET_WINDOW_MS. */
export const SECRET_TAPS = 5
export const SECRET_WINDOW_MS = 2000

export interface SpicyHit { id: string; name: string; inches: number }

/** Past-24 h snow at each favorite: the larger of the morning file and the live reading. */
function past24(favorites: SnowLocation[], past: PastSnowfall | null, live: Map<string, number | null>): SpicyHit[] {
  return favorites
    .map(f => {
      const vals = [past?.locations[f.id]?.last24In, live.get(f.id)].filter((v): v is number => v != null)
      return { id: f.id, name: f.name, inches: vals.length ? Math.max(...vals) : 0 }
    })
    .sort((a, b) => b.inches - a.inches)
}

/** Favorites with SPICY_MIN_IN or more in the past 24 h, biggest first. */
export function spicyHits(favorites: SnowLocation[], past: PastSnowfall | null, live: Map<string, number | null>): SpicyHit[] {
  return past24(favorites, past, live).filter(h => h.inches >= SPICY_MIN_IN)
}

/** `?spicy=1` (or `#…?spicy=1`) forces the easter egg with a demo dump, for testing. */
export const spicyForced = (href = location.href) => /[?&]spicy=1\b/.test(href)

/**
 * Counts taps; returns true on the tap that completes SECRET_TAPS within SECRET_WINDOW_MS, then
 * starts over so a sixth tap doesn't immediately fire again.
 */
export function tapCounter(taps = SECRET_TAPS, windowMs = SECRET_WINDOW_MS) {
  let times: number[] = []
  return (now: number): boolean => {
    times = [...times.filter(t => now - t < windowMs), now]
    if (times.length < taps) return false
    times = []
    return true
  }
}

async function loadPast24(favorites: SnowLocation[]): Promise<{ past: PastSnowfall | null; live: Map<string, number | null> }> {
  const past = await loadPastSnowfall()
  const live = await Promise.all(favorites.map(async f => {
    const p = past?.locations[f.id]
    if (p?.station?.type !== 'snotel') return [f.id, null] as const
    const r = await getRecent(f.id, p, { lat: f.lat, lon: f.lon, elevFt: midElevation(f) }).catch(() => null)
    return [f.id, r?.source === 'snotel' ? r.totals[24] : null] as const
  }))
  return { past, live: new Map(live) }
}

export interface SpicyState {
  hits: SpicyHit[]
  /** Opened by the secret taps rather than earned by a real dump. */
  summoned: boolean
  dismiss: () => void
}

/**
 * Checks once when the app opens, and listens for the secret five-tap summon. When summoned, it
 * shows the snowiest favorite's real 24 h total, whatever it is.
 */
export function useSpicy(favorites: SnowLocation[]): SpicyState {
  const [hits, setHits] = useState<SpicyHit[]>([])
  const [summoned, setSummoned] = useState(false)
  const favRef = useRef(favorites)
  useEffect(() => { favRef.current = favorites })

  useEffect(() => {
    let live = true
    if (spicyForced()) {
      const f = favorites[0]
      setHits([{ id: f?.id ?? 'wolf-creek', name: f?.name ?? 'Wolf Creek', inches: 14 }])
      return
    }
    loadPast24(favorites).then(({ past, live: l }) => {
      if (live && past) setHits(spicyHits(favorites, past, l))
    })
    return () => { live = false }
    // Only on open: favorites changing later shouldn't pop it up mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const tap = tapCounter()
    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary || !tap(e.timeStamp)) return
      const favs = favRef.current
      loadPast24(favs).then(({ past, live }) => {
        const all = past24(favs, past, live)
        const top = all[0] ?? { id: favs[0]?.id ?? 'colorado', name: favs[0]?.name ?? 'Colorado', inches: 0 }
        const earned = all.filter(h => h.inches >= SPICY_MIN_IN)
        setSummoned(earned.length === 0)
        setHits(earned.length ? earned : [top])
      })
    }
    window.addEventListener('pointerdown', onDown, { capture: true })
    return () => window.removeEventListener('pointerdown', onDown, { capture: true })
  }, [])

  const dismiss = useCallback(() => { setHits([]); setSummoned(false) }, [])
  return { hits, summoned, dismiss }
}
