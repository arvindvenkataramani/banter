import { adapterFor } from '@platform/shared/apis'
import type { Provision } from '@platform/shared/apis/types'

// Serialize all transcription requests — Parakeet does not handle concurrent requests gracefully
let queue: Promise<unknown> = Promise.resolve()

let saveMicSamples = false

/** Toggle debug mic-sample saving. The dashboard updates this when voice config loads/changes. */
export function setSaveMicSamples(enabled: boolean): void {
  saveMicSamples = enabled
}

export async function transcribeAudio(endpoint: string, provision: Provision, wavBuffer: ArrayBuffer, model?: string): Promise<string> {
  if (saveMicSamples) {
    // Fire-and-forget tee — never block STT, never throw
    fetch('/api/debug/mic-sample', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavBuffer,
    }).catch(() => {})
  }
  const result = queue.then(() => _transcribe(endpoint, provision, wavBuffer, model))
  // Swallow errors in the chain so a failed request doesn't block subsequent ones
  queue = result.catch(() => {})
  return result
}

async function _transcribe(endpoint: string, provision: Provision, wavBuffer: ArrayBuffer, model?: string): Promise<string> {
  try {
    return await adapterFor(provision.api)!.transcribe!({ endpoint, provision, audio: wavBuffer, model })
  } catch (err) {
    // A rejected fetch carries no status and no reason. The browser withholds
    // both deliberately for a blocked cross-origin request, so a service that
    // is up and answers curl perfectly fails here indistinguishably from one
    // that is down. Name what we do know instead of guessing at the cause.
    if (err instanceof TypeError) {
      const sameOrigin = endpoint.startsWith(window.location.origin)
      const hint = sameOrigin
        ? 'The service may be down or unreachable.'
        : `This page is ${window.location.origin}; check that origin is in the service's CORS allowlist.`
      throw new Error(`STT request to ${endpoint} was rejected by the browser (${err.message}). ${hint}`)
    }
    // The adapter's error carries the status and the server's own text.
    throw new Error(`STT request failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
