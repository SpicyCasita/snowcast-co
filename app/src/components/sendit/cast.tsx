/**
 * The SEND IT cast, drawn around (0, 0) so scenes can place them with a wrapping
 * <g transform="translate(…)">. Animate an inner <g className="…">: CSS transforms replace the SVG
 * transform attribute on the same element, so position and motion live on different groups.
 */
import { useId, type ReactNode } from 'react'

export type Mood = 'happy' | 'wow' | 'derp' | 'blush' | 'sleepy' | 'dizzy' | 'sick' | 'bulge' | 'laugh'

function Eyes({ mood, shades }: { mood: Mood; shades: boolean }) {
  if (shades) {
    return (
      <g>
        <rect x="-19" y="-30" width="16" height="11" rx="4.5" fill="#141414" />
        <rect x="1" y="-31" width="16" height="11" rx="4.5" fill="#141414" />
        <path d="M-3 -25h4" stroke="#141414" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M-16 -27l4 -1.5M4 -28l4 -1.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity="0.85" />
      </g>
    )
  }
  if (mood === 'sleepy' || mood === 'sick') {
    return <path d="M-16 -24q5 4 10 0M2 -25q5 4 10 0" stroke="#3a0008" strokeWidth="2.4" strokeLinecap="round" fill="none" />
  }
  if (mood === 'laugh') {
    return <path d="M-16 -22q5 -7 10 0M2 -23q5 -7 10 0" stroke="#3a0008" strokeWidth="2.6" strokeLinecap="round" fill="none" />
  }
  if (mood === 'dizzy') {
    const spiral = (cx: number) => `M${cx} -24 m-6 0 a6 6 0 1 1 12 0 a4 4 0 1 1 -8 0 a2 2 0 1 1 4 0`
    return (
      <g stroke="#3a0008" strokeWidth="1.8" fill="#fff">
        <circle cx="-10" cy="-24" r="7" />
        <circle cx="8" cy="-24" r="7" />
        <path d={`${spiral(-10)}${spiral(8)}`} fill="none" />
      </g>
    )
  }
  if (mood === 'bulge') {
    return (
      <g>
        <circle cx="-11" cy="-26" r="11" fill="#fff" stroke="#3a0008" strokeWidth="1.5" />
        <circle cx="10" cy="-27" r="11" fill="#fff" stroke="#3a0008" strokeWidth="1.5" />
        <circle cx="-11" cy="-26" r="2.2" fill="#1b0b12" />
        <circle cx="10" cy="-27" r="2.2" fill="#1b0b12" />
      </g>
    )
  }
  const eye = (cx: number, squint = false) =>
    squint ? (
      <path d={`M${cx - 5} -24q5 -5 10 0`} stroke="#3a0008" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    ) : (
      <g>
        <ellipse cx={cx} cy="-24" rx="6.5" ry={mood === 'wow' ? 8 : 7} fill="#fff" />
        <circle cx={cx + 0.5} cy="-23" r={mood === 'wow' ? 3 : 4} fill="#1b0b12" />
        <circle cx={cx + 2} cy="-25.5" r="1.6" fill="#fff" />
      </g>
    )
  return (
    <g>
      {eye(-10)}
      {eye(8, mood === 'derp')}
    </g>
  )
}

function Mouth({ mood }: { mood: Mood }) {
  if (mood === 'wow') return <ellipse cx="-1" cy="-6" rx="5" ry="6" fill="#3a0008" />
  if (mood === 'derp') {
    return (
      <g>
        <path d="M-10 -9q9 9 18 0" stroke="#3a0008" strokeWidth="2.6" strokeLinecap="round" fill="none" />
        <path d="M1 -5q3 7 7 1" fill="#ff7a8a" stroke="#3a0008" strokeWidth="1.4" />
      </g>
    )
  }
  if (mood === 'sleepy') return <path d="M-5 -7q4 2 8 0" stroke="#3a0008" strokeWidth="2.2" strokeLinecap="round" fill="none" />
  if (mood === 'sick' || mood === 'dizzy') return <path d="M-10 -6q3 -4 6 0t6 0t6 0" stroke="#3a0008" strokeWidth="2.4" strokeLinecap="round" fill="none" />
  if (mood === 'bulge') return <ellipse cx="-1" cy="-4" rx="4" ry="5" fill="#3a0008" />
  if (mood === 'laugh') {
    return (
      <g>
        <path d="M-13 -12 C-10 6 10 6 12 -13 Z" fill="#3a0008" />
        <path d="M-6 -2 C-2 2 4 2 6 -3 C2 -2 -2 -2 -6 -2 Z" fill="#ff7a8a" />
      </g>
    )
  }
  return (
    <g>
      <path d="M-11 -10 C-7 0 7 0 10 -11 Z" fill="#3a0008" />
      <path d="M-5 -5 C-2 -2 4 -2 6 -6 C2 -5 -2 -5 -5 -5 Z" fill="#ff7a8a" />
    </g>
  )
}

/** The hero: a chili pepper with big eyes (or shades), stubby arms and legs. About 60×110. */
export function Pepper({ mood = 'happy', shades = false, green = false, beard = false, wave = false, pants, undies = false, children }: {
  mood?: Mood
  shades?: boolean
  green?: boolean
  /** Blue ski pants, optionally ripped open to show heart boxers. */
  pants?: 'on' | 'split'
  /** Heart-print briefs. */
  undies?: boolean
  /** Powder beard and frosty brows. */
  beard?: boolean
  /** Right arm up in a shaka. */
  wave?: boolean
  children?: ReactNode
}) {
  const id = useId()
  const [hi, mid, lo] = green ? ['#9ef07a', '#3fbf45', '#1d7a2a'] : ['#ff7a5a', '#ff2d2d', '#b3001b']
  return (
    <g>
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={hi} />
          <stop offset="0.55" stopColor={mid} />
          <stop offset="1" stopColor={lo} />
        </linearGradient>
      </defs>
      {/* legs */}
      <path d="M-9 40 L-13 58M5 42 L9 58" stroke="#1f8f52" strokeWidth="5" strokeLinecap="round" />
      {/* arms */}
      <path d="M-24 -4 C-34 2 -38 10 -40 18" stroke={lo} strokeWidth="5" strokeLinecap="round" fill="none" />
      {wave ? (
        <g>
          <path d="M22 -8 C32 -16 36 -26 38 -36" stroke={lo} strokeWidth="5" strokeLinecap="round" fill="none" />
          <circle cx="39" cy="-39" r="5" fill={mid} stroke={lo} strokeWidth="1.6" />
          <path d="M35 -43l-3 -5M43 -42l3 -5" stroke={lo} strokeWidth="2.2" strokeLinecap="round" />
        </g>
      ) : (
        <path d="M22 -4 C32 2 36 10 38 18" stroke={lo} strokeWidth="5" strokeLinecap="round" fill="none" />
      )}
      {/* body: a plump chili curling to a tip */}
      <path d="M-20 -42 C-34 -18 -30 22 -10 44 C-2 54 10 52 8 40 C4 20 26 -6 20 -36 C16 -50 -10 -54 -20 -42 Z"
        fill={`url(#${id}b)`} stroke={lo} strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M-18 -30 C-24 -12 -22 10 -12 28" stroke="#fff" strokeOpacity="0.5" strokeWidth="4.5" strokeLinecap="round" fill="none" />
      {undies && <Undies />}
      {pants && (
        <g>
          <path d="M-31 4 C-30 24 -18 42 -8 46 C2 52 10 48 8 40 C6 28 16 16 24 4 Z" fill="#2f6fd6" stroke="#1d4a99" strokeWidth="2.2" strokeLinejoin="round" />
          <path d="M-31 4 L24 4" stroke="#1d4a99" strokeWidth="3" />
          {pants === 'split' && (
            <g>
              {/* a jagged rip showing pink heart boxers */}
              <path d="M-28 12 l7 -7 l5 9 l6 -8 l5 9 l6 -8 l5 8 l5 -6 C8 44 -20 42 -28 12 Z" fill="#ffd6e4" stroke="#1d4a99" strokeWidth="1.8" strokeLinejoin="round" />
              <g transform="translate(-16 22)"><Heart size={0.75} /></g>
              <g transform="translate(-2 30)"><Heart size={0.75} /></g>
              <g transform="translate(-14 36)"><Heart size={0.55} /></g>
            </g>
          )}
        </g>
      )}
      {mood === 'sick' && <ellipse cx="-2" cy="-18" rx="22" ry="20" fill="#7fdc5a" opacity="0.55" />}
      {/* stem cap */}
      <path d="M-20 -44 C-16 -56 6 -60 18 -44 C10 -40 4 -44 -2 -38 C-8 -44 -14 -42 -20 -44 Z" fill="#2fbf71" stroke="#1f8f52" strokeWidth="2" strokeLinejoin="round" />
      <path d="M0 -52 C0 -64 8 -70 18 -70" stroke="#1f8f52" strokeWidth="4.5" strokeLinecap="round" fill="none" />
      {/* cheeks */}
      <ellipse cx="-17" cy="-12" rx="5" ry="3" fill="#ff9db0" opacity={mood === 'blush' ? 0.95 : 0.55} />
      <ellipse cx="15" cy="-13" rx="5" ry="3" fill="#ff9db0" opacity={mood === 'blush' ? 0.95 : 0.55} />
      <Eyes mood={mood} shades={shades} />
      <Mouth mood={mood} />
      {beard && (
        <g fill="#fff">
          <path d="M-16 -8 C-14 10 12 10 14 -8 C10 4 -10 4 -16 -8 Z" />
          <circle cx="-10" cy="4" r="4" />
          <circle cx="0" cy="7" r="5" />
          <circle cx="9" cy="4" r="4" />
          <path d="M-18 -34 q8 -5 14 0M2 -35 q8 -5 14 0" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" fill="none" />
        </g>
      )}
      {children}
    </g>
  )
}

/** A snowboard, centered, about 110 wide. */
export function Board({ hue = 'purple' }: { hue?: 'purple' | 'teal' | 'tiny' }) {
  const id = useId()
  const [a, b] = hue === 'teal' ? ['#19b5e6', '#7b5cff'] : hue === 'tiny' ? ['#ffd23f', '#ff7aa8'] : ['#7b5cff', '#ff4fa3']
  const w = hue === 'tiny' ? 60 : 110
  return (
    <g>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={a} />
          <stop offset="1" stopColor={b} />
        </linearGradient>
      </defs>
      <rect x={-w / 2} y="-6" width={w} height="12" rx="6" fill={`url(#${id}g)`} stroke="#2b1a5e" strokeWidth="2" />
      <path d={`M${-w / 4} 0c5 -7 9 -3 12 -9 3 6 7 3 9 10`} fill="none" stroke="#ffd23f" strokeWidth="2.6" strokeLinecap="round" />
    </g>
  )
}

export function Penguin({ mood = 'happy', slimed = false }: { mood?: 'happy' | 'wow' | 'dizzy' | 'laugh' | 'glare'; slimed?: boolean }) {
  return (
    <g>
      <ellipse cx="0" cy="0" rx="17" ry="22" fill="#1d2433" />
      <ellipse cx="0" cy="5" rx="11" ry="15" fill="#fff" />
      <path d="M-17 -2 C-24 4 -24 12 -19 16M17 -2 C24 4 24 12 19 16" stroke="#1d2433" strokeWidth="6" strokeLinecap="round" fill="none" />
      <path d="M-8 21h7M2 21h7" stroke="#ff9f1c" strokeWidth="4.5" strokeLinecap="round" />
      {mood === 'dizzy' ? (
        <path d="M-9 -12l5 5M-4 -12l-5 5M4 -12l5 5M9 -12l-5 5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      ) : mood === 'laugh' ? (
        <g>
          <path d="M-10 -8q4 -5 8 0M2 -8q4 -5 8 0" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          <path d="M-6 4 q6 8 12 0 Z" fill="#c2182b" />
        </g>
      ) : mood === 'glare' ? (
        <g>
          <path d="M-10 -14 l8 3M10 -14 l-8 3" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="-5.5" cy="-8" r="2.4" fill="#fff" />
          <circle cx="5.5" cy="-8" r="2.4" fill="#fff" />
        </g>
      ) : (
        <g>
          <circle cx="-6" cy="-9" r={mood === 'wow' ? 4.5 : 4} fill="#fff" />
          <circle cx="6" cy="-9" r={mood === 'wow' ? 4.5 : 4} fill="#fff" />
          <circle cx="-5.5" cy="-8.5" r="2.4" fill="#111" />
          <circle cx="6.5" cy="-8.5" r="2.4" fill="#111" />
        </g>
      )}
      <path d="M-4 -3 L0 2 L4 -3 Z" fill="#ff9f1c" />
      <ellipse cx="-11" cy="-1" rx="3" ry="2" fill="#ff9db0" opacity="0.7" />
      <ellipse cx="11" cy="-1" rx="3" ry="2" fill="#ff9db0" opacity="0.7" />
      {slimed && (
        <path d="M-16 -18 C-10 -30 12 -30 16 -18 C14 -10 12 -4 10 2 C8 -6 4 -8 2 -2 C0 -10 -4 -10 -6 -2 C-8 -8 -12 -8 -16 -18 Z"
          fill="#8fe04a" stroke="#4f9a1e" strokeWidth="1.4" />
      )}
    </g>
  )
}

/** Penguin from behind with its pants down, wiggling heart boxers that say SEND IT. */
export function PenguinMoon() {
  return (
    <g>
      <ellipse cx="0" cy="-6" rx="17" ry="22" fill="#1d2433" />
      <path d="M-17 -4 C-24 2 -24 10 -19 14M17 -4 C24 2 24 10 19 14" stroke="#1d2433" strokeWidth="6" strokeLinecap="round" fill="none" />
      <path d="M-17 2 C-17 16 -8 22 0 22 C8 22 17 16 17 2 Z" fill="#ff4f7b" stroke="#a3123b" strokeWidth="1.6" />
      <path d="M0 4 V22" stroke="#a3123b" strokeWidth="1.4" />
      <g transform="translate(-9 10)"><Heart size={0.35} /></g>
      <g transform="translate(9 14)"><Heart size={0.35} /></g>
      <text x="0" y="-12" fontSize="7" fontWeight="900" textAnchor="middle" fill="#fff">SEND IT</text>
      <rect x="-12" y="22" width="24" height="5" rx="2" fill="#2f6fd6" />
      <path d="M-8 28h7M2 28h7" stroke="#ff9f1c" strokeWidth="4.5" strokeLinecap="round" />
    </g>
  )
}

export function Marmot({ mood = 'happy' }: { mood?: 'happy' | 'hot' | 'sick' }) {
  const fur = mood === 'hot' ? '#ff5a3c' : mood === 'sick' ? '#8fcf5a' : '#b07a4a'
  return (
    <g>
      <circle cx="-14" cy="-24" r="6" fill={fur} stroke="#6b4425" strokeWidth="2" />
      <circle cx="14" cy="-24" r="6" fill={fur} stroke="#6b4425" strokeWidth="2" />
      <ellipse cx="0" cy="0" rx="24" ry="26" fill={fur} stroke="#6b4425" strokeWidth="2.4" style={{ transition: 'fill 0.4s' }} />
      <ellipse cx="0" cy="8" rx="15" ry="14" fill="#f3d2a8" />
      <circle cx="-8" cy="-8" r="4" fill="#1b0b12" />
      <circle cx="8" cy="-8" r="4" fill="#1b0b12" />
      <circle cx="-6.5" cy="-9.5" r="1.4" fill="#fff" />
      <circle cx="9.5" cy="-9.5" r="1.4" fill="#fff" />
      <ellipse cx="0" cy="0" rx="4" ry="3" fill="#3a2414" />
      <rect x="-3.5" y="3" width="7" height="6" rx="1.5" fill="#fff" stroke="#6b4425" strokeWidth="1" />
      <ellipse cx="-15" cy="2" rx="4" ry="2.5" fill="#ff9db0" opacity="0.7" />
      <ellipse cx="15" cy="2" rx="4" ry="2.5" fill="#ff9db0" opacity="0.7" />
    </g>
  )
}

export function Snowman({ shades = false }: { shades?: boolean }) {
  return (
    <g>
      <circle cx="0" cy="40" r="30" fill="#fff" stroke="#bcd8f5" strokeWidth="2.5" />
      <circle cx="0" cy="-8" r="22" fill="#fff" stroke="#bcd8f5" strokeWidth="2.5" />
      <circle cx="0" cy="-46" r="17" fill="#fff" stroke="#bcd8f5" strokeWidth="2.5" />
      <path d="M-18 -10 L-40 -24M18 -10 L40 -26" stroke="#7a4a22" strokeWidth="3" strokeLinecap="round" />
      <path d="M0 -44 L20 -40 L0 -38 Z" fill="#ff8a1c" />
      {shades ? (
        <g>
          <rect x="-13" y="-55" width="11" height="8" rx="3" fill="#141414" />
          <rect x="2" y="-55" width="11" height="8" rx="3" fill="#141414" />
          <path d="M-2 -51h4" stroke="#141414" strokeWidth="2" />
        </g>
      ) : (
        <g fill="#1b1b1b">
          <circle cx="-6" cy="-51" r="2.6" />
          <circle cx="6" cy="-51" r="2.6" />
        </g>
      )}
      <path d="M-8 -36q8 6 16 0" stroke="#1b1b1b" strokeWidth="2" strokeLinecap="round" fill="none" />
      <g fill="#1b1b1b">
        <circle cx="0" cy="-12" r="2.4" />
        <circle cx="0" cy="-2" r="2.4" />
      </g>
      <path d="M-14 -30 C-6 -24 6 -24 14 -30 L16 -24 C6 -18 -6 -18 -16 -24 Z" fill="#ff4fa3" />
    </g>
  )
}

export function Duck({ shades = false }: { shades?: boolean }) {
  return (
    <g>
      <ellipse cx="0" cy="6" rx="16" ry="11" fill="#ffd23f" stroke="#e0a800" strokeWidth="1.6" />
      <circle cx="-6" cy="-8" r="10" fill="#ffd23f" stroke="#e0a800" strokeWidth="1.6" />
      <path d="M-16 -8 L-24 -5 L-16 -3 Z" fill="#ff8a1c" />
      {shades ? (
        <rect x="-14" y="-12" width="12" height="6" rx="2.5" fill="#141414" />
      ) : (
        <circle cx="-9" cy="-10" r="2.2" fill="#1b0b12" />
      )}
      <path d="M8 2q6 -2 8 4" stroke="#e0a800" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </g>
  )
}

/** A tiny adobe casita on wheels, with a ristra of chiles by the door. */
export function Casita() {
  return (
    <g>
      <rect x="-60" y="-50" width="120" height="70" rx="10" fill="#e8b98a" stroke="#a8693e" strokeWidth="2.5" />
      <rect x="-64" y="-56" width="128" height="12" rx="5" fill="#d29a6a" stroke="#a8693e" strokeWidth="2" />
      <rect x="-12" y="-24" width="24" height="44" rx="10" fill="#3fa7a1" stroke="#22706c" strokeWidth="2" />
      <rect x="-48" y="-36" width="22" height="20" rx="4" fill="#bfe8ff" stroke="#a8693e" strokeWidth="2" />
      <g fill="#ff2d2d" stroke="#8a0012" strokeWidth="1">
        {[0, 1, 2, 3].map(i => <ellipse key={i} cx="22" cy={-36 + i * 8} rx="3.4" ry="4.6" />)}
      </g>
      <path d="M22 -42v-6" stroke="#2fbf71" strokeWidth="2" />
      <circle cx="-36" cy="24" r="11" fill="#2b2b3a" stroke="#000" strokeWidth="2" />
      <circle cx="36" cy="24" r="11" fill="#2b2b3a" stroke="#000" strokeWidth="2" />
      <circle cx="-36" cy="24" r="4" fill="#bbb" />
      <circle cx="36" cy="24" r="4" fill="#bbb" />
    </g>
  )
}

/** Snowy hills across the bottom of a 400×500 scene. */
export function Hills({ tint = '#eaf4ff' }: { tint?: string }) {
  return (
    <g>
      <path d="M0 330 C80 300 160 320 240 300 C310 284 360 300 400 290 L400 500 L0 500 Z" fill="#d6e8fa" />
      <path d="M0 380 C100 350 200 372 300 350 C350 340 380 346 400 342 L400 500 L0 500 Z" fill={tint} />
    </g>
  )
}

export function Heart({ size = 1 }: { size?: number }) {
  return <path transform={`scale(${size})`} d="M0 6 C-10 -2 -10 -10 -4 -10 C-1 -10 0 -7 0 -6 C0 -7 1 -10 4 -10 C10 -10 10 -2 0 6 Z" fill="#ff4f7b" />
}

/* ── Shared scenery ── */

export const Sky = ({ night = false }: { night?: boolean }) => (
  <rect width="400" height="500" fill={night ? 'url(#si-night)' : 'url(#si-day)'} />
)

export const Defs = () => (
  <defs>
    <linearGradient id="si-day" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#8fd0ff" />
      <stop offset="0.7" stopColor="#dff1ff" />
      <stop offset="1" stopColor="#ffffff" />
    </linearGradient>
    <linearGradient id="si-night" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#0b1033" />
      <stop offset="1" stopColor="#3a2a6e" />
    </linearGradient>
  </defs>
)

export const Poof = ({ className }: { className: string }) => (
  <g className={className}>
    <circle r="22" fill="#fff" />
    <circle cx="-24" cy="6" r="16" fill="#fff" />
    <circle cx="24" cy="4" r="18" fill="#fff" />
    <circle cx="0" cy="-18" r="14" fill="#fff" />
  </g>
)

export const Stars = () => (
  <g fill="#fff">
    {[[40, 50], [120, 90], [220, 40], [310, 80], [360, 140], [70, 160], [270, 150]].map(([x, y]) => (
      <circle key={`${x}${y}`} cx={x} cy={y} r="1.8" className="si-twinkle" />
    ))}
  </g>
)


/* ── Crude props ── */

/** Heart-print briefs drawn over the pepper's lower body. */
export function Undies() {
  return (
    <g>
      <path d="M-30 6 C-24 30 -6 46 6 44 C12 30 20 16 24 6 Z" fill="#fff" stroke="#c9c9d6" strokeWidth="2" strokeLinejoin="round" />
      <path d="M-30 6 L24 6" stroke="#ff4f7b" strokeWidth="3.5" />
      <g transform="translate(-14 20)"><Heart size={0.5} /></g>
      <g transform="translate(4 18)"><Heart size={0.45} /></g>
      <g transform="translate(-4 32)"><Heart size={0.45} /></g>
    </g>
  )
}

export function PortaPotty() {
  return (
    <g>
      <rect x="-34" y="-90" width="68" height="110" rx="6" fill="#2f8fe0" stroke="#1c5f9e" strokeWidth="3" />
      <path d="M-38 -90 Q0 -112 38 -90 Z" fill="#1c5f9e" />
      <rect x="-24" y="-74" width="48" height="90" rx="4" fill="#3aa0f0" stroke="#1c5f9e" strokeWidth="2" />
      <path d="M-4 -62 a8 8 0 1 0 10 9 a6 6 0 1 1 -10 -9 Z" fill="#ffd23f" />
      <circle cx="16" cy="-24" r="3" fill="#1c5f9e" />
      <rect x="-14" y="-40" width="28" height="9" rx="2" fill="#fff" />
      <text x="0" y="-33" fontSize="6.5" fontWeight="800" textAnchor="middle" fill="#c2182b">OCCUPIED</text>
    </g>
  )
}

export function BeanCan() {
  return (
    <g>
      <rect x="-12" y="-16" width="24" height="32" rx="3" fill="#c9ced8" stroke="#7a8496" strokeWidth="1.6" />
      <rect x="-12" y="-9" width="24" height="18" fill="#c2182b" />
      <text x="0" y="3" fontSize="6.5" fontWeight="900" textAnchor="middle" fill="#fff">BEANS</text>
      <ellipse cx="0" cy="-16" rx="12" ry="3" fill="#dfe3ea" stroke="#7a8496" strokeWidth="1.4" />
    </g>
  )
}

/** A toxic green cloud. */
export function FartCloud() {
  return (
    <g fill="#9fdc4a" stroke="#5f9e22" strokeWidth="2" opacity="0.92">
      <circle cx="0" cy="0" r="22" />
      <circle cx="-22" cy="8" r="16" />
      <circle cx="20" cy="10" r="17" />
      <circle cx="-6" cy="-18" r="14" />
      <circle cx="14" cy="-14" r="11" />
      <g stroke="none" fill="#5f9e22" opacity="0.6">
        <circle cx="-8" cy="-2" r="3" />
        <circle cx="10" cy="6" r="2.5" />
        <circle cx="-16" cy="12" r="2" />
      </g>
    </g>
  )
}

/** A projectile rainbow arc that draws itself (sendit2.css animates .barf-stream's dash offset). */
export function Barf({ d, className }: { d: string; className: string }) {
  return (
    <g className={className} fill="none" strokeLinecap="round">
      {['#ff4f4f', '#ff9f1c', '#ffd23f', '#5ed46a', '#4fa3ff', '#9b6bff'].map((c, i) => (
        <g key={c} transform={`translate(0 ${(i - 2.5) * 5})`}>
          <path className="barf-stream" d={d} stroke={c} strokeWidth="6" pathLength={1} strokeDasharray="1 1" />
        </g>
      ))}
    </g>
  )
}

/** A metal lift-tower pole, freezing cold. */
export function Pole() {
  return (
    <g>
      <rect x="-9" y="-200" width="18" height="230" rx="4" fill="#aeb8c6" stroke="#6b7686" strokeWidth="2" />
      <rect x="-4" y="-200" width="4" height="230" fill="#fff" opacity="0.5" />
      {[-160, -100, -40].map(y => <circle key={y} cx="0" cy={y} r="2.5" fill="#6b7686" />)}
      <path d="M-14 -120 l-6 -10M14 -90 l6 -8" stroke="#bfe6ff" strokeWidth="2.5" strokeLinecap="round" />
    </g>
  )
}

export function TBar() {
  return (
    <g>
      <path d="M0 -60 V0" stroke="#5a5f6b" strokeWidth="3" />
      <path d="M-26 0 H26" stroke="#5a5f6b" strokeWidth="6" strokeLinecap="round" />
    </g>
  )
}
