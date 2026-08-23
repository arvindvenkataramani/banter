import { TextChunker } from './text-chunker'
import type { Session } from '../session'
import type { VoiceAnnotation } from '../controls'
import type { ChunkStrategy } from './voice-config'
import type { RunEvent } from '../run-state'

export interface TurnManagerCallbacks {
  // Per-chunk: the chunker emits a speakable chunk → enqueue into player.
  enqueueChat: (text: string) => Promise<void>
  // Lifecycle: tell the player engine when a new turn begins/ends.
  beginRun: () => void
  endRun: () => void
}

export interface TurnManagerConfig {
  chunkStrategy: ChunkStrategy
  minChunkWords: number | undefined
  maxChunkWords: number | undefined
}

export class TurnManager {
  private session: Session | null = null
  private unsubscribeEvent: (() => void) | null = null
  private unsubscribeSnapshot: (() => void) | null = null
  private cb: TurnManagerCallbacks
  config: TurnManagerConfig = { chunkStrategy: 'two-chunk', minChunkWords: undefined, maxChunkWords: undefined }

  // Per-run state
  private activeRunId: string | null = null
  private prevTextLen = 0
  private chunker: TextChunker | null = null
  private pendingSpeaks: Promise<void>[] = []
  // Set when a run was discarded out of band (reset/markUnknown) rather than
  // via its own terminal event — the next run-start fast-forwards past
  // whatever text arrives first, since we can't know how much of it (if any)
  // was already spoken before the discard. Dropping stale audio is better
  // than replaying it.
  private justDiscarded = false
  // Guards against genuinely stale/duplicate chat events arriving after this
  // run's own terminal (final/aborted/error) — e.g. a re-delivered chat event
  // for a run that has already fully finished. Without this, such an event
  // reads as a brand new run and re-speaks the entire response from the
  // start. One runId is enough: a second stale event for an
  // already-superseded run is caught by the normal eventRunId-mismatch path
  // in the reducer/session layer already.
  private lastFinishedRunId: string | null = null

  constructor(cb: TurnManagerCallbacks) {
    this.cb = cb
  }

  attach(session: Session): void {
    this.detach()
    this.session = session
    this.unsubscribeEvent = session.conversation.onEvent((e) => this.handleEvent(e))
    this.unsubscribeSnapshot = session.conversation.subscribe(() => this.handleSnapshotChange())
  }

  detach(): void {
    this.unsubscribeEvent?.()
    this.unsubscribeEvent = null
    this.unsubscribeSnapshot?.()
    this.unsubscribeSnapshot = null
    this.session = null
    this.discardChunker()
    this.lastFinishedRunId = null
  }

  /** External cancellation — used when the user interrupts mid-turn. */
  abort(): void {
    this.session?.controls.stop().catch(() => {})
  }

  /** External send — routed through the abort-then-send policy in controls. */
  send(text: string, opts?: { annotation?: VoiceAnnotation }): Promise<void> {
    if (!this.session) return Promise.resolve()
    return this.session.controls.send(text, opts)
  }

  private handleEvent(e: RunEvent): void {
    switch (e.kind) {
      case 'chat': {
        if (e.runId === this.lastFinishedRunId) {
          // Stale/duplicate event trailing a run whose own chat terminal
          // already finished it — drop it rather than re-speak.
          break
        }
        if (e.state === 'delta') {
          if (this.activeRunId !== e.runId) {
            this.beginNewRun(e.runId)
            if (this.justDiscarded) {
              // Fast-forward: treat everything already accumulated in this
              // first post-discard delta as handled, never re-spoken.
              this.prevTextLen = e.text.length
              this.justDiscarded = false
            }
          }
          this.feedDelta(e.text)
        } else if (this.activeRunId !== null) {
          this.finishRun(e.text)
        }
        break
      }
      case 'tool': {
        if (e.phase === 'start') this.chunker?.recommendFlush()
        break
      }
      // lifecycle / item / thinking / compaction / unknown: allowlist — never
      // reach the chunker or the finish path. Only chat events drive speech:
      // the chat stream is self-terminating (final/aborted/error, with final
      // carrying the full text). lifecycle:end means only "execution ended",
      // not "all chat text delivered" — the gateway gives no ordering
      // guarantee between the two streams, so lifecycle must never be
      // treated as a finish trigger.
    }
  }

  // Catches reset()/markUnknown(), neither of which flows through the
  // ordered tap (they're not RunEvents) — only observable via the snapshot.
  private handleSnapshotChange(): void {
    if ((this.activeRunId === null && this.lastFinishedRunId === null) || !this.session) return
    const snap = this.session.conversation.getSnapshot()
    const resetOccurred = snap.runId === null && !snap.runActive
    if (!snap.known || resetOccurred) {
      this.discardChunker()
      this.justDiscarded = true
      this.lastFinishedRunId = null
    }
  }

  private beginNewRun(runId: string): void {
    this.activeRunId = runId
    this.prevTextLen = 0
    this.pendingSpeaks = []
    this.chunker = new TextChunker({
      mode: this.config.chunkStrategy,
      minWords: this.config.minChunkWords,
      maxWords: this.config.maxChunkWords,
      onChunk: (text) => this.fireSpeak(text),
    })
    this.cb.beginRun()
  }

  private feedDelta(fullText: string): void {
    if (fullText.length > this.prevTextLen) {
      const delta = fullText.slice(this.prevTextLen)
      this.prevTextLen = fullText.length
      this.chunker?.feed(delta)
    }
  }

  private finishRun(finalText: string | undefined): void {
    if (this.chunker) {
      if (finalText !== undefined && finalText.length > this.prevTextLen) {
        this.chunker.feed(finalText.slice(this.prevTextLen))
      }
      this.chunker.finish()
      Promise.all(this.pendingSpeaks)
        .then(() => this.cb.endRun())
        .catch(() => {})
    }
    this.lastFinishedRunId = this.activeRunId
    this.discardChunker()
  }

  private discardChunker(): void {
    this.chunker = null
    this.activeRunId = null
    this.prevTextLen = 0
    this.pendingSpeaks = []
  }

  private fireSpeak(text: string): void {
    const p = this.cb.enqueueChat(text).catch((err) => {
      if (err?.name !== 'AbortError') console.error('[turn-manager] TTS error:', err)
    })
    this.pendingSpeaks.push(p)
  }
}
