import { useEffect, useRef, type CSSProperties } from 'react'
import type { SpicyHit } from '../spicy'

const TITLE = ['SPICY', 'CASITA', 'SPECIAL']

/** The rider: a chili pepper in shades and a scarf, shredding a flame-decal board through powder. */
function PepperScene() {
  return (
    <svg className="spicy-scene" viewBox="0 0 400 300" role="img" aria-label="A chili pepper in sunglasses snowboarding through deep powder">
      <defs>
        <linearGradient id="sp-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff6b4a" />
          <stop offset="0.55" stopColor="#ff2d2d" />
          <stop offset="1" stopColor="#b3001b" />
        </linearGradient>
        <linearGradient id="sp-board" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#7b5cff" />
          <stop offset="1" stopColor="#ff4fa3" />
        </linearGradient>
        <linearGradient id="sp-flame" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#ffd23f" />
          <stop offset="1" stopColor="#ff6b00" />
        </linearGradient>
        <radialGradient id="sp-powder" cx="0.5" cy="0.3" r="0.7">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#d6ecff" />
        </radialGradient>
      </defs>

      {/* speed lines */}
      <g className="sp-speed" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" opacity="0.7">
        <path d="M330 90h50M300 120h70M340 160h45M310 200h60" />
      </g>

      {/* deep powder field behind */}
      <path d="M0 230 C70 200 140 215 200 205 C270 193 330 210 400 196 L400 300 L0 300 Z" fill="url(#sp-powder)" />

      <g className="sp-rider">
        {/* scarf streaming back */}
        <path className="sp-scarf" d="M200 140 C230 132 255 142 282 132 C276 146 258 152 236 150 C222 149 210 151 200 152 Z" fill="#2fbf71" />
        <path d="M262 136l14 -4M266 145l12 1" stroke="#1f8f52" strokeWidth="2" strokeLinecap="round" />

        {/* board with flame decal */}
        <g transform="rotate(-9 210 236)">
          <rect x="128" y="228" width="168" height="16" rx="8" fill="url(#sp-board)" stroke="#2b1a5e" strokeWidth="2" />
          <path d="M160 236c8-10 14-4 18-12 4 8 10 4 12 14 4-6 10-4 12 2" fill="none" stroke="url(#sp-flame)" strokeWidth="3.5" strokeLinecap="round" />
          <rect x="182" y="222" width="14" height="9" rx="3" fill="#2b1a5e" />
          <rect x="222" y="222" width="14" height="9" rx="3" fill="#2b1a5e" />
        </g>

        {/* legs */}
        <path d="M190 200 L188 226M214 204 L228 224" stroke="#1f8f52" strokeWidth="6" strokeLinecap="round" />

        {/* chili body */}
        <path d="M166 120 C146 146 150 184 176 202 C200 218 238 222 266 210 C242 204 218 190 204 168 C192 148 194 126 202 112 C190 103 174 106 166 120 Z" fill="url(#sp-body)" stroke="#7a0012" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M172 132 C164 152 168 174 182 188" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="5" strokeLinecap="round" fill="none" />

        {/* stem cap */}
        <path d="M168 116 C172 104 190 98 204 110 C196 114 190 112 184 118 C178 112 174 114 168 116 Z" fill="#2fbf71" stroke="#1f8f52" strokeWidth="2" strokeLinejoin="round" />
        <path d="M188 104 C188 92 196 84 208 84" stroke="#1f8f52" strokeWidth="5" strokeLinecap="round" fill="none" />

        {/* arms: one up throwing a shaka, one out for balance */}
        <path d="M166 150 C150 140 142 124 140 110" stroke="#b3001b" strokeWidth="5" strokeLinecap="round" fill="none" />
        <circle cx="139" cy="106" r="6" fill="#ff2d2d" stroke="#7a0012" strokeWidth="2" />
        <path d="M134 101l-4-6M144 102l4-6" stroke="#7a0012" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M206 168 C222 170 236 164 246 154" stroke="#b3001b" strokeWidth="5" strokeLinecap="round" fill="none" />
        <circle cx="248" cy="152" r="5.5" fill="#ff2d2d" stroke="#7a0012" strokeWidth="2" />

        {/* sunglasses */}
        <g>
          <rect x="164" y="128" width="20" height="13" rx="5" fill="#141414" />
          <rect x="188" y="126" width="20" height="13" rx="5" fill="#141414" />
          <path d="M184 133h4M164 133l-6 -3" stroke="#141414" strokeWidth="3" strokeLinecap="round" />
          <path d="M168 131l5 -2M192 129l5 -2" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" opacity="0.8" />
        </g>

        {/* huge grin */}
        <path d="M170 150 C178 166 198 166 206 148 Z" fill="#3a0008" />
        <path d="M178 158 C184 164 194 164 198 156 C192 158 184 158 178 158 Z" fill="#ff7a8a" />
        <path d="M172 151 L204 149" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />

        {/* spicy steam */}
        <g className="sp-steam" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" fill="none" opacity="0.85">
          <path d="M176 92c-4-6 4-8 0-14" />
          <path d="M214 96c-4-6 4-8 0-14" />
        </g>
      </g>

      {/* powder spray off the board's tail */}
      <g className="sp-spray" fill="#ffffff">
        {Array.from({ length: 14 }, (_, i) => (
          <circle key={i} cx={292 + (i % 4) * 4} cy={214 + (i % 5) * 3} r={3 + (i % 4)} style={{ '--i': i } as CSSProperties} />
        ))}
      </g>

      {/* deep powder wave in front, burying the board a little */}
      <path className="sp-wave" d="M100 250 C130 228 170 238 200 246 C240 256 280 236 320 244 C350 250 380 240 400 246 L400 300 L100 300 Z" fill="url(#sp-powder)" />
    </svg>
  )
}

/** Full-screen celebration when a favorite gets more than a foot in 24 hours. */
export function SpicySpecial({ hits, summoned = false, onClose }: { hits: SpicyHit[]; summoned?: boolean; onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    button.current?.focus()
    navigator.vibrate?.([40, 60, 40, 60, 120])
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const top = hits[0]
  let letter = 0
  return (
    <div className="spicy" role="dialog" aria-modal="true" aria-labelledby="spicy-title" onClick={onClose}>
      <div className="spicy-rays" aria-hidden />
      <div className="spicy-confetti" aria-hidden>
        {Array.from({ length: 26 }, (_, i) => (
          <span key={i} style={{ '--x': `${(i * 37) % 100}%`, '--d': `${(i % 7) * 0.45}s`, '--t': `${3.2 + (i % 5) * 0.6}s` } as CSSProperties}>
            {i % 3 === 0 ? '🌶️' : '❄️'}
          </span>
        ))}
      </div>

      <div className="spicy-card" onClick={e => e.stopPropagation()}>
        <h1 id="spicy-title" className="spicy-title" aria-label="Spicy Casita Special">
          {TITLE.map(word => (
            <span key={word} className="spicy-word" aria-hidden>
              {[...word].map(ch => <span key={letter} className="spicy-letter" style={{ '--n': letter++ } as CSSProperties}>{ch}</span>)}
            </span>
          ))}
        </h1>
        <PepperScene />
        {summoned ? (
          <p className="spicy-dump">
            🤫 Secret menu unlocked. <b>{top.name}</b> got <b className="spicy-inches">{Math.round(top.inches)}"</b> in 24 hours.
            <br />Not a foot yet, but this pepper can dream.
          </p>
        ) : (
          <p className="spicy-dump">
            <b>{top.name}</b> just got <b className="spicy-inches">{Math.round(top.inches)}"</b> in 24 hours
            {hits.length > 1 && <> (and {hits.slice(1).map(h => `${h.name} ${Math.round(h.inches)}"`).join(', ')})</>}
          </p>
        )}
        <ul className="spicy-report">
          <li><span>Conditions</span><b>HOT 🔥</b></li>
          <li><span>Snow</span><b>{summoned && top.inches < 12 ? 'IMAGINARY ❄️' : 'BOTTOMLESS ❄️'}</b></li>
          <li><span>Vibes</span><b>IMMACULATE 🌶️</b></li>
        </ul>
        <button ref={button} className="spicy-go" onClick={onClose}>SEND IT 🤙</button>
        <p className="spicy-fine">Call in sick. Responsibly.</p>
      </div>
    </div>
  )
}
