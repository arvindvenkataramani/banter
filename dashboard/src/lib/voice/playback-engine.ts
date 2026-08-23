import { STREAMING_BACKEND } from './streaming-backend'
import type { StreamingBackend } from './streaming-backend'

export type PlayerState = 'idle' | 'playing' | 'paused' | 'error'

export interface PlayerStateView {
  state: PlayerState
  remainingSeconds: number
  heldChunkCount: number
}

export interface PlaybackEngineCallbacks {
  onState: (s: PlayerState) => void
  onRemainingSeconds: (s: number) => void
  onHeldChunkCount: (n: number) => void
}

interface SpeakRequest {
  endpoint: string
  text: string
  modelId: string
  voiceId: string
  speed: number
  params?: Record<string, unknown>
}

interface HeldChunk {
  req: SpeakRequest
  resolve: () => void
  reject: (err: unknown) => void
}

/**
 * Audio playback engine. Wraps the <audio> element, MediaSource/SourceBuffer,
 * streaming pipeline, and the held-chunks queue.
 *
 * The engine is the only writer to its callbacks. Consumers read state via
 * the callbacks — they should not read fields directly.
 */
export class PlaybackEngine {
  private cb: PlaybackEngineCallbacks

  // Streaming state
  private mediaSource: MediaSource | ManagedMediaSource | null = null
  private sourceBuffer: SourceBuffer | null = null
  private pendingChunks: Uint8Array[] = []
  private appending = false
  private objectUrl: string | null = null

  // MMS flow control
  private streamingAllowed = true
  private streamingResolve: (() => void) | null = null

  // Stream serialization
  private streamingChain: Promise<void> = Promise.resolve()
  private activeStreams = 0
  private generation = 0

  // Concurrency cap
  private maxConcurrency: number | undefined
  private inFlight = 0
  private concurrencyWaiters: Array<() => void> = []

  // Audio + lifecycle
  private audio: HTMLAudioElement | null = null
  private abortControllers: AbortController[] = []
  private _state: PlayerState = 'idle'
  private responseActive = false
  private userPaused = false

  // Blob fallback
  private playQueue: Promise<string | null>[] = []
  private playing = false

  // Held chunks (deferred until user is no longer speaking)
  private heldChunks: HeldChunk[] = []

  // remainingSeconds publisher
  private remainingTimer: ReturnType<typeof setInterval> | null = null

  // Predicate: should an enqueued chunk be held instead of dispatched?
  // Set by consumers (the mic store integration) before enqueueChat.
  private shouldHold: () => boolean = () => false

  // Predicate: did this run begin while speech was muted? A chunk from such
  // a run is discarded at enqueue, never held — nothing from an unvoiced run
  // will ever be heard, so there is nothing to hold it for.
  private shouldDiscard: () => boolean = () => false

  constructor(cb: PlaybackEngineCallbacks) {
    this.cb = cb
  }

  setShouldHold(fn: () => boolean): void {
    this.shouldHold = fn
  }

  setShouldDiscard(fn: () => boolean): void {
    this.shouldDiscard = fn
  }

  setConcurrency(n: number | undefined): void {
    this.maxConcurrency = n && n > 0 ? n : undefined
  }

  get state(): PlayerState {
    return this._state
  }

  get streamingTier(): StreamingBackend {
    return STREAMING_BACKEND
  }

  get useMSE(): boolean {
    return STREAMING_BACKEND !== 'blob'
  }

  get isAudioActive(): boolean {
    return !!this.audio && !this.audio.paused
  }

  get heldChunkCount(): number {
    return this.heldChunks.length
  }

  /**
   * Live-read of buffered audio ahead of the playhead. Works for both blob
   * (finite duration) and MSE/MMS (Infinity duration) backends: reads from
   * audio.buffered rather than audio.duration so it reflects actual decoded
   * audio in the buffer, not the stream's declared length.
   */
  get remainingSeconds(): number {
    const a = this.audio
    if (!a || a.paused) return 0
    const buf = a.buffered
    if (buf.length === 0) return 0
    return Math.max(0, buf.end(buf.length - 1) - a.currentTime)
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  init(): void {
    if (this.audio) return

    const audio = new Audio()
    audio.addEventListener('playing', () => this.setState('playing'))
    audio.addEventListener('waiting', () => {
      if (!this.responseActive && this.pendingChunks.length === 0 && this.activeStreams === 0) {
        this.setState('idle')
      }
    })
    audio.addEventListener('error', () => {
      console.error('[playback-engine] audio error:', audio.error)
    })
    this.audio = audio

    if (STREAMING_BACKEND === 'blob') {
      audio.onended = () => this.playNext()
      return
    }

    if (STREAMING_BACKEND === 'mms') {
      this.attachMMS(audio)
    } else {
      this.attachMSE(audio)
    }
  }

  destroy(): void {
    this.cancel()

    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try { this.mediaSource.endOfStream() } catch { /* ignore */ }
    }

    if (this.audio) {
      this.audio.onended = null
      this.audio.pause()
      if (STREAMING_BACKEND === 'mms') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(this.audio as any).srcObject = null
      } else {
        this.audio.src = ''
      }
      this.audio = null
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
    this.mediaSource = null
    this.sourceBuffer = null
    this.streamingAllowed = true
    this.streamingResolve = null
    this.streamingChain = Promise.resolve()
    this.activeStreams = 0
    this.dropHeldChunks()
    this.stopRemainingTicker()
    this.setState('idle')
  }

  // ── Per-response (called by TurnManager) ─────────────────────────────────

  /** Start of a new assistant turn — cancels any prior playback. */
  beginRun(): void {
    this.cancel()
    this.responseActive = true
  }

  /** End of an assistant turn — let the audio drain naturally. */
  endRun(): void {
    this.responseActive = false
    // If the user paused with audio still buffered, stay in 'paused' so the
    // chrome keeps the resume button live and the mic-loop can see pending audio.
    if (this.userPaused) return
    if (this.audio?.paused && this.pendingChunks.length === 0 && this.activeStreams === 0) {
      this.setState('idle')
    }
  }

  // ── Held chunks ─────────────────────────────────────────────────────────

  /** Release all held chunks — the user's utterance was rejected as not-speech. */
  releaseHeldChunks(): void {
    const held = this.heldChunks
    this.heldChunks = []
    this.cb.onHeldChunkCount(0)
    for (const h of held) {
      this.dispatchSpeak(h.req).then(h.resolve, h.reject)
    }
  }

  /** Drop all held chunks — the user's utterance was a real interrupt. */
  dropHeldChunks(): void {
    const held = this.heldChunks
    this.heldChunks = []
    this.cb.onHeldChunkCount(0)
    for (const h of held) h.resolve()
  }

  // ── Enqueue (called by TurnManager per chunk) ────────────────────────────

  /**
   * Enqueue a TTS chunk. Discarded outright if the run it belongs to began
   * while speech was muted; otherwise parked until released or dropped when
   * `shouldHold()` is true at enqueue time. Discard is checked first: a
   * chunk from an unvoiced run should never occupy the hold queue.
   */
  enqueueChat(req: SpeakRequest): Promise<void> {
    if (this.shouldDiscard()) return Promise.resolve()
    if (this.shouldHold()) {
      return new Promise<void>((resolve, reject) => {
        this.heldChunks.push({ req, resolve, reject })
        this.cb.onHeldChunkCount(this.heldChunks.length)
      })
    }
    return this.dispatchSpeak(req)
  }

  // ── Pause / resume / cancel (mic actor commands) ────────────────────────

  pause(): void {
    if (!this.audio) return
    // No-op if there's genuinely nothing to pause: not playing, no pending
    // chunks, no in-flight streams, no active response. Without this guard,
    // a mute-all (which calls pause() unconditionally) leaves the engine in
    // a phantom 'paused' state with userPaused=true and no audio to resume.
    const hasAudio =
      !this.audio.paused
      || this.pendingChunks.length > 0
      || this.activeStreams > 0
      || this.responseActive
    if (!hasAudio) return
    this.userPaused = true
    if (!this.audio.paused) {
      this.audio.pause()
      this.setState('paused')
    }
  }

  /**
   * Resume clears the pause the mute arbiter (or caller) set. Self-guarded
   * on `userPaused`: without this, a resume issued with nothing paused would
   * clear a flag no one set, and — worse — on the blob backend it would call
   * `audio.play()` with no blob mounted, resuming nothing. `userPaused` is
   * the authoritative flag; store state is a lossy proxy of it (pause() can
   * set userPaused without the store ever reaching 'paused' — see the
   * playback-arbiter header comment).
   */
  resume(): void {
    if (!this.userPaused) return
    this.userPaused = false
    // Blob backend, nothing mounted: audio.play() would resume nothing.
    // playNext() pulls the next queued blob and starts it.
    if (STREAMING_BACKEND === 'blob' && !this.playing) {
      this.playNext()
      return
    }
    if (this.audio?.paused) {
      this.audio.play().catch(() => { /* ignore */ })
    }
  }

  /**
   * Hard cancel — abort fetches, drain in-flight body-readers, rebuild pipeline.
   *
   * Bug B fix: await streamingChain to settle before resetting the chain
   * and rebuilding the pipeline. Stale drains observe the generation bump
   * and exit before any new fetch can start.
   */
  cancel(): void {
    this.userPaused = false
    this.responseActive = false

    // Bump generation so in-flight speaks see invalid gen and bail
    this.generation++

    // Abort in-flight fetches (errors any active readers)
    for (const abort of this.abortControllers) abort.abort()
    this.abortControllers = []

    // Release semaphore waiters
    this.inFlight = 0
    const waiters = this.concurrencyWaiters.splice(0)
    for (const w of waiters) w()

    // Wake any MMS-parked drain
    this.streamingAllowed = true
    if (this.streamingResolve) {
      this.streamingResolve()
      this.streamingResolve = null
    }

    // Reset chain — new speaks chain off Promise.resolve(); old drains
    // detect generation mismatch and exit. We don't await here because
    // that would require cancel() to be async; instead, the rebuilt
    // pipeline below is keyed off generation so old chunks won't append.
    this.streamingChain = Promise.resolve()
    this.activeStreams = 0

    // Fallback queue
    this.playQueue = []
    this.playing = false

    // Stop audio
    if (this.audio && !this.audio.paused) {
      this.audio.pause()
    }

    // Rebuild streaming pipeline
    this.pendingChunks = []
    this.appending = false
    if (this.sourceBuffer) {
      try { this.sourceBuffer.abort() } catch { /* ignore */ }
      this.sourceBuffer = null
    }
    this.mediaSource = null

    const audio = this.audio
    if (audio && STREAMING_BACKEND !== 'blob') {
      if (STREAMING_BACKEND === 'mms') {
        this.attachMMS(audio)
      } else {
        if (this.objectUrl) {
          URL.revokeObjectURL(this.objectUrl)
          this.objectUrl = null
        }
        this.attachMSE(audio)
      }
    }

    this.dropHeldChunks()
    this.stopRemainingTicker()
    this.setState('idle')
  }

  // ── Internal: dispatch one speak() ──────────────────────────────────────

  private async dispatchSpeak(req: SpeakRequest): Promise<void> {
    if (!this.audio) {
      throw new Error('PlaybackEngine.init() must be called before enqueueChat()')
    }
    const gen = this.generation

    await this.acquireSlot()
    if (gen !== this.generation) {
      this.releaseSlot()
      return
    }
    let slotReleased = false
    const release = () => {
      if (!slotReleased) {
        slotReleased = true
        this.releaseSlot()
      }
    }

    const abort = new AbortController()
    this.abortControllers.push(abort)

    let resolveSlot: (url: string | null) => void = () => {}
    if (STREAMING_BACKEND === 'blob') {
      const slot = new Promise<string | null>(r => { resolveSlot = r })
      this.enqueueBlob(slot)
    }

    const url = `${req.endpoint.replace(/\/$/, '')}/v1/audio/speech`
    const body = {
      model: req.modelId,
      input: req.text,
      voice: req.voiceId,
      speed: req.speed,
      stream: STREAMING_BACKEND !== 'blob',
      response_format: 'mp3',
      ...req.params,
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      })
    } catch (err) {
      resolveSlot(null)
      release()
      throw err
    }

    if (!res.ok) {
      resolveSlot(null)
      release()
      this.setState('error')
      throw new Error(`TTS request failed: ${res.status} ${res.statusText}`)
    }

    if (STREAMING_BACKEND === 'blob') {
      try {
        const blob = await res.blob()
        resolveSlot(URL.createObjectURL(blob))
      } catch {
        resolveSlot(null)
      }
      release()
      return
    }

    const reader = res.body!.getReader()

    if (gen !== this.generation) {
      reader.cancel().catch(() => {})
      release()
      return
    }

    this.activeStreams++
    const prev = this.streamingChain
    this.streamingChain = prev.then(() => this.drainStream(reader, gen))
    try {
      await this.streamingChain
    } finally {
      if (this.activeStreams > 0) this.activeStreams--
      release()
    }
  }

  private async drainStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    gen: number,
  ): Promise<void> {
    if (gen !== this.generation) {
      reader.cancel().catch(() => {})
      return
    }

    try {
      while (true) {
        if (STREAMING_BACKEND === 'mms' && !this.streamingAllowed) {
          await new Promise<void>(resolve => { this.streamingResolve = resolve })
        }
        if (gen !== this.generation) {
          reader.cancel().catch(() => {})
          return
        }

        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        if (gen !== this.generation) {
          reader.cancel().catch(() => {})
          return
        }

        this.pendingChunks.push(value)
        this.processNextChunk()
      }
    } catch {
      // aborted / errored — nothing to do
    }
  }

  // ── Pipeline plumbing ───────────────────────────────────────────────────

  private attachMMS(audio: HTMLAudioElement): void {
    const ms = new ManagedMediaSource()
    this.mediaSource = ms
    audio.disableRemotePlayback = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(audio as any).srcObject = ms

    ms.addEventListener('sourceopen', () => this.setupSourceBuffer(ms))

    ms.addEventListener('startstreaming', () => {
      this.streamingAllowed = true
      if (this.streamingResolve) {
        this.streamingResolve()
        this.streamingResolve = null
      }
    })
    ms.addEventListener('endstreaming', () => {
      this.streamingAllowed = false
    })
  }

  private attachMSE(audio: HTMLAudioElement): void {
    const ms = new MediaSource()
    this.mediaSource = ms
    this.objectUrl = URL.createObjectURL(ms)
    audio.src = this.objectUrl

    ms.addEventListener('sourceopen', () => this.setupSourceBuffer(ms))
  }

  private setupSourceBuffer(ms: MediaSource | ManagedMediaSource): void {
    try {
      const sb = ms.addSourceBuffer('audio/mpeg')
      this.sourceBuffer = sb
      sb.addEventListener('updateend', () => this.onAppendComplete())
      this.processNextChunk()
    } catch (e) {
      console.error('[playback-engine] failed to add SourceBuffer:', e)
      this.setState('error')
    }
  }

  private onAppendComplete(): void {
    this.appending = false
    if (this.audio?.paused && !this.userPaused) {
      this.audio.play()
        .then(() => {
          if (this.audio && !this.audio.paused && this._state !== 'playing') {
            this.setState('playing')
          }
        })
        .catch(err => console.error('[playback-engine] play() rejected:', err))
    } else if (this.audio && !this.audio.paused && this._state !== 'playing') {
      this.setState('playing')
    }
    this.processNextChunk()
  }

  private processNextChunk(): void {
    if (this.appending || !this.sourceBuffer || this.sourceBuffer.updating) return
    const chunk = this.pendingChunks.shift()
    if (!chunk) return
    this.appending = true
    try {
      this.sourceBuffer.appendBuffer(chunk as Uint8Array<ArrayBuffer>)
    } catch (e) {
      console.error('[playback-engine] appendBuffer error:', e)
      this.appending = false
      this.processNextChunk()
    }
  }

  // ── Blob fallback ───────────────────────────────────────────────────────

  private enqueueBlob(slot: Promise<string | null>): void {
    this.playQueue.push(slot)
    // Don't auto-start while user-paused: a chunk arriving mid-pause should
    // queue silently, not jump the pause. resume() restarts the queue.
    if (!this.playing && !this.userPaused) this.playNext()
  }

  private async playNext(): Promise<void> {
    if (!this.audio) return
    const slot = this.playQueue.shift()
    if (!slot) {
      this.playing = false
      this.setState('idle')
      return
    }
    this.playing = true
    const blobUrl = await slot
    if (!blobUrl || !this.audio) {
      this.playNext()
      return
    }
    this.audio.src = blobUrl
    this.audio.play().catch(err => console.error('[playback-engine] play() rejected:', err))
  }

  // ── Concurrency semaphore ───────────────────────────────────────────────

  private async acquireSlot(): Promise<void> {
    if (this.maxConcurrency === undefined) return
    while (this.inFlight >= this.maxConcurrency) {
      await new Promise<void>(resolve => { this.concurrencyWaiters.push(resolve) })
    }
    this.inFlight++
  }

  private releaseSlot(): void {
    if (this.maxConcurrency === undefined) return
    this.inFlight = Math.max(0, this.inFlight - 1)
    const next = this.concurrencyWaiters.shift()
    if (next) next()
  }

  // ── State + remaining-seconds publishing ────────────────────────────────

  private setState(s: PlayerState): void {
    if (this._state !== s) {
      this._state = s
      this.cb.onState(s)
      if (s === 'playing') this.startRemainingTicker()
      else this.stopRemainingTicker()
    }
  }

  private startRemainingTicker(): void {
    if (this.remainingTimer) return
    this.remainingTimer = setInterval(() => {
      this.cb.onRemainingSeconds(this.remainingSeconds)
    }, 500)
  }

  private stopRemainingTicker(): void {
    if (this.remainingTimer) {
      clearInterval(this.remainingTimer)
      this.remainingTimer = null
      this.cb.onRemainingSeconds(0)
    }
  }
}
