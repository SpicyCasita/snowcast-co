/** Snow-globe shake: tuning, shake detection, and the motion-permission dance iOS requires. */

export const SHAKE_EVENT = 'snowcast-shake'
const MOTION_KEY = 'snowcast.motion'

/** The bigger the forecast, the more flakes and the longer they float. Capped at a 3-foot forecast. */
export function globeParams(forecastIn: number): { count: number; floatSeconds: number } {
  const x = Math.max(0, Math.min(forecastIn, 36))
  return { count: Math.round(70 + x * 18), floatSeconds: Math.round((4 + x * 0.45) * 10) / 10 }
}

export interface Accel { x: number; y: number; z: number }
export interface ShakeOptions { threshold?: number; jolts?: number; windowMs?: number; cooldownMs?: number }

/**
 * Feed it accelerometer samples (m/s², gravity included). It calls onShake when it sees `jolts` sharp
 * changes within `windowMs`, with a horizontal direction (-1 left … 1 right) and a power of 0.5–2.
 * Direction comes from the first jolt: a back-and-forth shake's later jolts cancel it out.
 */
export function createShakeDetector(onShake: (dir: number, power: number) => void, opts: ShakeOptions = {}) {
  const { threshold = 14, jolts = 2, windowMs = 800, cooldownMs = 700 } = opts
  let prev: Accel | null = null
  let hits: { t: number; dx: number; mag: number }[] = []
  let last = -Infinity
  return (a: Accel, t: number) => {
    if (prev) {
      const dx = a.x - prev.x
      const mag = Math.hypot(dx, a.y - prev.y, a.z - prev.z)
      if (mag > threshold) hits.push({ t, dx, mag })
    }
    prev = a
    hits = hits.filter(h => t - h.t < windowMs)
    if (hits.length >= jolts && t - last > cooldownMs) {
      last = t
      const dx = hits[0].dx
      const power = Math.min(2, Math.max(0.5, Math.max(...hits.map(h => h.mag)) / (threshold * 1.5)))
      hits = []
      onShake(dx === 0 ? 0 : Math.sign(dx), power)
    }
  }
}

/** Ask the globe to shake (also what the header button does on desktop and as a demo). */
export const shakeGlobe = (dir = 0, power = 1) => window.dispatchEvent(new CustomEvent(SHAKE_EVENT, { detail: { dir, power } }))

type PermissionFn = () => Promise<'granted' | 'denied'>
const permissionFn = (): PermissionFn | undefined =>
  (globalThis.DeviceMotionEvent as unknown as { requestPermission?: PermissionFn } | undefined)?.requestPermission

/** iOS needs a tap-triggered permission prompt; Android and desktop don't. */
export const motionNeedsPermission = () => typeof permissionFn() === 'function'

export function motionEnabled(): boolean {
  try { return localStorage.getItem(MOTION_KEY) === 'on' } catch { return false }
}

/** Call from a tap. Resolves true when motion events will flow. */
export async function enableMotion(): Promise<boolean> {
  const ask = permissionFn()
  const ok = ask ? (await ask().catch(() => 'denied')) === 'granted' : true
  try { localStorage.setItem(MOTION_KEY, ok ? 'on' : 'off') } catch { /* not persisted */ }
  if (ok) window.dispatchEvent(new Event('snowcast-motion'))
  return ok
}
