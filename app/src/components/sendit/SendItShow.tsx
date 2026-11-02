import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Defs, SCENES, type Scene } from './scenes'
import './sendit.css'

const LAST_KEY = 'snowcast.lastSendIt'

/** A random scene, never the same one twice in a row. */
export function pickScene(lastId: number | null, rand: () => number = Math.random): Scene {
  const pool = SCENES.filter(s => s.id !== lastId)
  return pool[Math.floor(rand() * pool.length) % pool.length]
}

/** `?sendit=3` (or `#…?sendit=3`) forces scene 3, for testing. */
export function forcedScene(href = location.href): Scene | null {
  const m = /[?&]sendit=(\d+)\b/.exec(href)
  return m ? SCENES.find(s => s.id === Number(m[1])) ?? null : null
}

export const captionAt = (scene: Scene, pct: number) => scene.captions.find(c => pct >= c.from && pct < c.to)?.text ?? ''

/** Pure: reads the last scene shown but doesn't record anything (render code may run twice). */
function chooseScene(): Scene {
  const forced = forcedScene()
  if (forced) return forced
  let last: number | null = null
  try { last = Number(sessionStorage.getItem(LAST_KEY)) || null } catch { /* no storage */ }
  return pickScene(last)
}

/** Plays one SEND IT cartoon full screen, then calls onDone. Tap or Escape skips. */
export function SendItShow({ onDone }: { onDone: () => void }) {
  const scene = useMemo(chooseScene, [])
  const [pct, setPct] = useState(0)

  // Record the scene actually on screen, so the next SEND IT picks a different one.
  useEffect(() => {
    try { sessionStorage.setItem(LAST_KEY, String(scene.id)) } catch { /* no storage */ }
  }, [scene])

  useEffect(() => {
    const start = performance.now()
    const ms = scene.seconds * 1000
    const tick = window.setInterval(() => setPct(Math.min(100, ((performance.now() - start) / ms) * 100)), 100)
    // `&hold=1` (testing only) keeps the scene open so frames can be inspected.
    const hold = /[?&]hold=1(?!\d)/.test(location.href)
    const end = hold ? 0 : window.setTimeout(onDone, ms + 600)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onDone()
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(tick)
      window.clearTimeout(end)
      window.removeEventListener('keydown', onKey)
    }
  }, [scene, onDone])

  const caption = captionAt(scene, pct)
  const dur = { '--dur': `${scene.seconds}s` } as CSSProperties
  return (
    <div className="sendit" role="dialog" aria-modal="true" aria-label={`SEND IT: ${scene.title}`} onClick={onDone} data-scene={scene.id} data-seconds={scene.seconds}>
      <p className="sendit-title">{scene.title}</p>
      <div className="sendit-stage">
        <svg className="si" viewBox="0 0 400 500" preserveAspectRatio="xMidYMid slice" style={dur} aria-hidden>
          <Defs />
          {scene.art()}
        </svg>
      </div>
      <div className="sendit-caption" aria-live="polite">{caption && <span key={caption}>{caption}</span>}</div>
      <div className="sendit-progress" style={dur}><i /></div>
      <p className="sendit-skip">Tap to skip</p>
    </div>
  )
}
