/**
 * The batch transport: post the whole utterance at commit, as the loop has
 * always done.
 *
 * Nothing leaves the device until a turn ends, which is why three of the four
 * methods do nothing. Discarding is free here — the audio never left — and
 * that asymmetry with streaming is the reason `discard` exists on the
 * interface at all rather than being a caller-side `if`.
 */

import { encodeWav } from './wav-encoder'
import { transcribeAudio } from './stt-client'
import { ensureServiceReady } from '../voice-service'
import type { SttTransport } from './stt-transport'

export interface BatchTransportOptions {
  endpoint: string
  /** Restarts a stopped service and retries once. Without it, a failure is final. */
  serviceId?: string
  /** So the session can keep using an endpoint a restart moved. */
  onEndpointChange?: (endpoint: string) => void
}

export class BatchSttTransport implements SttTransport {
  private endpoint: string
  private serviceId?: string
  private onEndpointChange?: (endpoint: string) => void

  constructor(opts: BatchTransportOptions) {
    this.endpoint = opts.endpoint
    this.serviceId = opts.serviceId
    this.onEndpointChange = opts.onEndpointChange
  }

  /** Audio is read from the recorder at commit, so frames need nothing here. */
  onFrame(_chunk: Float32Array): void {}

  async commit(audio: Float32Array): Promise<string> {
    return this.transcribeWithRestart(encodeWav(audio, 16000))
  }

  /** Free: the audio never left the device, so there is nothing to clear. */
  async discard(): Promise<void> {}

  /** Mute stops the loop analysing; nothing is in flight to gate. */
  setSending(_sending: boolean): void {}

  close(): void {}

  /**
   * A demand-loaded service can idle out between utterances. The first failure
   * is often that rather than a broken service, so ask the control plane to
   * bring it back and try once more.
   */
  private async transcribeWithRestart(wav: ArrayBuffer): Promise<string> {
    try {
      return await transcribeAudio(this.endpoint, wav)
    } catch (first) {
      const previousEndpoint = this.endpoint
      if (!this.serviceId) throw new Error('No STT service configured')
      const newEndpoint = await ensureServiceReady(this.serviceId)
      this.endpoint = newEndpoint
      this.onEndpointChange?.(newEndpoint)
      try {
        return await transcribeAudio(newEndpoint, wav)
      } catch (second) {
        // The retry usually fails for the same reason as the first attempt, and
        // reporting only the second hides that the endpoint changed in between.
        const a = first instanceof Error ? first.message : String(first)
        const b = second instanceof Error ? second.message : String(second)
        throw new Error(a === b ? a : `${b} (first attempt on ${previousEndpoint}: ${a})`)
      }
    }
  }
}
