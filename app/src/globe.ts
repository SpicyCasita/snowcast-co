/** Snow-globe shake: tuning, shake detection, and the motion-permission dance iOS requires. */

export const SHAKE_EVENT = 'snowcast-shake'
const MOTION_KEY = 'snowcast.motion'

/** The bigger the forecast, the more flakes and the longer they float. Capped at a 3-foot forecast. */
export function globeParams(forecastIn: number): { count: number; floatSeconds: number } {
  const x = Math.max(0, Math.min(forecastIn, 36))
  return { count: Math.round(70 + x * 18), floatSeconds: Math.round((4 + x * 0.45) * 10) / 10 }
}

export interface Accel { x: number; y: number; z: number }

/** Any linear acceleration above this (m/s², ~0.15 g) pushes flakes already in the air. */
export const AGITATE_MIN = 1.5
/** A gentle shake above this (m/s², ~0.25 g) stirs settled snow up into the globe. */
export const STIR_MIN = 2.5

/** A motion sample in screen coordinates (x right, y down), in m/s². */
export interface GlobeMotion {
  /** The phone's own acceleration (gravity removed): the snow lags the glass, so it pushes the other way. */
  accel: { x: number; y: number }
  /** Size of that acceleration in 3-D. */
  magnitude: number
  /** Which way is down on screen, as a unit vector, plus how much of gravity lies in the screen plane (0–1). */
  down: { x: number; y: number }
  tilt: number
}

/**
 * Turns raw DeviceMotion samples into globe motion, reacting on the very first sample.
 * Uses the browser's gravity-free `acceleration` when it has one (iOS does); otherwise it separates
 * gravity from `accelerationIncludingGravity` with a fast low-pass filter.
 */
export function createMotionFilter(smoothing = 0.12) {
  let gravity: Accel | null = null
  // Browsers disagree on sign (the spec reports +9.8 "up" on the y axis when held upright; iOS Safari
  // has historically reported −9.8). Calibrate from the first clearly upright-ish sample, since people
  // hold the phone top-up when they start shaking.
  let sign: number | null = null
  return (incl: Accel, linear?: Accel | null): GlobeMotion => {
    gravity = gravity
      ? { x: gravity.x + (incl.x - gravity.x) * smoothing, y: gravity.y + (incl.y - gravity.y) * smoothing, z: gravity.z + (incl.z - gravity.z) * smoothing }
      : { ...incl }
    if (sign == null && Math.abs(incl.y) > 3) sign = Math.sign(incl.y)
    const s = sign ?? 1
    const lin = linear ?? { x: incl.x - gravity.x, y: incl.y - gravity.y, z: incl.z - gravity.z }
    // Device axes: x right, y toward the top of the screen; screen y grows downward.
    const downX = -s * gravity.x
    const downY = s * gravity.y
    const inPlane = Math.hypot(downX, downY)
    const g = Math.hypot(gravity.x, gravity.y, gravity.z) || 9.81
    return {
      accel: { x: s * lin.x, y: -s * lin.y },
      magnitude: Math.hypot(lin.x, lin.y, lin.z),
      down: inPlane > 0.5 ? { x: downX / inPlane, y: downY / inPlane } : { x: 0, y: 1 },
      tilt: Math.min(1, inPlane / g),
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
