/**
 * The streaming transport: audio goes to an open socket as it is captured, and
 * commit asks for what the server already has.
 *
 * The socket carries a conversation rather than an utterance. It outlives every
 * turn on it, holds the server's one resident model while open, and dies
 * exactly once. Reconnecting builds a new transport; whoever built this one
 * owns that, not the loop.
 *
 * `Finalize` is the only thing that resets the server's context, which is why
 * `discard` is not free: audio the loop decides against has already been
 * consumed, and leaving it there puts it in the next turn's first partial.
 */

import { SttSocket, type AudioFormat } from './stt-socket'
import { createEncoder, canEncodeOpus, type FrameEncoder } from './stt-audio-encoder'
import type { SttTransport } from './stt-transport'

export interface StreamingTransportOptions {
  endpoint: string
  model: string
  format?: AudioFormat
  /** This connection's session id. Sent only when the STT service declares
   *  `sessions: true`. */
  session?: string
  /** Take the slot from whoever holds it. */
  takeover?: boolean
  /** The transcript as it currently stands. Carries the whole of it, not a delta. */
  onPartial: (text: string) => void
  /** The server accepted the session. */
  onReady?: () => void
  /** The socket ended; this is the only failure path. */
  onClosed: (reason: string, info: StreamingCloseInfo) => void
}

export interface StreamingCloseInfo {
  /** Requests still awaiting a final when the socket ended. Their words are lost. */
  dropped: number
  /** The protocol error code (docs/speech-server-api.md) when the server named
   *  one; null otherwise. */
  code: string | null
}

export class StreamingSttTransport implements SttTransport {
  private socket: SttSocket
  private encoder: FrameEncoder
  private closed = false
  /** Muted: the microphone's frames are not sent. */
  private muted = false
  /** Until when, while muted, silence is sent in their place. */
  private silenceUntil = 0
  private onClosed: StreamingTransportOptions['onClosed']
  /**
   * One entry per `commit()`/`discard()` call still waiting on the server,
   * oldest first. The server answers each `Finalize` in the order it
   * received them, so the oldest entry here is always the next final's
   * answer — several may be outstanding at once, each settled by its own
   * promise, with nothing here needing to know which utterance it belongs
   * to. `HumanVoice` knows, because it is the one holding each call's
   * promise.
   */
  private pending: Array<{ resolve: (text: string) => void; reject: (err: Error) => void }> = []

  constructor(opts: StreamingTransportOptions) {
    this.socket = new SttSocket({
      onPartial: opts.onPartial,
      onFinal: (text) => {
        const oldest = this.pending.shift()
        oldest?.resolve(text)
      },
      onReady: () => opts.onReady?.(),
      onClosed: (reason, code) => this.fail(reason, code),
    })
    this.onClosed = opts.onClosed

    const format = opts.format ?? (canEncodeOpus() ? 'opus' : 'pcm16')
    this.socket.connect({
      endpoint: opts.endpoint,
      model: opts.model,
      format,
      session: opts.session,
      takeover: opts.takeover,
    })
    this.encoder = createEncoder(
      format,
      (frame) => this.socket.sendAudio(frame),
      (err) => {
        // The socket is still open and still holds the session. Closed here,
        // so a replacement connection is not taken for another client.
        this.socket.close()
        this.fail(`Audio encoding failed: ${err.message}`, null)
      },
    )
  }

  /**
   * The transport's end, from either the socket or the encoder, reported once.
   *
   * A close while turns are in flight loses those transcripts: the audio was
   * all sent and the server had it. Every one is rejected rather than
   * resolved empty, so each caller reports a dropped utterance instead of an
   * empty one. Named so a caller can tell this apart from an ordinary
   * transcription failure: whoever handles `onClosed` says the connection
   * dropped, once, with the count — a caller banner per outstanding
   * utterance would say it again for no new reason.
   */
  private fail(reason: string, code: string | null): void {
    if (this.closed) return
    this.closed = true
    this.encoder.close()
    const err = new Error(reason)
    err.name = 'SttTransportClosed'
    const dropped = this.rejectAll(err)
    this.onClosed(reason, { dropped, code })
  }

  onFrame(chunk: Float32Array): void {
    if (this.closed) return
    if (this.muted) {
      // Silence in the microphone's place, at the microphone's own pace,
      // until the tail runs out; then nothing.
      if (performance.now() < this.silenceUntil) this.encoder.encode(new Float32Array(chunk.length))
      return
    }
    this.encoder.encode(chunk)
  }

  async commit(_audio: Float32Array): Promise<string> {
    // The audio is already on the server; only the request and the wait remain.
    return this.finalize()
  }

  async discard(): Promise<void> {
    // The transcript is thrown away; the reset it performs is the point. A
    // failure here is not worth surfacing — the turn was being discarded
    // anyway, and a broken socket reports itself through onClosed.
    await this.finalize().catch(() => '')
  }

  setSending(sending: boolean, silenceMs = 0): void {
    this.muted = !sending
    this.silenceUntil = sending ? 0 : performance.now() + silenceMs
  }

  /**
   * A deliberate close, as opposed to `onClosed` above (the socket's own,
   * server-initiated or connection-failure report). `SttSocket.close()`
   * tears itself down directly without routing back through `onClosed`, so
   * without this every request still outstanding at the moment of a
   * deliberate close would settle neither way — a caller awaiting `commit()`
   * would hang forever. Rejecting here is what makes "a close ends every
   * outstanding request" true regardless of which side initiated it.
   */
  close(): void {
    this.closed = true
    this.rejectAll(new Error('The connection to the transcription service is closed.'))
    this.encoder.close()
    this.socket.close()
  }

  private rejectAll(err: Error): number {
    const all = this.pending.splice(0)
    for (const p of all) p.reject(err)
    return all.length
  }

  /**
   * Ask the server to settle the turn. The audio is already there, so this
   * sends no samples — only the request and the wait. Callable with earlier
   * calls still outstanding: each gets its own queued slot, settled in the
   * order the server answers them.
   */
  private finalize(): Promise<string> {
    if (this.closed || !this.socket.isOpen) {
      return Promise.reject(new Error('The connection to the transcription service is closed.'))
    }
    return new Promise<string>((resolve, reject) => {
      this.pending.push({ resolve, reject })
      this.socket.finalize()
    })
  }
}
