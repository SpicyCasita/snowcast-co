import { describe, expect, it } from 'vitest'
import { locationForSlot, MAX_ENTRY_AGE_MS, summarize } from '../src/colorado'

const now = Date.parse('2026-11-10T12:00:00Z')

describe('colorado snow summary', () => {
  it('reports the snowiest fresh location and flags 1 inch or more', () => {
    const s = summarize({
      a: { name: 'Breckenridge', in48: 3.26, at: now - 60_000 },
      b: { name: 'Vail', in48: 0.4, at: now - 120_000 },
    }, now)
    expect(s).toMatchObject({ snow: true, maxInches: 3.3, where: 'Breckenridge', locationsChecked: 2, thresholdInches: 1 })
  })

  it('stays off under an inch', () => {
    expect(summarize({ a: { name: 'Vail', in48: 0.9, at: now } }, now)).toMatchObject({ snow: false, maxInches: 0.9 })
  })

  it('ignores stale totals so an old storm does not linger', () => {
    const s = summarize({ a: { name: 'Old', in48: 12, at: now - MAX_ENTRY_AGE_MS - 1 } }, now)
    expect(s).toMatchObject({ snow: false, maxInches: 0, where: null, locationsChecked: 0, updated: null })
  })

  it('rotates through every location', () => {
    const locs = [{ id: 'x' }, { id: 'y' }, { id: 'z' }] as Parameters<typeof locationForSlot>[1]
    expect([0, 1, 2, 3, -1].map(n => locationForSlot(n, locs).id)).toEqual(['x', 'y', 'z', 'x', 'z'])
  })
})
