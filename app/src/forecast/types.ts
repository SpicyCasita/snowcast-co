export type ModelId =
  | 'ncep_hrrr_conus'
  | 'ncep_nam_conus'
  | 'ecmwf_ifs025'
  | 'gfs_seamless'
  | 'gem_seamless'
  | 'icon_seamless'
  | 'nws'

export const MODEL_LABELS: Record<ModelId, string> = {
  ncep_hrrr_conus: 'HRRR',
  ncep_nam_conus: 'NAM 3km',
  ecmwf_ifs025: 'ECMWF',
  gfs_seamless: 'GFS',
  gem_seamless: 'GEM',
  icon_seamless: 'ICON',
  nws: 'NWS',
}

/** One model's hourly series, aligned to the shared `times` array. Missing hours are null. */
export interface ModelSeries {
  model: ModelId
  /** Liquid precip, inches/hour. */
  precipIn: (number | null)[]
  tempF: (number | null)[]
  /** Model's own snowfall (inches). For NWS this is the only field populated. */
  rawSnowIn: (number | null)[]
  freezingLevelFt: (number | null)[]
}

export interface RawForecast {
  /** Unix seconds, hourly, UTC. */
  times: number[]
  /** Hour index of "now" within `times`. */
  nowIndex: number
  elevationFt: number
  models: ModelSeries[]
}
