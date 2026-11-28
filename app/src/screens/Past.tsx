import { useEffect, useMemo, useState } from 'react'
import uPlot from 'uplot'
import { WebcamLink } from '../components/WebcamLink'
import { LOCATIONS, LOCATIONS_BY_ID, type SnowLocation } from '../data/locations'
import { dayLabel, inches } from '../format'
import { biasPhrase, composeTotals, loadPastSnowfall, sourceNote, stationLabel, stationNote, type PastDay, type PastLocation, type PastSnowfall } from '../past'
import { getRecent, type Amount, type RecentSnow } from '../recent'
import { useRefreshTick } from '../refresh'
import { compareToResort, isCurrent, loadResortReports, type ResortReport } from '../resortReports'
import { axisBase, css, HEIGHT, usePlot } from './HourlyChart'

const CHART_DAYS = 30

function usePast() {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; data: PastSnowfall | null }>({ status: 'loading' })
  const tick = useRefreshTick()
  useEffect(() => {
    let live = true
    loadPastSnowfall().then(data => live && setState(prev => (prev.status === 'ready' && prev.data === data ? prev : { status: 'ready', data })))
    return () => { live = false }
  }, [tick])
  return state
}

const measuredAt = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { timeZone: 'America/Denver', weekday: 'short', hour: 'numeric', minute: '2-digit' })

const amount = (x: number | null) => (x == null ? '–' : `${inches(x)}"`)
/** An amount still settling in shows as ≈. */
const approx = (a: Amount | null) => (a == null ? '–' : `${a.provisional ? '≈' : ''}${inches(a.inches)}"`)
/** One decimal under 10" so a row's measured, forecast and error visibly add up. */
const precise = (x: number | null) => (x == null ? '–' : `${Math.abs(x) < 10 ? Math.abs(x).toFixed(1) : Math.round(Math.abs(x))}"`)

/** Live 3–48 h totals for one location (null while loading or unavailable). */
function useRecent(id: string, l: PastLocation | undefined): RecentSnow | null {
  const [recent, setRecent] = useState<RecentSnow | null>(null)
  const tick = useRefreshTick()
  useEffect(() => {
    if (!l) return
    let live = true
    const loc = LOCATIONS_BY_ID.get(id)
    const fallback = { lat: loc?.lat ?? 0, lon: loc?.lon ?? 0, elevFt: loc ? Math.round((loc.baseFt + loc.summitFt) / 2) : 9000 }
    getRecent(id, l, fallback).then(r => live && setRecent(r))
    return () => { live = false }
  }, [id, l, tick])
  return recent
}

const clock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' })

/** "readings to 6:00 AM", plus how old that is once it's more than an hour. */
function readingsTo(asOf: number | null, at: number): string {
  if (asOf == null) return ''
  const h = (at - asOf) / 3_600_000
  return ` · readings to ${clock(asOf)}${h >= 1.5 ? ` (${Math.round(h)} h ago)` : ''}`
}

function Totals({ id, l, dayStartH }: { id: string; l: PastLocation; dayStartH?: number }) {
  const recent = useRecent(id, l)
  const now = recent?.at ?? Date.now()
  const live = recent?.source === 'snotel'
  const est = recent?.source === 'estimate' || l.estimate
  const t = recent?.totals
  const win = (w: 3 | 6 | 12 | 24 | 48): Amount | null => (t?.[w] == null ? null : { inches: t[w]!, provisional: recent!.provisional[w] })
  const fileWin = (v: number | null): Amount | null => (v == null ? null : { inches: v, provisional: false })
  const c = composeTotals(l, recent, now, dayStartH)
  const items: [string, Amount | null, boolean][] = [
    ['3h', win(3), est], ['6h', win(6), est], ['12h', win(12), est],
    ['24h', recent ? win(24) : fileWin(l.last24In), recent ? est : l.estimate],
    ['48h', recent ? win(48) : fileWin(l.last48In), recent ? est : l.estimate],
    ['7 days', c.week, l.estimate], ['Since Oct 1', c.season, l.estimate],
  ]
  const anyProvisional = items.some(([, v]) => v?.provisional)
  return (
    <>
      <div className="past-totals">
        {items.map(([label, v, isEst], i) => (
          <div key={label} className={`total${v != null && v.inches >= 6 ? ' big' : ''}${i < 3 ? ' short' : ''}${v?.provisional ? ' settling' : ''}`}>
            <span className="total-val">{recent || i >= 3 ? approx(v) : '·'}</span>
            <span className="total-label">{label}{isEst && v != null && <span className="est-tag">est.</span>}</span>
            {label === 'Since Oct 1' && !!l.missingDays && <span className="total-note">{l.missingDays} day{l.missingDays === 1 ? '' : 's'} not reported</span>}
          </div>
        ))}
      </div>
      {recent && (
        <div className="recent-source">
          <span className={`live-dot${live ? '' : ' est'}`} />
          <span>
            {live
              ? `Live from SNOTEL snow depth, checked against its precip gauge${readingsTo(recent.asOf, now)}`
              : `3–48 h are a model estimate${l.station?.type === 'cocorahs' ? ' (the observer reports once a day)' : ''}`}
            {anyProvisional && <> · <strong>≈</strong> still settling in, may change</>}
          </span>
        </div>
      )}
    </>
  )
}

function useResortReport(id: string): ResortReport | null {
  const [report, setReport] = useState<ResortReport | null>(null)
  const tick = useRefreshTick()
  useEffect(() => {
    let live = true
    loadResortReports().then(r => live && setReport(r?.resorts[id] ?? null))
    return () => { live = false }
  }, [id, tick])
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

const unit = (l: PastLocation) => (l.stats?.per === 'storm' ? 'storm' : 'snow day')

function ErrorLine({ l }: { l: PastLocation }) {
  if (!l.stats) return <div className="muted small">No snow to score in the last 30 days</div>
  return (
    <div className="small past-error">
      Forecast off by <strong>±{l.stats.maeIn.toFixed(1)}"</strong>/{unit(l)} on avg · {biasPhrase(l.stats.biasIn)}
      {' '}({l.stats.n} {unit(l)}{l.stats.n === 1 ? '' : 's'})
    </div>
  )
}

function PastCard({ id, l, dayStartH }: { id: string; l: PastLocation; dayStartH?: number }) {
  return (
    <a className="fav-card" href={`#/past/${id}`}>
      <div className="fav-name">{l.name}{l.estimate && <span className="badge">estimate</span>}</div>
      <div className="fav-sub">{sourceNote(l) ? `${sourceNote(l)} · live: ${l.station?.name ?? 'estimate'}` : stationLabel(l)}</div>
      <Totals id={id} l={l} dayStartH={dayStartH} />
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
        <p className="muted small">Measured: each resort's own morning report once it's open, otherwise a nearby SNOTEL snow-depth sensor or CoCoRaHS observer. Next to it, what we forecast the day before. Days run 7am to 7am.</p>
      </header>
      {!data ? (
        <div className="error">Past snowfall data isn't available yet.</div>
      ) : (
        <>
          <p className="muted small">Daily file built {measuredAt(data.obsGenerated)}; live numbers refresh every few minutes</p>
          {favorites.length > 0 && (
            <section>
              <h2 className="section-title">Favorites</h2>
              <div className="fav-grid">
                {favorites.filter(f => data.locations[f.id]).map(f => <PastCard key={f.id} id={f.id} l={data.locations[f.id]} dayStartH={data.dayStartH} />)}
              </div>
            </section>
          )}
          <details className="loc-section" open={favorites.length === 0}>
            <summary><span className="section-title">All locations</span><span className="muted small">7 days · since Oct 1</span></summary>
            <ul className="loc-list">
              {LOCATIONS.filter(l => data.locations[l.id]).map(l => {
                const p = data.locations[l.id]
                // No live readings for the whole list: the file's own partial day stands in for today.
                const c = composeTotals(p, null, Date.now(), data.dayStartH)
                return (
                  <li key={l.id}>
                    <a href={`#/past/${l.id}`}>
                      <span>{l.name}{p.estimate && <span className="badge">est.</span>}</span>
                      <span className="muted small">{approx(c.week)} · {approx(c.season)}</span>
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

/** Whether a file's measured days are resort-first (built with sources) and this location has resort days. */
const hasResortDays = (l: PastLocation) => l.days.some(d => d.s === 'resort')

/**
 * Last 30 days: measured (bars) vs our day-before forecast (outlined bars), side by side. Dots: the
 * station's own number on days the bar is the resort's report (or, in older files, the resort's report).
 */
function PastChart({ l, dots }: { l: PastLocation; dots: (d: PastDay) => number | null }) {
  const el = usePlot(width => {
    const days = l.days.slice(-CHART_DAYS)
    const xs = days.map((_, i) => i)
    return {
      data: [xs, days.map(d => d.a), days.map(d => d.p), days.map(dots)],
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
          { label: 'Dots', stroke: css('--text'), width: 0, paths: () => null, points: { show: true, size: 7, width: 1.5, stroke: css('--text'), fill: css('--surface') } },
        ],
      },
    }
  }, [l, dots])
  return <div ref={el} className="chart" />
}

const SOURCE_TAG: Record<string, string> = { resort: 'resort', snotel: 'station', cocorahs: 'observer', estimate: 'est.' }

export function PastDetail({ id }: { id: string }) {
  const state = usePast()
  const data = state.status === 'ready' ? state.data : null
  const l = data?.locations[id]
  const report = useResortReport(id)
  const resortDays = report && Object.keys(report.days).length ? report.days : null
  const resortFirst = l ? hasResortDays(l) : false
  // Resort-first files carry the station's own number on resort days; older files only the station's.
  // A station dot only where the station or the resort had snow, so dry days stay clear.
  const dots = useMemo(() => (resortFirst
    ? (d: PastDay) => (d.s === 'resort' && d.st != null && Math.max(d.st, d.a ?? 0) >= 0.1 ? d.st : null)
    : (d: PastDay) => resortDays?.[d.d] ?? null), [resortFirst, resortDays])
  const vsResort = l && resortDays && !resortFirst ? compareToResort(l.days.slice(-CHART_DAYS), resortDays) : null
  const gap = l && resortFirst ? stationGap(l.days.slice(-CHART_DAYS)) : null
  const recent = l ? l.days.slice(-CHART_DAYS).filter(d => (d.a ?? 0) >= 0.1 || (d.p ?? 0) >= 0.1 || (dots(d) ?? 0) >= 0.1).reverse() : []
  const extraCol = resortFirst ? 'Station' : resortDays ? 'Resort' : null
  const per = l?.stats?.per === 'storm' ? 'storm' : 'snow day'
  return (
    <div className="screen">
      <header className="detail-header">
        <a className="back" href="#/past" aria-label="Back">‹</a>
        <div className="detail-title">
          <h1>{l?.name ?? 'Past snowfall'}</h1>
          {l && <p className="muted small">{sourceNote(l) ?? stationLabel(l)}</p>}
          {l && sourceNote(l) && <p className="muted small">Before that, and live: {stationLabel(l)}</p>}
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
            <Totals id={id} l={l} dayStartH={data?.dayStartH} />
            {report && <ResortCard name={l.name} report={report} />}
          </div>

          <section>
            <h2 className="section-title">Last 30 days · measured vs forecast</h2>
            <PastChart l={l} dots={dots} />
            <p className="muted small chart-legend">
              <span className="swatch snow" /> measured <span className="swatch forecast" /> our forecast the day before
              {resortFirst ? <><span className="swatch resort" /> the station, on days the bar is the resort's report</> : resortDays && <><span className="swatch resort" /> resort reported</>}
            </p>
          </section>

          <section>
            <h2 className="section-title">Forecast error · last 30 days</h2>
            {l.stats ? (
              <div className="totals-row">
                <div className="total-card">
                  <div className="total-card-label">Avg miss</div>
                  <div className="total-card-val">±{l.stats.maeIn.toFixed(1)}"</div>
                  <div className="total-card-range">per {per}</div>
                </div>
                <div className="total-card">
                  <div className="total-card-label">Bias</div>
                  <div className={`total-card-val ${l.stats.biasIn > 0.3 ? 'over' : l.stats.biasIn < -0.3 ? 'under' : ''}`}>
                    {l.stats.biasIn > 0 ? '+' : ''}{l.stats.biasIn.toFixed(1)}"
                  </div>
                  <div className="total-card-range">{l.stats.biasIn > 0.3 ? 'too high' : l.stats.biasIn < -0.3 ? 'too low' : 'about right'}</div>
                </div>
                <div className="total-card">
                  <div className="total-card-label">{per === 'storm' ? 'Storms caught' : 'Snow days caught'}</div>
                  <div className="total-card-val">{l.stats.hitRate == null ? '–' : `${Math.round(l.stats.hitRate * 100)}%`}</div>
                  <div className="total-card-range">of 1"+ {per}s</div>
                </div>
              </div>
            ) : (
              <p className="muted small">No snow in the last 30 days to score yet.</p>
            )}
            {l.stats && (
              <p className="muted small">
                {per === 'storm'
                  ? `Scored on ${l.stats.n} storm${l.stats.n === 1 ? '' : 's'}: each storm's total, with a day either side so a storm dated a day differently isn't two misses.`
                  : `Scored on ${l.stats.n} day${l.stats.n === 1 ? '' : 's'} where we forecast or measured 1"+.`}
                {resortFirst && ` Measured = ${l.name}'s own reports where it posted them.`}
              </p>
            )}
            {gap != null && Math.abs(gap) >= 0.3 && (
              <p className="small past-error">
                {l.station?.name ?? 'The station'} reads <strong>{Math.abs(gap).toFixed(1)}"</strong> {gap < 0 ? 'less' : 'more'} than the resort on a typical snow day.
              </p>
            )}
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
                  <thead><tr><th>Day</th><th>Measured</th>{extraCol && <th>{extraCol}</th>}<th>Forecast</th><th>Error</th></tr></thead>
                  <tbody>
                    {recent.map(d => {
                      const err = d.a != null && d.p != null ? d.p - d.a : null
                      const lbl = dayLabel(d.d, 1)
                      return (
                        <tr key={d.d}>
                          <th>{lbl.top} {lbl.bottom}</th>
                          <td>{precise(d.a)}{resortFirst && d.a != null && d.s && <span className="src-tag">{SOURCE_TAG[d.s] ?? d.s}</span>}</td>
                          {extraCol && <td>{precise(dots(d))}</td>}
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
                {resortFirst ? ' Resort = its own morning report, counted on the day before it was posted; Station = the SNOTEL sensor the same day.'
                  : resortDays && ' Resort = the resort\'s own morning report, counted on the day before it was posted.'}</p>
            </section>
          )}

          <p className="small"><a className="link-button" href={`#/loc/${id}`}>See the forecast →</a></p>
        </>
      )}
    </div>
  )
}

/** Station − resort, inches, on an average snow day where both measured (resort-first files). */
function stationGap(days: PastDay[]): number | null {
  const both = days.filter(d => d.s === 'resort' && d.a != null && d.st != null && Math.max(d.a, d.st) >= 1)
  return both.length >= 3 ? Math.round((both.reduce((s, d) => s + d.st! - d.a!, 0) / both.length) * 10) / 10 : null
}
