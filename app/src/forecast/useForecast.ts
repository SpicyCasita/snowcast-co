import { useEffect, useState } from 'react'
import { blend, type BlendedForecast } from './blend'
import { alignNwsSnow, fetchNwsSnow } from './nws'
import { fetchOpenMeteo } from './openMeteo'
import { loadSkillWeights, skillModel } from './skill'

const TTL_MS = 15 * 60 * 1000
const cache = new Map<string, { at: number; promise: Promise<BlendedForecast> }>()

/**
 * Fetch every model plus NWS in parallel and blend them with the SNOTEL-tuned weights when available.
 * Results are shared and cached for 15 minutes.
 */
export function getForecast(lat: number, lon: number, elevationFt: number): Promise<BlendedForecast> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${Math.round(elevationFt)}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise
  const promise = Promise.all([fetchOpenMeteo(lat, lon, elevationFt), fetchNwsSnow(lat, lon), loadSkillWeights()]).then(([raw, nws, weights]) => {
    if (nws) raw.models.push({ model: 'nws', ...alignNwsSnow(nws, raw.times) })
    return blend(raw, weights ? skillModel(weights, lat, lon, elevationFt) : {})
  })
  promise.catch(() => cache.delete(key))
  cache.set(key, { at: Date.now(), promise })
  return promise
}

export type ForecastState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; forecast: BlendedForecast }

export function useForecast(lat: number, lon: number, elevationFt: number | null): ForecastState {
  const [state, setState] = useState<ForecastState>({ status: 'loading' })
  useEffect(() => {
    if (elevationFt == null) return
    let live = true
    setState({ status: 'loading' })
    getForecast(lat, lon, elevationFt).then(
      forecast => live && setState({ status: 'ready', forecast }),
      e => live && setState({ status: 'error', error: String(e.message ?? e) }),
    )
    return () => { live = false }
  }, [lat, lon, elevationFt])
  return state
}
