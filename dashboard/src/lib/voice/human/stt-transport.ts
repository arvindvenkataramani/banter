/**
 * How a turn's audio becomes a transcript.
 *
 * Turn detection is transport-agnostic: nothing that decides when a turn ends
 * reads text. What differs between posting a WAV and streaming to a socket is
 * confined to four moments, and this is those four. `MicLoop` calls them and
 * never learns which implementation it holds — a conditional on transport
 * inside the loop is the design failing, because the difference is supposed to
 * be here.
 *
 * Design record: docs/design/voice-loop-streaming-stt.md.
 */

export interface SttTransport {
  /**
   * One captured frame, on capture's own schedule. Called for every chunk
   * regardless of what VAD is doing: the streaming encoders carry cache state
   * across frames, so a dropped frame is a hole in the audio the server
   * decodes, where VAD merely misses one verdict out of many.
   */
  onFrame(chunk: Float32Array): void

  /**
   * End of a turn whose transcript is wanted. Resolves with the settled text.
   * Rejects when transcription fails, which the caller reports and treats as a
   * dropped utterance.
   */
  commit(audio: Float32Array): Promise<string>

  /**
   * End of a turn whose transcript is not wanted — noise rejection, and
   * anything else that abandons an utterance.
   *
   * Not a no-op on every transport: a streaming server has already consumed
   * the audio, and `Finalize` is the only thing that clears its context, so
   * discarding there means finalizing and throwing the result away. Skipping
   * it leaves the rejected audio to surface in the next turn.
   */
  discard(): Promise<void>

  /**
   * Mute and unmute. Transport-level, not merely an analysis gate. On a mute,
   * `silenceMs` of silence stands in for the microphone before sending stops,
   * so a streaming model transcribes the words it already holds: it produces
   * text for buffered audio only as further audio arrives behind it.
   */
  setSending(sending: boolean, silenceMs?: number): void

  /** Release whatever the transport holds open. */
  close(): void
}
