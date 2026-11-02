import { lazy, Suspense, useEffect, useState } from 'react'
import { Backdrop } from './components/Backdrop'
import { BellIcon, ChartIcon, MapIcon, PastIcon, SnowflakeIcon } from './components/Icons'
import { LOCATIONS_BY_ID, type SnowLocation } from './data/locations'
import { Home } from './screens/Home'
import { LocationView } from './screens/LocationView'
import { syncAlerts } from './push'
import { loadFavorites, moveItem, saveFavorites } from './storage'

// MapLibre is most of the bundle; only load it when the map tab opens.
const MapView = lazy(() => import('./screens/MapView').then(m => ({ default: m.MapView })))
const Alerts = lazy(() => import('./screens/Alerts').then(m => ({ default: m.Alerts })))
const Accuracy = lazy(() => import('./screens/Accuracy').then(m => ({ default: m.Accuracy })))
const PastList = lazy(() => import('./screens/Past').then(m => ({ default: m.PastList })))
const PastDetail = lazy(() => import('./screens/Past').then(m => ({ default: m.PastDetail })))

const favoriteLocations = (ids: string[]) => ids.map(id => LOCATIONS_BY_ID.get(id)).filter((l): l is SnowLocation => !!l)

type Route =
  | { name: 'home' }
  | { name: 'map' }
  | { name: 'alerts' }
  | { name: 'accuracy' }
  | { name: 'past' }
  | { name: 'pastLoc'; id: string }
  | { name: 'loc'; loc: SnowLocation }
  | { name: 'point'; loc: SnowLocation }

function parseRoute(hash: string): Route {
  const [, kind, arg] = hash.replace(/^#/, '').split('/')
  if (kind === 'map') return { name: 'map' }
  if (kind === 'alerts') return { name: 'alerts' }
  if (kind === 'accuracy') return { name: 'accuracy' }
  if (kind === 'past') return arg ? { name: 'pastLoc', id: arg } : { name: 'past' }
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

  const tab = route.name === 'map' || route.name === 'point' ? 'map'
    : route.name === 'past' || route.name === 'pastLoc' ? 'past'
    : route.name === 'alerts' || route.name === 'accuracy' ? route.name
    : 'home'
  const loading = <div className="loading">Loading…</div>

  return (
    <div className="app">
      <Backdrop />
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
        {route.name === 'past' && <Suspense fallback={loading}><PastList favorites={favoriteLocations(favorites)} /></Suspense>}
        {route.name === 'pastLoc' && <Suspense fallback={loading}><PastDetail key={route.id} id={route.id} /></Suspense>}
        {route.name === 'loc' && (
          <LocationView key={route.loc.id} loc={route.loc} isFavorite={favorites.includes(route.loc.id)} onToggleFavorite={() => toggleFavorite(route.loc.id)} />
        )}
        {route.name === 'point' && <LocationView key={route.loc.id} loc={route.loc} />}
      </main>
      <nav className="tab-bar" aria-label="Main">
        <a href="#/" className={tab === 'home' ? 'active' : ''} aria-current={tab === 'home' ? 'page' : undefined}><SnowflakeIcon />Forecasts</a>
        <a href="#/map" className={tab === 'map' ? 'active' : ''} aria-current={tab === 'map' ? 'page' : undefined}><MapIcon />Map</a>
        <a href="#/past" className={tab === 'past' ? 'active' : ''} aria-current={tab === 'past' ? 'page' : undefined}><PastIcon />Past</a>
        <a href="#/alerts" className={tab === 'alerts' ? 'active' : ''} aria-current={tab === 'alerts' ? 'page' : undefined}><BellIcon />Alerts</a>
        <a href="#/accuracy" className={tab === 'accuracy' ? 'active' : ''} aria-current={tab === 'accuracy' ? 'page' : undefined}><ChartIcon />Accuracy</a>
      </nav>
    </div>
  )
}
