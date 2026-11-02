import { useEffect, useRef } from 'react'
import { createShakeDetector, enableMotion, globeParams, motionEnabled, motionNeedsPermission, SHAKE_EVENT } from '../globe'

interface Flake { x: number; y: number; vx: number; vy: number; r: number; phase: number }

/** A soft glowing flake drawn once and stamped, which is far cheaper than a gradient per flake. */
function makeSprite(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.25, 'rgba(255,255,255,0.95)')
  grad.addColorStop(0.5, 'rgba(180,220,255,0.45)')
  grad.addColorStop(1, 'rgba(180,220,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 32, 32)
  return c
}

/**
 * Shake the phone and the screen becomes a snow globe: flakes burst up in the shake's direction,
 * swirl, and settle. `forecastIn` (the biggest 72-hour forecast among favorites) sets how many flakes
 * and how long they float. Draws only while flakes are in the air.
 */
export function SnowGlobe({ forecastIn }: { forecastIn: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const params = useRef(globeParams(forecastIn))
  useEffect(() => { params.current = globeParams(forecastIn) }, [forecastIn])

  useEffect(() => {
    const cv = canvas.current
    if (!cv || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const ctx = cv.getContext('2d')!
    const sprite = makeSprite()
    let flakes: Flake[] = []
    let raf = 0
    let lastT = 0
    let w = 0
    let h = 0

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = window.innerWidth
      h = window.innerHeight
      cv.width = w * dpr
      cv.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const frame = (t: number) => {
      const dt = Math.min(0.05, (t - (lastT || t)) / 1000)
      lastT = t
      // Terminal fall speed so a flake starting at the top takes ~floatSeconds to reach the bottom.
      const vt = h / params.current.floatSeconds
      const settle = 1 - Math.exp(-dt * 1.6)
      const damp = Math.exp(-dt * 1.4)
      ctx.clearRect(0, 0, w, h)
      flakes = flakes.filter(f => {
        f.vy += (vt * (0.7 + f.r / 8) - f.vy) * settle
        f.vx = f.vx * damp + Math.sin(t / 700 + f.phase) * 14 * dt
        f.x += f.vx * dt
        f.y += f.vy * dt
        if (f.x < -10) f.x += w + 20
        else if (f.x > w + 10) f.x -= w + 20
        if (f.y > h + 12) return false
        const s = f.r * 4
        ctx.globalAlpha = Math.min(1, Math.max(0.15, (h + 12 - f.y) / 120))
        ctx.drawImage(sprite, f.x - s / 2, f.y - s / 2, s, s)
        return true
      })
      ctx.globalAlpha = 1
      raf = flakes.length ? requestAnimationFrame(frame) : 0
      if (!raf) lastT = 0
    }

    const shake = (dir: number, power: number) => {
      const { count } = params.current
      // Kick the flakes already up there, then top up to the forecast's count.
      for (const f of flakes) {
        f.vx += (dir * 260 + (Math.random() - 0.5) * 240) * power
        f.vy -= (250 + Math.random() * 350) * power
      }
      while (flakes.length < count) {
        flakes.push({
          x: Math.random() * w,
          y: h * (0.35 + Math.random() * 0.75),
          vx: (dir * 220 + (Math.random() - 0.5) * 420) * power,
          vy: -(380 + Math.random() * 620) * power,
          r: 1.2 + Math.random() * 3.2,
          phase: Math.random() * Math.PI * 2,
        })
      }
      if (!raf) raf = requestAnimationFrame(frame)
    }

    const onShakeEvent = (e: Event) => {
      const { dir = 0, power = 1 } = (e as CustomEvent<{ dir?: number; power?: number }>).detail ?? {}
      shake(dir, power)
    }
    window.addEventListener(SHAKE_EVENT, onShakeEvent)

    const detect = createShakeDetector(shake)
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity
      if (a?.x == null || a.y == null || a.z == null) return
      detect({ x: a.x, y: a.y, z: a.z }, e.timeStamp)
    }
    let listening = false
    const listen = () => {
      if (listening) return
      listening = true
      window.addEventListener('devicemotion', onMotion)
    }
    // Android and desktop deliver motion freely. iOS needs a tap each launch once the user opted in.
    if (!motionNeedsPermission()) listen()
    window.addEventListener('snowcast-motion', listen)
    const reask = () => { if (motionEnabled()) enableMotion() }
    if (motionNeedsPermission()) window.addEventListener('pointerdown', reask, { once: true })

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener(SHAKE_EVENT, onShakeEvent)
      window.removeEventListener('devicemotion', onMotion)
      window.removeEventListener('snowcast-motion', listen)
      window.removeEventListener('pointerdown', reask)
    }
  }, [])

  return <canvas ref={canvas} className="snow-globe" aria-hidden />
}
