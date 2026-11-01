import { defaultWeight, type BiasFn, type BlendOptions, type WeightFn } from './blend'
import type { ModelId } from './types'

/** One model's fit in one region × band × lead-day cell (see pipeline/bias.py). */
export interface CellStats {
  /** Multiplicative QPF correction: observed SWE ≈ bias × forecast precip. */
  bias: number
  /** Inverse-MAE² weight, normalised over the models in the cell. */
  weight: number
  /** Bias-corrected MAE (shrunk toward the parent cell), mm. */
  mae: number
  /** Uncorrected MAE, mm. */
  maeRaw: number
  n: number
}

type Cell = Partial<Record<ModelId, CellStats>>

export interface SkillWeights {
  version: number
  generated: string
  regions: Record<string, { bbox: [number, number, number, number]; order: number }>
  bands: Record<string, [number | null, number | null]>
  meta: {
    aliases?: Partial<Record<ModelId, Record<string, ModelId>>>
    dateRange?: [string, string]
    sites?: number
  }
  /** weights[region][band][leadDay][model]; "ALL" holds the pooled fallbacks. */
  weights: Record<string, Record<string, Record<string, Cell>>>
}

/** A cell is trusted only when every model in it has at least this many verified days. */
export const MIN_CELL_N = 100
const MAX_LEAD_DAY = 7

let pending: Promise<SkillWeights | null> | null = null

/** weights.json is committed to app/public/data by the pipeline. Missing or broken → null, and the app uses its heuristics. */
export function loadSkillWeights(): Promise<SkillWeights | null> {
  pending ??= fetch(`${import.meta.env.BASE_URL}data/weights.json`)
    .then(r => (r.ok ? r.json() : null))
    .then(j => (j?.version === 1 && j.weights ? (j as SkillWeights) : null))
    .catch(() => null)
  return pending
}

export function regionOf(w: SkillWeights, lat: number, lon: number): string | null {
  const ordered = Object.entries(w.regions).sort((a, b) => a[1].order - b[1].order)
  for (const [name, { bbox: [minLon, minLat, maxLon, maxLat] }] of ordered) {
    if (minLon <= lon && lon <= maxLon && minLat <= lat && lat <= maxLat) return name
  }
  return null
}

export function bandOf(w: SkillWeights, elevationFt: number): string | null {
  for (const [label, [lo, hi]] of Object.entries(w.bands)) {
    if ((lo == null || elevationFt >= lo) && (hi == null || elevationFt < hi)) return label
  }
  return null
}

export const leadDayOf = (leadH: number) => (leadH <= 0 ? 1 : Math.ceil(leadH / 24))

export interface SkillModel extends Required<BlendOptions> {
  weight: WeightFn
  bias: BiasFn
  /** Human-readable note on where the calibration came from. */
  calibration: string
}

/**
 * Turn weights.json into weight and bias functions for one location. For each lead day it uses the
 * most specific cell (region+band, region, band, statewide) with enough data behind it.
 */
export function skillModel(w: SkillWeights, lat: number, lon: number, elevationFt: number, fallback: WeightFn = defaultWeight): SkillModel {
  const region = regionOf(w, lat, lon)
  const band = bandOf(w, elevationFt)
  const candidates: [string, string][] = []
  if (region && band) candidates.push([region, band])
  if (region) candidates.push([region, 'ALL'])
  if (band) candidates.push(['ALL', band])
  candidates.push(['ALL', 'ALL'])

  const cells = new Map<number, Cell>()
  const used = new Set<string>()
  for (let day = 1; day <= MAX_LEAD_DAY; day++) {
    for (const [r, b] of candidates) {
      const cell = w.weights[r]?.[b]?.[String(day)]
      const stats = cell ? Object.values(cell) : []
      if (stats.length && stats.every(s => s!.n >= MIN_CELL_N)) {
        cells.set(day, cell!)
        used.add(r === 'ALL' && b === 'ALL' ? 'statewide' : [r, b].filter(x => x !== 'ALL').join(', '))
        break
      }
    }
  }

  const aliased = (model: ModelId, day: number) => w.meta.aliases?.[model]?.[String(day)] != null

  const weight: WeightFn = (model, leadH) => {
    const day = leadDayOf(leadH)
    // A seamless product that is a copy of another model at this lead would be counted twice.
    if (aliased(model, Math.min(day, MAX_LEAD_DAY))) return 0
    const base = fallback(model, leadH)
    const cell = cells.get(day)
    const s = cell?.[model]
    if (!cell || !s || base <= 0) return base
    // Learned weights sum to 1 within the cell; rescale them to the heuristic weight mass of the
    // same models so they mix sensibly with models the cell doesn't cover (NAM, NWS).
    let mass = 0
    for (const m of Object.keys(cell) as ModelId[]) mass += fallback(m, leadH)
    return s.weight * mass
  }

  const bias: BiasFn = (model, leadH) => {
    // Bias is a property of the model's climatology, so carry the last fitted day forward.
    const s = cells.get(Math.min(leadDayOf(leadH), MAX_LEAD_DAY))?.[model]
    // Only correct where it actually reduced error in verification.
    return s && s.mae <= s.maeRaw ? s.bias : 1
  }

  const sites = w.meta.sites ? `${w.meta.sites} SNOTEL sites` : 'SNOTEL'
  const range = w.meta.dateRange ? `, ${w.meta.dateRange[0].slice(0, 7)} to ${w.meta.dateRange[1].slice(0, 7)}` : ''
  const calibration = cells.size
    ? `Weights tuned on ${sites}${range} (${[...used].join('; ')})`
    : 'Default weights (not enough SNOTEL data for this area yet)'
  return { weight, bias, calibration }
}
