import { getService, startService } from '@/lib/api'
import type { ServiceWithHealth } from '@/lib/api'

const POLL_INTERVAL_MS = 500

// How long the control plane may fail to answer before the wait gives up. This
// is not the deadline on how long a start may take — the lifecycle task owns
// that, derived from the service's declared startupTime, and a constant in the
// browser cannot know which service it is starting. This bounds something the
// server cannot bound on our behalf: how long we may go without being able to
// ask at all. A shard that stops answering mid-spawn is a transient the poll
// should ride out, not a failed start.
const UNREACHABLE_GRACE_MS = 45_000

// Demand-loaded services start in the background on the shard: POST start returns
// immediately while the real spawn runs as a submitted lifecycle task, so the
// wait on a reachable control plane is unbounded on purpose.
//
// Only an explicit true continues the loop: a value the client never receives
// has to end the wait rather than spin forever.
async function waitWhilePending(serviceId: string): Promise<ServiceWithHealth> {
  let unreachableSince: number | null = null

  for (;;) {
    let svc: ServiceWithHealth
    try {
      svc = await getService(serviceId)
      unreachableSince = null
    } catch (err) {
      // A read that fails says nothing about the start — keep asking, and fail
      // on the transport rather than blaming a service that may be coming up
      // perfectly well behind an unanswerable control plane.
      unreachableSince ??= Date.now()
      if (Date.now() - unreachableSince > UNREACHABLE_GRACE_MS) {
        const reason = err instanceof Error ? err.message : 'unknown error'
        throw new Error(`Lost contact while starting "${serviceId}": ${reason}`)
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
      continue
    }

    if (svc.pending !== true) return svc
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
}

export async function ensureServiceReady(serviceId: string): Promise<string> {
  // Ask before starting. A service that is already healthy needs no start, and
  // demanding one fails outright for runners the platform does not own — an
  // externally-managed model server is a legitimate thing to point at and use.
  let svc = await getService(serviceId)

  // An external runner is one the platform does not own, so a start would be
  // rejected however unhealthy it looks. Whatever is wrong there is not ours to
  // fix, and the endpoint below is still worth trying.
  if (svc.health !== 'healthy' && svc.runner?.type !== 'external') {
    const result = await startService(serviceId)
    if (!result.success) {
      throw new Error(result.error ?? `Service "${serviceId}" could not be started`)
    }

    // Wait for the operation to settle, then judge the state it left behind. The
    // two questions are asked in sequence because they are different questions:
    // whether anything is still outstanding, and whether the service is usable.
    svc = await waitWhilePending(serviceId)
    if (svc.health !== 'healthy') {
      const reason = svc.lastEvent?.data?.error
      throw new Error(
        typeof reason === 'string'
          ? `Service "${serviceId}" is not available: ${reason}`
          : `Service "${serviceId}" is not available`
      )
    }
  }

  if (!svc.network?.endpoint) {
    throw new Error(`Service "${serviceId}" has no endpoint`)
  }
  return svc.network.endpoint
}

export async function ensureTtsReady(serviceId: string): Promise<string> {
  return ensureServiceReady(serviceId)
}

export async function loadTtsModel(endpoint: string, modelName: string): Promise<void> {
  const res = await fetch(`${endpoint}/v1/models?model_name=${encodeURIComponent(modelName)}`, {
    method: 'POST',
  })
  if (!res.ok) {
    throw new Error(`Failed to load model "${modelName}": ${res.status}`)
  }
}

/** What a model is, as its server reports it. */
export type SttModelKind = 'batch' | 'streaming' | 'both'

/**
 * Load an STT model. The server starts holding nothing and never loads as a
 * side effect of transcribing, so this has to happen before the first
 * utterance; a transcription naming an unloaded model is refused.
 *
 * `mode` names which way a model capable of both should be brought up. A model
 * that does one thing needs none, and one capable of both is refused without
 * it — the refusal being the point, since the alternative is discovering the
 * wrong choice as unexplained latency rather than as an error. What the server
 * then makes resident is its own decision: asking for batch does not pay for
 * the streaming encoder.
 */
export async function loadSttModel(
  endpoint: string,
  model: string,
  mode?: Exclude<SttModelKind, 'both'>,
  chunkMs?: number,
): Promise<void> {
  const res = await fetch(`${endpoint}/v1/models/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      ...(mode ? { mode } : {}),
      // A latency tier is a parameter, not a separate model — the roster
      // stopped baking it into the id.
      ...(typeof chunkMs === 'number' ? { chunkMs } : {}),
    }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    const reason = detail && typeof detail.error === 'string' ? `: ${detail.error}` : ''
    throw new Error(`Failed to load STT model "${model}" (${res.status})${reason}`)
  }
}

export async function unloadTtsModel(endpoint: string, modelName: string): Promise<void> {
  try {
    const res = await fetch(`${endpoint}/v1/models?model_name=${encodeURIComponent(modelName)}`, {
      method: 'DELETE',
    })
    if (!res.ok && res.status !== 404) {
      console.error(`Failed to unload model "${modelName}": ${res.status}`)
    }
  } catch {
    // Best-effort — don't block on failure
  }
}
