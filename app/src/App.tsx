import { lazy, Suspense, useEffect, useState } from 'react'
import { LOCATIONS_BY_ID, type SnowLocation } from './data/locations'
import { Home } from './screens/Home'
import { LocationView } from './screens/LocationView'
import { loadFavorites, saveFavorites } from './storage'

// MapLibre is most of the bundle; only load it when the map tab opens.
const MapView = lazy(() => import('./screens/MapView').then(m => ({ default: m.MapView })))

type Route =
  | { name: 'home' }
  | { name: 'map' }
  | { name: 'loc'; loc: SnowLocation }
  | { name: 'point'; loc: SnowLocation }

function parseRoute(hash: string): Route {
  const [, kind, arg] = hash.replace(/^#/, '').split('/')
  if (kind === 'map') return { name: 'map' }
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

  const toggleFavorite = (id: string) => {
    const next = favorites.includes(id) ? favorites.filter(f => f !== id) : [...favorites, id]
    setFavorites(next)
    saveFavorites(next)
  }

  const tab = route.name === 'map' || route.name === 'point' ? 'map' : 'home'

  return (
    <div className="app">
      <main>
        {route.name === 'home' && <Home favorites={favorites} />}
        {route.name === 'map' && <Suspense fallback={<div className="loading">Loading map…</div>}><MapView /></Suspense>}
        {route.name === 'loc' && (
          <LocationView key={route.loc.id} loc={route.loc} isFavorite={favorites.includes(route.loc.id)} onToggleFavorite={() => toggleFavorite(route.loc.id)} />
        )}
        {route.name === 'point' && <LocationView key={route.loc.id} loc={route.loc} />}
      </main>
      <nav className="tab-bar">
        <a href="#/" className={tab === 'home' ? 'active' : ''}><span aria-hidden>❄</span>Forecasts</a>
        <a href="#/map" className={tab === 'map' ? 'active' : ''}><span aria-hidden>⛰</span>Map</a>
      </nav>
    </div>
  )
}
