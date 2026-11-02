import { useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import type { SnowLocation } from '../data/locations'
import { feet } from '../format'
import {
  currentSubscription, loadThresholds, pushSupport, saveThresholds, sendTestPush, subscribe, syncAlerts, unsubscribe,
  type Thresholds,
} from '../push'

const primaryButton: CSSProperties = {
  padding: '10px 16px', borderRadius: 10, border: 0, background: 'var(--accent)', color: '#fff', fontWeight: 600, cursor: 'pointer',
}
const secondaryButton: CSSProperties = {
  ...primaryButton, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', fontWeight: 500,
}
const row: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const toInput = (x: number | null) => (x == null ? '' : String(x))
/** Blank turns a window off; anything else must be a positive number of inches. */
function parseInches(s: string): number | null | undefined {
  if (s.trim() === '') return null
  const x = Number(s)
  return Number.isFinite(x) && x > 0 && x <= 500 ? x : undefined
}

type Status = { kind: 'ok' | 'error'; text: string } | null

export function Alerts({ favorites }: { favorites: SnowLocation[] }) {
  const support = pushSupport()
  // undefined while checking this device's subscription.
  const [subscribed, setSubscribed] = useState<boolean | undefined>(support === 'ok' ? undefined : false)
  const [saved, setSaved] = useState<Thresholds>(loadThresholds)
  const [h72, setH72] = useState(() => toInput(saved.h72In))
  const [d7, setD7] = useState(() => toInput(saved.d7In))
  const [fresh, setFresh] = useState(() => toInput(saved.freshIn))
  const [freshHours, setFreshHours] = useState<24 | 48>(saved.freshHours)
  const [miss, setMiss] = useState(() => toInput(saved.missIn))
  const [recapDay, setRecapDay] = useState(() => (saved.recapDay == null ? '' : String(saved.recapDay)))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const favKey = favorites.map(f => f.id).join(',')
  useEffect(() => {
    if (support !== 'ok') return
    let live = true
    // Keep the Worker's copy of the favorites current whenever this screen opens.
    currentSubscription()
      .then(sub => {
        if (live) setSubscribed(!!sub)
        return sub ? syncAlerts(favorites, saved) : false
      })
      .catch(e => live && setStatus({ kind: 'error', text: (e as Error).message }))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [support, favKey])

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true)
    setStatus(null)
    try {
      const text = await fn()
      if (text) setStatus({ kind: 'ok', text })
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const enable = () => run(async () => {
    await subscribe(favorites, saved)
    setSubscribed(true)
    return 'Alerts are on for this device.'
  })
  const disable = () => run(async () => {
    await unsubscribe()
    setSubscribed(false)
    return 'Alerts are off for this device.'
  })
  const test = () => run(async () => {
    await sendTestPush()
    return 'Test sent. It should arrive in a few seconds.'
  })
  const saveForm = (e: FormEvent) => {
    e.preventDefault()
    const h72In = parseInches(h72)
    const d7In = parseInches(d7)
    const freshIn = parseInches(fresh)
    const missIn = parseInches(miss)
    if (h72In === undefined || d7In === undefined || freshIn === undefined || missIn === undefined) {
      setStatus({ kind: 'error', text: 'Amounts must be a positive number of inches, or blank for off.' })
      return
    }
    const next: Thresholds = { h72In, d7In, freshIn, freshHours, missIn, recapDay: recapDay === '' ? null : Number(recapDay) }
    saveThresholds(next)
    setSaved(next)
    run(async () => ((await syncAlerts(favorites, next).catch(() => { throw new Error('Saved on this device, but the alerts server could not be reached.') }))
      ? 'Saved.'
      : 'Saved. Turn on alerts to use them.'))
  }

  const off = saved.h72In == null && saved.d7In == null && saved.freshIn == null && saved.missIn == null && saved.recapDay == null

  return (
    <div className="screen">
      <header className="app-header">
        <h1>Alerts</h1>
        <p className="muted">Notifications for your favorites: big forecasts, fresh snow that actually fell, forecast misses, and a weekly recap.</p>
      </header>

      {support === 'ios-install' && (
        <section>
          <h2 className="section-title">Add to Home Screen first (iOS 16.4+)</h2>
          <div className="fav-card">
            <p style={{ margin: 0 }}>iPhone only sends notifications to web apps opened from the Home Screen.</p>
            <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              <li>In Safari, tap the Share button <span aria-hidden>⎋</span>.</li>
              <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
              <li>Open SnowCast from the Home Screen and come back to Alerts.</li>
            </ol>
          </div>
        </section>
      )}

      <section>
        <h2 className="section-title">This device</h2>
        <div className="fav-card" style={row}>
          <div>
            <div className="fav-name">
              {support === 'no-api' ? 'Alerts not available' :
                support === 'unsupported' ? 'Not supported here' :
                support === 'ios-install' ? 'Needs Home Screen app' :
                subscribed === undefined ? 'Checking…' : subscribed ? 'Alerts on' : 'Alerts off'}
            </div>
            <div className="fav-sub">
              {support === 'no-api' ? 'This build has no alerts server configured.' :
                support === 'unsupported' ? "This browser can't receive push notifications." :
                subscribed ? `Covering ${favorites.length} favorite${favorites.length === 1 ? '' : 's'}` : 'Notifications for your favorites'}
            </div>
          </div>
          {support === 'ok' && subscribed !== undefined && (
            subscribed
              ? <button style={secondaryButton} disabled={busy} onClick={disable}>Turn off</button>
              : <button style={primaryButton} disabled={busy} onClick={enable}>Enable alerts</button>
          )}
        </div>
        {status && <p className={status.kind === 'error' ? 'small' : 'small muted'} style={status.kind === 'error' ? { color: 'var(--danger)' } : undefined} role="status">{status.text}</p>}
      </section>

      <form onSubmit={saveForm}>
        <section>
          <h2 className="section-title">Forecast alerts · when the forecast reaches</h2>
          <div className="elev-form" style={{ marginTop: 0 }}>
            <label>
              Next 72 hours (in)
              <input type="number" inputMode="decimal" min="0.5" step="0.5" placeholder="Off" value={h72} onChange={e => setH72(e.target.value)} />
            </label>
            <label>
              Next 7 days (in)
              <input type="number" inputMode="decimal" min="0.5" step="0.5" placeholder="Off" value={d7} onChange={e => setD7(e.target.value)} />
            </label>
          </div>
          <p className="muted small">Each favorite alerts at most once a day per window, unless its forecast grows by half again.</p>
        </section>

        <section>
          <h2 className="section-title">Past snowfall alerts · sent ~6am</h2>
          <div className="elev-form" style={{ marginTop: 0 }}>
            <label>
              Fresh snow measured (in)
              <input type="number" inputMode="decimal" min="0.5" step="0.5" placeholder="Off" value={fresh} onChange={e => setFresh(e.target.value)} />
            </label>
            <label>
              In the last
              <select value={freshHours} onChange={e => setFreshHours(e.target.value === '48' ? 48 : 24)}>
                <option value="24">24 hours</option>
                <option value="48">48 hours</option>
              </select>
            </label>
          </div>
          <div className="elev-form">
            <label>
              Forecast missed by (in)
              <input type="number" inputMode="decimal" min="0.5" step="0.5" placeholder="Off" value={miss} onChange={e => setMiss(e.target.value)} />
            </label>
            <label>
              Weekly recap
              <select value={recapDay} onChange={e => setRecapDay(e.target.value)}>
                <option value="">Off</option>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d} mornings</option>)}
              </select>
            </label>
          </div>
          <p className="muted small">
            Fresh snow and misses use the nearest SNOTEL or CoCoRaHS station for each favorite (see the Past tab). A miss compares yesterday's measurement with what we forecast the day before.
          </p>
        </section>

        <div className="form-actions">
          <button type="submit" style={primaryButton} disabled={busy}>Save alert settings</button>
          {off && <span className="muted small">Everything is off, so no alerts will be sent.</span>}
        </div>
        <p className="muted small">Leave a box blank to turn that alert off.</p>
      </form>

      <section>
        <h2 className="section-title">Favorites covered</h2>
        {favorites.length === 0
          ? <p className="muted">Star a location to get alerts for it.</p>
          : (
            <ul className="loc-list">
              {favorites.map(l => (
                <li key={l.id}>
                  <a href={`#/loc/${l.id}`}>
                    <span>{l.name}</span>
                    <span className="muted small">at {feet(Math.round((l.baseFt + l.summitFt) / 2))}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
      </section>

      {support === 'ok' && subscribed && (
        <section>
          <button style={secondaryButton} disabled={busy} onClick={test}>Send test notification</button>
        </section>
      )}
    </div>
  )
}
