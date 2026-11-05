import { useEffect, useState } from 'react'
import uPlot from 'uplot'
import { WebcamLink } from '../components/WebcamLink'
import { LOCATIONS, LOCATIONS_BY_ID, type SnowLocation } from '../data/locations'
import { dayLabel, inches } from '../format'
import { biasPhrase, lastDaysTotal, loadPastSnowfall, stationLabel, stationNote, type PastLocation, type PastSnowfall } from '../past'
import { getRecent, type RecentSnow } from '../recent'
import { compareToResort, isCurrent, loadResortReports, type ResortReport } from '../resortReports'
import { axisBase, css, HEIGHT, usePlot } from './HourlyChart'

const CHART_DAYS = 30

function usePast() {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; data: PastSnowfall | null }>({ status: 'loading' })
  useEffect(() => {
    let live = true
    loadPastSnowfall().then(data => live && setState({ status: 'ready', data }))
    return () => { live = false }
  }, [])
  return state
}

const measuredAt = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { timeZone: 'America/Denver', weekday: 'short', hour: 'numeric', minute: '2-digit' })

const amount = (x: number | null) => (x == null ? '–' : `${inches(x)}"`)
/** One decimal under 10" so a row's measured, forecast and error visibly add up. */
const precise = (x: number | null) => (x == null ? '–' : `${Math.abs(x) < 10 ? Math.abs(x).toFixed(1) : Math.round(Math.abs(x))}"`)

/** Live 3–48 h totals for one location (null while loading or unavailable). */
function useRecent(id: string, l: PastLocation | undefined): RecentSnow | null {
  const [recent, setRecent] = useState<RecentSnow | null>(null)
  useEffect(() => {
    if (!l) return
    let live = true
    const loc = LOCATIONS_BY_ID.get(id)
    const fallback = { lat: loc?.lat ?? 0, lon: loc?.lon ?? 0, elevFt: loc ? Math.round((loc.baseFt + loc.summitFt) / 2) : 9000 }
    getRecent(id, l, fallback).then(r => live && setRecent(r))
    return () => { live = false }
  }, [id, l])
  return recent
}

function Totals({ id, l }: { id: string; l: PastLocation }) {
  const recent = useRecent(id, l)
  const t = recent?.totals
  // Live readings beat the 5am file for 24/48 h; the file fills in if the live call fails.
  const h48 = t?.[48] ?? l.last48In
  // The daily file lags today's snow, so longer totals are at least the live 48 h.
  const atLeast = (v: number | null) => (v == null ? h48 : h48 == null ? v : Math.max(v, h48))
  const items = [
    ['3h', t?.[3] ?? null], ['6h', t?.[6] ?? null], ['12h', t?.[12] ?? null], ['24h', t?.[24] ?? l.last24In],
    ['48h', h48], ['7 days', atLeast(lastDaysTotal(l.days, 7))], ['Since Oct 1', atLeast(l.seasonIn)],
  ] as const
  return (
    <>
      <div className="past-totals">
        {items.map(([label, v], i) => (
          <div key={label} className={`total${v != null && v >= 6 ? ' big' : ''}${i < 3 ? ' short' : ''}`}>
            <span className="total-val">{recent || i >= 3 ? amount(v) : '·'}</span>
            <span className="total-label">{label}</span>
          </div>
        ))}
      </div>
      {recent && (
        <div className="recent-source">
          <span className={`live-dot${recent.source === 'estimate' ? ' est' : ''}`} />
          {recent.source === 'snotel' ? 'Live from hourly SNOTEL snow depth, counted once new snow has held 3 hours' : 'Short windows are a model estimate (gauge reports daily)'}
          {recent.asOf && ` · ${new Date(recent.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' })}`}
        </div>
      )}
    </>
  )
}

function useResortReport(id: string): ResortReport | null {
  const [report, setReport] = useState<ResortReport | null>(null)
  useEffect(() => {
    let live = true
    loadResortReports().then(r => live && setReport(r?.resorts[id] ?? null))
    return () => { live = false }
  }, [id])
  return report
}

const shortDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** The resort's own latest snow report, or why there isn't one. */
function ResortCard({ name, report }: { name: string; report: ResortReport }) {
  const latest = isCurrent(report.latest) ? report.latest : null
  if (!latest) {
    const opens = report.openingDate && report.openingDate > new Date().toISOString().slice(0, 10) ? ` · opens ${shortDate(report.openingDate)}` : ''
    return <div className="resort-report muted small">No current snow report from {name}{opens}</div>
  }
  const items = [['24h', latest.new24In], ['48h', latest.new48In], ['72h', latest.new72In], ['Depth', latest.depthIn]] as const
  return (
    <div className="resort-report">
      <div className="resort-report-head">
        <span className="section-title">Resort reports</span>
        <span className="muted small">{measuredAt(latest.updatedAt)} · via OnTheSnow</span>
      </div>
      <div className="past-totals">
        {items.map(([label, v]) => (
          <div key={label} className={`total${label !== 'Depth' && v != null && v >= 6 ? ' big' : ''}`}>
            <span className="total-val">{amount(v)}</span>
            <span className="total-label">{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ErrorLine({ l }: { l: PastLocation }) {
  if (!l.stats) return <div className="muted small">No snow days to score in the last 30 days</div>
  return (
    <div className="small past-error">
      Forecast off by <strong>±{l.stats.maeIn.toFixed(1)}"</strong>/day on avg · {biasPhrase(l.stats.biasIn)}
      {' '}({l.stats.n} snow day{l.stats.n === 1 ? '' : 's'})
    </div>
  )
}

function PastCard({ id, l }: { id: string; l: PastLocation }) {
  return (
    <a className="fav-card" href={`#/past/${id}`}>
      <div className="fav-name">{l.name}{l.estimate && <span className="badge">estimate</span>}</div>
      <div className="fav-sub">{stationLabel(l)}</div>
      <Totals id={id} l={l} />
      <ErrorLine l={l} />
    </a>
  )
}

export function PastList({ favorites }: { favorites: SnowLocation[] }) {
  const state = usePast()
  if (state.status === 'loading') return <div className="screen"><div className="loading">Loading past snowfall…</div></div>
  const data = state.data
  return (
    <div className="screen">
      <header className="app-header">
        <h1>Past snowfall</h1>
        <p className="muted small">Measured at a nearby SNOTEL snow-depth sensor or CoCoRaHS observer, next to what we forecast the day before. Days run 7am to 7am, like resort reports.</p>
      </header>
      {!data ? (
        <div className="error">Past snowfall data isn't available yet.</div>
      ) : (
        <>
          <p className="muted small">Measured through {measuredAt(data.obsGenerated)}</p>
          {favorites.length > 0 && (
            <section>
              <h2 className="section-title">Favorites</h2>
              <div className="fav-grid">
                {favorites.filter(f => data.locations[f.id]).map(f => <PastCard key={f.id} id={f.id} l={data.locations[f.id]} />)}
              </div>
            </section>
          )}
          <details className="loc-section" open={favorites.length === 0}>
            <summary><span className="section-title">All locations</span><span className="muted small">7 days · since Oct 1</span></summary>
            <ul className="loc-list">
              {LOCATIONS.filter(l => data.locations[l.id]).map(l => {
                const p = data.locations[l.id]
                return (
                  <li key={l.id}>
                    <a href={`#/past/${l.id}`}>
                      <span>{l.name}{p.estimate && <span className="badge">est.</span>}</span>
                      <span className="muted small">{amount(lastDaysTotal(p.days, 7))} · {amount(p.seasonIn)}</span>
                    </a>
                  </li>
                )
              })}
            </ul>
          </details>
        </>
      )}
    </div>
  )
}

/** Last 30 days: measured (bars) vs our day-before forecast (outlined bars), side by side, plus resort-reported dots. */
function PastChart({ l, resortDays }: { l: PastLocation; resortDays: Record<string, number> | null }) {
  const el = usePlot(width => {
    const days = l.days.slice(-CHART_DAYS)
    const xs = days.map((_, i) => i)
    return {
      data: [xs, days.map(d => d.a), days.map(d => d.p), days.map(d => resortDays?.[d.d] ?? null)],
      opts: {
        width,
        height: HEIGHT,
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
        scales: { x: { time: false, range: [-0.6, days.length - 0.4] }, y: { range: (_u, _min, max) => [0, Math.max(2, max * 1.15)] } },
        axes: [
          { ...axisBase(), splits: () => xs.filter(i => (days.length - 1 - i) % 7 === 0), values: (_u: uPlot, splits: number[]) => splits.map(i => dayLabel(days[i].d, 1).bottom) },
          { ...axisBase(), size: 36, values: (_u, vals) => vals.map(v => `${v}"`) },
        ],
        series: [
          {},
          { label: 'Measured', fill: css('--snow'), stroke: css('--snow'), paths: uPlot.paths.bars!({ size: [0.42, 10], align: -1 }), points: { show: false } },
          { label: 'Forecast', fill: css('--forecast-fill'), stroke: css('--warm'), width: 1.5, paths: uPlot.paths.bars!({ size: [0.42, 10], align: 1 }), points: { show: false } },
          { label: 'Resort', stroke: css('--text'), width: 0, paths: () => null, points: { show: true, size: 7, width: 1.5, stroke: css('--text'), fill: css('--surface') } },
        ],
      },
    }
  }, [l, resortDays])
  return <div ref={el} className="chart" />
}

export function PastDetail({ id }: { id: string }) {
  const state = usePast()
  const l = state.status === 'ready' ? state.data?.locations[id] : undefined
  const report = useResortReport(id)
  const resortDays = report && Object.keys(report.days).length ? report.days : null
  const vsResort = l && resortDays ? compareToResort(l.days.slice(-CHART_DAYS), resortDays) : null
  const recent = l ? l.days.slice(-CHART_DAYS).filter(d => (d.a ?? 0) >= 0.1 || (d.p ?? 0) >= 0.1 || (resortDays?.[d.d] ?? 0) >= 0.1).reverse() : []
  return (
    <div className="screen">
      <header className="detail-header">
        <a className="back" href="#/past" aria-label="Back">‹</a>
        <div className="detail-title">
          <h1>{l?.name ?? 'Past snowfall'}</h1>
          {l && <p className="muted small">{stationLabel(l)}</p>}
          {l && stationNote(l) && <p className="muted small">{stationNote(l)}</p>}
        </div>
      </header>

      <WebcamLink id={id} />

      {state.status === 'loading' && <div className="loading">Loading…</div>}
      {state.status === 'ready' && !l && <div className="error">No past snowfall data for this location.</div>}
      {l && (
        <>
          {l.estimate && <p className="muted small">No station within 15 km, so "measured" here is a model-analysis estimate.</p>}
          <div className="fav-card past-summary">
            <Totals id={id} l={l} />
            {report && <ResortCard name={l.name} report={report} />}
          </div>

          <section>
            <h2 className="section-title">Last 30 days · measured vs forecast</h2>
            <PastChart l={l} resortDays={resortDays} />
            <p className="muted small chart-legend">
              <span className="swatch snow" /> measured <span className="swatch forecast" /> our forecast the day before
              {resortDays && <><span className="swatch resort" /> resort reported</>}
            </p>
          </section>

          <section>
            <h2 className="section-title">Forecast error · last 30 days</h2>
            {l.stats ? (
              <div className="totals-row">
                <div className="total-card">
                  <div className="total-card-label">Avg miss</div>
                  <div className="total-card-val">±{l.stats.maeIn.toFixed(1)}"</div>
                  <div className="total-card-range">per snow day</div>
                </div>
                <div className="total-card">
                  <div className="total-card-label">Bias</div>
                  <div className={`total-card-val ${l.stats.biasIn > 0.3 ? 'over' : l.stats.biasIn < -0.3 ? 'under' : ''}`}>
                    {l.stats.biasIn > 0 ? '+' : ''}{l.stats.biasIn.toFixed(1)}"
                  </div>
                  <div className="total-card-range">{l.stats.biasIn > 0.3 ? 'too high' : l.stats.biasIn < -0.3 ? 'too low' : 'about right'}</div>
                </div>
                <div className="total-card">
                  <div className="total-card-label">Snow days caught</div>
                  <div className="total-card-val">{l.stats.hitRate == null ? '–' : `${Math.round(l.stats.hitRate * 100)}%`}</div>
                  <div className="total-card-range">of 1"+ days</div>
                </div>
              </div>
            ) : (
              <p className="muted small">No snow days in the last 30 days to score yet.</p>
            )}
            {l.stats && <p className="muted small">Scored on {l.stats.n} day{l.stats.n === 1 ? '' : 's'} where we forecast or measured 1"+.</p>}
            {vsResort && (
              <p className="small past-error">
                Against the resort's own reports: off by <strong>±{vsResort.maeIn.toFixed(1)}"</strong>/day · {biasPhrase(vsResort.biasIn)} ({vsResort.n} days)
                {vsResort.stationGapIn != null && Math.abs(vsResort.stationGapIn) >= 0.3 &&
                  ` · the station reads ${Math.abs(vsResort.stationGapIn).toFixed(1)}" ${vsResort.stationGapIn < 0 ? 'less' : 'more'} than the resort on a typical snow day`}
              </p>
            )}
          </section>

          {recent.length > 0 && (
            <section>
              <h2 className="section-title">Day by day</h2>
              <div className="table-scroll">
                <table className="model-table past-table">
                  <thead><tr><th>Day</th><th>Measured</th>{resortDays && <th>Resort</th>}<th>Forecast</th><th>Error</th></tr></thead>
                  <tbody>
                    {recent.map(d => {
                      const err = d.a != null && d.p != null ? d.p - d.a : null
                      const lbl = dayLabel(d.d, 1)
                      return (
                        <tr key={d.d}>
                          <th>{lbl.top} {lbl.bottom}</th>
                          <td>{precise(d.a)}</td>
                          {resortDays && <td>{precise(resortDays[d.d] ?? null)}</td>}
                          <td>{precise(d.p)}</td>
                          <td className={err == null ? 'muted' : err >= 1 ? 'over' : err <= -1 ? 'under' : ''}>
                            {err == null ? '–' : `${err > 0 ? '+' : err < 0 ? '−' : ''}${precise(err)}`}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted small">Error = forecast − measured: <span className="over">+ too high</span>, <span className="under">− too low</span>.
                {resortDays && ' Resort = the resort\'s own morning report, counted on the day before it was posted.'}</p>
            </section>
          )}

          <p className="small"><a className="link-button" href={`#/loc/${id}`}>See the forecast →</a></p>
        </>
      )}
    </div>
  )
}
