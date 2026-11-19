import { cleanForSpeech } from './text-cleaner'

const SENTENCE_BOUNDARY = /[.!?][\s\n]/
const PARAGRAPH_BOUNDARY = /\n\n/
const CLAUSE_BOUNDARY = /,\s+(?:and|but|or|nor|for|yet|so)\s|;\s/
const LINE_BOUNDARY = /\n/
// Matches a list marker at the start of a line: "- ", "* ", "1. ", "2) " etc.
const LIST_MARKER = /^[ \t]*(?:[-*]|\d+[.)]) /m

const MIN_WORDS = 12

export type ChunkMode = 'two-chunk' | 'paragraph' | 'sentence' | 'greedy'

export interface TextChunkerOpts {
  mode: ChunkMode
  minWords?: number
  maxWords?: number
  onChunk: (text: string) => void
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/** End index of the last boundary match in text, or null if none. */
function lastBoundaryEnd(text: string, boundary: RegExp): number | null {
  const re = new RegExp(boundary.source, 'g')
  let last: number | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) last = m.index + m[0].length
  return last
}

/** End index of the nearest boundary of any kind at or after `from`, or null. */
function firstBoundaryEndAfter(text: string, from: number): number | null {
  let best: number | null = null
  for (const boundary of [SENTENCE_BOUNDARY, CLAUSE_BOUNDARY, LINE_BOUNDARY]) {
    const m = boundary.exec(text.slice(from))
    if (!m) continue
    const end = from + m.index + m[0].length
    if (best === null || end < best) best = end
  }
  return best
}

/**
 * Returns true when a short phrase should be held and merged with the content
 * that follows it rather than emitted alone.
 *
 * Conditions (all must hold):
 *   - phrase ends with a newline (i.e. is a lead-in line, not inline text)
 *   - what follows in the buffer starts with a list marker
 *   - phrase is under minWords
 *   - aggregate (phrase + buffer remainder) is within maxWords if set
 */
function isListLeadIn(
  phrase: string,
  remainder: string,
  minWords: number,
  maxWords: number | undefined,
): boolean {
  if (countWords(phrase) >= minWords) return false
  // phrase must end with a newline (after trailing spaces — it's a lead-in line, not inline text)
  if (!/\n[ \t]*$/.test(phrase)) return false
  if (!LIST_MARKER.test(remainder)) return false
  if (maxWords && countWords(phrase) + countWords(remainder) > maxWords) return false
  return true
}

export class TextChunker {
  private buffer = ''
  private firstChunkSent = false
  private scanFrom = 0
  private readonly minWords: number
  private readonly maxWords: number | undefined
  private readonly onChunk: (text: string) => void
  private readonly tryEmit: () => void

  constructor(opts: TextChunkerOpts) {
    this.minWords = opts.minWords ?? MIN_WORDS
    this.maxWords = opts.maxWords
    this.onChunk = opts.onChunk
    this.tryEmit = this.buildEmitter(opts.mode)
  }

  private buildEmitter(mode: ChunkMode): () => void {
    switch (mode) {
      case 'two-chunk':  return () => { if (!this.firstChunkSent) this.emitTwoChunk() }
      case 'paragraph':  return () => this.emitParagraphs()
      case 'sentence':   return () => this.emitSentences()
      case 'greedy':     return () => this.emitGreedy()
    }
  }

  feed(delta: string): void {
    this.buffer += delta
    this.tryEmit()
  }

  /**
   * Flush every complete sentence currently buffered, leaving only the trailing
   * partial fragment. Below-minWords sentences are emitted too — never mid-phrase
   * text. One-shot: subsequent feeds resume normal threshold behavior.
   *
   * Called when an external signal (e.g. a tool_use block arriving) tells us the
   * model has paused generation, so buffered text should play during the pause
   * rather than waiting for the turn to end.
   *
   * Mode-independent: it drains complete sentences directly rather than going
   * through the per-mode emitter, so it works after the first chunk in two-chunk
   * mode and re-examines boundaries the normal scan skipped under the higher
   * threshold.
   */
  recommendFlush(): void {
    // Find the last sentence boundary in the buffer and emit everything up to
    // it as a SINGLE chunk, leaving only the trailing partial fragment. One
    // chunk (not one-per-sentence) keeps the TTS request whole — some models
    // degrade on many tiny fragments. Scan from 0 because streaming may have
    // advanced scanFrom past boundaries that are now flushable.
    let lastBoundaryEnd = -1
    let searchFrom = 0
    while (true) {
      const match = SENTENCE_BOUNDARY.exec(this.buffer.slice(searchFrom))
      if (!match) break
      lastBoundaryEnd = searchFrom + match.index + match[0].length
      searchFrom = lastBoundaryEnd
    }
    if (lastBoundaryEnd === -1) return // no complete sentence — never cut mid-phrase
    this.emit(this.buffer.slice(0, lastBoundaryEnd), lastBoundaryEnd)
  }

  finish(): void {
    const text = this.buffer.trim()
    this.buffer = ''
    this.scanFrom = 0
    if (!text) return
    const cleaned = cleanForSpeech(text)
    if (!cleaned) return
    this.onChunk(cleaned)
    this.firstChunkSent = true
  }

  reset(): void {
    this.buffer = ''
    this.firstChunkSent = false
    this.scanFrom = 0
  }

  private emit(text: string, consumed: number): void {
    this.buffer = this.buffer.slice(consumed)
    this.scanFrom = 0
    this.firstChunkSent = true
    const cleaned = cleanForSpeech(text.trim())
    if (cleaned) this.onChunk(cleaned)
  }

  // ── two-chunk ────────────────────────────────────────────────────────────

  private emitTwoChunk(): void {
    let searchFrom = this.scanFrom
    let candidateBoundary = -1

    while (true) {
      const match = SENTENCE_BOUNDARY.exec(this.buffer.slice(searchFrom))
      if (!match) {
        this.scanFrom = searchFrom
        break
      }
      const boundaryEnd = searchFrom + match.index + match[0].length
      if (countWords(this.buffer.slice(0, boundaryEnd)) >= this.minWords) {
        candidateBoundary = boundaryEnd
        break
      }
      searchFrom = boundaryEnd
    }

    if (candidateBoundary === -1) {
      const paraMatch = PARAGRAPH_BOUNDARY.exec(this.buffer)
      if (paraMatch) {
        const para = this.buffer.slice(0, paraMatch.index)
        this.emit(para, paraMatch.index + 2)
      }
      return
    }

    const firstChunkText = this.buffer.slice(0, candidateBoundary)
    const afterFirst = this.buffer.slice(candidateBoundary)
    const paraMatch = PARAGRAPH_BOUNDARY.exec(afterFirst)

    if (paraMatch) {
      const tail = afterFirst.slice(0, paraMatch.index).trim()
      if (tail && countWords(tail) <= countWords(firstChunkText)) {
        this.emit(firstChunkText + afterFirst.slice(0, paraMatch.index), candidateBoundary + paraMatch.index + 2)
        return
      }
    }

    this.emit(firstChunkText, candidateBoundary)
  }

  // ── paragraph ────────────────────────────────────────────────────────────

  private emitParagraphs(): void {
    while (true) {
      const idx = this.buffer.search(PARAGRAPH_BOUNDARY)
      if (idx === -1) break

      const para = this.buffer.slice(0, idx)
      const remainder = this.buffer.slice(idx + 2)

      // If this paragraph is a short list lead-in, skip the boundary and keep
      // accumulating — the list items will be part of the next paragraph chunk.
      if (isListLeadIn(para, remainder, this.minWords, this.maxWords)) {
        // Drop the \n\n so the lead-in and list accumulate together
        this.buffer = para + '\n' + remainder
        this.scanFrom = 0
        // Continue the loop — there may be another \n\n after the list
        continue
      }

      this.buffer = remainder
      this.scanFrom = 0
      const trimmed = para.trim()
      if (trimmed) {
        const cleaned = cleanForSpeech(trimmed)
        if (cleaned) this.onChunk(cleaned)
      }
    }
  }

  // ── sentence ─────────────────────────────────────────────────────────────

  private emitSentences(): void {
    while (true) {
      if (this.maxWords && countWords(this.buffer) >= this.maxWords) {
        if (!this.splitAtMax()) break
        continue
      }

      const match = SENTENCE_BOUNDARY.exec(this.buffer.slice(this.scanFrom))
      if (!match) break

      const boundaryEnd = this.scanFrom + match.index + match[0].length
      const candidate = this.buffer.slice(0, boundaryEnd)
      const candidateWords = countWords(candidate)

      if (candidateWords >= this.minWords) {
        this.emit(candidate, boundaryEnd)
      } else {
        // Short candidate — check if it's a list lead-in before looking ahead
        const remainder = this.buffer.slice(boundaryEnd)
        if (isListLeadIn(candidate, remainder, this.minWords, this.maxWords)) {
          // Hold the lead-in; advance scan past it and keep accumulating
          this.scanFrom = boundaryEnd
          break
        }

        const nextMatch = SENTENCE_BOUNDARY.exec(remainder)
        if (!nextMatch) {
          this.scanFrom = boundaryEnd
          break
        }
        const combinedEnd = boundaryEnd + nextMatch.index + nextMatch[0].length
        const combined = this.buffer.slice(0, combinedEnd)
        if (countWords(combined) >= this.minWords) {
          this.emit(combined, combinedEnd)
        } else {
          this.scanFrom = combinedEnd
          break
        }
      }
    }
  }

  // ── greedy ───────────────────────────────────────────────────────────────

  private emitGreedy(): void {
    while (true) {
      let candidateEnd = 0
      let searchFrom = this.scanFrom

      while (true) {
        const match = SENTENCE_BOUNDARY.exec(this.buffer.slice(searchFrom))
        if (!match) break
        const boundaryEnd = searchFrom + match.index + match[0].length
        if (this.maxWords && countWords(this.buffer.slice(0, boundaryEnd)) > this.maxWords) break
        candidateEnd = boundaryEnd
        searchFrom = boundaryEnd
      }

      if (candidateEnd === 0) {
        if (this.maxWords && countWords(this.buffer) >= this.maxWords) {
          if (!this.splitAtMax()) break
          continue
        }
        this.scanFrom = searchFrom
        break
      }

      const candidate = this.buffer.slice(0, candidateEnd)
      const candidateWords = countWords(candidate)

      if (candidateWords < this.minWords) {
        // Short candidate — check for list lead-in before waiting
        const remainder = this.buffer.slice(candidateEnd)
        if (isListLeadIn(candidate, remainder, this.minWords, this.maxWords)) {
          this.scanFrom = candidateEnd
          break
        }
        this.scanFrom = candidateEnd
        break
      }

      // Wait until the next boundary is visible, confirming this candidate is complete
      const hasNextBoundary = SENTENCE_BOUNDARY.test(this.buffer.slice(candidateEnd))
      const hitMax = this.maxWords && candidateWords >= this.maxWords
      if (!hasNextBoundary && !hitMax) {
        this.scanFrom = candidateEnd
        break
      }

      this.emit(candidate, candidateEnd)
    }
  }

  // ── shared ───────────────────────────────────────────────────────────────

  /**
   * Over-cap split that only ever cuts at a natural boundary. Prefers the
   * latest boundary inside the maxWords window — sentence, then clause, then
   * line break (searched from the buffer start, so boundaries the streaming
   * scan already passed are still honored). If the window has none, takes the
   * nearest boundary past it: a slightly oversized chunk at a real boundary
   * sounds better than a cut at a bare word position. With no boundary
   * anywhere, holds the buffer — finish() drains it at turn end.
   */
  private splitAtMax(): boolean {
    if (!this.maxWords) return false

    const buf = this.buffer
    let pos = 0
    let wordCount = 0
    while (wordCount < this.maxWords && pos < buf.length) {
      while (pos < buf.length && /\s/.test(buf[pos])) pos++
      if (pos >= buf.length) break
      while (pos < buf.length && !/\s/.test(buf[pos])) pos++
      wordCount++
    }

    const searchWindow = buf.slice(0, pos)
    const splitPos =
      lastBoundaryEnd(searchWindow, SENTENCE_BOUNDARY) ??
      lastBoundaryEnd(searchWindow, CLAUSE_BOUNDARY) ??
      lastBoundaryEnd(searchWindow, LINE_BOUNDARY) ??
      firstBoundaryEndAfter(buf, pos)

    if (splitPos === null) return false
    const chunk = buf.slice(0, splitPos).trim()
    if (!chunk) return false
    this.emit(chunk, splitPos)
    return true
  }
}
