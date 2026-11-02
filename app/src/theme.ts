import { useEffect, useState } from 'react'

/** 'system' follows the phone's light/dark setting; the others force a theme. */
export type ThemeMode = 'system' | 'light' | 'dark'

const KEY = 'snowcast.theme'
export const THEME_EVENT = 'snowcast-theme'
/** Status-bar colors, matching the top of the sky in each theme (see index.html). */
const BAR = { light: '#bcdcff', dark: '#03060f' } as const

export function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

/** Apply a mode: CSS reads `data-theme` on <html>; the status bar follows via theme-color. */
export function applyTheme(mode: ThemeMode) {
  const root = document.documentElement
  if (mode === 'system') delete root.dataset.theme
  else root.dataset.theme = mode
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(m => {
    const scheme = m.media.includes('dark') ? 'dark' : 'light'
    m.content = mode === 'system' ? BAR[scheme] : BAR[mode]
  })
  window.dispatchEvent(new Event(THEME_EVENT))
}

export function saveTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    // Blocked storage: the choice lasts until the app closes.
  }
  applyTheme(mode)
}

export const nextTheme = (m: ThemeMode): ThemeMode => (m === 'system' ? 'light' : m === 'light' ? 'dark' : 'system')

/** Bumps whenever the effective colors may have changed, so canvas charts can redraw. */
export function useThemeVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    const bump = () => setV(x => x + 1)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    window.addEventListener(THEME_EVENT, bump)
    mq.addEventListener('change', bump)
    return () => {
      window.removeEventListener(THEME_EVENT, bump)
      mq.removeEventListener('change', bump)
    }
  }, [])
  return v
}
