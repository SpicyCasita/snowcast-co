import { useMemo, type CSSProperties } from 'react'

/** Deterministic pseudo-random numbers so storm crystals don't jump around on re-render. */
function seeded(seed: number) {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

/** An abstract six-armed ice crystal with a glint at its heart. */
function Crystal() {
  return (
    <svg viewBox="-12 -12 24 24" aria-hidden>
      <g stroke="url(#crystal-grad)" strokeWidth="1.3" strokeLinecap="round">
        {[0, 60, 120].map(a => <path key={a} d="M0 -10V10M-3 -7.5 0 -5l3-2.5M-3 7.5 0 5l3 2.5" transform={`rotate(${a})`} />)}
      </g>
      <circle r="1.6" fill="#fff" />
    </svg>
  )
}

/** Large drifting crystals for storm mode. */
function StormCrystals({ count = 16 }: { count?: number }) {
  const flakes = useMemo(() => {
    const rand = seeded(42)
    return Array.from({ length: count }, (_, i) => ({
      key: i,
      style: {
        left: `${rand() * 100}%`,
        width: `${12 + rand() * 18}px`,
        animationDuration: `${11 + rand() * 10}s, ${4 + rand() * 4}s`,
        animationDelay: `${-rand() * 20}s, ${-rand() * 4}s`,
        '--sway': `${(rand() - 0.5) * 80}px`,
        '--spin': `${rand() > 0.5 ? 1 : -1}`,
      } as CSSProperties,
    }))
  }, [count])
  return (
    <div className="crystals">
      {flakes.map(f => <span key={f.key} className="crystal" style={f.style}><Crystal /></span>)}
    </div>
  )
}

/**
 * The fixed scenery behind every screen: an alpine sky with soft glows, three abstract ridgelines
 * with icy highlights, and two layers of slow CSS snowfall (off with prefers-reduced-motion).
 * With `storm`, a heavier shiny snowfall and drifting crystals join in. Purely decorative, so it's
 * hidden from assistive tech and never takes pointer events.
 */
export function Backdrop({ storm = false }: { storm?: boolean }) {
  return (
    <div className={storm ? 'backdrop storm' : 'backdrop'} aria-hidden>
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <linearGradient id="crystal-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: '#ffffff' }} />
            <stop offset="0.5" style={{ stopColor: 'var(--crystal-mid)' }} />
            <stop offset="1" style={{ stopColor: '#ffffff' }} />
          </linearGradient>
        </defs>
      </svg>
      <div className="sky" />
      <div className="glow glow-a" />
      <div className="glow glow-b" />
      <svg className="ridges" viewBox="0 0 1200 520" preserveAspectRatio="xMidYMax slice">
        <defs>
          <linearGradient id="ridge-far" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--ridge-far-top)' }} />
            <stop offset="1" style={{ stopColor: 'var(--ridge-far-bottom)' }} />
          </linearGradient>
          <linearGradient id="ridge-mid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--ridge-mid-top)' }} />
            <stop offset="1" style={{ stopColor: 'var(--ridge-mid-bottom)' }} />
          </linearGradient>
          <linearGradient id="ridge-near" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--ridge-near-top)' }} />
            <stop offset="1" style={{ stopColor: 'var(--ridge-near-bottom)' }} />
          </linearGradient>
          <linearGradient id="ridge-shine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" style={{ stopColor: 'var(--ridge-shine)' }} stopOpacity="0" />
            <stop offset="0.45" style={{ stopColor: 'var(--ridge-shine)' }} stopOpacity="0.9" />
            <stop offset="1" style={{ stopColor: 'var(--ridge-shine)' }} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Far range: tall, faint, faceted peaks */}
        <path fill="url(#ridge-far)" d="M0 300 L90 230 L150 262 L250 150 L330 220 L410 170 L470 205 L560 110 L640 190 L700 160 L790 230 L880 140 L960 210 L1040 170 L1120 235 L1200 200 L1200 520 L0 520 Z" />
        <path className="ridge-line" stroke="url(#ridge-shine)" d="M180 222 L250 150 L292 186 M500 160 L560 110 L610 160 M830 182 L880 140 L925 180" />
        {/* Mid range */}
        <path fill="url(#ridge-mid)" d="M0 360 L120 290 L200 330 L300 250 L380 310 L470 270 L560 330 L660 240 L760 320 L850 280 L950 340 L1060 270 L1200 330 L1200 520 L0 520 Z" />
        <path className="ridge-line" stroke="url(#ridge-shine)" d="M240 300 L300 250 L345 283 M600 290 L660 240 L715 283 M1000 310 L1060 270 L1120 300" />
        {/* Near hills: rounded drifts */}
        <path fill="url(#ridge-near)" d="M0 430 C120 390 220 400 330 420 C460 445 560 380 700 395 C840 410 930 440 1060 410 C1120 397 1170 400 1200 405 L1200 520 L0 520 Z" />
      </svg>
      <div className="snow snow-far" />
      <div className="snow snow-near" />
      {storm && (
        <>
          <div className="storm-sway"><div className="snow storm-glow" /></div>
          <div className="snow storm-sparkle" />
          <StormCrystals />
        </>
      )}
    </div>
  )
}
