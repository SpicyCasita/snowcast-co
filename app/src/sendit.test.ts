import { describe, expect, it } from 'vitest'
import { SCENES } from './components/sendit/scenes'
import { captionAt, forcedScene, pickScene } from './components/sendit/SendItShow'

describe('SEND IT scenes', () => {
  it('has ten scenes with ids 1–10', () => {
    expect(SCENES.map(s => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(new Set(SCENES.map(s => s.title)).size).toBe(10)
  })

  it('runs each scene 8–15 seconds', () => {
    for (const s of SCENES) {
      expect(s.seconds, s.title).toBeGreaterThanOrEqual(8)
      expect(s.seconds, s.title).toBeLessThanOrEqual(15)
    }
  })

  it('keeps captions inside the timeline, in order, without overlap', () => {
    for (const s of SCENES) {
      let end = 0
      for (const c of s.captions) {
        expect(c.from, s.title).toBeGreaterThanOrEqual(end)
        expect(c.to, s.title).toBeGreaterThan(c.from)
        expect(c.to, s.title).toBeLessThanOrEqual(100)
        end = c.to
      }
      expect(s.captions.at(-1)!.to, `${s.title} ends on a caption`).toBe(100)
    }
  })

  it('shows the caption for the current moment', () => {
    const s = SCENES[0]
    expect(captionAt(s, 0)).toBe(s.captions[0].text)
    expect(captionAt(s, 99.9)).toBe(s.captions.at(-1)!.text)
    expect(captionAt(s, 34)).toBe('') // a beat of silence between captions
  })
})

describe('picking a scene', () => {
  it('never repeats the last one', () => {
    for (let last = 1; last <= 10; last++) {
      for (const r of [0, 0.3, 0.6, 0.9999]) expect(pickScene(last, () => r).id).not.toBe(last)
    }
  })

  it('can reach every scene', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) seen.add(pickScene(null, () => (i % 10) / 10 + 0.01).id)
    expect(seen.size).toBe(10)
  })

  it('reads ?sendit=N for testing', () => {
    expect(forcedScene('https://x/snowcast-co/?sendit=7#/')?.title).toBe('Face Shot')
    expect(forcedScene('https://x/snowcast-co/#/?sendit=10')?.title).toBe('Jalapeño Jr.')
    expect(forcedScene('https://x/snowcast-co/?sendit=11')).toBeNull()
    expect(forcedScene('https://x/snowcast-co/#/')).toBeNull()
  })
})
