/**
 * SEND IT cartoons 11–20: the crude ones. Same conventions as scenes.tsx: a 400×500 stage, groups with
 * a className are animated by keyframes in sendit2.css over the whole scene (--dur), art drawn around (0, 0).
 */
import type { Scene } from './scenes'
import {
  BeanCan, Barf, Board, Duck, FartCloud, Heart, Hills, Marmot, Penguin, PenguinMoon, Pepper, Pole, Poof, PortaPotty, Sky, TBar,
} from './cast'

const Pow = ({ className, text, color = '#ffd23f', size = 42 }: { className: string; text: string; color?: string; size?: number }) => (
  <g className={className}>
    <text textAnchor="middle" fontSize={size} fontWeight="900" fill={color} stroke="#2b1030" strokeWidth="5" paintOrder="stroke"
      style={{ fontFamily: 'var(--display)' }}>
      {text}
    </text>
  </g>
)

const Stink = ({ className, color = '#7fc23a' }: { className: string; color?: string }) => (
  <g className={className} stroke={color} strokeWidth="3.5" fill="none" strokeLinecap="round">
    <path d="M-20 0 q-6 -10 0 -20 q6 -10 0 -20" />
    <path d="M0 -6 q-6 -10 0 -20 q6 -10 0 -20" />
    <path d="M20 0 q-6 -10 0 -20 q6 -10 0 -20" />
  </g>
)

export const SCENES2: Scene[] = [
  {
    id: 11,
    title: 'Yellow Snow',
    seconds: 11,
    captions: [
      { from: 0, to: 22, text: 'Ooh… lemon snow? 🍋' },
      { from: 26, to: 44, text: '*lick* *lick*' },
      { from: 46, to: 72, text: 'OH NO 🤢🌈' },
      { from: 74, to: 100, text: "Rule #1: Don't eat the yellow snow" },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <g transform="translate(205 420)">
          <ellipse rx="34" ry="9" fill="#ffe14d" />
          <ellipse rx="18" ry="4.5" fill="#f2c200" />
          <text x="26" y="-10" fontSize="16">✨</text>
        </g>
        <g className="s11-marmot">
          <g className="s11-plain"><Marmot /></g>
          <g className="s11-sick"><Marmot mood="sick" /></g>
          <g className="s11-tongue"><ellipse cx="-2" cy="16" rx="5" ry="7" fill="#ff7a8a" stroke="#c2405a" strokeWidth="1.4" /></g>
        </g>
        <Barf className="s11-barf" d="M188 398 C240 330 300 340 332 432" />
        <g className="s11-puddle">
          {['#ff4f4f', '#ffd23f', '#5ed46a', '#4fa3ff'].map((c, i) => <ellipse key={c} cx={334 + i * 3} cy={436} rx={30 - i * 6} ry={8 - i * 1.5} fill={c} />)}
        </g>
        <g className="s11-sign">
          <Pepper mood="happy" />
          <path d="M38 18 V-70" stroke="#7a4a22" strokeWidth="4" />
          <rect x="-30" y="-150" width="136" height="82" rx="8" fill="#fff" stroke="#c2182b" strokeWidth="4" />
          <text x="38" y="-122" fontSize="14" fontWeight="900" textAnchor="middle" fill="#c2182b">DON'T EAT THE</text>
          <text x="38" y="-102" fontSize="14" fontWeight="900" textAnchor="middle" fill="#e0a800">YELLOW</text>
          <text x="38" y="-82" fontSize="14" fontWeight="900" textAnchor="middle" fill="#c2182b">SNOW</text>
        </g>
      </>
    ),
  },
  {
    id: 12,
    title: 'Bean Rocket',
    seconds: 12,
    captions: [
      { from: 0, to: 24, text: 'Stuck on the flats 😩' },
      { from: 26, to: 48, text: 'Emergency beans 🫘' },
      { from: 50, to: 74, text: 'BRRRRAAAAAP 💨' },
      { from: 76, to: 100, text: 'Bean-powered. Penguin down.' },
    ],
    art: () => (
      <>
        <Sky />
        <path d="M0 380 L400 380 L400 500 L0 500 Z" fill="#eaf4ff" />
        <path d="M0 380 L400 380" stroke="#cfe3f7" strokeWidth="4" />
        <g transform="translate(40 362)">
          <g className="s12-penguin-ok"><Penguin /></g>
          <g className="s12-penguin-out"><g transform="rotate(-90)"><Penguin mood="dizzy" /></g></g>
        </g>
        <g className="s12-cloud"><FartCloud /></g>
        <Stink className="s12-stink" />
        <g className="s12-flies" fill="#222">
          <circle cx="-14" cy="-10" r="2" /><circle cx="8" cy="-20" r="2" /><circle cx="18" cy="2" r="2" />
        </g>
        <g className="s12-pepper">
          <g className="s12-jiggle">
            <Pepper mood="happy" />
            <g transform="translate(0 62)"><Board /></g>
          </g>
          <g transform="translate(30 -6)"><g className="s12-can"><BeanCan /></g></g>
        </g>
        <g className="s12-trail" stroke="#9fdc4a" strokeWidth="6" strokeLinecap="round" opacity="0.8">
          <path d="M0 0 h-60M-10 18 h-50M-6 -18 h-40" />
        </g>
        <g transform="translate(200 210) rotate(-8)"><Pow className="s12-braap" text="BRAAAP!" color="#9fdc4a" size={50} /></g>
        <g transform="translate(175 250)"><Pow className="s12-rumble" text="*grumble*" color="#fff" size={18} /></g>
      </>
    ),
  },
  {
    id: 13,
    title: 'Pants Split',
    seconds: 10,
    captions: [
      { from: 0, to: 34, text: 'Strapping in real quick…' },
      { from: 36, to: 55, text: '*RIIIIIIIP*' },
      { from: 57, to: 78, text: 'Is that… a breeze? 🍑' },
      { from: 80, to: 100, text: 'Heart boxers. Bold choice. 💘' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <g transform="translate(70 386)"><g className="s13-laugh"><Penguin mood="laugh" /></g></g>
        <g transform="translate(118 398)"><g className="s13-laugh s13-laugh2"><Penguin mood="laugh" /></g></g>
        <g transform="translate(230 320)">
          <g className="s13-bend">
            <g className="s13-before"><Pepper pants="on" mood="happy" /></g>
            <g className="s13-after"><Pepper pants="split" mood="bulge" /></g>
          </g>
          <g transform="translate(0 64)"><Board hue="teal" /></g>
        </g>
        <g className="s13-wind" stroke="#fff" strokeWidth="4" strokeLinecap="round" fill="none">
          <path d="M0 290 q40 -10 80 0 t80 0" />
          <path d="M-30 330 q40 -10 80 0 t80 0" />
        </g>
        <g transform="translate(300 260) rotate(12)"><Pow className="s13-rip" text="RIIIIP!" color="#ff4f7b" size={44} /></g>
      </>
    ),
  },
  {
    id: 14,
    title: 'Porta-Potty Launch',
    seconds: 12,
    captions: [
      { from: 0, to: 22, text: 'Taco Tuesday was a mistake 🌮' },
      { from: 24, to: 56, text: '…' },
      { from: 58, to: 78, text: 'LIFTOFF 🚀💨' },
      { from: 80, to: 100, text: 'Penguin: "…Next?"' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <g transform="translate(120 392)"><g className="s14-wait"><g className="s14-blown"><Penguin mood="wow" /></g></g></g>
        <g transform="translate(70 396)"><g className="s14-wait s14-wait2"><g className="s14-blown s14-blown2"><Penguin /></g></g></g>
        <g className="s14-pepper"><Pepper mood="bulge" /></g>
        <g className="s14-potty">
          <g className="s14-shake"><PortaPotty /></g>
          <g transform="translate(0 40)"><g className="s14-exhaust"><FartCloud /></g></g>
        </g>
        <Stink className="s14-stink" />
        <g transform="translate(330 250) rotate(10)"><Pow className="s14-brrt" text="BRRRT" color="#9fdc4a" size={30} /></g>
        <g transform="translate(190 230) rotate(-10)"><Pow className="s14-plop" text="*plop*" color="#fff" size={22} /></g>
        <g transform="translate(260 340)"><Pow className="s14-q" text="?" color="#fff" size={40} /></g>
      </>
    ),
  },
  {
    id: 15,
    title: 'Snot Rocket',
    seconds: 10,
    captions: [
      { from: 0, to: 22, text: 'Peaceful chair ride ☁️' },
      { from: 24, to: 46, text: 'ah… ahhh… 🥴' },
      { from: 48, to: 64, text: 'AH-CHOOOOO 🤧' },
      { from: 66, to: 100, text: 'Sorry buddy 😬' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <path d="M-20 110 L420 60" stroke="#333" strokeWidth="3" />
        <g className="s15-penguin">
          <g className="s15-clean"><Penguin /></g>
          <g className="s15-slimed"><Penguin mood="glare" slimed /></g>
        </g>
        <g transform="translate(200 88)">
          <g className="s15-sway">
            <path d="M0 0 V50" stroke="#333" strokeWidth="3" />
            <rect x="-55" y="50" width="110" height="10" rx="4" fill="#3b4a6b" />
            <g transform="translate(0 30) scale(0.7)">
              <g className="s15-head">
                <g className="s15-calm"><Pepper mood="happy" /></g>
                <g className="s15-tickle"><Pepper mood="sick" /></g>
                <g className="s15-after"><Pepper mood="blush" /></g>
                <g className="s15-drip"><ellipse cx="-1" cy="2" rx="4" ry="12" fill="#8fe04a" stroke="#4f9a1e" strokeWidth="1.4" /></g>
              </g>
            </g>
          </g>
        </g>
        <g className="s15-flake"><text fontSize="18" textAnchor="middle">❄️</text></g>
        <g className="s15-snot"><ellipse rx="12" ry="9" fill="#8fe04a" stroke="#4f9a1e" strokeWidth="2" /><path d="M-12 0 q-14 -4 -22 -14" stroke="#8fe04a" strokeWidth="6" strokeLinecap="round" fill="none" /></g>
        <g transform="translate(290 170) rotate(-8)"><Pow className="s15-achoo" text="ACHOO!" color="#8fe04a" size={40} /></g>
      </>
    ),
  },
  {
    id: 16,
    title: 'Ring of Fire',
    seconds: 11,
    captions: [
      { from: 0, to: 22, text: 'Just gonna sit for a sec…' },
      { from: 26, to: 46, text: 'Is it… warm? 🥵' },
      { from: 48, to: 70, text: 'Spicy butt melted the mountain 🔥🍑' },
      { from: 72, to: 100, text: 'Butt-melted hot tub, now open ♨️' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <g transform="translate(200 420)"><g className="s16-pool"><ellipse rx="110" ry="26" fill="#ff8a4a" /><ellipse rx="90" ry="18" fill="#ffb066" /></g></g>
        <Stink className="s16-steam" color="#ffffff" />
        <g className="s16-pepper">
          <g className="s16-warm"><Pepper mood="happy" /></g>
          <g className="s16-hot"><Pepper mood="bulge" /></g>
          <g className="s16-chill"><Pepper mood="blush" shades /></g>
        </g>
        <g transform="translate(200 420)">
          {/* the pool's front lip, deep enough to hide the sunk pepper's legs */}
          <path d="M-112 2 C-100 26 100 26 112 2 L130 80 L-130 80 Z" fill="#eaf4ff" />
          <g className="s16-bubbles" fill="#fff" opacity="0.8">
            <circle cx="-50" cy="-4" r="4" /><circle cx="30" cy="-2" r="3" /><circle cx="60" cy="-6" r="4" />
          </g>
          <g className="s16-ducks">
            <g transform="translate(-70 -6) scale(0.8)"><Duck shades /></g>
            <g transform="translate(70 -6) scale(0.8)"><Duck /></g>
          </g>
        </g>
        <g className="s16-guest-l"><Penguin mood="happy" /><rect x="-18" y="-26" width="8" height="30" rx="3" fill="#ff4f7b" /></g>
        <g className="s16-guest-r"><Penguin mood="wow" /><rect x="10" y="-26" width="8" height="30" rx="3" fill="#4fa3ff" /></g>
        <g transform="translate(200 160)">
          <g className="s16-sign">
            <rect x="-80" y="-24" width="160" height="40" rx="8" fill="#9b6a43" stroke="#6b4425" strokeWidth="3" />
            <text y="4" fontSize="16" fontWeight="900" textAnchor="middle" fill="#fff">♨️ HOT TUB · OPEN</text>
          </g>
        </g>
      </>
    ),
  },
  {
    id: 17,
    title: 'Wedgie Lift',
    seconds: 12,
    captions: [
      { from: 0, to: 20, text: 'First time on the T-bar 🥹' },
      { from: 22, to: 48, text: "Wait, that's not my— 😳" },
      { from: 50, to: 70, text: 'MEGA WEDGIE 🩲' },
      { from: 72, to: 100, text: '*SNAP* …worth it' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <path d="M0 470 L400 210 L400 500 L0 500 Z" fill="#f4f9ff" />
        <path d="M-40 326 L440 14" stroke="#333" strokeWidth="3" />
        <g className="s17-idle">
          <Pepper undies mood="happy" />
          <g transform="translate(0 62)"><Board /></g>
        </g>
        <g className="s17-ride">
          <TBar />
          <g className="s17-hang">
            <g className="s17-dangle">
              {/* the briefs, stretched from the bar all the way down to his waist */}
              <path d="M-6 0 H6 L22 98 H-28 Z" fill="#fff" stroke="#c9c9d6" strokeWidth="2" strokeLinejoin="round" />
              <path d="M-6 0 H6" stroke="#ff4f7b" strokeWidth="4" />
              <g transform="translate(0 30)"><Heart size={0.6} /></g>
              <g transform="translate(-4 62)"><Heart size={0.7} /></g>
              <g transform="translate(0 86)">
                <Pepper undies mood="bulge" />
                <g transform="translate(0 62)"><Board /></g>
              </g>
            </g>
          </g>
        </g>
        <g className="s17-fall">
          <Pepper undies mood="dizzy" />
        </g>
        <Poof className="s17-poof" />
        <g transform="translate(250 150) rotate(-10)"><Pow className="s17-snap" text="SNAP!" color="#ff4f7b" size={46} /></g>
      </>
    ),
  },
  {
    id: 18,
    title: 'Tongue Stuck',
    seconds: 11,
    captions: [
      { from: 0, to: 22, text: 'Penguin: "Triple dog dare ya"' },
      { from: 24, to: 40, text: '*lick*' },
      { from: 42, to: 62, text: "it'th thtuck 😭" },
      { from: 64, to: 100, text: 'THWAP 👅💥' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <g transform="translate(250 420)"><Pole /></g>
        <g transform="translate(80 400)">
          <g className="s18-roll">
            <g className="s18-dare"><Penguin mood="happy" /></g>
            <g className="s18-lol"><Penguin mood="laugh" /></g>
          </g>
        </g>
        <g className="s18-tongue">
          <rect x="0" y="-3.5" width="1" height="7" fill="#ff7a8a" />
        </g>
        <g className="s18-pepper">
          <g className="s18-normal"><Pepper mood="happy" /></g>
          <g className="s18-stuck"><Pepper mood="bulge" /></g>
          <g className="s18-dizzy"><Pepper mood="dizzy"><ellipse cx="-2" cy="-10" rx="16" ry="9" fill="#ff7a8a" opacity="0.6" /></Pepper></g>
        </g>
        <g transform="translate(250 230) rotate(-12)"><Pow className="s18-thwap" text="THWAP!" color="#ff7a8a" size={44} /></g>
      </>
    ),
  },
  {
    id: 19,
    title: 'Mooned',
    seconds: 11,
    captions: [
      { from: 0, to: 24, text: 'Quiet chair ride… 😌' },
      { from: 26, to: 50, text: 'Is that penguin…' },
      { from: 52, to: 70, text: 'MOONED 🍑🌝' },
      { from: 72, to: 100, text: 'Laughed so hard he fell off 😂' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <path d="M-20 120 L420 60" stroke="#333" strokeWidth="3" />
        <g className="s19-chair">
          <path d="M0 0 V50" stroke="#333" strokeWidth="3" />
          <rect x="-50" y="50" width="100" height="10" rx="4" fill="#3b4a6b" />
          <g transform="translate(-20 26) scale(0.62)">
            <g className="s19-ride-happy"><Pepper mood="happy" /></g>
            <g className="s19-ride-laugh"><Pepper mood="laugh" /></g>
          </g>
        </g>
        <g transform="translate(220 404)">
          <g className="s19-front"><Penguin /></g>
          <g className="s19-moon"><g className="s19-wiggle"><PenguinMoon /></g></g>
        </g>
        <g className="s19-fall"><Pepper mood="laugh" /></g>
        <Poof className="s19-poof" />
      </>
    ),
  },
  {
    id: 20,
    title: 'Barf Judges',
    seconds: 12,
    captions: [
      { from: 0, to: 32, text: 'Going for the 1080 🌀' },
      { from: 36, to: 56, text: 'nailed it… *urp*' },
      { from: 58, to: 76, text: '🤮🌈🤮🌈🤮' },
      { from: 78, to: 100, text: 'Judges: 0 · 0 · 🤮' },
    ],
    art: () => (
      <>
        <Sky />
        <Hills />
        <g transform="translate(200 300)">
          <g className="s20-spin">
            <g className="s20-hype"><Pepper mood="happy" shades /></g>
            <g className="s20-dizzy"><Pepper mood="dizzy" /></g>
            <g className="s20-sick"><Pepper mood="sick" /></g>
            <g transform="translate(0 62)"><Board /></g>
          </g>
          <g className="s20-swirl" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" opacity="0.8">
            <path d="M-70 0 a70 30 0 1 0 140 0" />
          </g>
        </g>
        <Barf className="s20-barf-l" d="M198 300 C150 300 110 360 100 418" />
        <Barf className="s20-barf-r" d="M202 300 C250 300 290 360 300 418" />
        {[100, 200, 300].map((x, i) => (
          <g key={x} transform={`translate(${x} 462)`}>
            <g className="s20-judge-ok"><Penguin /></g>
            <g className="s20-judge-slimed"><Penguin mood="glare" slimed={i !== 1} /></g>
            <g transform="translate(0 -46)">
              <rect x="-22" y="-16" width="44" height="30" rx="4" fill="#fff" stroke="#1d2433" strokeWidth="2" />
              <text className="s20-card-before" y="6" fontSize="18" fontWeight="800" textAnchor="middle" fill="#1d2433">…</text>
              <text className="s20-card-after" y="6" fontSize="18" fontWeight="800" textAnchor="middle" fill="#c2182b">{i === 2 ? '🤮' : '0'}</text>
            </g>
          </g>
        ))}
      </>
    ),
  },
]
