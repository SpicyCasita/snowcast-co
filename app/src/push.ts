import type { SnowLocation } from './data/locations'

/** Base URL of the alerts Worker (worker/); unset means alerts are unavailable in this build. */
const API = (import.meta.env.VITE_ALERTS_API as string | undefined)?.replace(/\/+$/, '') || null

export interface Thresholds {
  /** Inches; null turns that window off. */
  h72In: number | null
  d7In: number | null
}

const THRESHOLDS_KEY = 'snowcast.alertThresholds'
export const DEFAULT_THRESHOLDS: Thresholds = { h72In: 6, d7In: 12 }

export function loadThresholds(): Thresholds {
  try {
    const raw = localStorage.getItem(THRESHOLDS_KEY)
    const t = raw ? JSON.parse(raw) : null
    if (t && 'h72In' in t && 'd7In' in t) return { h72In: t.h72In ?? null, d7In: t.d7In ?? null }
  } catch {
    // Blocked storage: fall through to defaults.
  }
  return DEFAULT_THRESHOLDS
}

export function saveThresholds(t: Thresholds) {
  try {
    localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(t))
  } catch {
    // Private mode or blocked storage: the setting just won't persist.
  }
}

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export const isStandalone = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches

export type PushSupport = 'ok' | 'no-api' | 'ios-install' | 'unsupported'

export function pushSupport(): PushSupport {
  if (!API) return 'no-api'
  // iOS only exposes Web Push to Home Screen web apps (16.4+).
  if (isIOS() && !isStandalone()) return 'ios-install'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  return 'ok'
}

/** Points the Worker forecasts for each favorite, at the same mid-mountain elevation the home screen uses. */
const toFavorites = (locs: SnowLocation[]) =>
  locs.map(l => ({ id: l.id, name: l.name, lat: l.lat, lon: l.lon, elevationFt: Math.round((l.baseFt + l.summitFt) / 2) }))

async function api(path: string, method: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `Alerts server error ${res.status}`)
  return data
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

const bytesToB64url = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const registration = () => Promise.race([
  navigator.serviceWorker.ready,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Service worker not active yet. Reload and try again.')), 10_000)),
])

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

/** Ask for permission (must run from a tap), subscribe, and register with the Worker. */
export async function subscribe(favorites: SnowLocation[], thresholds: Thresholds): Promise<PushSubscription> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked. Allow them in Settings, then try again.' : 'Notification permission was not granted.')
  const reg = await registration()
  const { publicKey } = await api('/vapid-public-key', 'GET')
  let sub = await reg.pushManager.getSubscription()
  // A subscription made with a different server key can't receive our pushes.
  const existingKey = sub?.options.applicationServerKey
  if (sub && existingKey && bytesToB64url(existingKey) !== publicKey) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) })
  await put(sub, favorites, thresholds)
  return sub
}

const put = (sub: PushSubscription, favorites: SnowLocation[], thresholds: Thresholds) =>
  api('/subscription', 'PUT', { subscription: sub.toJSON(), favorites: toFavorites(favorites), thresholds })

/**
 * Send the current favorites and thresholds to the Worker if this device is subscribed.
 * Call whenever either changes. Returns false when not subscribed.
 */
export async function syncAlerts(favorites: SnowLocation[], thresholds: Thresholds = loadThresholds()): Promise<boolean> {
  const sub = await currentSubscription()
  if (!sub) return false
  await put(sub, favorites, thresholds)
  return true
}

export async function unsubscribe(): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  // Drop it locally even if the server call fails; the Worker prunes dead endpoints on its next send.
  await api('/subscription', 'DELETE', { subscription: sub.toJSON() }).catch(() => undefined)
  await sub.unsubscribe()
}

export async function sendTestPush(): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) throw new Error('Not subscribed')
  await api('/test', 'POST', { subscription: sub.toJSON() })
}
