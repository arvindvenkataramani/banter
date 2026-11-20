/**
 * How much of a streaming transcript is shown, and how quickly.
 *
 * A partial carries the whole transcript as it currently stands, and its tail
 * is the token the model is least sure of. Both rules here exist so the
 * readout claims no more than the server has actually reported.
 */

/**
 * The buffer trimmed back to its last settled word boundary.
 *
 * The tail of a partial is a token the model may still revise, and rendering
 * it as a whole word claims recognition that was never reported — the user
 * reads a word, it changes under them, and the readout has rewritten its own
 * history. A partial with no boundary in it yet shows nothing, since its only
 * word is the unsettled one.
 */
export function settledText(raw: string): string {
  const end = raw.trimEnd()
  // Trailing whitespace is itself the boundary: the model finished that word
  // and moved on to the next.
  if (end !== raw) return end
  const lastBoundary = end.lastIndexOf(' ')
  return lastBoundary === -1 ? '' : end.slice(0, lastBoundary)
}

/**
 * The last `lines` worth of text, measured in words rather than rendered
 * height.
 *
 * The readout is a few lines tall and pinned to its bottom, so a long turn
 * scrolls its own beginning away. Trimming the string as well keeps the
 * element from growing unboundedly behind its own overflow while a turn runs
 * long — the words above the fold cannot be read and are not coming back.
 */
export function tailWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length <= maxWords) return text
  return words.slice(words.length - maxWords).join(' ')
}
