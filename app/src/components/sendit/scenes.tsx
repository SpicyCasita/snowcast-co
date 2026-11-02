/**
 * Ten short SEND IT cartoons. Each scene is a 400×500 SVG whose parts are animated by CSS keyframes
 * in sendit.css over the scene's whole length (--dur), plus captions the player shows on a timeline
 * (percent of the scene). Groups with a className are moved by CSS; they draw their art around (0, 0).
 */
import type { ReactNode } from 'react'
import { SCENES2 } from './scenes2'
import { Board, Casita, Defs, Duck, Heart, Hills, Marmot, Penguin, Pepper, Poof, Sky, Snowman, Stars } from './cast'

export interface Caption { from: number; to: number; text: string }
export interface Scene { id: number; title: string; seconds: number; captions: Caption[]; art: () => ReactNode }

const ORIGINALS: Scene[] = [
  {
    id: 1,
    title: 'Yard Sale',
    seconds: 10,
    captions: [
      { from: 0, to: 32, text: 'Sending it… 🌶️' },
      { from: 36, to: 58, text: 'Uh oh' },
      { from: 60, to: 82, text: 'YARD SALE! 🎉' },
      { from: 82, to: 100, text: 'Style points: 10/10' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <path d="M-10 300 L420 420" stroke="#cfe3f7" strokeWidth="3" strokeDasharray="10 12" />
        <g className="s1-rider">
          <Pepper mood="wow" />
          <g className="s1-board-on" transform="translate(0 62)"><Board /></g>
        </g>
        <g className="s1-board-fly"><Board /></g>
        <g className="s1-shades-fly">
          <rect x="-16" y="-6" width="14" height="10" rx="4" fill="#141414" />
          <rect x="2" y="-6" width="14" height="10" rx="4" fill="#141414" />
        </g>
        <Poof className="s1-poof" />
        <g className="s1-pop">
          <Pepper mood="derp" wave>
            <ellipse cx="0" cy="-58" rx="22" ry="10" fill="#fff" />
          </Pepper>
          <g className="s1-dizzy">
            {[0, 120, 240].map(a => <text key={a} transform={`rotate(${a}) translate(0 -80)`} fontSize="16" textAnchor="middle">⭐</text>)}
          </g>
        </g>
        {/* front drift the pepper digs out of */}
        <path d="M0 448 C90 440 170 400 240 394 C310 388 360 400 400 398 L400 500 L0 500 Z" fill="#fff" />
      </>
    ),
  },
  {
    id: 2,
    title: 'Called In Sick',
    seconds: 12,
    captions: [
      { from: 0, to: 24, text: '*cough cough* so sick today 🤒' },
      { from: 26, to: 44, text: '📱 POWDER ALERT: 14"' },
      { from: 46, to: 70, text: 'MIRACULOUS RECOVERY ✨' },
      { from: 72, to: 100, text: 'Called in sick. Went shredding. 🌶️🚐' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        {/* bed */}
        <g transform="translate(110 360)">
          <rect x="-80" y="-10" width="160" height="40" rx="8" fill="#8a5a3c" />
          <rect x="-84" y="-60" width="16" height="90" rx="6" fill="#8a5a3c" />
          <rect x="-66" y="-30" width="40" height="22" rx="10" fill="#fff" />
        </g>
        <g className="s2-sleepy" transform="translate(70 318) rotate(-80)">
          <Pepper mood="sleepy" />
        </g>
        <path className="s2-blanket" d="M40 336 C80 320 160 322 196 336 L196 372 L40 372 Z" fill="#7bc6ff" stroke="#3a8fd0" strokeWidth="2" />
        <g transform="translate(200 300)">
          <g className="s2-phone">
            <rect x="-14" y="-24" width="28" height="48" rx="6" fill="#1b1b2e" />
            <rect x="-11" y="-19" width="22" height="36" rx="3" fill="#ffd23f" />
            <text y="2" fontSize="11" textAnchor="middle">❄️</text>
          </g>
        </g>
        <g className="s2-casita"><Casita />
          <g className="s2-rider" transform="translate(0 -124)">
            <Pepper shades wave />
            <g transform="translate(0 62)"><Board hue="teal" /></g>
          </g>
          <g className="s2-puffs" transform="translate(-75 20)">
            <circle r="10" fill="#ff6b4a" opacity="0.7" />
            <circle cx="-16" cy="-6" r="7" fill="#ffb347" opacity="0.7" />
          </g>
        </g>
        <g className="s2-awake">
          <Pepper shades mood="happy" />
          <g transform="translate(0 62)"><Board hue="teal" /></g>
        </g>
      </>
    ),
  },
  {
    id: 3,
    title: 'Penguin Conga',
    seconds: 12,
    captions: [
      { from: 0, to: 40, text: 'Conga line! 🐧🐧🐧🐧' },
      { from: 44, to: 68, text: 'Wait— one fell off' },
      { from: 70, to: 100, text: 'Belly slide wins 🏆' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <path d="M-20 140 L420 470" stroke="#cfe3f7" strokeWidth="40" strokeLinecap="round" opacity="0.6" />
        <g transform="translate(340 420)">
          <rect x="-2" y="-60" width="4" height="60" fill="#666" />
          <path d="M2 -60 h30 l-6 10 6 10 h-30 Z" fill="#ff4f7b" />
        </g>
        <g className="s3-train">
          <g transform="translate(0 0)"><g className="s3-waddle"><Pepper shades /></g></g>
          {[1, 2, 3].map(i => (
            <g key={i} transform={`translate(${-48 * i} ${-36 * i})`}>
              <g className="s3-waddle" style={{ animationDelay: `${i * 0.12}s` }}><Penguin /></g>
            </g>
          ))}
          <g className="s3-last"><Penguin mood="wow" /></g>
        </g>
        {/* over the belly-slider's finishing spot: train end (300, 320) + its offset (64, 38) */}
        <g transform="translate(372 316)"><g className="s3-trophy"><text fontSize="34" textAnchor="middle">🏆</text></g></g>
      </>
    ),
  },
  {
    id: 4,
    title: 'Spicy Hug',
    seconds: 11,
    captions: [
      { from: 0, to: 26, text: 'Free hugs! 🤗' },
      { from: 28, to: 54, text: 'Awww 🥹' },
      { from: 56, to: 72, text: '…spicy hug 🔥😅' },
      { from: 74, to: 100, text: 'Stay chill, buddy 😎' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <g transform="translate(250 300)">
          <g className="s4-melt">
            <g className="s4-man-plain"><Snowman /></g>
            <g className="s4-man-cool"><Snowman shades /></g>
          </g>
          <g className="s4-sweat" fill="#7fc8ff">
            <path d="M-30 -60 q-4 8 0 10 q4 -2 0 -10Z" />
            <path d="M28 -20 q-4 8 0 10 q4 -2 0 -10Z" />
          </g>
        </g>
        <g className="s4-pepper">
          <g className="s4-shades-on"><Pepper shades mood="blush" /></g>
          <g className="s4-shades-off"><Pepper mood="happy" /></g>
        </g>
        <g className="s4-heat" stroke="#ff7a3c" strokeWidth="3" fill="none" strokeLinecap="round">
          <path d="M200 200 q6 -10 0 -20 q-6 -10 0 -20" />
          <path d="M225 190 q6 -10 0 -20 q-6 -10 0 -20" />
          <path d="M250 205 q6 -10 0 -20 q-6 -10 0 -20" />
        </g>
        <g className="s4-hearts">
          <g transform="translate(210 230)"><Heart size={1.6} /></g>
          <g transform="translate(240 210)"><Heart size={1.1} /></g>
        </g>
      </>
    ),
  },
  {
    id: 5,
    title: 'Big Air',
    seconds: 10,
    captions: [
      { from: 0, to: 24, text: 'Big air time 🚀' },
      { from: 26, to: 58, text: 'BACKFLIP!!' },
      { from: 60, to: 78, text: 'Stomped it 💥' },
      { from: 80, to: 100, text: 'Judges: 10 · 10 · 🌶️' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <path d="M110 380 L200 380 L200 330 Z" fill="#fff" stroke="#bcd8f5" strokeWidth="3" />
        <g className="s5-rider">
          <Pepper shades mood="happy" />
          <g transform="translate(0 62)"><Board /></g>
        </g>
        <Poof className="s5-poof" />
        {[0, 1, 2].map(i => (
          <g key={i} transform={`translate(${90 + i * 110} 470)`}>
            <g className="s5-judge" style={{ animationDelay: `calc(var(--dur) * ${0.66 + i * 0.05})` }}>
              <Penguin />
              <g transform="translate(0 -48)">
                <rect x="-22" y="-16" width="44" height="30" rx="4" fill="#fff" stroke="#1d2433" strokeWidth="2" />
                <text y="6" fontSize="18" fontWeight="800" textAnchor="middle" fill="#1d2433">{i === 2 ? '🌶️' : '10'}</text>
              </g>
            </g>
          </g>
        ))}
      </>
    ),
  },
  {
    id: 6,
    title: 'Chairlift Snack',
    seconds: 13,
    captions: [
      { from: 0, to: 20, text: 'Lift buddies 🚡' },
      { from: 22, to: 40, text: 'Snack? 🌯' },
      { from: 42, to: 58, text: '"It\'s MILD," he said' },
      { from: 60, to: 100, text: '🔥 Marmot has left the chair 🔥' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <path d="M-20 150 L420 70" stroke="#333" strokeWidth="3" />
        <g className="s6-chair">
          <path d="M0 0 V50" stroke="#333" strokeWidth="3" />
          <rect x="-70" y="50" width="140" height="10" rx="4" fill="#3b4a6b" />
          <rect x="-70" y="10" width="140" height="44" rx="6" fill="none" stroke="#3b4a6b" strokeWidth="3" />
          <g transform="translate(-34 26) scale(0.62)"><Pepper mood="happy" /></g>
          <g className="s6-marmot-seat" transform="translate(36 34)">
            <g className="s6-marmot-calm"><Marmot /></g>
            <g className="s6-marmot-hot"><Marmot mood="hot" /></g>
            <g className="s6-steam" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round">
              <path d="M-16 -32 q-4 -8 0 -16" />
              <path d="M16 -32 q4 -8 0 -16" />
            </g>
          </g>
          <g className="s6-burrito" transform="translate(4 34)">
            <rect x="-14" y="-7" width="28" height="14" rx="7" fill="#f2d39a" stroke="#b98a3e" strokeWidth="2" />
            <path d="M8 -7 v14" stroke="#ff4f2d" strokeWidth="4" />
          </g>
        </g>
        <g className="s6-leap"><Marmot mood="hot" /></g>
        <Poof className="s6-poof" />
      </>
    ),
  },
  {
    id: 7,
    title: 'Face Shot',
    seconds: 9,
    captions: [
      { from: 0, to: 30, text: 'Deep day… 😌' },
      { from: 32, to: 50, text: 'FACE SHOT ❄️' },
      { from: 52, to: 100, text: 'Snow beard unlocked 🧔‍♂️❄️' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <g transform="translate(200 270) scale(1.7)">
          <g className="s7-bob">
            <g className="s7-before"><Pepper mood="happy" /></g>
            <g className="s7-after"><Pepper mood="blush" beard /></g>
          </g>
        </g>
        <g className="s7-wave">
          <path d="M0 500 C40 300 120 220 220 260 C300 290 360 240 420 200 L420 500 Z" fill="#fff" />
          <circle cx="220" cy="250" r="30" fill="#fff" />
          <circle cx="160" cy="280" r="40" fill="#fff" />
        </g>
        <rect className="s7-flash" width="400" height="500" fill="#fff" />
        <g className="s7-sparkles" fontSize="20" textAnchor="middle">
          <text x="110" y="170">✨</text>
          <text x="300" y="190">✨</text>
          <text x="280" y="360">✨</text>
        </g>
      </>
    ),
  },
  {
    id: 8,
    title: 'Hot Tub Après',
    seconds: 12,
    captions: [
      { from: 0, to: 26, text: 'Après time 🛁' },
      { from: 28, to: 54, text: 'Ahhhh…' },
      { from: 56, to: 78, text: "Water's getting spicy 🌶️" },
      { from: 80, to: 100, text: 'Après level: legendary 🦆😎' },
    ],
    art: () => (
      <>
        <Sky night />
        <Stars />
        <path d="M0 360 C120 330 280 340 400 330 L400 500 L0 500 Z" fill="#e6ecff" />
        <g className="s8-pepper"><Pepper shades /></g>
        <g transform="translate(200 380)">
          <ellipse className="s8-water" cx="0" cy="0" rx="150" ry="40" fill="#5ab8ff" />
          {[-90, 0, 90].map((x, i) => (
            <g key={x} transform={`translate(${x} -4)`}>
              <g className="s8-duck" style={{ animationDelay: `${i * 0.3}s` }}>
                <g className="s8-duck-plain"><Duck /></g>
                <g className="s8-duck-cool"><Duck shades /></g>
              </g>
            </g>
          ))}
          <path d="M-150 0 C-150 50 -130 80 -110 86 L110 86 C130 80 150 50 150 0 C150 30 80 42 0 42 C-80 42 -150 30 -150 0 Z" fill="#9b6a43" stroke="#6b4425" strokeWidth="3" />
          <g className="s8-steam" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" opacity="0.6">
            <path d="M-60 -40 q-8 -14 0 -28 q8 -14 0 -28" />
            <path d="M10 -46 q-8 -14 0 -28 q8 -14 0 -28" />
            <path d="M80 -40 q-8 -14 0 -28 q8 -14 0 -28" />
          </g>
        </g>
      </>
    ),
  },
  {
    id: 9,
    title: 'Snow Angel Choir',
    seconds: 12,
    captions: [
      { from: 0, to: 38, text: 'Snow angel time 👼' },
      { from: 40, to: 72, text: '♪ Spiiiiicy ♪ ♫' },
      { from: 74, to: 100, text: '…did the snow just sing? 🥹' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <g transform="translate(200 400)">
          <g className="s9-wings" fill="#f4f9ff" stroke="#cfe3f7" strokeWidth="2">
            <path d="M0 0 C-70 -40 -90 -10 -60 30 Z" />
            <path d="M0 0 C70 -40 90 -10 60 30 Z" />
          </g>
          <g className="s9-lying" transform="rotate(-90)"><Pepper mood="sleepy" /></g>
          <g className="s9-sitting"><Pepper mood="blush" /></g>
        </g>
        {[110, 200, 290].map((x, i) => (
          <g key={x} transform={`translate(${x} 330)`}>
            <g className="s9-angel" style={{ animationDelay: `calc(var(--dur) * ${0.36 + i * 0.05})` }}>
              <path d="M0 -10 C-36 -30 -44 0 -24 20 L0 30 L24 20 C44 0 36 -30 0 -10 Z" fill="#fff" opacity="0.92" />
              <circle cx="0" cy="-22" r="10" fill="#fff" />
              <ellipse cx="0" cy="-38" rx="12" ry="4" fill="none" stroke="#ffd23f" strokeWidth="3" />
              <path d="M-4 -22 q4 4 8 0" stroke="#7aa6d6" strokeWidth="2" fill="none" />
            </g>
          </g>
        ))}
        <g className="s9-notes" fontSize="22" fill="#7b5cff">
          <text x="80" y="220">♪</text>
          <text x="200" y="190">♫</text>
          <text x="310" y="215">♪</text>
        </g>
        <g className="s9-hearts">
          <g transform="translate(170 330)"><Heart size={1.4} /></g>
          <g transform="translate(230 320)"><Heart size={1.1} /></g>
        </g>
      </>
    ),
  },
  {
    id: 10,
    title: 'Jalapeño Jr.',
    seconds: 13,
    captions: [
      { from: 0, to: 28, text: "Jalapeño Jr.'s first day 🥹" },
      { from: 30, to: 42, text: 'oop—' },
      { from: 44, to: 70, text: 'Get back up, little guy!' },
      { from: 72, to: 100, text: 'FIRST OLLIE!! ❤️' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <path d="M0 300 C140 300 260 360 400 380" stroke="#cfe3f7" strokeWidth="30" strokeLinecap="round" opacity="0.6" fill="none" />
        <g transform="translate(330 330)">
          <g className="s10-parent"><Pepper wave mood="happy" /></g>
        </g>
        <g className="s10-baby">
          <g transform="scale(0.55)">
            <g className="s10-wobble">
              <Pepper green mood="wow" />
              <g transform="translate(0 62)"><Board hue="tiny" /></g>
            </g>
          </g>
        </g>
        <g className="s10-hearts">
          {[[280, 230, 1.6], [320, 200, 1.2], [360, 240, 1.4], [250, 260, 1]].map(([x, y, s]) => (
            <g key={`${x}`} transform={`translate(${x} ${y})`}><Heart size={s} /></g>
          ))}
        </g>
      </>
    ),
  },
]

/** All SEND IT cartoons: the cute ten, then the crude ten (scenes2.tsx). */
export const SCENES: Scene[] = [...ORIGINALS, ...SCENES2]

export { Defs }
