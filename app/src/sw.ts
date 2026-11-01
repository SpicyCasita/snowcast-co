/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst, NetworkFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { clientsClaim } from 'workbox-core'

declare const self: ServiceWorkerGlobalScope

// registerType 'autoUpdate': take over as soon as a new version installs.
self.skipWaiting()
clientsClaim()

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

// Show the last forecast when offline (e.g. on the lift with no signal).
registerRoute(
  /^https:\/\/(api\.open-meteo\.com|api\.weather\.gov)\//,
  new NetworkFirst({ cacheName: 'forecasts', networkTimeoutSeconds: 8, plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 6 * 3600 })] }),
)
registerRoute(
  /^https:\/\/tiles\.openfreemap\.org\//,
  new CacheFirst({ cacheName: 'map-tiles', plugins: [new ExpirationPlugin({ maxEntries: 1500, maxAgeSeconds: 30 * 24 * 3600 })] }),
)

/** What the alerts Worker sends (worker/src/alerts.ts PushPayload). */
interface PushPayload {
  title: string
  body: string
  tag: string
  locId: string | null
}

self.addEventListener('push', event => {
  let p: PushPayload
  try {
    p = event.data!.json()
  } catch {
    p = { title: 'SnowCast CO', body: event.data?.text() ?? '', tag: 'snow', locId: null }
  }
  event.waitUntil(
    self.registration.showNotification(p.title, {
      body: p.body,
      tag: p.tag,
      icon: 'icon-192.png',
      badge: 'favicon-32.png',
      data: { locId: p.locId },
    }),
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const locId = (event.notification.data as { locId?: string | null } | null)?.locId
  const url = new URL(locId ? `./#/loc/${encodeURIComponent(locId)}` : './', self.registration.scope).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = windows.find(w => w.url.startsWith(self.registration.scope))
    if (open) {
      await open.focus()
      // The app routes on hashchange, so navigating the open window is enough.
      if (open.url !== url) await open.navigate(url).catch(() => undefined)
      return
    }
    await self.clients.openWindow(url)
  })())
})
