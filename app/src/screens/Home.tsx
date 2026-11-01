import { useMemo, useState } from 'react'
import { LOCATIONS, LOCATIONS_BY_ID, type LocationKind, type SnowLocation } from '../data/locations'
import { useForecast } from '../forecast/useForecast'
import { feet, inches, range } from '../format'

const SECTIONS: { kind: LocationKind; title: string }[] = [
  { kind: 'resort', title: 'Ski resorts' },
  { kind: 'pass', title: 'Mountain passes' },
  { kind: 'town', title: 'Towns' },
]

/** Resorts are summarized at mid-mountain; everything else at its own elevation. */
export const defaultElevation = (l: SnowLocation) => Math.round((l.baseFt + l.summitFt) / 2)

function FavoriteCard({ loc }: { loc: SnowLocation }) {
  const state = useForecast(loc.lat, loc.lon, defaultElevation(loc))
  return (
    <a className="fav-card" href={`#/loc/${loc.id}`}>
      <div className="fav-name">{loc.name}</div>
      <div className="fav-sub">{loc.region} · {feet(defaultElevation(loc))}</div>
      {state.status === 'ready' ? (
        <div className="fav-totals">
          {([['24h', state.forecast.next24], ['72h', state.forecast.next72], ['7 day', state.forecast.next7d]] as const).map(([label, r]) => (
            <div key={label} className={r.expected >= 6 ? 'total big' : 'total'}>
              <span className="total-val">{inches(r.expected)}"</span>
              <span className="total-label">{label}</span>
              <span className="total-range">{range(r)}</span>
            </div>
          ))}
        </div>
      ) : state.status === 'error' ? (
        <div className="muted small">Couldn't load forecast</div>
      ) : (
        <div className="fav-totals skeleton" aria-label="Loading" />
      )}
    </a>
  )
}

export function Home({ favorites }: { favorites: string[] }) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? LOCATIONS.filter(l => l.name.toLowerCase().includes(q) || l.region.toLowerCase().includes(q)) : LOCATIONS
  }, [query])
  const favLocs = favorites.map(id => LOCATIONS_BY_ID.get(id)).filter((l): l is SnowLocation => !!l)

  return (
    <div className="screen">
      <header className="app-header">
        <h1>SnowCast <span className="accent">CO</span></h1>
        <p className="muted small">6 weather models + NWS, blended and tuned for Colorado snow</p>
      </header>

      {!query && favLocs.length > 0 && (
        <section>
          <h2 className="section-title">Favorites</h2>
          <div className="fav-grid">{favLocs.map(l => <FavoriteCard key={l.id} loc={l} />)}</div>
        </section>
      )}

      <input
        className="search"
        type="search"
        placeholder="Search resorts, passes, towns…"
        value={query}
        onChange={e => setQuery(e.target.value)}
      />

      {SECTIONS.map(({ kind, title }) => {
        const items = filtered.filter(l => l.kind === kind)
        if (!items.length) return null
        return (
          <section key={kind}>
            <h2 className="section-title">{title}</h2>
            <ul className="loc-list">
              {items.map(l => (
                <li key={l.id}>
                  <a href={`#/loc/${l.id}`}>
                    <span>{l.name}</span>
                    <span className="muted small">{l.kind === 'resort' ? `${feet(l.baseFt)}–${feet(l.summitFt)}` : feet(l.baseFt)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
