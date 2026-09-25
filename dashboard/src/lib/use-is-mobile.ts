import { useEffect, useState } from 'react'

// Selects between the mobile and desktop forms in JS rather than CSS
// display classes, for components a frozen test renders standalone in
// jsdom: jsdom does not evaluate Tailwind (`hidden md:flex` stays inert
// there), so a CSS-only split renders *both* arrangements at once under
// test, and duplicate accessible names break `getByRole` queries. §8
// delegates the desktop/mobile selection mechanism to "the repo's existing
// pattern wins" — this is that pattern, used wherever a page needs to pick
// exactly one arrangement rather than let CSS hide the other.
//
// Matches the project's own `md` breakpoint (768px — see
// dashboard/src/styles/tokens.css's own note on it). Defaults to desktop
// (false) when matchMedia is unavailable, which is what jsdom's frozen
// suites were built and pass against.
const QUERY = '(min-width: 768px)'

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return !window.matchMedia(QUERY).matches
  })

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(QUERY)
    const onChange = () => setIsMobile(!mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
