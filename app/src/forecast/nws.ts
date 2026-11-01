import type { ModelSeries } from './types'

const MM_PER_IN = 25.4

/** Parse an ISO 8601 duration like "PT6H" or "P1DT12H" into hours. */
export function durationHours(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?)?$/.exec(iso)
  if (!m) return 1
  return Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0) || 1
}

export type NwsSnowValues = { validTime: string; value: number | null }[]

/**
 * The NWS official (NDFD) snowfall forecast periods, in mm. Returns null when the point is outside
 * NWS coverage or the API is down; the forecast still works from the other models.
 */
export async function fetchNwsSnow(lat: number, lon: number, signal?: AbortSignal): Promise<NwsSnowValues | null> {
  try {
    const point = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { signal })
    if (!point.ok) return null
    const gridUrl = (await point.json()).properties.forecastGridData as string
    const grid = await fetch(gridUrl, { signal })
    if (!grid.ok) return null
    return (await grid.json()).properties.snowfallAmount.values as NwsSnowValues
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    return null
  }
}

/** Spread each NWS period total evenly over its hours, aligned to `times`, in inches. */
export function alignNwsSnow(values: NwsSnowValues, times: number[]): Omit<ModelSeries, 'model'> {
  const rawSnowIn: (number | null)[] = times.map(() => null)
  const index = new Map(times.map((t, i) => [t, i]))
  for (const { validTime, value } of values) {
    if (value == null) continue
    const [start, dur] = validTime.split('/')
    const hours = durationHours(dur)
    const t0 = Math.floor(Date.parse(start) / 1000)
    for (let k = 0; k < hours; k++) {
      const i = index.get(t0 + k * 3600)
      if (i != null) rawSnowIn[i] = value / MM_PER_IN / hours
    }
  }
  const empty = times.map(() => null)
  return { precipIn: empty, tempF: empty, rawSnowIn, freezingLevelFt: empty }
}
