import { lazy, Suspense, useEffect, useState } from 'react'
import { LOCATIONS_BY_ID, type SnowLocation } from './data/locations'
import { Home } from './screens/Home'
import { LocationView } from './screens/LocationView'
import { syncAlerts } from './push'
import { loadFavorites, moveItem, saveFavorites } from './storage'

// MapLibre is most of the bundle; only load it when the map tab opens.
const MapView = lazy(() => import('./screens/MapView').then(m => ({ default: m.MapView })))
const Alerts = lazy(() => import('./screens/Alerts').then(m => ({ default: m.Alerts })))
const Accuracy = lazy(() => import('./screens/Accuracy').then(m => ({ default: m.Accuracy })))

const favoriteLocations = (ids: string[]) => ids.map(id => LOCATIONS_BY_ID.get(id)).filter((l): l is SnowLocation => !!l)

type Route =
  | { name: 'home' }
  | { name: 'map' }
  | { name: 'alerts' }
  | { name: 'accuracy' }
  | { name: 'loc'; loc: SnowLocation }
  | { name: 'point'; loc: SnowLocation }

function parseRoute(hash: string): Route {
  const [, kind, arg] = hash.replace(/^#/, '').split('/')
  if (kind === 'map') return { name: 'map' }
  if (kind === 'alerts') return { name: 'alerts' }
  if (kind === 'accuracy') return { name: 'accuracy' }
  if (kind === 'loc') {
    const loc = LOCATIONS_BY_ID.get(arg)
    if (loc) return { name: 'loc', loc }
  }
  if (kind === 'pt') {
    const [lat, lon] = (arg ?? '').split(',').map(Number)
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { name: 'point', loc: { id: `pt-${arg}`, name: 'Map point', kind: 'custom', lat, lon, baseFt: 0, summitFt: 0, region: 'Central Mtns' } }
    }
  }
  return { name: 'home' }
}

export default function App() {
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  const [favorites, setFavorites] = useState(loadFavorites)

  useEffect(() => {
    const onHash = () => { setRoute(parseRoute(location.hash)); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const updateFavorites = (next: string[]) => {
    setFavorites(next)
    saveFavorites(next)
    // Alerts follow favorites; a no-op unless this device has subscribed.
    syncAlerts(favoriteLocations(next)).catch(() => {})
  }
  const toggleFavorite = (id: string) =>
    updateFavorites(favorites.includes(id) ? favorites.filter(f => f !== id) : [...favorites, id])

  const tab = route.name === 'map' || route.name === 'point' ? 'map' : route.name === 'alerts' || route.name === 'accuracy' ? route.name : 'home'
  const loading = <div className="loading">Loading…</div>

  return (
    <div className="app">
      <main>
        {route.name === 'home' && (
          <Home
            favorites={favorites}
            onMoveFavorite={(from, to) => updateFavorites(moveItem(favorites, from, to))}
            onRemoveFavorite={id => updateFavorites(favorites.filter(f => f !== id))}
          />
        )}
        {route.name === 'map' && <Suspense fallback={<div className="loading">Loading map…</div>}><MapView /></Suspense>}
        {route.name === 'alerts' && <Suspense fallback={loading}><Alerts favorites={favoriteLocations(favorites)} /></Suspense>}
        {route.name === 'accuracy' && <Suspense fallback={loading}><Accuracy /></Suspense>}
        {route.name === 'loc' && (
          <LocationView key={route.loc.id} loc={route.loc} isFavorite={favorites.includes(route.loc.id)} onToggleFavorite={() => toggleFavorite(route.loc.id)} />
        )}
        {route.name === 'point' && <LocationView key={route.loc.id} loc={route.loc} />}
      </main>
      <nav className="tab-bar">
        <a href="#/" className={tab === 'home' ? 'active' : ''}><span aria-hidden>❄</span>Forecasts</a>
        <a href="#/map" className={tab === 'map' ? 'active' : ''}><span aria-hidden>⛰</span>Map</a>
        <a href="#/alerts" className={tab === 'alerts' ? 'active' : ''}>
          <svg aria-hidden viewBox="0 0 24 24" className="tab-icon"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z" /></svg>
          Alerts
        </a>
        <a href="#/accuracy" className={tab === 'accuracy' ? 'active' : ''}>
          <svg aria-hidden viewBox="0 0 24 24" className="tab-icon"><path d="M4 20h16v-2H4Zm1-4h3V9H5Zm5.5 0h3V4h-3ZM16 16h3v-5h-3Z" /></svg>
          Accuracy
        </a>
      </nav>
    </div>
  )
}
