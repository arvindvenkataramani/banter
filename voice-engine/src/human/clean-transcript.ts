// Design: docs/components/voice-turn-taking.md

/** Strip filler words from Parakeet transcripts. */
export function cleanTranscript(text: string): string {
  const cleaned = text
    .replace(/\b(uh|um|uhh|umm)\b[,.]?\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  // The model answers a stretch of silence with bare punctuation; with no
  // letter or digit in it, nothing was said.
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : ''
}
