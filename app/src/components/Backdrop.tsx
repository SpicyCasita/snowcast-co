/**
 * The fixed scenery behind every screen: an alpine sky with soft glows, three abstract ridgelines
 * with icy highlights, and two layers of slow CSS snowfall (off with prefers-reduced-motion).
 * Purely decorative, so it's hidden from assistive tech and never takes pointer events.
 */
export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden>
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
    </div>
  )
}
