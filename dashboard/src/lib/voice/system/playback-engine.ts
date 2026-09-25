// Design: docs/components/voice-turn-taking.md

import { STREAMING_BACKEND } from './streaming-backend'
import { element as deviceElement, unlockElement as unlockDeviceElement } from '../../system/devices'
import { useTurnManagerStore, report } from '../store/turn-manager-store'
import type { StreamingBackend } from './streaming-backend'
import type { Snapshot, Utterance, AudioSupply } from '../turn-manager'
import type { AudioFormat } from '../voice-config'

/** A tone that has neither been heard nor cut within this is treated as
 * finished: the microphone must never wait on a sound indefinitely. */
const TONE_TIMEOUT_MS = 3000

export interface SpeakRequest {
  endpoint: string
  text: string
  modelId: string
  voiceId: string
  /** The runtime's own format, requested and decoded as such. */
  format: AudioFormat
  speed: number
  params?: Record<string, unknown>
}

/** What the agent side plays and stops speech through — nothing about the
 * player's own lifecycle (init/reset/release), which only the system calls. */
export interface SpeechPlayer {
  enqueueChat(req: SpeakRequest): Promise<void>
  beginRun(runId: string): void
  endRun(): void
  cancel(): void
}

/** What the tone queue plays a tone through. */
export interface TonePlayer {
  enqueueTone(bytes: Uint8Array, durationS: number): Promise<void>
}

/** The MIME type each runtime format is decoded as. */
const FORMAT_MIME: Record<AudioFormat, string> = { mp3: 'audio/mpeg', aac: 'audio/aac', wav: 'audio/wav' }
/** Tones are mp3 files, whichever runtime is speaking. */
const TONE_MIME = FORMAT_MIME.mp3

interface PendingChunk {
  bytes: Uint8Array
  mime: string
}

interface HeldChunk {
  req: SpeakRequest
  resolve: () => void
  reject: (err: unknown) => void
}

/**
 * Audio playback engine. Wraps the <audio> element, MediaSource/SourceBuffer,
 * streaming pipeline, and the held-chunks queue. Reports the agent's
 * utterance and audio supply to the floor from one method, `publish()`, and
 * reconciles itself to the floor's snapshot — it holds no play/pause intent
 * of its own beyond what the snapshot says.
 */
export class PlaybackEngine implements SpeechPlayer, TonePlayer {
  // Streaming state
  private mediaSource: MediaSource | ManagedMediaSource | null = null
  private sourceBuffer: SourceBuffer | null = null
  private pendingChunks: PendingChunk[] = []
  /** The type the SourceBuffer currently decodes; a chunk of another type switches it. */
  private sourceMime = TONE_MIME
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
  private concurrencyWaiters: Array<(granted: boolean) => void> = []

  // Audio + lifecycle
  private audio: HTMLAudioElement | null = null
  private abortControllers: AbortController[] = []

  // Which run is currently being synthesised for — beginRun()/endRun()'s
  // own field, cleared by endRun() while the tail may still be draining.
  private run: string | null = null

  // Whether anything has been appended to the media source now attached.
  // On MSE/MMS `audio.paused` is not the truth about whether audio exists:
  // play() clears `paused` before it looks at readyState, so the gesture
  // play in unlock() leaves an element with an empty source reading
  // un-paused. Cleared wherever the pipeline is rebuilt.
  private appendedToSource = false

  // True for the duration of a cancel() call. cancel()'s own publish() at
  // its end reports into the floor store synchronously, which re-enters
  // reconcile() (the store's subscriber) before this call returns. The
  // reconcile() guard above is self-disarming by the time that happens
  // (appendedToSource/pendingChunks/heldChunks are already cleared earlier
  // in this same cancel() call, so the nested call's guard reads false) —
  // this flag is a second, explicit line against the same reentrancy,
  // named rather than left to follow from field-clearing order alone.
  private cancelling = false

  // Which run's utterance is (or was) mounted on the element, and how it
  // ended — separate from `run` above, which endRun() clears while the
  // tail is still playing. `ended` is a level: once reported, every later
  // publish() must keep reporting the same outcome for this run until a
  // new run's first chunk mounts and replaces it, since cancel() (called by
  // the next run's own beginRun()) resets appendedToSource before that
  // happens.
  private mountedRun: string | null = null
  private mountedOutcome: 'completed' | 'cut' | null = null

  // A tone in flight on the speech element's own timeline. Tones never
  // overlap speech: one is accepted only when no run is active, and a run
  // beginning cancels it. Its end is a point on the timeline, fixed when it
  // is enqueued, and it is finished when playback passes that point or
  // starves after starting; either way whoever waits on it
  // (the mic loop, before opening the microphone) is released, as they are
  // by a cancel, a reset or a timeout.
  private tone: { resolve: () => void; endTime: number | null; started: boolean; timer: ReturnType<typeof setTimeout> } | null = null

  // Held chunks (deferred until the floor's newAudio says park)
  private heldChunks: HeldChunk[] = []

  constructor() {
    // Wired at construction, not per attach: the player is a page-lifetime
    // singleton carrying the iOS gesture grant, and tones play on its
    // element with no AgentVoice alive at all — before the pipeline starts,
    // and during the teardown gap after voiceOff() while the ended tone
    // drains. The tone-trap guards inside reconcile() must hold across that
    // whole span. With nothing mounted or held, every snapshot notification
    // in that span is already a no-op.
    useTurnManagerStore.subscribe((state) => this.reconcile(state.snapshot))
  }

  setConcurrency(n: number | undefined): void {
    this.maxConcurrency = n && n > 0 ? n : undefined
  }

  get streamingTier(): StreamingBackend {
    return STREAMING_BACKEND
  }

  get useMSE(): boolean {
    return STREAMING_BACKEND !== 'blob'
  }

  /** The element is actively playing something the agent's utterance
   * counts, never a tone. On blob that is `this.playing` (a speech chunk is
   * the current queue slot, not a tone's) *and* the element is actually
   * unpaused — `this.playing` alone says a slot is current, not that the
   * element is running, since `pauseElement()` only pauses the element and
   * never touches it. On MSE/MMS it is `!audio.paused && appendedToSource`
   * — `audio.paused` alone reads wrong for the gesture play in unlock() (an
   * empty element fires `playing`) and for a tone's own bytes (never marked
   * appendedToSource). */
  private get elementBusy(): boolean {
    if (!this.audio) return false
    if (STREAMING_BACKEND === 'blob') return this.playing && !this.tone && !this.audio.paused
    return !this.audio.paused && this.appendedToSource
  }

  /**
   * Audio belonging to a run is mounted on the element. The two backends
   * mount differently — MSE and MMS append to a source buffer, blob assigns
   * `src` and plays from its own queue — so every reader of "is there audio
   * to act on" asks here rather than naming one backend's field. `supply
   * .mounted` and reconciliation's cancel guard are both such readers, and a
   * guard that named only the MSE field would leave blob's audio uncancelled
   * while the report said it was there. Unlike `elementBusy`, this reads
   * `this.playing` alone — mounted and paused is still mounted, which is
   * what makes `remainingSeconds` meaningful for a paused blob utterance —
   * but still excludes a tone's own slot, which is never the agent's
   * mounted audio.
   */
  private get speechMounted(): boolean {
    return this.appendedToSource || (STREAMING_BACKEND === 'blob' && this.playing && !this.tone)
  }

  /** Live-read of buffered audio ahead of the playhead, whether or not the
   * element is paused: paused audio still has seconds remaining, which is
   * what makes recordInterruption's threshold meaningful for a human turn
   * opening while the agent is mid-pause. */
  private get remainingSeconds(): number {
    const a = this.audio
    if (!a) return 0
    const buf = a.buffered
    if (buf.length === 0) return 0
    return Math.max(0, buf.end(buf.length - 1) - a.currentTime)
  }

  private get supply(): AudioSupply {
    return {
      run: this.run,
      mounted: this.speechMounted,
      pending: this.pendingChunks.length + this.activeStreams + this.heldChunks.length,
      remaining: this.remainingSeconds,
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Build the element if it does not exist yet, and attach a media source to
   * it if it has none. The two halves are separate because the element's
   * lifetime is the page's while a source's is one voice session: iOS Safari
   * grants programmatic playback only on an element that was played inside a
   * user gesture, so an element replaced at voice-off would take that grant
   * with it and leave every later voice start silent.
   */
  init(): void {
    const audio = this.element()

    if (STREAMING_BACKEND === 'blob') return

    if (this.mediaSource) return
    if (STREAMING_BACKEND === 'mms') {
      this.attachMMS(audio)
    } else {
      this.attachMSE(audio)
    }
  }

  /**
   * Read the shared element from the device module, arming its listeners
   * the first time this engine sees it. The listeners are armed once per
   * element instance, not once per call: a reset that no later init()
   * follows must not leave a rebuilt element deaf, and the element itself
   * carries no record of whether they are already attached.
   */
  private element(): HTMLAudioElement {
    const audio = deviceElement()
    if (this.audio === audio) return audio
    this.audio = audio

    audio.addEventListener('playing', () => {
      const tone = this.tone
      if (tone && !tone.started) {
        tone.started = true
        // The tone's own length, from the moment it is heard, is the clock:
        // timeupdate is coarse and a starved element may fire no final one.
        if (tone.endTime !== null) {
          clearTimeout(tone.timer)
          tone.timer = setTimeout(() => this.settleTone(), Math.max(0, tone.endTime - audio.currentTime) * 1000 + 50)
        }
      }
      this.publish()
    })
    // Registered here, for the element's lifetime, rather than in init():
    // every backend needs it, and a handler armed per-session could be left
    // un-armed by a reset that no later init() follows.
    audio.addEventListener('ended', () => this.onAudioEnded())
    audio.addEventListener('timeupdate', () => {
      const tone = this.tone
      if (tone?.endTime !== null && tone && audio.currentTime >= tone.endTime - 0.05) this.settleTone()
      this.publish()
    })
    audio.addEventListener('waiting', () => {
      // A tone that starves near its end has reached the end of its bytes:
      // nothing follows a tone on the timeline. Earlier starvation is the
      // decoder priming, and before the tone starts the element fires
      // `waiting` the moment play() is called below a full readyState;
      // neither says the tone was heard.
      const tone = this.tone
      if (tone?.started && tone.endTime !== null && audio.currentTime >= tone.endTime - 0.3) this.settleTone()
      // "Played out" on MSE/MMS: MediaSource.endOfStream() is never called
      // in this pipeline, so the element's own `ended` event never fires
      // for a real response. settleCompletedIfDrained() is what marks it
      // completed instead.
      this.settleCompletedIfDrained()
      this.publish()
    })
    audio.addEventListener('error', () => {
      console.error('[playback-engine] audio error:', audio.error)
    })
    return audio
  }

  /**
   * Arm the element's listeners, attach a media source to it, and play it
   * inside a user gesture through the device module — every later
   * programmatic play() then needs no gesture of its own.
   */
  unlock(): void {
    this.element()
    unlockDeviceElement()
    this.init()
  }

  /**
   * Return the engine to its pre-session state without giving up the
   * element: the media source is detached, fetches are aborted, held chunks
   * are dropped. The element itself carries the playback grant a user
   * gesture bought (see unlock()), so it stays and the next init() attaches
   * a fresh source to it.
   */
  reset(): void {
    this.cancel()

    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try { this.mediaSource.endOfStream() } catch { /* ignore */ }
    }

    if (this.audio) {
      this.audio.pause()
      if (STREAMING_BACKEND === 'mms') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(this.audio as any).srcObject = null
      } else {
        this.audio.src = ''
      }
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
    this.run = null
    this.mountedRun = null
    this.mountedOutcome = null
    // Bumped rather than zeroed: a drain parked on reader.read() carries the
    // generation it started with, and resetting the counter would let it
    // match again and append into the rebuilt pipeline.
    this.generation++
    this.dropHeldChunks()
    this.publish()
  }

  /**
   * reset(), plus the load() that makes the element stop being a playback
   * target. Clearing src/srcObject alone leaves WebKit holding the element as
   * live media, which puts a Now Playing control on the iOS lock screen for a
   * voice session that has ended; load() abandons the source for real.
   *
   * Separate from reset() because tones play on this element after the
   * pipeline stops: release() is for the end of the last sound, reset() for a
   * session that may still make noise. The element survives either way — it
   * carries the gesture grant (see unlock()).
   */
  release(): void {
    this.reset()
    const audio = this.audio
    if (!audio) return
    try {
      // Not implemented in jsdom; real browsers need it.
      audio.load()
    } catch { /* jsdom: HTMLMediaElement.load() not implemented */ }
  }

  // ── Per-run (called by AgentVoice) ───────────────────────────────────────

  /** Start of a new assistant turn — cancels any prior playback, and
   * reconciles at the end against the snapshot that gated the enqueue: the
   * turn manager's own agent turn may already be superseded or preempted by
   * the moment this run's first chunk would otherwise play. */
  beginRun(runId: string): void {
    this.cancel()
    this.run = runId
    this.publish()
    this.reconcile(useTurnManagerStore.getState().snapshot)
  }

  /** End of an assistant turn — let the audio drain naturally. supply.run
   * clears here, ahead of the utterance's own ended report, which is what
   * lets settleAgentTurn's closing rule read the player's own run as no
   * longer set while the utterance may still be live. If the element had
   * already starved before this call — nothing buffered, nothing pending,
   * no further `waiting` event coming to notice — this is the last chance
   * to settle `completed`; without it the utterance reports `audible`
   * forever, since nothing else will ever check again. */
  endRun(): void {
    this.run = null
    this.settleCompletedIfDrained()
    this.publish()
  }

  /**
   * Marks the mounted run's utterance `completed` when nothing is playing,
   * nothing is coming, and nothing remains buffered — the "played out"
   * condition MediaSource.endOfStream() would signal if this pipeline ever
   * called it. Read from four places: the `waiting` handler (the ordinary
   * path, the element itself telling us it ran dry), `endRun()` (the
   * element may have starved silently before the run ended, with no further
   * `waiting` event to notice), `dispatchSpeak`'s own `finally` (the last
   * fetched chunk has been appended or queued and this stream's own count
   * has dropped, which on a fast connection can be true before the element
   * has even started buffering it, let alone starved), and, on blob,
   * `playNext()`'s empty-queue branch (blob's own equivalent of "nothing
   * left, nothing coming").
   *
   * `remainingSeconds === 0` is what tells a genuinely starved element from
   * one merely paused mid-buffer — speech mute or a human interruption both
   * pause the element with audio still ahead of the playhead, and neither
   * is "played out."
   *
   * `this.appending`/`this.sourceBuffer?.updating` guard against a window
   * `remainingSeconds` alone cannot see: `processNextChunk` shifts a chunk
   * out of `pendingChunks` and calls `appendBuffer()` before that append's
   * own `updateend` fires, and `buffered` — what `remainingSeconds` reads —
   * does not grow until `updateend` runs. Between the shift and the
   * `updateend`, `pendingChunks` is already empty and every other condition
   * here reads drained, even though the last chunk's audio has not yet
   * reached the element. Marking `completed` in that window, and
   * reconcile's own pause following it, cuts audio that has not played.
   * `this.playing`/`this.playQueue.length` are blob's analogue of the same
   * fact — blob has no `appendBuffer`/`updateend` pair, but a queue slot
   * still current, or one queued behind it, is the same "not actually
   * drained yet" state.
   */
  private settleCompletedIfDrained(): void {
    if (this.tone) return
    if (this.run !== null || this.pendingChunks.length > 0 || this.activeStreams > 0) return
    if (this.appending || this.sourceBuffer?.updating) return
    if (STREAMING_BACKEND === 'blob' && (this.playing || this.playQueue.length > 0)) return
    if (this.mountedRun === null || this.mountedOutcome !== null) return
    if (this.remainingSeconds > 0) return
    this.mountedOutcome = 'completed'
  }

  // ── Held chunks ─────────────────────────────────────────────────────────

  private releaseHeldChunks(): void {
    const held = this.heldChunks
    this.heldChunks = []
    for (const h of held) {
      this.dispatchSpeak(h.req).then(h.resolve, h.reject)
    }
  }

  private dropHeldChunks(): void {
    const held = this.heldChunks
    this.heldChunks = []
    for (const h of held) h.resolve()
  }

  // ── Enqueue (called by AgentVoice/SpeechChunker per chunk) ───────────────

  /**
   * Enqueue a TTS chunk. `newAudio` at enqueue time decides its fate:
   * discarded outright on `discard`, parked on `park` until a later
   * reconcile finds `play`, dispatched at once on `play`.
   */
  enqueueChat(req: SpeakRequest): Promise<void> {
    const newAudio = useTurnManagerStore.getState().snapshot.newAudio
    if (newAudio === 'discard') return Promise.resolve()
    if (newAudio === 'park') {
      return new Promise<void>((resolve, reject) => {
        this.heldChunks.push({ req, resolve, reject })
        this.publish()
      })
    }
    // The snapshot can say `play` before reconcile() has released what was
    // parked under `park`. Those chunks came first and go first.
    if (this.heldChunks.length > 0) this.releaseHeldChunks()
    return this.dispatchSpeak(req)
  }

  /**
   * Play a tone on the speech element, in sequence with whatever is
   * buffered. Refused while a run is active, so a tone never overlays
   * speech. Resolves when the tone has been heard, or when a cancel, a
   * reset, or a timeout ends it early; never rejects.
   */
  enqueueTone(bytes: Uint8Array, durationS: number): Promise<void> {
    if (this.run !== null || this.activeStreams > 0) return Promise.resolve()
    this.init()
    this.settleTone()
    // The tone's end is where the timeline stands now plus its length. Not
    // read back from the buffered range after the append: Safari reports
    // that range late, and an end read from it lands on the playhead, so
    // the tone counts as heard the moment it starts.
    const audio = this.audio
    const buf = audio?.buffered
    const timelineEnd = Math.max(audio?.currentTime ?? 0, buf && buf.length > 0 ? buf.end(buf.length - 1) : 0)
    const done = new Promise<void>((resolve) => {
      this.tone = {
        resolve,
        endTime: STREAMING_BACKEND === 'blob' ? null : timelineEnd + durationS,
        started: false,
        timer: setTimeout(() => this.settleTone(), TONE_TIMEOUT_MS),
      }
    })
    if (STREAMING_BACKEND === 'blob') {
      this.enqueueBlob(Promise.resolve(URL.createObjectURL(new Blob([bytes as BlobPart], { type: TONE_MIME }))), true)
      return done
    }
    this.pendingChunks.push({ bytes, mime: TONE_MIME })
    this.processNextChunk()
    return done
  }

  private settleTone(): void {
    const tone = this.tone
    if (!tone) return
    this.tone = null
    clearTimeout(tone.timer)
    tone.resolve()
  }

  /** The element reached the end of its media; on blob that is the cue to
   * start the next queued chunk. */
  private onAudioEnded(): void {
    this.settleTone()
    if (STREAMING_BACKEND === 'blob') {
      this.playNext()
    }
    this.publish()
  }

  // ── Reconciliation ───────────────────────────────────────────────────────

  /**
   * Reads the floor's snapshot and closes the gap: plays or pauses to match
   * `mayBeAudible`, releases or drops held chunks to match `newAudio`, and
   * cancels mounted/held audio when the agent turn the snapshot names is
   * superseded, preempted, or was cancelled as the previous turn. Runs on
   * every snapshot change (the constructor's subscription) and again after
   * every append and at the end of beginRun.
   *
   * Idempotent: a repeat call with the same snapshot changes nothing, since
   * every branch is guarded on there being a gap left to close.
   */
  reconcile(snapshot: Snapshot): void {
    const supersededOrPreempted =
      snapshot.agent !== null && (snapshot.agent.outcome === 'superseded' || snapshot.agent.outcome === 'preempted')
    const previousCancelled =
      snapshot.previous.agent !== null
      && snapshot.previous.agent.outcome === 'cancelled'
      && this.mountedRun === snapshot.previous.agent.id

    if (supersededOrPreempted || previousCancelled) {
      // Guarded on facts cancel() actually clears — appendedToSource,
      // pendingChunks, heldChunks — never on mountedRun, which cancel()
      // must NOT clear (currentUtterance() needs it to keep reporting the
      // ended level for the run cancel() just cut). A guard reading
      // mountedRun cannot disarm: every cancel() leaves it exactly as it
      // was, so a superseded/preempted/previous-cancelled snapshot would
      // re-trigger cancel() on every subsequent notification, including
      // the one cancel()'s own publish() produces, forever. This guard is
      // what stops that: once cancel() has run, the audio it clears is gone,
      // so a repeat notification against the same superseded state finds
      // nothing left to cancel and the branch falls through to a no-op.
      // `speechMounted` rather than `appendedToSource`, so blob's mounted
      // audio is cancelled too — it is the same predicate the supply
      // reports, and the two must not disagree about what is mounted.
      if (!this.cancelling && (this.speechMounted || this.pendingChunks.length > 0 || this.heldChunks.length > 0)) {
        this.cancel()
      }
      // cancel() calls publish(), which re-enters this method with a
      // fresher snapshot before this call returns — the snapshot argument
      // held here is stale from this point on. this.cancelling (checked
      // above) and cancel()'s own reentrancy guard both cover that nested
      // call; the field-clearing guard above would already disarm it on
      // its own, since cancel() clears appendedToSource/pendingChunks/
      // heldChunks before its own publish() runs — this.cancelling is a
      // second, explicit line against the same case.
      return
    }

    if (snapshot.newAudio === 'play' && this.heldChunks.length > 0) {
      this.releaseHeldChunks()
    } else if (snapshot.newAudio === 'discard' && this.heldChunks.length > 0) {
      this.dropHeldChunks()
    }

    // Tones play with no turn open, where mayBeAudible is false by
    // construction — leave the element alone while this engine holds a
    // tone, whatever mayBeAudible says, or every tone would be cut as it
    // began. Sharing the element between tones and speech is the player's
    // concern; the floor never hears of it. A tone's own bytes on a paused
    // element are the one thing that starts it here: voice-off resets the
    // engine, which pauses the element, before the ended tone is appended.
    // On blob, only when the mounted slot is actually the tone's own —
    // `this.playing` alone would also be true once the queue has advanced
    // past the tone onto a speech chunk, and resuming from here would play
    // that chunk instead of the tone.
    if (this.tone) {
      const toneSlotCurrent = STREAMING_BACKEND !== 'blob' || this.currentSlotIsTone
      if (this.audio?.paused && toneSlotCurrent) this.play()
      return
    }

    if (snapshot.mayBeAudible) {
      // speechMounted, not elementBusy: a paused utterance has speech
      // mounted but reads !elementBusy by construction (busy means
      // unpaused), so resuming has to ask "is there something to resume,"
      // never "is it already playing" — the same condition that would tell
      // it not to bother.
      if (this.audio?.paused && this.speechMounted) {
        this.play()
      }
    } else if (this.elementBusy) {
      this.pauseElement()
    }
  }

  private play(): void {
    if (STREAMING_BACKEND === 'blob') {
      // this.playing tracks whether a queue slot is the current one, not
      // whether the element itself is running — a slot can be current and
      // paused (pauseElement() only pauses the element). Resume the
      // element directly when a slot is already current; only start the
      // next slot when none is.
      if (this.playing) {
        this.audio?.play().catch(() => { /* ignore */ })
      } else {
        this.playNext()
      }
      return
    }
    this.audio?.play().catch(() => { /* ignore */ })
  }

  private pauseElement(): void {
    if (!this.audio) return
    this.audio.pause()
    this.publish()
  }

  /**
   * Hard cancel — abort fetches, drain in-flight body-readers, rebuild
   * pipeline. Reports the mounted utterance `cut` when something was
   * mounted for the run being cancelled.
   */
  cancel(): void {
    if (this.cancelling) return
    this.cancelling = true
    try {
      this.cancelInner()
    } finally {
      this.cancelling = false
    }
  }

  private cancelInner(): void {
    // Bump generation so in-flight speaks see invalid gen and bail
    this.generation++

    // Abort in-flight fetches (errors any active readers)
    for (const abort of this.abortControllers) abort.abort()
    this.abortControllers = []

    // Release semaphore waiters
    this.inFlight = 0
    const waiters = this.concurrencyWaiters.splice(0)
    for (const w of waiters) w(false)

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

    // Read before the queue reset below clears the very flags this asks
    // about — speechMounted (not elementBusy) so a paused-but-mounted blob
    // utterance is still recorded cut, matching supply.mounted's own
    // definition of "is there audio to act on."
    const wasMounted = this.speechMounted
    const cutRun = this.mountedRun

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
    this.appendedToSource = false
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
    this.settleTone()
    this.run = null
    if (wasMounted && cutRun !== null && this.mountedOutcome === null) {
      this.mountedOutcome = 'cut'
    }
    this.publish()
  }

  // ── The report ────────────────────────────────────────────────────────

  /**
   * Reads the element, the source buffer and the queues, and nothing else,
   * synchronously — no await sits between an observation this reads and the
   * report it sends. Called from every element event handler and after
   * every queue change.
   */
  private publish(): void {
    const utterance = this.currentUtterance()
    report({ actor: 'agent', utterance, supply: this.supply })
  }

  /** The agent's utterance as this engine currently sees it: null before
   * anything is mounted for a run, else `audible`/`paused` while live, or
   * the level `ended` report for whichever run's audio is (or was) last
   * mounted — held steady by `mountedOutcome` since cancel()/beginRun()
   * clear `appendedToSource` before the next run's own first chunk
   * replaces it. */
  private currentUtterance(): Utterance<'agent'> | null {
    if (this.mountedRun === null) return null
    if (this.mountedOutcome !== null) {
      return { speaker: 'agent', id: this.mountedRun, phase: 'ended', outcome: this.mountedOutcome }
    }
    return {
      speaker: 'agent',
      id: this.mountedRun,
      phase: this.elementBusy ? 'audible' : 'paused',
    }
  }

  // ── Internal: dispatch one speak() ──────────────────────────────────────

  private async dispatchSpeak(req: SpeakRequest): Promise<void> {
    if (!this.audio) {
      throw new Error('PlaybackEngine.init() must be called before enqueueChat()')
    }
    const gen = this.generation

    // The stream's place in the play order is taken now, in enqueue order,
    // before anything awaits. Taken when the fetch answered instead, a later
    // chunk whose response came back first would play first. Every exit
    // below hands the place a reader or null, or the chain behind it stalls.
    let handOver: (reader: ReadableStreamDefaultReader<Uint8Array> | null) => void = () => {}
    let turn: Promise<void> = Promise.resolve()
    if (STREAMING_BACKEND !== 'blob') {
      const handed = new Promise<ReadableStreamDefaultReader<Uint8Array> | null>(r => { handOver = r })
      turn = this.streamingChain.then(async () => {
        const reader = await handed
        if (reader) await this.drainStream(reader, gen, FORMAT_MIME[req.format])
      })
      this.streamingChain = turn
    }

    if (!(await this.acquireSlot())) {
      // A cancel woke this speak while it waited: its run is gone.
      handOver(null)
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
      ...req.params,
      // After the params: the bytes are decoded as the runtime's format, so
      // nothing may ask for another.
      response_format: req.format,
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
      handOver(null)
      release()
      throw err
    }

    if (!res.ok) {
      resolveSlot(null)
      handOver(null)
      release()
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
      handOver(null)
      release()
      return
    }

    this.activeStreams++
    handOver(reader)
    try {
      await turn
    } finally {
      if (this.activeStreams > 0) this.activeStreams--
      // The last fetched chunk is appended (or queued) and this stream's
      // own count has dropped — if nothing else is still fetching or
      // buffered, the run may already be played out here, before the
      // element has fired another `waiting` event to notice on its own.
      this.settleCompletedIfDrained()
      release()
    }
  }

  private async drainStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    gen: number,
    mime: string,
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

        this.pendingChunks.push({ bytes: value, mime })
        this.processNextChunk()
      }
    } catch {
      // aborted / errored — nothing to do
    } finally {
      this.publish()
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
      this.sourceMime = this.pendingChunks[0]?.mime ?? TONE_MIME
      const sb = ms.addSourceBuffer(this.sourceMime)
      this.sourceBuffer = sb
      sb.addEventListener('updateend', () => this.onAppendComplete())
      this.processNextChunk()
    } catch (e) {
      console.error('[playback-engine] failed to add SourceBuffer:', e)
    }
  }

  private onAppendComplete(): void {
    this.appending = false
    if (this.audio?.paused) {
      // Whether this should now play is reconcile()'s question, from the
      // same snapshot that gated the enqueue — not decided here.
      this.reconcile(useTurnManagerStore.getState().snapshot)
    }
    this.publish()
    this.processNextChunk()
  }

  private processNextChunk(): void {
    if (this.appending || !this.sourceBuffer || this.sourceBuffer.updating) return
    const chunk = this.pendingChunks.shift()
    if (!chunk) return
    this.appending = true
    try {
      // One SourceBuffer serves the session, and tones are mp3 whichever
      // runtime speaks, so a chunk of another type switches it first.
      if (chunk.mime !== this.sourceMime) {
        this.sourceBuffer.changeType(chunk.mime)
        this.sourceMime = chunk.mime
      }
      this.sourceBuffer.appendBuffer(chunk.bytes as Uint8Array<ArrayBuffer>)
      // Not set for a tone's own bytes: tones never overlap speech, so every
      // pending chunk while one is in flight belongs to it, and marking the
      // source mounted for a tone would read as speech to elementBusy.
      if (!this.tone) {
        this.appendedToSource = true
        if (this.run !== null && this.mountedRun !== this.run) {
          this.mountedRun = this.run
          this.mountedOutcome = null
        }
      }
    } catch (e) {
      console.error('[playback-engine] appendBuffer error:', e)
      this.appending = false
      this.processNextChunk()
    }
  }

  // ── Blob fallback ───────────────────────────────────────────────────────

  private playQueue: { slot: Promise<string | null>; isTone: boolean }[] = []
  private playing = false
  /** Whether the slot currently mounted on the element (the one `playing`
   * refers to) is the tone's, not a speech chunk's — distinct from
   * `this.tone`, which is set for the whole span a tone is on the timeline
   * and outlives its own slot being current once the queue advances past
   * it. Reconcile's tone branch reads this, never `playing` alone: `playing`
   * only says *some* slot is current, and resuming the element for a
   * speech slot from the tone branch would play the wrong audio. */
  private currentSlotIsTone = false

  private enqueueBlob(slot: Promise<string | null>, isTone = false): void {
    this.playQueue.push({ slot, isTone })
    if (!this.playing) this.playNext()
  }

  private async playNext(): Promise<void> {
    if (!this.audio) return
    const next = this.playQueue.shift()
    if (!next) {
      this.playing = false
      this.currentSlotIsTone = false
      // Nothing left in the queue and nothing else coming — blob's own
      // "drained" moment, checked before the same publish() that reports it.
      this.settleCompletedIfDrained()
      this.publish()
      return
    }
    this.playing = true
    this.currentSlotIsTone = next.isTone
    if (this.run !== null && this.mountedRun !== this.run) {
      this.mountedRun = this.run
      this.mountedOutcome = null
    }
    const blobUrl = await next.slot
    if (!blobUrl || !this.audio) {
      this.playNext()
      return
    }
    this.audio.src = blobUrl
    this.audio.play().catch(err => console.error('[playback-engine] play() rejected:', err))
    this.publish()
  }

  // ── Concurrency semaphore ───────────────────────────────────────────────

  /**
   * First come, first served. A freed slot passes straight to the oldest
   * waiter rather than back to the pool, so a speak arriving in the gap
   * before that waiter resumes cannot take it: slots are granted in the
   * order speaks were enqueued. Resolves false when a cancel woke the waiter
   * instead, and the speak it belongs to is dropped.
   */
  private async acquireSlot(): Promise<boolean> {
    if (this.maxConcurrency === undefined) return true
    if (this.inFlight < this.maxConcurrency && this.concurrencyWaiters.length === 0) {
      this.inFlight++
      return true
    }
    return new Promise<boolean>(resolve => { this.concurrencyWaiters.push(resolve) })
  }

  private releaseSlot(): void {
    if (this.maxConcurrency === undefined) return
    const next = this.concurrencyWaiters.shift()
    if (next) next(true)
    else this.inFlight = Math.max(0, this.inFlight - 1)
  }
}
