// What the settings page's stylesheet and Radix controls share: the scope
// class every rule hangs from, the one-time stylesheet injection, and the
// read-only flag the controls read.

import { createContext } from 'react'
import css from './settings.css?inline'

/** The class every rule in settings.css hangs from; the page and the portalled Select menu both carry it. */
export const SCOPE = 'dsh-voice-settings'

const STYLE_ID = 'dsh-voice-settings-style'

/** Adds the stylesheet to the document once; a later call finds it there. */
export function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = css
  document.head.appendChild(style)
}

/** True while the page cannot write; the Radix controls read it because a disabled fieldset does not reach them. */
export const ReadOnly = createContext(false)
