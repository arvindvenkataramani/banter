/**
 * Client for fluidserver's streaming transcription socket.
 *
 * One connection carries a conversation, not an utterance: `Finalize` returns
 * the settled transcript and leaves the socket open for the next turn. Only
 * `CloseStream` ends it.
 *
 * A socket dies once and is not reopened. Reconnecting means building another,
 * which is the voice loop's work, not this class's.
 *
 * Protocol: services/fluid/STT.md.
 */

/** Proof the client is alive while it sends no audio. The server keeps a quiet session regardless, reclaiming only after thirty minutes of nothing, so this is well inside it. */
const KEEPALIVE_INTERVAL_MS = 4000

/**
 * Close codes 4001–4010 map onto the protocol's error codes (services/fluid/
 * STT.md). A close in this range with no preceding error frame — `replaced`
 * closes with no error frame at all — is mapped here so the caller still
 * gets the code.
 */
const CLOSE_CODES: Record<number, string> = {
  4001: 'held',
  4002: 'superseded',
  4003: 'idle',
  4004: 'model_not_loaded',
  4005: 'model_mismatch',
  4006: 'busy',
  4007: 'bad_format',
  4008: 'bad_audio',
  4009: 'failed',
  4010: 'replaced',
}

/**
 * Frames to hold while the socket opens. A couple of seconds at 4096 samples
 * per frame — enough for a connection on a slow network, bounded so a socket
 * that never opens cannot grow this without limit.
 */
const PRE_OPEN_FRAME_LIMIT = 24

export interface SttSocketCallbacks {
  /** A transcript that may still change. Carries the whole transcript so far. */
  onPartial: (text: string) => void
  /**
   * The settled transcript for one turn, with the milliseconds waited since
   * `Finalize` was sent — null if no `Finalize` was outstanding for it.
   *
   * Text only. The server's final also carries `words`, which is not read:
   * the batch path returns text alone, and nothing downstream of either
   * transport consumes word timings.
   */
  onFinal: (text: string, finalizeWaitMs: number | null) => void
  /** The socket is open and the server accepted the session. */
  onReady: (model: string, format: string) => void
  /**
   * The session is over: a close, an error frame, or a failure to connect.
   * Fires exactly once per socket. `code` is the protocol error code
   * (services/fluid/STT.md) when the server named one, either on an error
   * frame or as a close in the 4001–4010 range; null otherwise.
   */
  onClosed: (reason: string, code: string | null) => void
}

export type AudioFormat = 'opus' | 'pcm16'

export interface SttSocketOptions {
  /** Service endpoint, e.g. https://host:8767. */
  endpoint: string
  /** Asserts which model the caller believes is loaded; never selects one. */
  model: string
  format: AudioFormat
  /** This connection's session id. Sent only when the STT service declares
   *  `sessions: true` — omitted, it has an identity of its own. */
  session?: string
  /** Take the slot from whoever holds it. Only meaningful alongside `session`. */
  takeover?: boolean
}

function toWebSocketUrl(endpoint: string): string {
  return endpoint.replace(/^http/, 'ws')
}

export class SttSocket {
  private ws: WebSocket | null = null
  private cb: SttSocketCallbacks
  private keepAlive: ReturnType<typeof setInterval> | null = null
  private closed = false
  /** Set while mute holds transmission, so audio is dropped but KeepAlive is not. */
  private sending = true
  /**
   * One entry per `Finalize` still awaiting its final, oldest first. The
   * server processes requests serially and answers each with exactly one
   * final covering the audio since the previous one, so the oldest entry
   * here is always the next final's answer — nothing client-side needs to
   * correlate a request with its answer beyond queue order. `sentAt` is
   * what lets the wait for the settled transcript be measured: the number
   * that distinguishes streaming from batch, since a batch model
   * reprocesses the whole utterance at commit and its cost grows with
   * length, where a streaming model has only the tail left.
   */
  private finalizeQueue: Array<{ sentAt: number }> = []
  /** Frames captured before the socket opened, sent once it does. */
  private preOpen: ArrayBuffer[] = []

  constructor(cb: SttSocketCallbacks) {
    this.cb = cb
  }

  connect(opts: SttSocketOptions): void {
    let url = `${toWebSocketUrl(opts.endpoint)}/v1/audio/stream`
      + `?model=${encodeURIComponent(opts.model)}&format=${opts.format}`
    if (opts.session !== undefined) url += `&session=${encodeURIComponent(opts.session)}`
    if (opts.takeover) url += `&takeover=1`

    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onmessage = (e) => this.handleMessage(e)

    // A close and an error both end the session, and a failed connection
    // fires both. `closed` makes the report happen once.
    ws.onerror = () => this.finish('The connection to the transcription service failed.')
    ws.onclose = (e) => this.finish(
      e.reason ? `The connection closed: ${e.reason}` : 'The connection closed.',
      CLOSE_CODES[e.code] ?? null,
    )

    ws.onopen = () => {
      this.keepAlive = setInterval(() => this.sendKeepAlive(), KEEPALIVE_INTERVAL_MS)
      this.flushPreOpen()
    }
  }

  private handleMessage(e: MessageEvent): void {
    let msg: { type?: string; is_final?: boolean; text?: string; model?: string; format?: string; message?: string; code?: string }
    try {
      msg = JSON.parse(String(e.data))
    } catch {
      return
    }

    if (msg.type === 'transcript') {
      if (msg.is_final) {
        const oldest = this.finalizeQueue.shift()
        const sentAt = oldest?.sentAt ?? null
        this.cb.onFinal(msg.text ?? '', sentAt === null ? null : Math.round(performance.now() - sentAt))
      } else {
        this.cb.onPartial(msg.text ?? '')
      }
      return
    }
    if (msg.type === 'ready') {
      this.cb.onReady(msg.model ?? '', msg.format ?? '')
      return
    }
    if (msg.type === 'error') {
      // The server closes after an error frame, but reporting here names the
      // actual cause rather than the bare close that follows it. finish()
      // marks the socket closed, so the close that follows never re-reports.
      this.finish(
        msg.message ?? 'The transcription service reported an error.',
        msg.code ?? null,
      )
    }
  }

  /** True once the socket is open and has not closed. */
  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !this.closed
  }

  /**
   * Send one encoded audio frame. Dropped while muted — a muted room that
   * kept streaming would defeat the mute, sending audio nobody wants
   * transcribed.
   */
  sendAudio(frame: ArrayBuffer): void {
    if (!this.sending || this.closed) return
    if (!this.isOpen) {
      // Held, not dropped. Capture begins before the socket finishes opening,
      // so discarding here loses the first second or so of the first turn —
      // which arrives as a turn with no partials and an empty transcript,
      // looking like the model failed rather than like audio never left.
      if (this.preOpen.length < PRE_OPEN_FRAME_LIMIT) this.preOpen.push(frame)
      return
    }
    this.ws?.send(frame)
  }

  /** Send whatever was captured before the socket finished opening. */
  private flushPreOpen(): void {
    const held = this.preOpen
    this.preOpen = []
    for (const frame of held) {
      if (!this.isOpen) return
      this.ws?.send(frame)
    }
  }

  /** Stop and resume transmission. KeepAlive continues either way. */
  setSending(sending: boolean): void {
    this.sending = sending
  }

  /**
   * End of one utterance. The final transcript follows; the socket stays
   * open. Callable any number of times with earlier calls still
   * outstanding — each queues its own slot, answered in the order the
   * finals arrive, which is the order the server processes requests in.
   */
  finalize(): void {
    if (!this.isOpen) return
    this.finalizeQueue.push({ sentAt: performance.now() })
    this.ws?.send(JSON.stringify({ type: 'Finalize' }))
  }

  private sendKeepAlive(): void {
    if (!this.isOpen) return
    this.ws?.send(JSON.stringify({ type: 'KeepAlive' }))
  }

  /**
   * End the session at once. `CloseStream` lets the server end it as a client
   * close rather than a dropped socket; the final it sends back is discarded,
   * since the socket detaches before it can arrive. Nothing would read it:
   * `StreamingSttTransport.close()` has already rejected every outstanding
   * request by the time it calls this.
   */
  close(): void {
    if (this.isOpen) this.ws?.send(JSON.stringify({ type: 'CloseStream' }))
    this.teardown()
  }

  private finish(reason: string, code: string | null = null): void {
    if (this.closed) return
    this.teardown()
    this.cb.onClosed(reason, code)
  }

  private teardown(): void {
    this.closed = true
    this.preOpen = []
    this.finalizeQueue = []
    if (this.keepAlive !== null) {
      clearInterval(this.keepAlive)
      this.keepAlive = null
    }
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      // Detached from its handlers first: closing here must not re-enter
      // finish() through onclose.
      ws.onclose = null
      ws.onerror = null
      ws.onmessage = null
      ws.close()
    }
  }
}
