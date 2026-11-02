import type { SVGProps } from 'react'

/** Stroke icons on a 24px grid, drawn to match each other (1.8 stroke, round joins). */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      {children}
    </svg>
  )
}

export const SnowflakeIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 2v20M3.3 7l17.4 10M3.3 17l17.4-10" />
    <path d="M9.5 3.5 12 6l2.5-2.5M9.5 20.5 12 18l2.5 2.5M3 10.4l3.4.9-.9 3.4M21 13.6l-3.4-.9.9-3.4M5.5 9.3l.9 3.4-3.4.9M18.5 14.7l-.9-3.4 3.4-.9" />
  </Icon>
)

export const MapIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m2 20 6.5-11 4 6.5 2.5-3.5L22 20Z" />
    <path d="m6.8 12 1.7 1.2L10 12" />
  </Icon>
)

export const PastIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
    <path d="M3 3v4.5h4.5M12 7.5V12l3 2" />
  </Icon>
)

export const BellIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15Z" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </Icon>
)

export const ChartIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 20h16M7 16v-5M12 16V6M17 16v-8" />
  </Icon>
)

/** App mark: a peak with a snowcap inside a soft ring. */
export const LogoMark = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 32 32" aria-hidden {...p}>
    <defs>
      <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style={{ stopColor: 'var(--ice-1)' }} />
        <stop offset="1" style={{ stopColor: 'var(--ice-2)' }} />
      </linearGradient>
    </defs>
    <circle cx="16" cy="16" r="15" fill="url(#logo-g)" />
    <path d="M5 24 13 11l4 6 3-4 7 11Z" fill="#fff" opacity="0.92" />
    <path d="m10.6 15 2.4-4 2.4 3.6-1.3-.6-1.1 1.2-1.1-1Z" style={{ fill: 'var(--ice-2)' }} opacity="0.55" />
  </svg>
)
