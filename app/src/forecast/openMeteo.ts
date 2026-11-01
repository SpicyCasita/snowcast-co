import { FT_PER_M } from '../data/locations'
import type { ModelId, ModelSeries, RawForecast } from './types'

export const OPEN_METEO_MODELS: ModelId[] = [
  'ncep_hrrr_conus',
  'ncep_nam_conus',
  'ecmwf_ifs025',
  'gfs_seamless',
  'gem_seamless',
  'icon_seamless',
]

const HOURLY = ['precipitation', 'snowfall', 'temperature_2m', 'freezing_level_height']

type Num = number | null

/**
 * Fetch every model's hourly forecast for a point. Open-Meteo downscales temperature
 * to the requested elevation, which is what makes summit vs. base forecasts differ.
 */
export async function fetchOpenMeteo(lat: number, lon: number, elevationFt: number, signal?: AbortSignal): Promise<RawForecast> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    elevation: (elevationFt / FT_PER_M).toFixed(0),
    hourly: HOURLY.join(','),
    models: OPEN_METEO_MODELS.join(','),
    // forecast_days is ignored once past_hours is set, so ask for hours explicitly.
    forecast_hours: '240',
    past_hours: '24',
    timezone: 'GMT',
    timeformat: 'unixtime',
    precipitation_unit: 'inch',
    temperature_unit: 'fahrenheit',
  })
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal })
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`)
  const json = await res.json()
  const h = json.hourly as Record<string, Num[]>
  const times = json.hourly.time as number[]

  const models: ModelSeries[] = OPEN_METEO_MODELS.map(model => ({
    model,
    precipIn: h[`precipitation_${model}`] ?? times.map(() => null),
    tempF: h[`temperature_2m_${model}`] ?? times.map(() => null),
    rawSnowIn: h[`snowfall_${model}`] ?? times.map(() => null),
    // Open-Meteo returns freezing level in feet when imperial precip units are requested.
    freezingLevelFt: h[`freezing_level_height_${model}`] ?? times.map(() => null),
  })).filter(m => m.precipIn.some(v => v != null))

  const nowSec = Date.now() / 1000
  const nowIndex = Math.max(0, times.findIndex(t => t + 3600 > nowSec))
  return { times, nowIndex, elevationFt, models }
}

/** Terrain elevation (90m DEM) for a tapped map point. */
export async function fetchElevationFt(lat: number, lon: number): Promise<number> {
  const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`)
  if (!res.ok) throw new Error(`Elevation ${res.status}`)
  const json = await res.json()
  return Math.round(json.elevation[0] * FT_PER_M)
}
