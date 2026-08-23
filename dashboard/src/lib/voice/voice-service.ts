import { getService, startService } from '@/lib/api'
import type { ServiceWithHealth } from '@/lib/api'

const POLL_INTERVAL_MS = 500
// Safety net only — the poll normally resolves off the server's own locked/health
// state, not this deadline. It exists in case the shard's bookkeeping itself wedges.
const START_SAFETY_TIMEOUT_MS = 120_000

// Demand-loaded services start in the background on the shard: POST start returns
// immediately while the real spawn + health poll runs behind a lock. Poll the
// service until that lock clears — locked means still starting; unlocked and not
// healthy means the attempt genuinely finished and failed.
async function waitUntilReady(serviceId: string): Promise<ServiceWithHealth> {
  const deadline = Date.now() + START_SAFETY_TIMEOUT_MS
  let svc = await getService(serviceId)
  while (svc.health !== 'healthy') {
    if (!svc.locked) {
      const reason = svc.lastEvent?.data?.error
      throw new Error(
        typeof reason === 'string'
          ? `Service "${serviceId}" failed to start: ${reason}`
          : `Service "${serviceId}" failed to start`
      )
    }
    if (Date.now() > deadline) {
      throw new Error(`Service "${serviceId}" timed out waiting to start`)
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    svc = await getService(serviceId)
  }
  return svc
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
    svc = await waitUntilReady(serviceId)
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
