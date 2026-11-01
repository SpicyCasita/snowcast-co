// The same pure forecast code the app runs, so alerts match what the app shows.
import { blend } from '../../app/src/forecast/blend'
import { alignNwsSnow, fetchNwsSnow } from '../../app/src/forecast/nws'
import { fetchOpenMeteo } from '../../app/src/forecast/openMeteo'
import { skillModel, type SkillWeights } from '../../app/src/forecast/skill'
import type { Favorite, LocationTotals } from './alerts'

// api.weather.gov rejects requests without a User-Agent, and Workers' fetch doesn't send one.
// nws.ts calls the global fetch, so add it there rather than forking that code.
const baseFetch = globalThis.fetch
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith('https://api.weather.gov/')) {
    const headers = new Headers(init?.headers)
    headers.set('User-Agent', '(SnowCast CO alerts, https://spicycasita.github.io/snowcast-co/)')
    headers.set('Accept', 'application/geo+json')
    return baseFetch(input, { ...init, headers })
  }
  return baseFetch(input, init)
}

export const WEIGHTS_URL = 'https://spicycasita.github.io/snowcast-co/data/weights.json'

/** weights.json, or null so the blend falls back to its default weights. */
export async function fetchWeights(url = WEIGHTS_URL): Promise<SkillWeights | null> {
  try {
    const res = await fetch(url, { cf: { cacheTtl: 3600 } } as RequestInit)
    if (!res.ok) return null
    const j = await res.json() as SkillWeights
    return j?.version === 1 && j.weights ? j : null
  } catch {
    return null
  }
}

export async function forecastTotals(f: Favorite, weights: SkillWeights | null): Promise<LocationTotals> {
  const [raw, nws] = await Promise.all([fetchOpenMeteo(f.lat, f.lon, f.elevationFt), fetchNwsSnow(f.lat, f.lon)])
  if (nws) raw.models.push({ model: 'nws', ...alignNwsSnow(nws, raw.times) })
  const b = blend(raw, weights ? skillModel(weights, f.lat, f.lon, f.elevationFt) : {})
  return { h72: b.next72.expected, d7: b.next7d.expected }
}
