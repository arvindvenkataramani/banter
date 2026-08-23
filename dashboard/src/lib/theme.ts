export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'theme'

export function getTheme(): Theme {
  return (localStorage.getItem(STORAGE_KEY) as Theme) ?? 'system'
}

export function setTheme(theme: Theme) {
  localStorage.setItem(STORAGE_KEY, theme)
  applyTheme(theme)
}

export function applyTheme(theme?: Theme) {
  const t = theme ?? getTheme()
  const dark =
    t === 'dark' ||
    (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

// Track system preference changes when in system mode
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getTheme() === 'system') applyTheme()
})

/**
 * Force-apply a theme override (does not persist). Returns a function that
 * restores the user's stored preference. Useful for transient modes like
 * unattended/voice mode that should always be dark regardless of preference.
 */
export function overrideTheme(theme: 'light' | 'dark'): () => void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  return () => applyTheme()
}
