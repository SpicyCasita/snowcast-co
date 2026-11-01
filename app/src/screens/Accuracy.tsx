import { useEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { MODEL_LABELS, type ModelId } from '../forecast/types'

/** One method's scores on a set of days (pipeline/backtest.py `metrics`). SWE inches. */
interface Metrics {
  n: number
  mae: number
  bias: number
  events: number
  hitRate: number | null
  falseAlarm: number | null
}

interface LeaderRow extends Metrics {
  method: string
  tunedMae: number
  /** 1 - tuned MAE / this MAE on the same days; positive = the tuned blend is better. */
  skillVsTuned: number | null
  leads: number[]
}

interface Bins {
  n: number
  brier: number
  brierSkill: number | null
  bins: { lo: number; hi: number; n: number; meanP: number; freq: number }[]
}

interface Verification {
  version: number
  generated: string
  summary?: {
    n: number
    sites: number
    dateRange: [string, string]
    tunedActive: number
    tunedMae: number
    defaultMae: number
    bestModel: string | null
    bestModelMae: number | null
    bestModelTunedMae: number | null
    vsBestModel: number | null
    vsDefault: number | null
  }
  leaderboard?: LeaderRow[]
  monthly?: { month: string; n: number; tunedActive?: number; mae: Record<string, number> }[]
  byLead?: Record<string, Record<string, Metrics>>
  backtestMeta?: { eventIn?: number; monthlyLeads?: number[] }
  /** The same backtest against other networks, e.g. CoCoRaHS town gauges. */
  otherSources?: Record<string, { n: number; sites: number; dateRange: [string, string]; leaderboard: LeaderRow[] }>
  live: null | {
    n: number
    note?: string
    sites?: number
    dateRange?: [string, string]
    overall?: Record<string, Metrics>
    byLead?: Record<string, Record<string, Metrics>>
  }
  logged?: { records: number; runs: number; firstRun: string | null; lastRun: string | null }
  calibration: null | {
    obs: string
    chance: Bins | null
    confidence: Bins | null
    range: { n: number; inside: number; target: number } | null
  }
}

type State = { status: 'loading' } | { status: 'missing' } | { status: 'ready'; data: Verification }

const BLEND_LABELS: Record<string, string> = { tuned: 'SnowCast (tuned)', default: 'Default blend', equal: 'Equal-weight mean' }
const label = (m: string) => BLEND_LABELS[m] ?? MODEL_LABELS[m as ModelId] ?? m
const inches = (x: number | null | undefined, digits = 2) => (x == null ? '–' : `${x.toFixed(digits)}″`)
const pct = (x: number | null | undefined) => (x == null ? '–' : `${Math.round(x * 100)}%`)
const signedPct = (x: number | null | undefined) => (x == null ? '–' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`)
const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
const monthLabel = (ym: string) => monthFmt.format(new Date(`${ym}-01T00:00:00Z`)).replace(' ', " '")
/** Plain YYYY-MM-DD dates are calendar days, not UTC midnights. */
const dateLabel = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** Scored blends and models in display order: blends first, then models by MAE. */
function methodOrder(rows: Record<string, Metrics>): string[] {
  const blends = ['tuned', 'default', 'equal'].filter(m => rows[m])
  const models = Object.keys(rows).filter(m => !blends.includes(m)).sort((a, b) => rows[a].mae - rows[b].mae)
  return [...blends, ...models]
}

export function Accuracy() {
  const [state, setState] = useState<State>({ status: 'loading' })
  useEffect(() => {
    let live = true
    fetch(`${import.meta.env.BASE_URL}data/verification.json`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => live && setState(j?.version === 1 ? { status: 'ready', data: j } : { status: 'missing' }))
      .catch(() => live && setState({ status: 'missing' }))
    return () => { live = false }
  }, [])

  return (
    <div className="screen">
      <header className="app-header">
        <h1>Accuracy</h1>
        <p className="muted small">How past forecasts compared with what SNOTEL stations measured</p>
      </header>
      {state.status === 'loading' && <div className="loading">Loading scores…</div>}
      {state.status === 'missing' && (
        <section>
          <div className="total-card" style={{ textAlign: 'left', padding: 14 }}>
            <p style={{ margin: 0 }}>No accuracy data has been published yet.</p>
            <p className="muted small" style={{ margin: '6px 0 0' }}>Scores appear after the nightly verification job has run.</p>
          </div>
          <HowWeScore />
        </section>
      )}
      {state.status === 'ready' && <Report data={state.data} />}
    </div>
  )
}

function Report({ data }: { data: Verification }) {
  const s = data.summary
  return (
    <>
      {s && (
        <section>
          <div className="totals-row">
            <Tile label="Tuned MAE" value={inches(s.tunedMae)} sub="SWE per day" />
            <Tile label={`vs ${label(s.bestModel ?? '')}`} value={signedPct(s.vsBestModel)} sub="best single model" tone={s.vsBestModel} />
            <Tile label="vs default" value={signedPct(s.vsDefault)} sub="heuristic blend" tone={s.vsDefault} />
          </div>
          <p className="muted small" style={{ margin: '8px 2px 0' }}>
            Backtest on {s.n.toLocaleString()} station-days at {s.sites} SNOTEL sites, {dateLabel(s.dateRange[0])} – {dateLabel(s.dateRange[1])}.
            Positive % = the tuned blend's error is lower.
            {s.tunedActive < 1 && ` Tuned weights had enough history on ${pct(s.tunedActive)} of days; on the rest they fall back to the default blend.`}
          </p>
        </section>
      )}
      {data.leaderboard && <Leaderboard rows={data.leaderboard} />}
      {data.monthly && data.monthly.length > 1 && <MaeOverTime monthly={data.monthly} best={s?.bestModel ?? null} leads={data.backtestMeta?.monthlyLeads} />}
      {Object.entries(data.otherSources ?? {}).map(([src, o]) => (
        <Leaderboard
          key={src}
          rows={o.leaderboard}
          title={src === 'cocorahs' ? 'Towns (CoCoRaHS gauges)' : src}
          intro={`${o.n.toLocaleString()} gauge-days at ${o.sites} lower-elevation volunteer stations, ${dateLabel(o.dateRange[0])} – ${dateLabel(o.dateRange[1])}.`}
        />
      ))}
      {data.byLead && <ByLead byLead={data.byLead} title="Error by lead day" note="Mean absolute error (SWE inches) by how many days ahead the forecast was made. Lowest per day in blue." />}
      <LiveRecord data={data} />
      {data.calibration && <Calibration cal={data.calibration} />}
      <HowWeScore eventIn={data.backtestMeta?.eventIn} />
      <p className="muted small" style={{ margin: '16px 2px 0' }}>Updated {dateLabel(data.generated)}</p>
    </>
  )
}

function Tile({ label: l, value, sub, tone }: { label: string; value: string; sub: string; tone?: number | null }) {
  const color = tone == null ? undefined : tone > 0.005 ? 'var(--good)' : tone < -0.005 ? 'var(--danger)' : 'var(--text-muted)'
  return (
    <div className="total-card">
      <div className="total-card-label">{l}</div>
      <div className="total-card-val" style={{ fontSize: '1.5rem', ...(color ? { color } : {}) }}>{value}</div>
      <div className="total-card-range">{sub}</div>
    </div>
  )
}

function Leaderboard({ rows, title = 'Leaderboard', intro }: { rows: LeaderRow[]; title?: string; intro?: string }) {
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      {intro && <p className="muted small" style={{ margin: '0 2px 8px' }}>{intro}</p>}
      <div className="table-scroll">
        <table className="model-table">
          <thead>
            <tr><th style={{ textAlign: 'left' }}>Forecast</th><th>MAE</th><th>Tuned</th><th>Tuned gain</th><th>Hit</th><th>False alarm</th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.method} className={r.method === 'tuned' ? 'blend-row' : undefined}>
                <th>
                  {label(r.method)}
                  {r.leads.length < 7 && r.method !== 'tuned' && <span className="muted small"> · day {r.leads.length === 1 ? r.leads[0] : `${r.leads[0]}–${r.leads[r.leads.length - 1]}`}</span>}
                </th>
                <td>{inches(r.mae, 3)}</td>
                <td className="muted">{inches(r.tunedMae, 3)}</td>
                <td style={{ color: r.method === 'tuned' ? undefined : (r.skillVsTuned ?? 0) > 0.005 ? 'var(--good)' : (r.skillVsTuned ?? 0) < -0.005 ? 'var(--danger)' : undefined }}>
                  {r.method === 'tuned' ? '—' : signedPct(r.skillVsTuned)}
                </td>
                <td>{pct(r.hitRate)}</td>
                <td>{pct(r.falseAlarm)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ margin: '6px 2px 0' }}>
        Each row is compared with the tuned blend on exactly the same days, so models that only cover some lead days are scored fairly.
      </p>
    </section>
  )
}

const HEIGHT = 200

type Month = NonNullable<Verification['monthly']>[number]

const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7))

/** Insert a null point between non-consecutive months so the line breaks across the off-season. */
function withGaps(monthly: Month[]): (Month | null)[] {
  const out: (Month | null)[] = []
  monthly.forEach((m, i) => {
    if (i > 0 && monthIndex(m.month) - monthIndex(monthly[i - 1].month) > 1) out.push(null)
    out.push(m)
  })
  return out
}

function MaeOverTime({ monthly: months, best, leads }: { monthly: Month[]; best: string | null; leads?: number[] }) {
  const el = useRef<HTMLDivElement>(null)
  const monthly = withGaps(months)
  const [hover, setHover] = useState<number | null>(null)
  const series = [
    { key: 'tuned', color: '--accent', dash: undefined },
    { key: 'default', color: '--wind', dash: [6, 4] },
    ...(best ? [{ key: best, color: '--warm', dash: undefined }] : []),
  ].filter(s => months.some(m => m.mae[s.key] != null))

  useEffect(() => {
    const node = el.current
    if (!node) return
    const xs = monthly.map((_, i) => i)
    const data: uPlot.AlignedData = [xs, ...series.map(s => monthly.map(m => m?.mae[s.key] ?? null))]
    const axis = { stroke: css('--text-muted'), grid: { stroke: css('--grid'), width: 1 }, ticks: { show: false }, font: '11px system-ui' }
    const step = Math.ceil(monthly.length / 6)
    const plot = new uPlot({
      width: node.clientWidth,
      height: HEIGHT,
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { size: 8 } },
      scales: { x: { time: false }, y: { range: (_u, _min, max) => [0, Math.max(0.1, max * 1.15)] } },
      axes: [
        { ...axis, splits: () => xs.filter(i => monthly[i] && i % step === 0), values: (_u, splits) => splits.map(i => (monthly[i] ? monthLabel(monthly[i]!.month) : '')) },
        { ...axis, size: 44, values: (_u, vals) => vals.map(v => `${v.toFixed(2)}″`) },
      ],
      series: [{}, ...series.map(s => ({ label: label(s.key), stroke: css(s.color), width: 2, dash: s.dash, points: { show: monthly.length < 12, size: 8 } }))],
      hooks: { setCursor: [u => setHover(u.cursor.idx ?? null)] },
    }, data, node)
    const ro = new ResizeObserver(() => plot.setSize({ width: node.clientWidth, height: HEIGHT }))
    ro.observe(node)
    return () => { ro.disconnect(); plot.destroy() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months, best])

  const m = (hover != null ? monthly[hover] : null) ?? months[months.length - 1]
  return (
    <section>
      <h2 className="section-title">Error over time</h2>
      <div className="chart" ref={el} />
      <div className="chart-legend small muted">
        {series.map(s => (
          <span key={s.key}>
            <span className="swatch" style={{ background: s.dash ? `repeating-linear-gradient(90deg, var(${s.color}) 0 5px, transparent 5px 8px)` : `var(${s.color})` }} />{' '}
            {label(s.key)}
          </span>
        ))}
      </div>
      {m && (
        <p className="small" style={{ margin: '6px 2px 0', fontVariantNumeric: 'tabular-nums' }}>
          <strong>{monthLabel(m.month)}</strong>
          {series.map(s => <span key={s.key} className="muted"> · {label(s.key)} {inches(m.mae[s.key], 3)}</span>)}
          {m.tunedActive === 0 && <span className="muted"> · tuned = default (no history yet)</span>}
        </p>
      )}
      <p className="muted small" style={{ margin: '4px 2px 0' }}>
        Monthly mean absolute error of daily SWE, lead days {leads?.length ? `${leads[0]}–${leads[leads.length - 1]}` : '1–3'}. Each month is scored with weights fit only on earlier months.
      </p>
    </section>
  )
}

function ByLead({ byLead, title, note }: { byLead: Record<string, Record<string, Metrics>>; title: string; note: string }) {
  const leads = Object.keys(byLead).sort((a, b) => Number(a) - Number(b))
  const all: Record<string, Metrics> = {}
  for (const l of leads) for (const [m, s] of Object.entries(byLead[l])) all[m] ??= s
  const methods = methodOrder(all)
  const best = Object.fromEntries(leads.map(l => [l, Math.min(...Object.values(byLead[l]).map(s => s.mae))]))
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      <div className="table-scroll">
        <table className="model-table">
          <thead>
            <tr><th style={{ textAlign: 'left' }}>Day</th>{leads.map(l => <th key={l}>{l}</th>)}</tr>
          </thead>
          <tbody>
            {methods.map(m => (
              <tr key={m}>
                <th style={m === 'tuned' ? { fontWeight: 700 } : undefined}>{label(m)}</th>
                {leads.map(l => {
                  const s = byLead[l][m]
                  return <td key={l} className={s && s.mae === best[l] ? 'hit' : undefined}>{s ? s.mae.toFixed(2) : '–'}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ margin: '6px 2px 0' }}>{note}</p>
    </section>
  )
}

function LiveRecord({ data }: { data: Verification }) {
  const live = data.live
  const logged = data.logged
  if (live?.byLead && live.n > 0) {
    return (
      <>
        <ByLead
          byLead={live.byLead}
          title="Live track record"
          note={`Forecasts logged daily and checked against SNOTEL: ${live.n.toLocaleString()} station-days at ${live.sites} sites${live.dateRange ? `, ${dateLabel(live.dateRange[0])} – ${dateLabel(live.dateRange[1])}` : ''}. MAE in SWE inches.`}
        />
      </>
    )
  }
  return (
    <section>
      <h2 className="section-title">Live track record</h2>
      <div className="total-card" style={{ textAlign: 'left', padding: 14 }}>
        <p className="small" style={{ margin: 0 }}>
          {logged?.firstRun
            ? `Logging live forecasts since ${dateLabel(logged.firstRun)} (${logged.runs} run${logged.runs === 1 ? '' : 's'}). Scores appear once observed snowy days come in.`
            : 'Live forecasts are logged daily from now on; scores appear once observed snowy days come in.'}
        </p>
      </div>
    </section>
  )
}

function Calibration({ cal }: { cal: NonNullable<Verification['calibration']> }) {
  const sets = [
    { key: 'chance', title: 'Chance of N inches or more', bins: cal.chance },
    { key: 'confidence', title: 'Headline confidence', bins: cal.confidence },
  ].filter(s => s.bins && s.bins.n > 0)
  return (
    <section>
      <h2 className="section-title">Calibration</h2>
      {sets.map(s => (
        <div key={s.key} style={{ marginBottom: 12 }}>
          <div className="table-scroll">
            <table className="model-table">
              <thead>
                <tr><th style={{ textAlign: 'left' }}>{s.title}</th><th>Said</th><th>Happened</th><th>Cases</th></tr>
              </thead>
              <tbody>
                {s.bins!.bins.map(b => (
                  <tr key={b.lo}>
                    <th className="muted">{Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}%</th>
                    <td>{pct(b.meanP)}</td>
                    <td style={{ fontWeight: 600, color: Math.abs(b.freq - b.meanP) <= 0.1 ? 'var(--good)' : undefined }}>{pct(b.freq)}</td>
                    <td className="muted">{b.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ margin: '6px 2px 0' }}>
            Brier score {s.bins!.brier.toFixed(3)}{s.bins!.brierSkill != null && ` (skill ${signedPct(s.bins!.brierSkill)} vs climatology)`}.
          </p>
        </div>
      ))}
      {cal.range && cal.range.n > 0 && (
        <p className="small" style={{ margin: '0 2px' }}>
          Observed totals landed inside the low–high range <strong>{pct(cal.range.inside)}</strong> of the time ({cal.range.n} windows; aim {pct(cal.range.target)}).
        </p>
      )}
      <p className="muted small" style={{ margin: '6px 2px 0' }}>
        A well-calibrated 70% happens about 70% of the time. Observed: {cal.obs}.
      </p>
    </section>
  )
}

function HowWeScore({ eventIn = 0.5 }: { eventIn?: number }) {
  return (
    <section>
      <h2 className="section-title">How we score</h2>
      <div className="total-card small" style={{ textAlign: 'left', padding: 14, lineHeight: 1.5 }}>
        <p style={{ margin: 0 }}>
          Each forecast day is compared with the snow water equivalent (SWE) a SNOTEL station gained that day. We use cold
          snow-season days (Nov–Apr, at or below 34°F) when the station or a model saw at least 0.1″, so rain and melt don't
          muddy the comparison.
        </p>
        <p style={{ margin: '8px 0 0' }}>
          <strong>MAE</strong> is the average miss in inches of SWE (about 1″ of SWE ≈ 10–15″ of snow).
          <strong> Hit</strong> is the share of {eventIn}″+ SWE days we called; <strong>false alarm</strong> is the share of {eventIn}″+ calls that didn't happen.
        </p>
        <p style={{ margin: '8px 0 0' }}>
          The tuned blend is scored <strong>walk-forward</strong>: each month uses weights learned only from earlier months, the
          way it would have run live. The live track record checks forecasts this app actually logged.
        </p>
      </div>
    </section>
  )
}
