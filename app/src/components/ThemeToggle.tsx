import { useState } from 'react'
import { loadTheme, nextTheme, saveTheme, type ThemeMode } from '../theme'

const LABEL: Record<ThemeMode, string> = { system: 'Auto', light: 'Light', dark: 'Dark' }

const icon = (mode: ThemeMode) => {
  if (mode === 'light') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
      </svg>
    )
  }
  if (mode === 'dark') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
        <path d="M17 3.5v2M16 4.5h2" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Cycles Auto → Light → Dark. Auto follows the phone's setting. */
export function ThemeToggle() {
  const [mode, setMode] = useState(loadTheme)
  const next = nextTheme(mode)
  return (
    <button
      className="theme-toggle"
      onClick={() => { saveTheme(next); setMode(next) }}
      aria-label={`Theme: ${LABEL[mode]}. Switch to ${LABEL[next]}`}
      title={`Theme: ${LABEL[mode]}`}
    >
      {icon(mode)}
      <span>{LABEL[mode]}</span>
    </button>
  )
}
