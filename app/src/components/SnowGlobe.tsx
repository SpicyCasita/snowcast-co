import { useEffect, useRef } from 'react'
import { AGITATE_MIN, createMotionFilter, enableMotion, globeParams, motionEnabled, motionNeedsPermission, SHAKE_EVENT, STIR_MIN, type GlobeMotion } from '../globe'

interface Flake {
  x: number
  y: number
  vx: number
  vy: number
  /** Diameter in CSS px. */
  size: number
  sprite: number
  rot: number
  spin: number
  /** Tumble phase: flakes flip edge-on as they fall. */
  flip: number
  flipRate: number
  /** 0.4 (far, faint) … 1 (near). */
  depth: number
  /** Seconds spent resting on the bottom of the globe; null while floating. */
  rest: number | null
}

const SPRITE_PX = 64
const REST_SECONDS = 2.2
/** Screen px/s of flake velocity per m/s² of phone acceleration, per second it lasts. */
const PUSH = 320

/** Draw one sprite: an ice crystal (or a soft dot) with a cold glow. */
function sprite(kind: 'dendrite' | 'star' | 'plate' | 'dot'): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = SPRITE_PX
  const g = c.getContext('2d')!
  g.translate(SPRITE_PX / 2, SPRITE_PX / 2)
  if (kind === 'dot') {
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, SPRITE_PX / 2)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.35, 'rgba(235,245,255,0.8)')
    grad.addColorStop(1, 'rgba(180,220,255,0)')
    g.fillStyle = grad
    g.fillRect(-SPRITE_PX / 2, -SPRITE_PX / 2, SPRITE_PX, SPRITE_PX)
    return c
  }
  const R = SPRITE_PX * 0.42
  g.strokeStyle = 'rgba(255,255,255,0.97)'
  g.fillStyle = 'rgba(255,255,255,0.97)'
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.shadowColor = 'rgba(160,210,255,0.95)'
  g.shadowBlur = 5
  g.lineWidth = kind === 'plate' ? 2.4 : 2.8
  for (let i = 0; i < 6; i++) {
    g.save()
    g.rotate((i * Math.PI) / 3)
    g.beginPath()
    g.moveTo(0, 0)
    g.lineTo(0, -R)
    if (kind === 'dendrite') {
      // Two pairs of side branches, longer near the middle, like a stellar dendrite.
      for (const [at, len] of [[0.45, 0.34], [0.72, 0.24]] as const) {
        g.moveTo(0, -R * at)
        g.lineTo(-R * len * 0.8, -R * (at + len * 0.6))
        g.moveTo(0, -R * at)
        g.lineTo(R * len * 0.8, -R * (at + len * 0.6))
      }
    } else if (kind === 'star') {
      // Forked tips.
      g.moveTo(0, -R * 0.78)
      g.lineTo(-R * 0.16, -R * 0.98)
      g.moveTo(0, -R * 0.78)
      g.lineTo(R * 0.16, -R * 0.98)
    } else {
      // Sector plate: arms ending in small paddles.
      g.moveTo(-R * 0.12, -R * 0.62)
      g.lineTo(R * 0.12, -R * 0.62)
    }
    g.stroke()
    g.restore()
  }
  if (kind === 'plate') {
    g.beginPath()
    for (let i = 0; i <= 6; i++) {
      const a = (i * Math.PI) / 3 + Math.PI / 6
      g.lineTo(Math.cos(a) * R * 0.42, Math.sin(a) * R * 0.42)
    }
    g.lineWidth = 2
    g.stroke()
  }
  g.beginPath()
  g.arc(0, 0, kind === 'plate' ? 2.4 : 3, 0, Math.PI * 2)
  g.fill()
  return c
}

/**
 * Shake the phone and the screen becomes a snow globe. Every motion sample pushes the snow (it lags
 * the glass like a fluid, so a flick leaves it swirling), gentle shakes stir settled snow up, flakes
 * tumble down toward the real "down" (tilt the phone and they drift that way), bounce softly off the
 * sides and rest at the bottom before fading. `forecastIn` (the biggest 72-hour forecast among
 * favorites) sets how many flakes there are and how slowly they settle. Draws only while snow is moving.
 */
export function SnowGlobe({ forecastIn }: { forecastIn: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const params = useRef(globeParams(forecastIn))
  useEffect(() => { params.current = globeParams(forecastIn) }, [forecastIn])

  useEffect(() => {
    const cv = canvas.current
    if (!cv || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const surface: HTMLCanvasElement = cv
    const ctx = surface.getContext('2d')!
    const sprites = [sprite('dendrite'), sprite('star'), sprite('plate'), sprite('dot')]
    let flakes: Flake[] = []
    let raf = 0
    let lastT = 0
    let w = 0
    let h = 0
    let dpr = 1
    let turbulence = 0
    let down = { x: 0, y: 1 }
    let fall = 1

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = window.innerWidth
      h = window.innerHeight
      cv.width = w * dpr
      cv.height = h * dpr
    }
    resize()
    window.addEventListener('resize', resize)

    const wake = () => { if (!raf) raf = requestAnimationFrame(frame) }
    const settle = (f: Flake) => { f.rest = 0; f.vx = 0; f.vy = 0 }

    /** New flakes start resting on the bottom of the globe, then get thrown up. */
    const spawn = (n: number, kick: number) => {
      const room = params.current.count - flakes.length
      for (let i = 0; i < Math.min(n, room); i++) {
        const depth = 0.4 + Math.random() * 0.6
        const crystal = depth > 0.55
        // Along the "bottom" edge relative to gravity.
        const along = Math.random()
        const x = down.x > 0.7 ? w - Math.random() * 40 : down.x < -0.7 ? Math.random() * 40 : along * w
        const y = down.y > 0.7 ? h - Math.random() * h * 0.2 : down.y < -0.7 ? Math.random() * h * 0.2 : along * h
        const speed = (260 + Math.random() * 520) * kick
        flakes.push({
          x, y,
          vx: -down.x * speed + (Math.random() - 0.5) * 420 * kick,
          vy: -down.y * speed + (Math.random() - 0.5) * 220 * kick,
          size: crystal ? 9 + depth * 15 : 3 + depth * 4,
          sprite: crystal ? Math.floor(Math.random() * 3) : 3,
          rot: Math.random() * Math.PI * 2,
          spin: (Math.random() - 0.5) * 2.4,
          flip: Math.random() * Math.PI * 2,
          flipRate: 1 + Math.random() * 2.5,
          depth,
          rest: null,
        })
      }
    }

    /** One motion sample (or a synthetic shake): push every flake, stir up more if it's brisk. */
    const agitate = (m: GlobeMotion, dt: number) => {
      down = m.down
      fall = Math.max(0.35, m.tilt)
      if (m.magnitude < AGITATE_MIN && flakes.length === 0) return
      if (m.magnitude >= AGITATE_MIN) {
        for (const f of flakes) {
          const push = PUSH * dt * (0.6 + f.depth * 0.6)
          f.vx -= m.accel.x * push
          f.vy -= m.accel.y * push
          if (f.rest != null && Math.hypot(m.accel.x, m.accel.y) * push > 25) f.rest = null
        }
        turbulence = Math.min(3, turbulence + m.magnitude * dt * 1.6)
      }
      if (m.magnitude >= STIR_MIN) spawn(Math.ceil(params.current.count * 0.05 * (m.magnitude / STIR_MIN)), Math.min(2, m.magnitude / (STIR_MIN * 2)))
      wake()
    }

    function frame(t: number) {
      const dt = Math.min(0.05, (t - (lastT || t)) / 1000)
      lastT = t
      const { floatSeconds } = params.current
      const drag = 1 - Math.exp(-dt * 1.9)
      turbulence *= Math.exp(-dt / 1.3)
      const T = t / 1000
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, surface.width, surface.height)
      flakes = flakes.filter(f => {
        if (f.rest != null) {
          f.rest += dt
          if (f.rest > REST_SECONDS) return false
        } else {
          // Bigger flakes sink faster; terminal speed so the average flake crosses the screen in floatSeconds.
          const vt = (h / floatSeconds) * (0.55 + f.size / 40) * fall
          const swirlX = Math.sin(f.y * 0.011 + T * 1.7 + f.flip) * turbulence * 120
          const swirlY = Math.cos(f.x * 0.013 + T * 1.3 + f.rot) * turbulence * 90
          // Flutter: a light sideways sway as each flake tumbles.
          const flutter = Math.sin(T * f.flipRate * 1.3 + f.flip) * 18
          f.vx += (down.x * vt + swirlX + flutter * -down.y - f.vx) * drag
          f.vy += (down.y * vt + swirlY + flutter * down.x - f.vy) * drag
          f.x += f.vx * dt
          f.y += f.vy * dt
          f.rot += f.spin * dt * (1 + turbulence)
          f.flip += f.flipRate * dt
          // The glass: soft bounces off the walls, and flakes come to rest on whichever edge is "down".
          const r = f.size / 2
          if (f.x < r || f.x > w - r) {
            const edge = f.x < r ? -1 : 1
            f.x = edge < 0 ? r : w - r
            if (edge * down.x > 0.7) settle(f)
            else f.vx *= -0.35
          }
          if (f.y < r || f.y > h - r) {
            const edge = f.y < r ? -1 : 1
            f.y = edge < 0 ? r : h - r
            if (edge * down.y > 0.7) settle(f)
            else f.vy *= -0.35
          }
        }
        const fade = f.rest == null ? 1 : 1 - f.rest / REST_SECONDS
        const tumble = 0.45 + 0.55 * Math.abs(Math.cos(f.flip))
        const cos = Math.cos(f.rot)
        const sin = Math.sin(f.rot)
        const s = f.size * dpr
        ctx.globalAlpha = (0.35 + f.depth * 0.6) * fade
        ctx.setTransform(cos * s, sin * s, -sin * s * tumble, cos * s * tumble, f.x * dpr, f.y * dpr)
        ctx.drawImage(sprites[f.sprite], -0.5, -0.5, 1, 1)
        return true
      })
      ctx.globalAlpha = 1
      raf = flakes.length ? requestAnimationFrame(frame) : 0
      if (!raf) {
        lastT = 0
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, surface.width, surface.height)
      }
    }

    // Header button / demo: a short burst of synthetic shaking in the given direction.
    const onShakeEvent = (e: Event) => {
      const { dir = 0, power = 1 } = (e as CustomEvent<{ dir?: number; power?: number }>).detail ?? {}
      const base: GlobeMotion = { accel: { x: 0, y: 0 }, magnitude: 0, down, tilt: fall }
      ;[1, -1, 1, -0.6].forEach((k, i) => window.setTimeout(() => {
        const ax = (dir || 1) * 7 * k * power
        agitate({ ...base, accel: { x: ax, y: -4 * Math.abs(k) * power }, magnitude: Math.hypot(ax, 4 * power) }, 0.06)
      }, i * 70))
    }
    window.addEventListener(SHAKE_EVENT, onShakeEvent)

    const filter = createMotionFilter()
    let lastStamp = 0
    const onMotion = (e: DeviceMotionEvent) => {
      const incl = e.accelerationIncludingGravity
      if (incl?.x == null || incl.y == null || incl.z == null) return
      const lin = e.acceleration
      const linear = lin?.x != null && lin.y != null && lin.z != null ? { x: lin.x, y: lin.y, z: lin.z } : null
      const dt = lastStamp ? Math.min(0.1, (e.timeStamp - lastStamp) / 1000) : (e.interval || 16) / 1000
      lastStamp = e.timeStamp
      agitate(filter({ x: incl.x, y: incl.y, z: incl.z }, linear), dt)
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
