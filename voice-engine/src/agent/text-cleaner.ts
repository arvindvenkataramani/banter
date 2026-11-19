/**
 * Strip markdown that TTS would read literally. Only remove genuinely
 * unspeakable markup — let the engine handle prosody and list reading.
 */
export function cleanForSpeech(text: string): string {
  let s = text

  // Fenced code blocks → "code block omitted"
  s = s.replace(/```[\s\S]*?```/g, 'code block omitted')

  // Inline backticks → bare word, expand punctuation for speech
  s = s.replace(/`([^`]+)`/g, (_match, code: string) =>
    code.replace(/\./g, ' dot ').replace(/-/g, ' dash ').replace(/_/g, ' underscore ')
  )

  // Markdown links [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // Bare URLs → speak domain (+ path if short and all letters/slashes)
  s = s.replace(/https?:\/\/\S+/g, (url) => {
    try {
      // Strip query params, fragments, and percent-encoded junk before parsing
      const clean = url.split(/[?&#%]/)[0]
      const parsed = new URL(clean)
      const host = parsed.hostname.replace(/^www\./, '')
      const path = parsed.pathname.replace(/\/$/, '')
      const spoken = (path && path.length <= 30 && /^[/a-zA-Z-]+$/.test(path))
        ? host + path
        : host
      return spoken.replace(/\./g, ' dot ').replace(/\//g, ' slash ')
    } catch {
      return ''
    }
  })

  // Bold **text** or __text__
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')

  // Italic *text* or _text_
  s = s.replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/_([^_]+)_/g, '$1')

  // Heading markers (## Heading → Heading)
  s = s.replace(/^#{1,6}\s+/gm, '')

  // Horizontal rules
  s = s.replace(/^[-*_]{3,}\s*$/gm, '')

  // HTML entities
  s = s.replace(/&amp;/g, 'and')
  s = s.replace(/&lt;/g, 'less than')
  s = s.replace(/&gt;/g, 'greater than')
  s = s.replace(/&nbsp;/g, ' ')
  s = s.replace(/&quot;/g, '')
  s = s.replace(/&#?39;|&apos;/g, "'")

  // Collapse multiple blank lines to one
  s = s.replace(/\n{3,}/g, '\n\n')

  // Trim leading/trailing whitespace
  s = s.trim()

  return s
}
