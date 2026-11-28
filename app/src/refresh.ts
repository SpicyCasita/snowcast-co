import { useEffect, useState } from 'react'

/**
 * A counter that goes up when the app comes back to the screen and every `everyMs` while it's
 * showing. An installed iPhone web app can sit open in the background for hours, so data hooks put
 * this in their effect dependencies to ask their loaders again (which only refetch once stale).
 */
export function useRefreshTick(everyMs = 5 * 60_000): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const bump = () => { if (document.visibilityState === 'visible') setTick(t => t + 1) }
    document.addEventListener('visibilitychange', bump)
    window.addEventListener('pageshow', bump)
    const id = window.setInterval(bump, everyMs)
    return () => {
      document.removeEventListener('visibilitychange', bump)
      window.removeEventListener('pageshow', bump)
      window.clearInterval(id)
    }
  }, [everyMs])
  return tick
}

/** Wraps a loader so it reuses its last answer for `ttlMs`, then fetches again. Failures retry sooner. */
export function freshLoader<T>(load: () => Promise<T | null>, ttlMs: number, failedTtlMs = 30_000): () => Promise<T | null> {
  let at = 0
  let pending: Promise<T | null> | null = null
  let ttl = ttlMs
  return () => {
    if (!pending || Date.now() - at > ttl) {
      at = Date.now()
      ttl = ttlMs
      const p = load().catch(() => null)
      p.then(v => { if (v == null && pending === p) ttl = failedTtlMs })
      pending = p
    }
    return pending
  }
}

/** Fetch a data file, revalidating with the server rather than trusting the browser's copy. */
export const fetchJson = (url: string): Promise<unknown> =>
  fetch(url, { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null))
