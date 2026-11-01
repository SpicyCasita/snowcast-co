import { FT_PER_M } from '../data/locations'
import type { EnsembleSeries, ModelId } from './types'

/** Ensemble products and the deterministic model whose SNOTEL bias they share. */
const FAMILIES: { api: string; key: string; family: ModelId }[] = [
  { api: 'gfs025', key: 'ncep_gefs025', family: 'gfs_seamless' },
  { api: 'ecmwf_ifs025', key: 'ecmwf_ifs025_ensemble', family: 'ecmwf_ifs025' },
]

type Num = number | null

export interface EnsembleResponse {
  hourly: Record<string, Num[]>
  times: number[]
}

/**
 * GEFS (31 members) and ECMWF ENS (51 members) hourly precip and temperature; align with `parseEnsemble`.
 * Returns null on any failure: the forecast then falls back to the deterministic model spread.
 */
export async function fetchEnsemble(lat: number, lon: number, elevationFt: number, signal?: AbortSignal): Promise<EnsembleResponse | null> {
  try {
    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      elevation: (elevationFt / FT_PER_M).toFixed(0),
      hourly: 'precipitation,temperature_2m',
      models: FAMILIES.map(f => f.api).join(','),
      forecast_hours: '240',
      past_hours: '24',
      timezone: 'GMT',
      timeformat: 'unixtime',
      precipitation_unit: 'inch',
      temperature_unit: 'fahrenheit',
    })
    const res = await fetch(`https://ensemble-api.open-meteo.com/v1/ensemble?${params}`, { signal })
    if (!res.ok) return null
    const json = await res.json()
    return { hourly: json.hourly, times: json.hourly.time }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    return null
  }
}

/** Split the flat `precipitation_memberNN_<model>` columns into one series per member. */
export function parseEnsemble(hourly: Record<string, Num[]>, ensTimes: number[], times: number[]): EnsembleSeries[] | null {
  const index = new Map(ensTimes.map((t, i) => [t, i]))
  const align = (col: Num[]) => times.map(t => {
    const i = index.get(t)
    return i == null ? null : col[i] ?? null
  })
  const members: EnsembleSeries[] = []
  for (const { key, family } of FAMILIES) {
    // The control run has no member number; perturbed members are member01, member02, ...
    const suffixes = [`_${key}`, ...Object.keys(hourly)
      .map(k => /^precipitation(_member\d+_.+)$/.exec(k)?.[1])
      .filter((s): s is string => !!s && s.endsWith(`_${key}`))]
    for (const s of suffixes) {
      const p = hourly[`precipitation${s}`]
      const t = hourly[`temperature_2m${s}`]
      if (!p || !t) continue
      members.push({ family, precipIn: align(p), tempF: align(t) })
    }
  }
  return members.length ? members : null
}
