// Serialize all transcription requests — Parakeet does not handle concurrent requests gracefully
let queue: Promise<unknown> = Promise.resolve()

let saveMicSamples = false

/** Toggle debug mic-sample saving. The dashboard updates this when voice config loads/changes. */
export function setSaveMicSamples(enabled: boolean): void {
  saveMicSamples = enabled
}

export async function transcribeAudio(endpoint: string, wavBuffer: ArrayBuffer): Promise<string> {
  if (saveMicSamples) {
    // Fire-and-forget tee — never block STT, never throw
    fetch('/api/debug/mic-sample', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavBuffer,
    }).catch(() => {})
  }
  const result = queue.then(() => _transcribe(endpoint, wavBuffer))
  // Swallow errors in the chain so a failed request doesn't block subsequent ones
  queue = result.catch(() => {})
  return result
}

async function _transcribe(endpoint: string, wavBuffer: ArrayBuffer): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav')

  const url = `${endpoint}/audio/transcriptions`

  let res: Response
  try {
    res = await fetch(url, { method: 'POST', body: form })
  } catch (err) {
    // A rejected fetch carries no status and no reason. The browser withholds
    // both deliberately for a blocked cross-origin request, so a service that
    // is up and answers curl perfectly fails here indistinguishably from one
    // that is down. Name what we do know instead of guessing at the cause.
    const detail = err instanceof Error ? err.message : String(err)
    const sameOrigin = url.startsWith(window.location.origin)
    const hint = sameOrigin
      ? 'The service may be down or unreachable.'
      : `This page is ${window.location.origin}; check that origin is in the service's CORS allowlist.`
    throw new Error(`STT request to ${url} was rejected by the browser (${detail}). ${hint}`)
  }

  if (!res.ok) {
    // Include the body — model servers put the actual complaint there, and the
    // status alone rarely says which of several things went wrong.
    const body = await res.text().catch(() => '')
    const suffix = body ? ` — ${body.slice(0, 300)}` : ''
    throw new Error(`STT request failed: ${res.status} ${res.statusText}${suffix}`)
  }

  const data = await res.json() as { text: string }
  return data.text ?? ''
}
