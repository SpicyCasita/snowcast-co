import { useEffect, useState, type CSSProperties } from 'react'
import { WebcamLink } from '../components/WebcamLink'
import type { SnowLocation } from '../data/locations'
import { CHANCE_THRESHOLDS, type BlendedForecast } from '../forecast/blend'
import { fetchElevationFt } from '../forecast/openMeteo'
import { MODEL_LABELS, type ModelId } from '../forecast/types'
import { useForecast } from '../forecast/useForecast'
import { bucketLabel, dayLabel, feet, inches, pct, range } from '../format'
import { HourlyChart, WeatherChart } from './HourlyChart'

const MODEL_ORDER: ModelId[] = ['ncep_hrrr_conus', 'ncep_nam_conus', 'ecmwf_ifs025', 'gfs_seamless', 'gem_seamless', 'icon_seamless', 'nws']

interface Props {
  loc: SnowLocation
  isFavorite?: boolean
  onToggleFavorite?: () => void
}

export function LocationView({ loc, isFavorite, onToggleFavorite }: Props) {
  const isResort = loc.kind === 'resort'
  const isPoint = loc.kind === 'custom'
  const levels = isResort
    ? [['Base', loc.baseFt], ['Mid', Math.round((loc.baseFt + loc.summitFt) / 2)], ['Summit', loc.summitFt]] as const
    : null
  const [elevationFt, setElevationFt] = useState<number | null>(isPoint ? null : levels ? levels[1][1] : loc.baseFt)
  const [elevInput, setElevInput] = useState('')

  useEffect(() => {
    if (!isPoint) return
    fetchElevationFt(loc.lat, loc.lon).then(
      ft => { setElevationFt(ft); setElevInput(String(ft)) },
      () => { setElevationFt(9000); setElevInput('9000') },
    )
  }, [isPoint, loc.lat, loc.lon])

  const state = useForecast(loc.lat, loc.lon, elevationFt)

  return (
    <div className="screen">
      <header className="detail-header">
        <a className="back" href={isPoint ? '#/map' : '#/'} aria-label="Back">‹</a>
        <div className="detail-title">
          <h1>{loc.name}</h1>
          <p className="muted small">{loc.kind === 'custom' ? `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}` : loc.region}</p>
        </div>
        {onToggleFavorite && (
          <button className={isFavorite ? 'star on' : 'star'} onClick={onToggleFavorite} aria-label={isFavorite ? 'Remove favorite' : 'Add favorite'}>
            {isFavorite ? '★' : '☆'}
          </button>
        )}
      </header>

      <WebcamLink id={loc.id} />

      {levels && (
        <div className="segmented" role="tablist">
          {levels.map(([label, ft]) => (
            <button key={label} role="tab" aria-selected={elevationFt === ft} className={elevationFt === ft ? 'active' : ''} onClick={() => setElevationFt(ft)}>
              {label}<span className="small muted"> {feet(ft)}</span>
            </button>
          ))}
        </div>
      )}
      {isPoint && (
        <form className="elev-form" onSubmit={e => { e.preventDefault(); const v = Number(elevInput); if (v > 3000 && v < 15000) setElevationFt(v) }}>
          <label>Elevation (ft)
            <input inputMode="numeric" value={elevInput} onChange={e => setElevInput(e.target.value)} />
          </label>
          <button type="submit">Update</button>
        </form>
      )}
      {!levels && !isPoint && <p className="muted small">Elevation {feet(loc.baseFt)}</p>}

      {state.status === 'loading' && <div className="loading">Loading forecasts from 7 sources…</div>}
      {state.status === 'error' && <div className="error">Couldn't load the forecast: {state.error}</div>}
      {state.status === 'ready' && <ForecastBody forecast={state.forecast} />}
      {!isPoint && <a className="link-button past-link" href={`#/past/${loc.id}`}>Past snowfall &amp; how our forecasts did here →</a>}
    </div>
  )
}

function ForecastBody({ forecast }: { forecast: BlendedForecast }) {
  const maxDay = Math.max(1, ...forecast.days.map(d => d.snow.high))
  const models = MODEL_ORDER.filter(m => forecast.members.includes(m))
  const windows = [['Next 24h', forecast.next24], ['Next 72h', forecast.next72], ['Next 7 days', forecast.next7d]] as const

  return (
    <>
      <div className="totals-row">
        {windows.map(([label, r]) => (
          <div key={label} className="total-card">
            <div className="total-card-label">{label}</div>
            <div className="total-card-val">{inches(r.expected)}"</div>
            <div className="total-card-range">likely {range(r)}</div>
            {r.confidence != null && r.bucket && (
              <div className="total-card-conf" title={`Chance the total lands in ${bucketLabel(r.bucket)}`}>
                {pct(r.confidence)} · {bucketLabel(r.bucket)}
              </div>
            )}
          </div>
        ))}
      </div>

      {forecast.next24.chance && (
        <section>
          <h2 className="section-title">Chance of at least…</h2>
          <div className="table-scroll">
            <table className="chance-table">
              <thead>
                <tr>
                  <th />
                  {CHANCE_THRESHOLDS.map(t => <th key={t}>{t}"</th>)}
                </tr>
              </thead>
              <tbody>
                {windows.map(([label, r]) => (
                  <tr key={label}>
                    <th>{label.replace('Next ', '')}</th>
                    {CHANCE_THRESHOLDS.map(t => {
                      const p = r.chance?.[t] ?? 0
                      return (
                        <td key={t} style={{ '--p': p } as CSSProperties} className="chance-cell">
                          {p < 0.01 ? '–' : pct(p)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            From {forecast.next24.ensembleSize} ensemble runs (GEFS + ECMWF), re-centred on the blended forecast. Confidence % = chance the total lands in the shown range bucket.
          </p>
        </section>
      )}

      <section>
        <h2 className="section-title">Daily snowfall</h2>
        <div className="day-bars">
          {forecast.days.map((d, i) => {
            const lbl = dayLabel(d.date, i)
            return (
              <div key={d.date} className="day-col">
                <div className="day-val">{inches(d.snow.expected)}"</div>
                <div className="day-track">
                  <div className="day-range" style={{ bottom: `${(d.snow.low / maxDay) * 100}%`, height: `${((d.snow.high - d.snow.low) / maxDay) * 100}%` }} />
                  <div className="day-bar" style={{ height: `${(d.snow.expected / maxDay) * 100}%` }} />
                </div>
                <div className="day-label">{lbl.top}</div>
                <div className="day-sub muted">{lbl.bottom}</div>
                <div className="day-temp hi">{d.hiF != null ? `${Math.round(d.hiF)}°` : ''}</div>
                <div className="day-temp lo">{d.loF != null ? `${Math.round(d.loF)}°` : ''}</div>
                <div className="day-gust" title="Max wind gust (mph)">{d.maxGustMph != null ? Math.round(d.maxGustMph) : ''}</div>
              </div>
            )
          })}
        </div>
        <p className="muted small">Bar = blended forecast · shaded = likely range (10th–90th percentile) · below: high/low °F and <span className="day-gust-key">max gust mph</span></p>
      </section>

      <section>
        <h2 className="section-title">Next 72 hours · snowfall</h2>
        <HourlyChart forecast={forecast} />
        <p className="muted small chart-legend">
          <span className="swatch snow" /> snowfall rate (in/hr) <span className="swatch total" /> total so far (in)
        </p>
      </section>

      <section>
        <h2 className="section-title">Next 72 hours · temperature &amp; wind</h2>
        <WeatherChart forecast={forecast} />
        <p className="muted small chart-legend">
          <span className="swatch warm" /> temp (°F) <span className="swatch wind" /> wind <span className="swatch gust" /> gusts (mph)
        </p>
      </section>

      <section>
        <h2 className="section-title">Model by model</h2>
        <div className="table-scroll">
          <table className="model-table">
            <thead>
              <tr>
                <th>Model</th>
                {forecast.days.map((d, i) => <th key={d.date}>{dayLabel(d.date, i).top}</th>)}
              </tr>
            </thead>
            <tbody>
              {models.map(m => (
                <tr key={m}>
                  <th>{MODEL_LABELS[m]}</th>
                  {forecast.days.map(d => {
                    const v = d.perModel[m]
                    return <td key={d.date} className={v != null && v >= 1 ? 'hit' : ''}>{v == null ? '–' : inches(v)}</td>
                  })}
                </tr>
              ))}
              <tr className="blend-row">
                <th>Blend</th>
                {forecast.days.map(d => <td key={d.date}>{inches(d.snow.expected)}</td>)}
              </tr>
              <tr>
                <th>Snow level</th>
                {forecast.days.map(d => <td key={d.date} className="muted">{d.snowLevelFt == null ? '–' : `${(d.snowLevelFt / 1000).toFixed(1)}k`}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Snow is computed from each model's liquid precip × a temperature-based snow-to-liquid ratio (often 15–20:1 in Colorado), then blended with lead-time skill weights: HRRR/NAM lead in the first 48h, ECMWF beyond.
        </p>
        <p className="muted small calibration">{forecast.calibration}</p>
      </section>
    </>
  )
}
