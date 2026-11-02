import { useState } from 'react'
import { enableMotion, motionEnabled, motionNeedsPermission, shakeGlobe } from '../globe'

/**
 * Header button for the snow globe. On iPhone the first tap asks for motion access (required before
 * shakes can be felt); every tap also gives the globe a shake, so it works as a demo on desktop too.
 */
export function GlobeButton() {
  const [hint, setHint] = useState<string | null>(null)
  const onTap = async () => {
    shakeGlobe((Math.random() - 0.5) * 2, 1.2)
    if (motionNeedsPermission() && !motionEnabled()) {
      const ok = await enableMotion()
      setHint(ok ? 'Shake your phone ❄' : 'Motion access is off. Allow it in Settings › Safari')
    } else if (!hint) {
      setHint('Shake your phone ❄')
    }
    window.setTimeout(() => setHint(null), 2600)
  }
  return (
    <span className="globe-wrap">
      <button className="globe-button" onClick={onTap} aria-label="Snow globe: shake your phone to make it snow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="10" r="7.5" />
          <path d="M6.5 19h11l-1.5 2.5h-8Z" />
          <path d="M9 9.5h.01M14.5 7h.01M12 12.5h.01M15 11.5h.01M9.5 6.5h.01" strokeWidth={2.6} />
        </svg>
      </button>
      {hint && <span className="globe-hint" role="status">{hint}</span>}
    </span>
  )
}
