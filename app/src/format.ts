import type { Range } from './forecast/blend'

export const inches = (x: number) => (x < 0.1 ? '0' : x < 1 ? x.toFixed(1) : String(Math.round(x)))

export const range = (r: Range) => {
  const lo = inches(r.low)
  const hi = inches(r.high)
  return lo === hi ? `${hi}"` : `${lo}–${hi}"`
}

export const feet = (ft: number) => `${Math.round(ft).toLocaleString()}′`

/** Ensemble shares come from ~80 members, so whole percents clamped away from 0/100 are honest. */
export const pct = (p: number) => `${Math.min(99, Math.max(1, Math.round(p * 100)))}%`

export const confidenceLabel = (p: number) => `${pct(p)} confident`

export const bucketLabel = ([lo, hi]: [number, number | null]) => (hi == null ? `${lo}"+` : `${lo}–${hi}"`)

const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' })
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
export const dayLabel = (isoDate: string, i: number) => {
  const d = new Date(`${isoDate}T12:00:00Z`)
  return { top: i === 0 ? 'Today' : weekday.format(d), bottom: monthDay.format(d) }
}
