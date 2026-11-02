import { useMemo, useState } from 'react'
import { LOCATIONS, LOCATIONS_BY_ID, type LocationKind, type SnowLocation } from '../data/locations'
import { LogoMark } from '../components/Icons'
import { useForecast } from '../forecast/useForecast'
import { confidenceLabel, feet, inches, range } from '../format'
import { loadOpenSections, saveOpenSections } from '../storage'

const SECTIONS: { kind: LocationKind; title: string }[] = [
  { kind: 'resort', title: 'Ski resorts' },
  { kind: 'pass', title: 'Mountain passes' },
  { kind: 'town', title: 'Towns' },
]

/** Resorts are summarized at mid-mountain; everything else at its own elevation. */
export const defaultElevation = (l: SnowLocation) => Math.round((l.baseFt + l.summitFt) / 2)

function FavoriteTotals({ loc }: { loc: SnowLocation }) {
  const state = useForecast(loc.lat, loc.lon, defaultElevation(loc))
  if (state.status === 'error') return <div className="muted small">Couldn't load forecast</div>
  if (state.status === 'loading') return <div className="fav-totals skeleton" aria-label="Loading" />
  const { next24, next72, next7d } = state.forecast
  return (
    <div className="fav-totals">
      {([['24h', next24], ['72h', next72], ['7 day', next7d]] as const).map(([label, r]) => (
        <div key={label} className={r.expected >= 6 ? 'total big' : 'total'}>
          <span className="total-val">{inches(r.expected)}"</span>
          <span className="total-label">{label}</span>
          <span className="total-range">{range(r)}</span>
          {r.confidence != null && <span className="total-conf">{confidenceLabel(r.confidence)}</span>}
        </div>
      ))}
    </div>
  )
}

interface EditProps {
  index: number
  count: number
  onMove: (from: number, to: number) => void
  onRemove: () => void
}

function FavoriteCard({ loc, edit }: { loc: SnowLocation; edit?: EditProps }) {
  const header = (
    <>
      <div className="fav-name">{loc.name}</div>
      <div className="fav-sub">{loc.region} · {feet(defaultElevation(loc))}</div>
    </>
  )
  if (edit) {
    return (
      <div className="fav-card editing">
        <div className="fav-edit-row">
          <div className="fav-edit-name">{header}</div>
          <div className="fav-edit-buttons">
            <button aria-label={`Move ${loc.name} up`} disabled={edit.index === 0} onClick={() => edit.onMove(edit.index, edit.index - 1)}>↑</button>
            <button aria-label={`Move ${loc.name} down`} disabled={edit.index === edit.count - 1} onClick={() => edit.onMove(edit.index, edit.index + 1)}>↓</button>
            <button aria-label={`Remove ${loc.name}`} className="remove" onClick={edit.onRemove}>✕</button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <a className="fav-card" href={`#/loc/${loc.id}`}>
      {header}
      <FavoriteTotals loc={loc} />
    </a>
  )
}

interface Props {
  favorites: string[]
  onMoveFavorite: (from: number, to: number) => void
  onRemoveFavorite: (id: string) => void
}

export function Home({ favorites, onMoveFavorite, onRemoveFavorite }: Props) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(loadOpenSections)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? LOCATIONS.filter(l => l.name.toLowerCase().includes(q) || l.region.toLowerCase().includes(q)) : LOCATIONS
  }, [query])
  const favLocs = favorites.map(id => LOCATIONS_BY_ID.get(id)).filter((l): l is SnowLocation => !!l)

  const toggleSection = (kind: string, isOpen: boolean) => {
    if (query || (open[kind] ?? true) === isOpen) return
    const next = { ...open, [kind]: isOpen }
    setOpen(next)
    saveOpenSections(next)
  }

  return (
    <div className="screen">
      <header className="app-header">
        <div className="brand">
          <LogoMark />
          <h1>SnowCast <span className="accent">CO</span></h1>
        </div>
        <p className="muted small">6 weather models + NWS, blended and tuned for Colorado snow</p>
      </header>

      {!query && favLocs.length > 0 && (
        <section>
          <div className="section-head">
            <h2 className="section-title">Favorites</h2>
            <button className="link-button" onClick={() => setEditing(e => !e)}>{editing ? 'Done' : 'Edit'}</button>
          </div>
          <div className="fav-grid">
            {favLocs.map((l, i) => (
              <FavoriteCard
                key={l.id}
                loc={l}
                edit={editing ? { index: i, count: favLocs.length, onMove: onMoveFavorite, onRemove: () => onRemoveFavorite(l.id) } : undefined}
              />
            ))}
          </div>
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
        // While searching, show every match regardless of the saved open/closed state.
        const isOpen = query ? true : open[kind] ?? true
        return (
          <details key={kind} className="loc-section" open={isOpen} onToggle={e => toggleSection(kind, e.currentTarget.open)}>
            <summary>
              <span className="section-title">{title}</span>
              <span className="muted small">{items.length}</span>
            </summary>
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
          </details>
        )
      })}
    </div>
  )
}
