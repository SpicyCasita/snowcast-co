import { describe, expect, it } from 'vitest'
import { LOCATIONS } from './data/locations'
import { WEBCAMS } from './data/webcams'

describe('resort webcams', () => {
  it('has a webcam page for every resort', () => {
    const resorts = LOCATIONS.filter(l => l.kind === 'resort')
    expect(resorts.length).toBe(25)
    for (const r of resorts) expect(WEBCAMS[r.id], r.name).toBeDefined()
  })

  it('only links https pages, and every id is a real resort', () => {
    const ids = new Set(LOCATIONS.filter(l => l.kind === 'resort').map(l => l.id))
    for (const [id, cam] of Object.entries(WEBCAMS)) {
      expect(ids.has(id), id).toBe(true)
      expect(cam.url.startsWith('https://'), id).toBe(true)
    }
  })

  it('labels the third-party pages', () => {
    expect(WEBCAMS.silverton.source).toMatch(/OpenSnow/)
    expect(WEBCAMS.echo.source).toBe('OnTheSnow')
    expect(Object.values(WEBCAMS).filter(c => c.source)).toHaveLength(2)
  })
})
